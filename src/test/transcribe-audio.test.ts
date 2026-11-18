import { describe, expect, it, vi } from "vitest";

import {
  ASR_SAMPLE_RATE,
  encodeWavPcm16,
  planChunks,
  transcribeChunks,
} from "@/lib/transcribe-audio";

function tone(seconds: number, sampleRate = 1000, amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  samples.fill(amplitude);
  return samples;
}

function readHeader(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + length));
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    fmt: text(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: text(36, 4),
    dataBytes: view.getUint32(40, true),
  };
}

describe("encodeWavPcm16", () => {
  it("writes a mono 16-bit PCM header and the right size", () => {
    const samples = new Float32Array([0, 1, -1, 0.5]);
    const wav = encodeWavPcm16(samples, ASR_SAMPLE_RATE);
    expect(wav.byteLength).toBe(44 + samples.length * 2);

    const header = readHeader(wav);
    expect(header.riff).toBe("RIFF");
    expect(header.wave).toBe("WAVE");
    expect(header.fmt).toBe("fmt ");
    expect(header.data).toBe("data");
    expect(header.audioFormat).toBe(1);
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(ASR_SAMPLE_RATE);
    expect(header.byteRate).toBe(ASR_SAMPLE_RATE * 2);
    expect(header.blockAlign).toBe(2);
    expect(header.bits).toBe(16);
    expect(header.dataBytes).toBe(samples.length * 2);
  });

  it("clamps samples outside the representable range", () => {
    const wav = encodeWavPcm16(new Float32Array([2, -2]), 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe("planChunks", () => {
  it("returns nothing for empty audio", () => {
    expect(planChunks(new Float32Array(0), 1000)).toEqual([]);
  });

  it("tiles the whole recording exactly once", () => {
    const rate = 1000;
    const chunks = planChunks(tone(400, rate), rate, {
      targetSeconds: 90,
      searchSeconds: 20,
      minSeconds: 20,
    });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]?.startSample).toBe(0);
    expect(chunks[chunks.length - 1]?.endSample).toBe(400 * rate);
    chunks.forEach((chunk, index) => {
      if (index > 0) expect(chunk.startSample).toBe(chunks[index - 1]?.endSample);
      expect(chunk.endSample).toBeGreaterThan(chunk.startSample);
      expect(chunk.endSample - chunk.startSample).toBeLessThanOrEqual((90 + 20) * rate);
    });
  });

  it("cuts on silence rather than at an arbitrary frame", () => {
    const rate = 1000;
    // 200 s of tone with a clear 2 s gap starting at 80 s.
    const samples = tone(200, rate);
    for (let i = 80 * rate; i < 82 * rate; i += 1) samples[i] = 0;

    const chunks = planChunks(samples, rate, {
      targetSeconds: 90,
      searchSeconds: 20,
      minSeconds: 20,
    });
    const firstCut = chunks[0]?.end ?? 0;
    expect(firstCut).toBeGreaterThan(79.5);
    expect(firstCut).toBeLessThan(82.1);
  });

  it("keeps a short tail rather than merging it into the previous chunk", () => {
    const rate = 1000;
    const chunks = planChunks(tone(95, rate), rate, {
      targetSeconds: 90,
      searchSeconds: 20,
      minSeconds: 20,
    });
    // 95 s is inside target + search, so it is one chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.end).toBe(95);
  });
});

describe("transcribeChunks", () => {
  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("posts one WAV chunk and maps words with clause breaks", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        model: "test-model",
        words: [
          { text: "Hello", start: 0.2, end: 0.4 },
          { text: "world.", start: 0.5, end: 0.8 },
        ],
        text: "Hello world.",
      }),
    ) as unknown as typeof fetch;

    const samples = new Float32Array(ASR_SAMPLE_RATE * 3).fill(0.1);
    const result = await transcribeChunks(samples, {
      endpoint: "https://asr.test/",
      token: "secret",
      fetchImpl,
      language: "en",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://asr.test/transcribe?offset=0.000&language=en");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(init.headers).get("Content-Type")).toBe("audio/wav");
    expect((init.body as Uint8Array).byteLength).toBe(44 + samples.length * 2);

    expect(result.words).toEqual([
      { text: "Hello", start: 0.2, end: 0.4, clauseBreakAfter: false },
      { text: "world.", start: 0.5, end: 0.8, clauseBreakAfter: true },
    ]);
    expect(result.text).toBe("Hello world.");
    expect(result.duration).toBe(3);
    expect(result.model).toBe("test-model");
    expect(result.chunks).toBe(1);
  });

  it("merges several chunks in timeline order", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      return jsonResponse({
        ok: true,
        model: "test-model",
        words: [
          { text: `w${offset.toFixed(1)}`, start: offset + 0.1, end: offset + 0.2 },
          { text: `x${offset.toFixed(1)}`, start: offset + 0.3, end: offset + 0.4 },
        ],
        text: `w${offset.toFixed(1)} x${offset.toFixed(1)}`,
      });
    }) as unknown as typeof fetch;

    const samples = new Float32Array(ASR_SAMPLE_RATE * 3).fill(0.1);
    const progress: [number, number][] = [];
    const result = await transcribeChunks(samples, {
      endpoint: "https://asr.test",
      chunkSeconds: 1,
      searchSeconds: 0,
      minSeconds: 0.5,
      fetchImpl,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(result.chunks).toBe(3);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(result.words.map((word) => word.text)).toEqual(["w0.0", "x0.0", "w1.0", "x1.0", "w2.0", "x2.0"]);
    const starts = result.words.map((word) => word.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("retries a server failure once", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ ok: false, message: "cold start" }, 502);
      return jsonResponse({ ok: true, words: [], text: "" });
    }) as unknown as typeof fetch;

    const result = await transcribeChunks(new Float32Array(ASR_SAMPLE_RATE), {
      endpoint: "https://asr.test",
      fetchImpl,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(result.words).toEqual([]);
  });

  it("does not retry a 4xx and surfaces the message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "bad_request", message: "Audio chunk is too large." }, 400),
    ) as unknown as typeof fetch;

    await expect(
      transcribeChunks(new Float32Array(ASR_SAMPLE_RATE), {
        endpoint: "https://asr.test",
        fetchImpl,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow("Audio chunk is too large.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires an endpoint", async () => {
    await expect(
      transcribeChunks(new Float32Array(ASR_SAMPLE_RATE), { endpoint: "  " }),
    ).rejects.toThrow("No transcription endpoint is configured.");
  });
});
