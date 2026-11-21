import { describe, expect, it } from "vitest";

import { alignScriptToTranscript, tokenSimilarity } from "@/lib/script-align";
import type { TranscriptWord } from "@/lib/slice-timing";

/** Evenly spaced words, 0.4 s each, so offsets in assertions are easy to read. */
function heard(text: string, startAt = 0): TranscriptWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({
      text: word,
      start: startAt + index * 0.4,
      end: startAt + (index + 1) * 0.4,
    }));
}

describe("tokenSimilarity", () => {
  it("scores identical words at 1 and unrelated words at 0", () => {
    expect(tokenSimilarity("problem", "problem")).toBe(1);
    expect(tokenSimilarity("problem", "elephant")).toBe(0);
  });

  it("tolerates recogniser spelling changes", () => {
    expect(tokenSimilarity("their", "there")).toBeGreaterThanOrEqual(0.6);
  });
});

describe("alignScriptToTranscript", () => {
  it("places exact cues at the heard word times", () => {
    const script = "most teams start with a messy problem, then the idea arrives";
    const result = alignScriptToTranscript(script, [
      { id: "b1", cue: "messy problem" },
      { id: "b2", cue: "idea arrives" },
    ], heard(script));

    expect(result.misses).toEqual([]);
    expect(result.weak).toEqual([]);
    expect(result.beats).toHaveLength(2);
    expect(result.beats[0]?.start).toBeCloseTo(2.0, 5);
    expect(result.beats[0]?.end).toBeCloseTo(2.8, 5);
    expect(result.beats[1]?.start).toBeCloseTo(3.6, 5);
    expect(result.score).toBeCloseTo(1, 5);
  });

  it("points at the original word indices even after filler is heard", () => {
    const script = "we start with a messy problem";
    const result = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "messy problem" }],
      heard("we start with um a messy problem"),
    );

    expect(result.beats).toHaveLength(1);
    // "messy" is the sixth heard word, so index 5 in the untouched transcript.
    expect(result.beats[0]?.wordIndex).toBe(5);
    expect(result.beats[0]?.endWordIndex).toBe(6);
    expect(result.beats[0]?.start).toBeCloseTo(2.0, 5);
  });

  it("absorbs common ASR substitutions instead of missing the beat", () => {
    const script = "their plan cannot fail";
    const result = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "their plan" }],
      heard("there plan can not fail"),
    );

    expect(result.misses).toEqual([]);
    const beat = result.beats[0];
    expect(beat?.start).toBeCloseTo(0, 5);
    expect(beat?.confidence).toBeGreaterThan(0.55);
    expect(beat?.confidence).toBeLessThan(1);
  });

  it("reports a line the narrator never said as not-in-transcript", () => {
    const script = "we build a dashboard and then we ship it";
    const result = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "ship it" }],
      heard("we build a dashboard"),
    );

    expect(result.beats).toEqual([]);
    expect(result.misses).toEqual([
      { id: "b1", cue: "ship it", reason: "not-in-transcript" },
    ]);
  });

  it("tells a paraphrased cue apart from a skipped line", () => {
    const script = "one two three";
    const result = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "three four" }],
      heard("one two three four"),
    );

    expect(result.misses).toEqual([
      { id: "b1", cue: "three four", reason: "not-in-script" },
    ]);
  });

  it("treats a blank cue as empty rather than guessing", () => {
    const result = alignScriptToTranscript(
      "one two three",
      [{ id: "b1", cue: "   " }],
      heard("one two three"),
    );

    expect(result.misses).toEqual([{ id: "b1", cue: "   ", reason: "empty" }]);
  });

  it("uses the nth occurrence for a phrase that repeats in the script", () => {
    const script = "first we draw the box then we fill the box";
    const result = alignScriptToTranscript(
      script,
      [
        { id: "b1", cue: "the box" },
        { id: "b2", cue: "the box" },
      ],
      heard(script),
    );

    expect(result.misses).toEqual([]);
    expect(result.beats[0]?.start).toBeCloseTo(1.2, 5);
    expect(result.beats[1]?.start).toBeCloseTo(3.2, 5);
    expect(result.beats[0]?.wordIndex).toBeLessThan(result.beats[1]?.wordIndex ?? 0);
  });

  it("flags a beat that aligned to the wrong words as weak", () => {
    const result = alignScriptToTranscript(
      "draw a circle",
      [{ id: "b1", cue: "circle" }],
      heard("draw a square"),
    );

    expect(result.beats).toHaveLength(1);
    expect(result.weak).toEqual(["b1"]);
    expect(result.beats[0]?.confidence).toBeLessThan(0.55);
    expect(result.beats[0]?.mismatches).toEqual([
      { script: "circle", heard: "square" },
    ]);
  });

  it("honours a stricter confidence threshold", () => {
    const script = "their plan cannot fail";
    const result = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "their plan" }],
      heard("there plan can not fail"),
      { minConfidence: 0.95 },
    );

    expect(result.weak).toEqual(["b1"]);
  });

  it("returns identical output for identical input", () => {
    const script = "we build a dashboard and then we ship it";
    const beats = [
      { id: "b1", cue: "we build" },
      { id: "b2", cue: "ship it" },
    ];
    const words = heard(script);

    const first = alignScriptToTranscript(script, beats, words);
    const second = alignScriptToTranscript(script, beats, words);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("scores a badly mismatched transcript below a clean one", () => {
    const script = "we build a dashboard and then we ship it";
    const clean = alignScriptToTranscript(script, [{ id: "b1", cue: "we build" }], heard(script));
    const noisy = alignScriptToTranscript(
      script,
      [{ id: "b1", cue: "we build" }],
      heard("completely different words entirely unrelated"),
    );

    expect(clean.score).toBeGreaterThan(noisy.score);
  });
});
