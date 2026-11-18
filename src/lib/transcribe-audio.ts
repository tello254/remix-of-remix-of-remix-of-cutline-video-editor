/**
 * Narration transcription client.
 *
 * The browser owns the audio, so it also owns the chunking: decode to 16 kHz
 * mono, cut on the quietest 250 ms near each target boundary, and send each
 * chunk to the Cloudflare ASR worker with its timeline offset. Word times come
 * back absolute, which is what `resolveTriggerAnchor` expects.
 *
 * Chunking matters for two reasons: Workers AI bills by the audio minute, and
 * Whisper drifts (and hallucinates) on long, quiet stretches. Cutting on
 * silence keeps every cue inside one chunk.
 */

import type { TranscriptWord } from "@/lib/slice-timing";

export const ASR_SAMPLE_RATE = 16000;

/** Longest chunk we send; 90 s keeps each request a few megabytes. */
export const CHUNK_TARGET_SECONDS = 90;
/** How far either side of the target a silence cut may be taken. */
export const CHUNK_SEARCH_SECONDS = 20;
/** Never leave a tail shorter than this; it would transcribe badly. */
export const CHUNK_MIN_SECONDS = 20;
/** Width of the window scored when looking for a quiet cut. */
const SILENCE_WINDOW_SECONDS = 0.25;
/** 20 ms energy frames. */
const FRAME_SECONDS = 0.02;

export type AudioChunk = {
  index: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  startSample: number;
  endSample: number;
};

export type PlanChunksOptions = {
  targetSeconds?: number | undefined;
  searchSeconds?: number | undefined;
  minSeconds?: number | undefined;
};

export type TranscribeChunkOptions = {
  /** Worker base URL, e.g. https://cutline-asr.example.workers.dev */
  endpoint: string;
  /** Optional `SHARED_SECRET` configured on the worker. */
  token?: string | undefined;
  language?: string | undefined;
  initialPrompt?: string | undefined;
  /** Voice-activity pre-pass. On by default; turn off if word times look squeezed. */
  vad?: boolean | undefined;
  chunkSeconds?: number | undefined;
  searchSeconds?: number | undefined;
  minSeconds?: number | undefined;
  retries?: number | undefined;
  retryDelayMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export type TranscriptionResult = {
  words: TranscriptWord[];
  text: string;
  /** Seconds of audio that were transcribed. */
  duration: number;
  model: string | null;
  chunks: number;
};

function clampSample(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** 16-bit PCM WAV. Whisper does its own resampling, but not its own container. */
export function encodeWavPcm16(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);

  let cursor = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = clampSample(samples[i] ?? 0);
    view.setInt16(cursor, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    cursor += 2;
  }
  return new Uint8Array(buffer);
}

function frameEnergies(samples: Float32Array, frame: number): { energies: Float64Array; prefix: Float64Array } {
  const count = Math.max(1, Math.ceil(samples.length / frame));
  const energies = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const start = index * frame;
    const end = Math.min(samples.length, start + frame);
    let total = 0;
    for (let i = start; i < end; i += 1) total += Math.abs(samples[i] ?? 0);
    energies[index] = total;
  }
  const prefix = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    prefix[index + 1] = (prefix[index] ?? 0) + (energies[index] ?? 0);
  }
  return { energies, prefix };
}

/**
 * Splits the recording into chunks, preferring a quiet seam near each target.
 * The returned chunks always tile `[0, samples.length]` exactly once.
 */
export function planChunks(
  samples: Float32Array,
  sampleRate: number,
  options?: PlanChunksOptions,
): AudioChunk[] {
  const total = samples.length;
  if (total === 0) return [];

  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const windowFrames = Math.max(1, Math.round(SILENCE_WINDOW_SECONDS / FRAME_SECONDS));
  const target = Math.max(frame, Math.round((options?.targetSeconds ?? CHUNK_TARGET_SECONDS) * sampleRate));
  const search = Math.max(0, Math.round((options?.searchSeconds ?? CHUNK_SEARCH_SECONDS) * sampleRate));
  const requestedMin = Math.round((options?.minSeconds ?? CHUNK_MIN_SECONDS) * sampleRate);
  // A tail can never need more than half the recording, and clamping keeps the
  // cut loop from stalling when the caller asks for tiny chunks.
  const minChunk = Math.max(frame, Math.min(requestedMin, Math.max(frame, Math.floor(total / 2))));

  const { prefix } = frameEnergies(samples, frame);
  const lastFrame = Math.max(1, Math.ceil(total / frame));

  const quietest = (low: number, high: number): number => {
    const first = Math.max(0, Math.floor(low / frame));
    const last = Math.min(lastFrame - windowFrames, Math.floor(high / frame));
    let bestStart = first;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let startFrame = first; startFrame <= last; startFrame += 1) {
      const score = (prefix[startFrame + windowFrames] ?? 0) - (prefix[startFrame] ?? 0);
      if (score < bestScore) {
        bestScore = score;
        bestStart = startFrame;
      }
    }
    return bestStart * frame;
  };

  const chunks: AudioChunk[] = [];
  const push = (startSample: number, endSample: number) => {
    chunks.push({
      index: chunks.length,
      start: startSample / sampleRate,
      end: endSample / sampleRate,
      startSample,
      endSample,
    });
  };

  let cursor = 0;
  while (total - cursor > target + search) {
    const low = cursor + Math.max(0, target - search);
    const high = Math.max(low, Math.min(total - minChunk, cursor + target + search));
    let cut = quietest(low, high);
    cut = Math.max(cursor + minChunk, Math.min(total - minChunk, cut));
    push(cursor, cut);
    cursor = cut;
  }
  push(cursor, total);
  return chunks;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

