import { describe, expect, it } from "vitest";

import { narrationBeats, syncSliceBeats, syncSliceCues } from "@/lib/slice-sync";
import type { TranscriptWord } from "@/lib/slice-timing";

function transcript(...entries: [text: string, start: number][]): TranscriptWord[] {
  return entries.map(([text, start]) => ({ text, start, end: start + 0.3 }));
}

const beat = (id: string, cue: string, time: number) => ({
  id,
  cue,
  anchor: { wordIndex: 0, text: cue, time },
});

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
    // The words are heard at 2.0, but slice a is still drawing then, so b waits.
    expect(result.patches[1]?.timing.intendedStart).toBeCloseTo(2, 6);
    expect(result.patches[1]?.timing.anchorStart).toBeGreaterThan(2);
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

describe("syncSliceBeats", () => {
  it("uses the aligned beat time in clip space", () => {
    const result = syncSliceBeats(
      [
        { id: "a", cue: "draw a circle" },
        { id: "b", cue: "then a square" },
      ],
      [beat("a", "draw a circle", 10), beat("b", "then a square", 20)],
      { offsetSeconds: 5, clipDuration: 18 },
    );

    expect(result.patches).toHaveLength(2);
    expect(result.patches[0]?.timing.intendedStart).toBeCloseTo(5, 6);
    expect(result.patches[0]?.timing.anchorStart).toBeCloseTo(5, 6);
    expect(result.patches[1]?.timing.intendedStart).toBeCloseTo(15, 6);
    expect(result.patches[0]?.timing.anchor.time).toBe(10);
    expect(result.clamped).toEqual([]);
  });

  it("keeps the aligned anchor even when the reveal must be pushed later", () => {
    const result = syncSliceBeats(
      [
        { id: "a", cue: "one" },
        { id: "b", cue: "two" },
      ],
      [beat("a", "one", 1), beat("b", "two", 1.4)],
      { offsetSeconds: 0, clipDuration: 10 },
    );

    expect(result.patches).toHaveLength(2);
    expect(result.patches[1]?.timing.anchorStart).toBeGreaterThan(1.4);
    expect(result.patches[1]?.timing.intendedStart).toBeCloseTo(1.4, 6);
    expect(result.clamped).toEqual(["b"]);
  });

  it("reports a beat that belongs to another image", () => {
    const result = syncSliceBeats(
      [{ id: "a", cue: "later" }],
      [beat("a", "later", 12)],
      { offsetSeconds: 0, clipDuration: 6 },
    );

    expect(result.patches).toEqual([]);
    expect(result.missing).toEqual([{ id: "a", cue: "later" }]);
  });

  it("grows the scene instead of dropping a beat past the natural draw time", () => {
    const result = syncSliceBeats(
      [{ id: "a", cue: "one" }, { id: "b", cue: "two" }],
      [beat("a", "one", 2), beat("b", "two", 12)],
      { offsetSeconds: 0, clipDuration: 6, maxDuration: 20 },
    );

    expect(result.missing).toEqual([]);
    expect(result.patches).toHaveLength(2);
    expect(result.patches[1]?.timing.anchorStart).toBeCloseTo(12, 6);
    // The caller sizes the clip from this, so the last drawing is not cut off.
    expect(result.spanEnd).toBeGreaterThan(12);
  });

  it("still refuses a beat beyond the room the scene is allowed", () => {
    const result = syncSliceBeats(
      [{ id: "a", cue: "later" }],
      [beat("a", "later", 12)],
      { offsetSeconds: 0, clipDuration: 6, maxDuration: 8 },
    );

    expect(result.patches).toEqual([]);
    expect(result.missing).toEqual([{ id: "a", cue: "later" }]);
  });

  it("separates slices without cues from slices without a beat", () => {
    const result = syncSliceBeats(
      [{ id: "a", cue: "  " }, { id: "b", cue: "never said" }],
      [],
      { offsetSeconds: 0, clipDuration: 6 },
    );

    expect(result.noCue).toEqual(["a"]);
    expect(result.missing).toEqual([{ id: "b", cue: "never said" }]);
  });

  it("is deterministic for the same inputs", () => {
    const slices = [{ id: "a", cue: "one" }, { id: "b", cue: "two" }];
    const beats = [beat("a", "one", 1), beat("b", "two", 3)];
    const options = { offsetSeconds: 0.5, clipDuration: 9 };

    expect(syncSliceBeats(slices, beats, options)).toEqual(
      syncSliceBeats(slices, beats, options),
    );
  });
});

