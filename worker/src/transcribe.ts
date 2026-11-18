/**
 * Cutline ASR worker.
 *
 * One endpoint, one job: turn a WAV chunk into timed words using
 * `@cf/openai/whisper-large-v3-turbo` through the Workers AI binding.
 *
 * The app does the chunking (so it can cut on silence and keep the original
 * timeline offsets) and sends each chunk with its `offset`. Word times come
 * back absolute, ready for `resolveTriggerAnchor`.
 *
 * Nothing secret lives in the repository. The `AI` binding authenticates the
 * model call inside Cloudflare; `SHARED_SECRET` is optional and only stops
 * strangers from spending your neurons.
 */

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface WorkerEnv {
  AI?: AiBinding | undefined;
  MODEL?: string | undefined;
  ALLOWED_ORIGINS?: string | undefined;
  SHARED_SECRET?: string | undefined;
}

export const DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** A 90 s chunk at 16 kHz mono is ~2.9 MB; this leaves room for slack. */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export type TranscribedWord = {
  text: string;
  start: number;
  end: number;
  /** True when the timing was interpolated because the model gave no words. */
  estimated?: boolean;
};

export type TranscribedSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionResult = {
  text: string;
  /** Length of this chunk in seconds, as reported by the model. */
  duration: number;
  language: string | null;
  words: TranscribedWord[];
  segments: TranscribedSegment[];
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Base64 without blowing the argument limit on large buffers. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorised(request: Request, env: WorkerEnv): boolean {
  const secret = env.SHARED_SECRET?.trim();
  if (!secret) return true;
  const header = request.headers.get("Authorization") ?? "";
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return constantTimeEqual(given, secret);
}

function resolveOrigin(request: Request, env: WorkerEnv): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const origin = resolveOrigin(request, env);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...(origin === "*" ? {} : { Vary: "Origin" }),
  };
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

type TranscribeRequest = {
  audioBase64: string;
  offset: number;
  language: string | null;
  prompt: string | null;
  vad: boolean;
  conditionOnPreviousText: boolean;
};

function readNumber(query: string | null, body: unknown, fallback: number): number {
  const candidates = [query, body];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const parsed = typeof candidate === "number" ? candidate : Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readFlag(query: string | null, body: unknown, fallback: boolean): boolean {
  if (query != null && query !== "") {
    return query === "1" || query === "true";
  }
  if (typeof body === "boolean") return body;
  if (typeof body === "string" && body !== "") {
    return body === "1" || body === "true";
  }
  return fallback;
}

async function readTranscribeRequest(request: Request): Promise<TranscribeRequest> {
  const url = new URL(request.url);
  const contentType = request.headers.get("Content-Type") ?? "";
  let audioBase64 = "";
  let jsonBody: Json = {};

  if (contentType.includes("application/json")) {
    const parsed = asRecord(await request.json());
    if (!parsed) throw new Error("Body must be a JSON object.");
    jsonBody = parsed;
    const audio = asString(parsed.audio);
    if (!audio) throw new Error('JSON body needs an "audio" base64 string.');
    audioBase64 = audio;
  } else {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("Empty audio body.");
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(`Audio chunk is too large (${bytes.byteLength} bytes).`);
    }
    audioBase64 = toBase64(bytes);
  }

  return {
    audioBase64,
    offset: readNumber(url.searchParams.get("offset"), jsonBody.offset, 0),
    language:
      url.searchParams.get("language")?.trim() || asString(jsonBody.language)?.trim() || null,
    prompt: url.searchParams.get("prompt")?.trim() || asString(jsonBody.prompt)?.trim() || null,
    vad: readFlag(url.searchParams.get("vad"), jsonBody.vad, true),
    conditionOnPreviousText: readFlag(url.searchParams.get("context"), jsonBody.context, false),
  };
}

/**
 * Flattens the model output into absolute word times.
 *
 * The turbo model returns `segments[].words[]`. Older/alternate shapes give
 * only segments, so those words are distributed evenly and marked `estimated`
 * — the caller can then decide whether to trust the anchor.
 */