class FatalTranscriptionError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clauseBreak(text: string) {
  return /[.,;:!?]["')\]]*$/.test(text.trim());
}

function readChunk(payload: unknown): { words: TranscriptWord[]; text: string; model: string | null } {
  const body = asRecord(payload);
  if (!body) throw new FatalTranscriptionError("The transcription worker returned no JSON.");
  if (body["ok"] === false) {
    const message =
      typeof body["message"] === "string" ? body["message"] : "Transcription failed.";
    throw new FatalTranscriptionError(message);
  }

  const rawWords = Array.isArray(body["words"]) ? body["words"] : [];
  const words: TranscriptWord[] = [];
  for (const entry of rawWords) {
    const word = asRecord(entry);
    if (!word) continue;
    const text = typeof word["text"] === "string" ? word["text"].trim() : "";
    const start =
      typeof word["start"] === "number" && Number.isFinite(word["start"]) ? word["start"] : null;
    const end =
      typeof word["end"] === "number" && Number.isFinite(word["end"]) ? word["end"] : start;
    if (!text || start === null) continue;
    const wordEnd = end === null ? start : Math.max(start, end);
    words.push({ text, start, end: wordEnd, clauseBreakAfter: clauseBreak(text) });
  }

  return {
    words,
    text: typeof body["text"] === "string" ? body["text"].trim() : "",
    model: typeof body["model"] === "string" ? body["model"] : null,
  };
}

async function requestChunk(
  fetchImpl: typeof fetch,
  url: string,
  wav: Uint8Array<ArrayBuffer>,
  options: TranscribeChunkOptions,
): Promise<{ words: TranscriptWord[]; text: string; model: string | null }> {
  const attempts = Math.max(1, (options.retries ?? 2) + 1);
  const retryDelay = options.retryDelayMs ?? 400;
  const headers: Record<string, string> = { "Content-Type": "audio/wav" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: wav,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const body = asRecord(parsed);
        const message =
          typeof body?.["message"] === "string"
            ? body["message"]
            : `Transcription failed (${response.status}).`;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new FatalTranscriptionError(message);
        }
        lastError = new Error(message);
      } else {
        return readChunk(parsed);
      }
    } catch (error) {
      if (error instanceof FatalTranscriptionError) throw error;
      if (options.signal?.aborted) throw error;
      lastError = error;
    }

    if (attempt + 1 < attempts && retryDelay > 0) {
      await delay(retryDelay * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Transcription failed.");
}

/** Transcribes already-decoded mono 16 kHz samples and stitches the chunks. */
export async function transcribeChunks(
  samples: Float32Array,
  options: TranscribeChunkOptions,
): Promise<TranscriptionResult> {
  const endpoint = options.endpoint.trim().replace(/\/+$/, "");
  if (!endpoint) throw new FatalTranscriptionError("No transcription endpoint is configured.");

  const fetchImpl = options.fetchImpl ?? fetch;
  const chunks = planChunks(samples, ASR_SAMPLE_RATE, {
    targetSeconds: options.chunkSeconds,
    searchSeconds: options.searchSeconds,
    minSeconds: options.minSeconds,
  });

  const words: TranscriptWord[] = [];
  const parts: string[] = [];
  let model: string | null = null;
  let done = 0;

  for (const chunk of chunks) {
    const url = new URL(`${endpoint}/transcribe`);
    url.searchParams.set("offset", chunk.start.toFixed(3));
    if (options.language) url.searchParams.set("language", options.language);
    if (options.initialPrompt) url.searchParams.set("prompt", options.initialPrompt);
    if (options.vad === false) url.searchParams.set("vad", "0");

    const wav = encodeWavPcm16(samples.subarray(chunk.startSample, chunk.endSample), ASR_SAMPLE_RATE);
    const result = await requestChunk(fetchImpl, url.toString(), wav, options);
    words.push(...result.words);
    if (result.text) parts.push(result.text);
    model = result.model ?? model;
    done += 1;
    options.onProgress?.(done, chunks.length);
  }

  // Chunk order is chronological, but sorting keeps word indices trustworthy if
  // a chunk ever comes back with a slightly early first word.
  words.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    words,
    text: parts.join(" ").replace(/\s+/g, " ").trim(),
    duration: samples.length / ASR_SAMPLE_RATE,
    model,
    chunks: chunks.length,
  };
}

type AudioContextCtor = typeof AudioContext;

/**
 * Decodes any browser-supported audio file to mono 16 kHz samples, which is
 * what Whisper wants and what keeps the uploaded chunks small.
 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser cannot decode audio.");

  const context = new Ctor();
  let decoded: AudioBuffer;
  try {
    // Safari detaches the buffer passed to decodeAudioData, so hand it a copy.
    decoded = await context.decodeAudioData(bytes.slice(0));
  } finally {
    void context.close().catch(() => undefined);
  }

  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new Error("The audio file is empty.");
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * ASR_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, ASR_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Decode + chunk + upload. The one call the editor needs. */
export async function transcribeAudio(
  blob: Blob,
  options: TranscribeChunkOptions,
): Promise<TranscriptionResult> {
  const samples = await decodeToMono16k(blob);
  return transcribeChunks(samples, options);
}
