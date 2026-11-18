import { describe, expect, it, vi } from "vitest";

import {
  handleRequest,
  normaliseResult,
  type AiBinding,
  type WorkerEnv,
} from "./transcribe";

const MODEL_OUTPUT = {
  text: "Hello there.",
  transcription_info: { duration: 1.2, language: "en" },
  segments: [
    {
      start: 0.1,
      end: 1.2,
      text: "Hello there.",
      words: [
        { word: "Hello", start: 0.1, end: 0.5 },
        { word: "there.", start: 0.6, end: 1.2 },
      ],
    },
  ],
};

function fakeAi(output: unknown = MODEL_OUTPUT) {
  const run = vi.fn(async () => output);
  return { ai: { run } as AiBinding, run };
}

function wavBytes(length = 320) {
  return new Uint8Array(length).fill(7);
}

describe("normaliseResult", () => {
  it("applies the chunk offset to words and segments", () => {
    const result = normaliseResult(MODEL_OUTPUT, 12.5);
    expect(result.words).toHaveLength(2);
    expect(result.words[0]).toEqual({ text: "Hello", start: 12.6, end: 13 });
    expect(result.words[1]?.start).toBeCloseTo(13.1, 6);
    expect(result.segments[0]?.start).toBeCloseTo(12.6, 6);
    expect(result.duration).toBe(1.2);
    expect(result.language).toBe("en");
    expect(result.text).toBe("Hello there.");
  });

  it("distributes segment words and marks them estimated when the model omits words", () => {
    const result = normaliseResult(
      {
        text: "one two three",
        segments: [{ start: 0, end: 1.5, text: "one two three" }],
      },
      0,
    );
    expect(result.words).toHaveLength(3);
    expect(result.words.every((word) => word.estimated === true)).toBe(true);
    expect(result.words[0]?.start).toBe(0);
    expect(result.words[2]?.end).toBeCloseTo(1.5, 6);
  });

  it("accepts a plain string and a nested result wrapper", () => {
    expect(normaliseResult("just text", 0).text).toBe("just text");
    const nested = normaliseResult({ result: MODEL_OUTPUT }, 0);
    expect(nested.words).toHaveLength(2);
  });

  it("never returns inverted word times", () => {
    const result = normaliseResult(
      {
        segments: [
          { start: 0, end: 1, words: [{ word: "odd", start: 0.8, end: 0.2 }] },
        ],
      },
      0,
    );
    expect(result.words[0]).toEqual({ text: "odd", start: 0.8, end: 0.8 });
  });
});

describe("worker routing", () => {
  it("reports the binding on /health", async () => {
    const env: WorkerEnv = { AI: fakeAi().ai };
    const response = await handleRequest(new Request("https://asr.test/health"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.aiBinding).toBe(true);
    expect(body.model).toBe("@cf/openai/whisper-large-v3-turbo");
  });

  it("explains a missing binding instead of failing with a 500", async () => {
    const response = await handleRequest(
      new Request("https://asr.test/transcribe", { method: "POST", body: wavBytes() }),
      {},
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("ai_binding_missing");
  });

  it("rejects outlier methods and unknown paths", async () => {
    const env: WorkerEnv = { AI: fakeAi().ai };
    expect((await handleRequest(new Request("https://asr.test/transcribe"), env)).status).toBe(405);
    expect((await handleRequest(new Request("https://asr.test/nope"), env)).status).toBe(404);
  });
});

describe("POST /transcribe", () => {
  it("forwards base64 audio, VAD and the prompt, then returns absolute words", async () => {
    const { ai, run } = fakeAi();
    const env: WorkerEnv = { AI: ai };
    const request = new Request(
      "https://asr.test/transcribe?offset=30&language=en&prompt=Cutline%20narration",
      { method: "POST", body: wavBytes(4) },
    );
    const response = await handleRequest(request, env);
    expect(response.status).toBe(200);

    const [model, input] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(input.vad_filter).toBe(true);
    expect(input.condition_on_previous_text).toBe(false);
    expect(input.language).toBe("en");
    expect(input.initial_prompt).toBe("Cutline narration");
    expect(typeof input.audio).toBe("string");
    expect(atob(String(input.audio)).length).toBe(4);

    const body = (await response.json()) as { words: { start: number }[]; offset: number };
    expect(body.offset).toBe(30);
    expect(body.words[0]?.start).toBeCloseTo(30.1, 6);
  });

  it("accepts a JSON body with a base64 string", async () => {
    const { ai, run } = fakeAi();
    const response = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: "AAAA", offset: 2 }),
      }),
      { AI: ai },
    );
    expect(response.status).toBe(200);
    const [, input] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(input.audio).toBe("AAAA");
    const body = (await response.json()) as { words: { start: number }[] };
    expect(body.words[0]?.start).toBeCloseTo(2.1, 6);
  });

  it("rejects a JSON body without audio", async () => {
    const response = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: 2 }),
      }),
      { AI: fakeAi().ai },
    );
    expect(response.status).toBe(400);
  });

  it("turns a model failure into a readable 502", async () => {
    const ai: AiBinding = {
      run: async () => {
        throw new Error("upstream exploded");
      },
    };
    const response = await handleRequest(
      new Request("https://asr.test/transcribe", { method: "POST", body: wavBytes() }),
      { AI: ai },
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.message).toBe("upstream exploded");
  });
});

describe("CORS and access", () => {
  it("echoes an allowed origin and answers preflight", async () => {
    const env: WorkerEnv = { AI: fakeAi().ai, ALLOWED_ORIGINS: "http://localhost:8081" };
    const preflight = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8081" },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("does not echo an unknown origin", async () => {
    const env: WorkerEnv = { AI: fakeAi().ai, ALLOWED_ORIGINS: "http://localhost:8081" };
    const response = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: wavBytes(),
      }),
      env,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    expect(preflight.status).toBe(403);
  });

  it("requires the shared secret when one is configured", async () => {
    const env: WorkerEnv = { AI: fakeAi().ai, SHARED_SECRET: "s3cret" };
    const denied = await handleRequest(
      new Request("https://asr.test/transcribe", { method: "POST", body: wavBytes() }),
      env,
    );
    expect(denied.status).toBe(401);

    const allowed = await handleRequest(
      new Request("https://asr.test/transcribe", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret" },
        body: wavBytes(),
      }),
      env,
    );
    expect(allowed.status).toBe(200);
  });
});