export function normaliseResult(raw: unknown, offset: number): TranscriptionResult {
  let payload = asRecord(raw) ?? (typeof raw === "string" ? { text: raw } : {});
  const nested = asRecord(payload.result);
  if (nested && payload.segments == null && payload.text == null) payload = nested;

  const segmentsRaw = Array.isArray(payload.segments) ? payload.segments : [];
  const words: TranscribedWord[] = [];
  const segments: TranscribedSegment[] = [];

  for (const entry of segmentsRaw) {
    const segment = asRecord(entry);
    if (!segment) continue;

    const segStart = asNumber(segment.start) ?? 0;
    const segEnd = Math.max(segStart, asNumber(segment.end) ?? segStart);
    const segText = (asString(segment.text) ?? "").trim();

    if (segText) {
      segments.push({ start: segStart + offset, end: segEnd + offset, text: segText });
    }

    const segWords = Array.isArray(segment.words) ? segment.words : [];
    if (segWords.length > 0) {
      for (const entryWord of segWords) {
        const word = asRecord(entryWord);
        if (!word) continue;
        const text = (asString(word.word) ?? asString(word.text) ?? "").trim();
        const start = asNumber(word.start);
        if (!text || start === null) continue;
        const end = Math.max(start, asNumber(word.end) ?? start);
        words.push({ text, start: start + offset, end: end + offset });
      }
      continue;
    }

    if (!segText) continue;
    const tokens = segText.split(/\s+/).filter(Boolean);
    const span = Math.max(segEnd - segStart, tokens.length * 0.18);
    const step = tokens.length > 0 ? span / tokens.length : span;
    tokens.forEach((token, index) => {
      const start = segStart + index * step;
      words.push({
        text: token,
        start: start + offset,
        end: Math.min(segStart + span, start + step) + offset,
        estimated: true,
      });
    });
  }

  words.sort((a, b) => a.start - b.start || a.end - b.end);

  const info = asRecord(payload.transcription_info) ?? {};
  const reportedDuration = asNumber(info.duration);
  const duration =
    reportedDuration ?? (words.length ? (words[words.length - 1]?.end ?? 0) - offset : 0);

  const text =
    (asString(payload.text) ?? "").trim() ||
    segments.map((segment) => segment.text).join(" ").trim() ||
    words.map((word) => word.text).join(" ");

  return {
    text,
    duration,
    language: asString(info.language),
    words,
    segments,
  };
}

export async function handleTranscribe(request: Request, env: WorkerEnv): Promise<Response> {
  const cors = corsHeaders(request, env);
  const model = env.MODEL?.trim() || DEFAULT_MODEL;

  if (!authorised(request, env)) {
    return json({ ok: false, error: "unauthorised" }, 401, cors);
  }
  if (!env.AI) {
    return json(
      {
        ok: false,
        error: "ai_binding_missing",
        message:
          'The worker has no AI binding. Add "ai": { "binding": "AI" } to wrangler.jsonc and redeploy.',
      },
      503,
      cors,
    );
  }

  let input: TranscribeRequest;
  try {
    input = await readTranscribeRequest(request);
  } catch (error) {
    return json(
      { ok: false, error: "bad_request", message: error instanceof Error ? error.message : "Bad request." },
      400,
      cors,
    );
  }

  const payload: Record<string, unknown> = {
    audio: input.audioBase64,
    task: "transcribe",
    vad_filter: input.vad,
    condition_on_previous_text: input.conditionOnPreviousText,
  };
  if (input.language) payload.language = input.language;
  if (input.prompt) payload.initial_prompt = input.prompt;

  try {
    const raw = await env.AI.run(model, payload);
    const result = normaliseResult(raw, input.offset);
    return json({ ok: true, model, offset: input.offset, ...result }, 200, cors);
  } catch (error) {
    return json(
      {
        ok: false,
        error: "ai_failed",
        message: error instanceof Error ? error.message : "The model call failed.",
      },
      502,
      cors,
    );
  }
}

export function handleRequest(request: Request, env: WorkerEnv): Promise<Response> | Response {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === "OPTIONS") {
    if (request.headers.get("Origin") && Object.keys(cors).length === 0) {
      return json({ ok: false, error: "origin_not_allowed" }, 403, {});
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(
      {
        ok: true,
        service: "cutline-asr",
        model: env.MODEL?.trim() || DEFAULT_MODEL,
        aiBinding: Boolean(env.AI),
        sharedSecret: Boolean(env.SHARED_SECRET),
        usage: "POST /transcribe?offset=0.0&language=en with a WAV body.",
      },
      200,
      cors,
    );
  }

  if (url.pathname === "/transcribe") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    return handleTranscribe(request, env);
  }

  return json({ ok: false, error: "not_found" }, 404, cors);
}