describe("estimation", () => {
  function spoken(...entries: [text: string, start: number, end: number][]): TranscriptWord[] {
    return entries.map(([text, start, end]) => ({ text, start, end }));
  }

  it("reads sentence, clause and pause boundaries with different strengths", () => {
    const beats = narrationBeats(
      spoken(
        ["Start", 0, 0.3],
        ["here.", 0.3, 0.6],
        ["Next", 1.2, 1.5],
        ["clause,", 1.5, 1.8],
        ["breath", 2.1, 2.4],
      ),
    );

    expect(beats.map((entry) => entry.text)).toEqual(["Start", "Next", "breath"]);
    expect(beats.map((entry) => entry.strength)).toEqual([1, 3, 2]);
  });

  it("places a missing cue on the nearest strong beat after the previous reveal", () => {
    const words = spoken(
      ["first", 0, 0.3],
      ["line", 0.3, 0.6],
      ["more", 1.5, 1.8],
      ["after", 6, 6.3],
      ["that", 6.3, 6.6],
    );
    const result = syncSliceBeats(
      [
        { id: "a", cue: "first line", timing: { animation: 1.2 } },
        { id: "b", cue: "quantum leap", timing: { animation: 1 } },
        { id: "c", cue: "after that", timing: { animation: 1 } },
      ],
      [beat("a", "first line", 0), beat("c", "after that", 6)],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    expect(result.estimated).toEqual(["b"]);
    expect(result.patches.find((patch) => patch.id === "b")?.timing.anchorStart).toBeCloseTo(
      1.5,
      6,
    );
    expect(result.patches.find((patch) => patch.id === "b")?.timing.estimated).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("centres the slice when sitting on the beat would leave the previous one staring", () => {
    const words = spoken(
      ["first", 0, 0.3],
      ["line", 0.3, 0.6],
      ["late", 4.5, 4.8],
      ["after", 6, 6.3],
      ["that", 6.3, 6.6],
    );
    const result = syncSliceBeats(
      [
        { id: "a", cue: "first line", timing: { animation: 1.2 } },
        { id: "b", cue: "quantum leap", timing: { animation: 1 } },
        { id: "c", cue: "after that", timing: { animation: 1 } },
      ],
      [beat("a", "first line", 0), beat("c", "after that", 6)],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    // Gap is 1.2 → 6.0 with a 1.0 drawing, so the middle is 1.2 + 1.9 = 3.1.
    expect(result.patches.find((patch) => patch.id === "b")?.timing.anchorStart).toBeCloseTo(
      3.1,
      6,
    );
  });

  it("shortens a drawing rather than pushing it into the next slice", () => {
    const words = spoken(["first", 0, 0.3], ["after", 5.4, 5.7]);
    const result = syncSliceBeats(
      [
        { id: "a", cue: "first", timing: { animation: 5 } },
        { id: "b", cue: "quantum leap", timing: { animation: 1 } },
        { id: "c", cue: "after", timing: { animation: 0.3 } },
      ],
      [beat("a", "first", 0), beat("c", "after", 5.4)],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    const patch = result.patches.find((entry) => entry.id === "b");
    expect(patch?.timing.anchorStart).toBeCloseTo(5, 6);
    expect(patch?.timing.animation).toBeCloseTo(0.4, 6);
    expect(result.estimated).toEqual(["b"]);
  });

  it("uses beats for the last slice, with the clip end as its boundary", () => {
    const words = spoken(["first", 0, 0.3], ["second", 1.5, 1.8]);
    const result = syncSliceBeats(
      [
        { id: "a", cue: "first", timing: { animation: 1 } },
        { id: "b", cue: "quantum leap", timing: { animation: 1 } },
      ],
      [beat("a", "first", 0)],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    expect(result.patches.find((patch) => patch.id === "b")?.timing.anchorStart).toBeCloseTo(
      1.5,
      6,
    );
  });

  it("splits one gap between a run of missing cues instead of stacking them", () => {
    const words = spoken(["first", 0, 0.3], ["last", 9, 9.3]);
    const result = syncSliceBeats(
      [
        { id: "a", cue: "first", timing: { animation: 1 } },
        { id: "b", cue: "quantum leap", timing: { animation: 1 } },
        { id: "c", cue: "another leap", timing: { animation: 1 } },
        { id: "d", cue: "last", timing: { animation: 0.5 } },
      ],
      [beat("a", "first", 0), beat("d", "last", 9)],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    expect(result.estimated).toEqual(["b", "c"]);
    expect(result.patches.find((patch) => patch.id === "b")?.timing.anchorStart).toBeCloseTo(
      2.5,
      6,
    );
    expect(result.patches.find((patch) => patch.id === "c")?.timing.anchorStart).toBeCloseTo(
      6.5,
      6,
    );
  });

  it("does not estimate a slice that has no cue at all", () => {
    const words = spoken(["first", 0, 0.3], ["second", 1.5, 1.8]);
    const result = syncSliceBeats(
      [{ id: "a", cue: "   " }, { id: "b", cue: "quantum leap" }],
      [],
      { offsetSeconds: 0, clipDuration: 10, candidates: narrationBeats(words) },
    );

    expect(result.noCue).toEqual(["a"]);
    expect(result.estimated).toEqual(["b"]);
  });

  it("keeps a beat that belongs to another image as a miss, not an estimate", () => {
    const words = spoken(["later", 12, 12.3]);
    const result = syncSliceBeats(
      [{ id: "a", cue: "later" }],
      [beat("a", "later", 12)],
      { offsetSeconds: 0, clipDuration: 6, candidates: narrationBeats(words) },
    );

    expect(result.estimated).toEqual([]);
    expect(result.missing).toEqual([{ id: "a", cue: "later" }]);
  });

  it("is deterministic when estimating", () => {
    const words = spoken(["first", 0, 0.3], ["second", 1.5, 1.8], ["last", 8, 8.3]);
    const slices = [
      { id: "a", cue: "first", timing: { animation: 1 } },
      { id: "b", cue: "quantum leap", timing: { animation: 1 } },
      { id: "c", cue: "last", timing: { animation: 1 } },
    ];
    const beats = [beat("a", "first", 0), beat("c", "last", 8)];
    const options = {
      offsetSeconds: 0,
      clipDuration: 10,
      candidates: narrationBeats(words),
    };

    expect(syncSliceBeats(slices, beats, options)).toEqual(
      syncSliceBeats(slices, beats, options),
    );
  });
});
