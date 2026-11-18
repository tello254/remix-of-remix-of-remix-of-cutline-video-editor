import { describe, expect, it } from "vitest";

import { syncSliceCues } from "@/lib/slice-sync";
import type { TranscriptWord } from "@/lib/slice-timing";

function transcript(...entries: [text: string, start: number][]): TranscriptWord[] {
  return entries.map(([text, start]) => ({ text, start, end: start + 0.3 }));
}

describe("syncSliceCues", () => {
  it("maps spoken phrases onto clip time using the audio offset", () => {
    const words = transcript(
      ["draw", 10],
      ["a", 10.3],
      ["circle", 10.6],
      ["then", 20],
      ["a", 20.3],
      ["square.", 20.6],
    );
    const result = syncSliceCues(
      [
        { id: "a", cue: "draw a circle" },
        { id: "b", cue: "then a square" },
      ],
      words,
      { offsetSeconds: 5, clipDuration: 18 },
    );

    expect(result.patches).toHaveLength(2);
    expect(result.patches[0]?.timing.intendedStart).toBeCloseTo(5, 6);
    expect(result.patches[0]?.timing.anchorStart).toBeCloseTo(5, 6);
    expect(result.patches[1]?.timing.intendedStart).toBeCloseTo(15, 6);
    expect(result.patches[0]?.timing.anchor.time).toBeCloseTo(10, 6);
    expect(result.missing).toEqual([]);
  });

  it("uses the next occurrence when two slices share a cue", () => {
    const words = transcript(["circle", 1], ["fill", 5], ["circle", 9], ["fill", 13]);
    const result = syncSliceCues(
      [
        { id: "a", cue: "circle" },
        { id: "b", cue: "circle" },
      ],
      words,
      { offsetSeconds: 0, clipDuration: 16 },
    );

    expect(result.patches.map((patch) => patch.timing.intendedStart)).toEqual([1, 9]);
  });

  it("reports phrases that are not in the transcript instead of guessing", () => {
    const result = syncSliceCues(
      [{ id: "a", cue: "draw a triangle" }],
      transcript(["draw", 1], ["a", 1.2], ["circle", 1.4]),
      { offsetSeconds: 0, clipDuration: 8 },
    );
    expect(result.patches).toEqual([]);
    expect(result.missing).toEqual([{ id: "a", cue: "draw a triangle" }]);
  });

  it("reports a cue that belongs to another image clip", () => {
    const result = syncSliceCues(
      [{ id: "a", cue: "later" }],
      transcript(["later", 12]),
      { offsetSeconds: 0, clipDuration: 6 },
    );
    expect(result.patches).toEqual([]);
    expect(result.missing).toHaveLength(1);
  });

  it("lists slices that have no cue yet", () => {
    const result = syncSliceCues(
      [{ id: "a", cue: "   " }, { id: "b" }],
      transcript(["hello", 1]),
      { offsetSeconds: 0, clipDuration: 5 },
    );
    expect(result.noCue).toEqual(["a", "b"]);
    expect(result.patches).toEqual([]);
  });

  it("flags a repeated cue that cannot clear the previous reveal", () => {
    // Two occurrences of "go"; the second lands inside the first reveal, and
    // every nearby word is just as common, so the resolver must clamp it.
    const words = transcript(["go", 1], ["on", 1.5], ["go", 2], ["on", 2.5]);
    const result = syncSliceCues(
      [
        { id: "a", cue: "go" },
        { id: "b", cue: "go" },
      ],
      words,
      { offsetSeconds: 0, clipDuration: 10 },
    );

    expect(result.patches).toHaveLength(2);
    expect(result.clamped).toEqual(["b"]);
    expect(result.patches[1]?.timing.anchorStart).toBeCloseTo(2, 6);
  });

  it("is deterministic for the same inputs", () => {
    const words = transcript(["one", 2], ["two", 4], ["one", 6], ["two", 8]);
    const slices = [
      { id: "a", cue: "one" },
      { id: "b", cue: "two" },
    ];
    const first = syncSliceCues(slices, words, { offsetSeconds: 1, clipDuration: 9 });
    const second = syncSliceCues(slices, words, { offsetSeconds: 1, clipDuration: 9 });
    expect(first).toEqual(second);
  });

  it("treats an empty transcript as a miss, not an empty success", () => {
    const result = syncSliceCues([{ id: "a", cue: "hello" }], [], {
      offsetSeconds: 0,
      clipDuration: 5,
    });
    expect(result.patches).toEqual([]);
    expect(result.missing).toEqual([{ id: "a", cue: "hello" }]);
  });
});
