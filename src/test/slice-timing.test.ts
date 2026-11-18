import { describe, expect, it } from "vitest";
import {
  defaultSliceTimings,
  MIN_SLICE_HOLD,
  naturalSliceAnimation,
  resolveSliceTiming,
  resolveTriggerAnchor,
  timingBands,
  type TranscriptWord,
} from "@/lib/slice-timing";

const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 5);

function words(entries: [string, number, number][]): TranscriptWord[] {
  return entries.map(([text, start, end]) => ({ text, start, end }));
}

describe("slice timing schedule", () => {
  it("falls back to the engine's uniform reveal timing", () => {
    const defaults = defaultSliceTimings(2, 4);
    expect(defaults).toHaveLength(2);
    near(defaults[0]?.animation ?? 0, naturalSliceAnimation());
    near(defaults[1]?.animation ?? 0, naturalSliceAnimation());
    expect(defaults[1]?.intendedStart ?? 0).toBeGreaterThan(defaults[0]?.intendedStart ?? 0);
  });

  it("keeps reveals sequential and derives hold up to the next start", () => {
    const { slices } = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        { id: "b", timing: { intendedStart: 2.5, animation: 0.8 } },
      ],
      5,
    );
    near(slices[0]?.start ?? -1, 0);
    near(slices[0]?.animEnd ?? -1, 1);
    near(slices[0]?.hold ?? -1, 1.5);
    near(slices[1]?.start ?? -1, 2.5);
    near(slices[1]?.hold ?? -1, 1.7);
    expect(slices[0]?.flags).toEqual([]);
    expect(slices[1]?.flags).toEqual([]);
  });

  it("measures lag from intendedStart, not from the replacement anchor", () => {
    const { slices } = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        {
          id: "b",
          timing: { intendedStart: 1.4, anchorStart: 2, animation: 0.6 },
        },
      ],
      5,
    );
    near(slices[1]?.start ?? -1, 2);
    near(slices[1]?.lag ?? 0, 0.6);
    // The lag lands on the previous slice's hold, which is allowed.
    expect(slices[1]?.flags).toEqual([]);
  });

  it("never lets two reveals overlap, flagging the clamp", () => {
    const { slices } = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        { id: "b", timing: { intendedStart: 1.4, anchorStart: 0.5, animation: 0.5 } },
      ],
      5,
    );
    near(slices[1]?.start ?? -1, 1);
    expect(slices[1]?.flags).toContain("clamped");
  });

  it("flags a hand-moved slice that runs ahead of the words", () => {
    const { slices } = resolveSliceTiming(
      [{ id: "a", timing: { intendedStart: 2, animation: 1, startOverride: 0 } }],
      5,
    );
    expect(slices[0]?.flags).toContain("override");
    expect(slices[0]?.flags).toContain("early");
    near(slices[0]?.lag ?? 0, -2);
  });

  it("flags a reveal that cannot fit before the next slice", () => {
    const { slices } = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        { id: "b", timing: { intendedStart: 1.2, animation: 1.5, minHold: MIN_SLICE_HOLD } },
        { id: "c", timing: { intendedStart: 2, animation: 0.5 } },
      ],
      5,
    );
    near(slices[1]?.animation ?? -1, 0.8);
    expect(slices[1]?.flags).toContain("tight");
  });

  it("recalculates a neighbour's hold when the next start moves", () => {
    const baseline = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        { id: "b", timing: { intendedStart: 2, animation: 0.5 } },
      ],
      6,
    );
    const moved = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 0, animation: 1 } },
        { id: "b", timing: { intendedStart: 3, animation: 0.5 } },
      ],
      6,
    );
    near(baseline.slices[0]?.hold ?? -1, 1);
    near(moved.slices[0]?.hold ?? -1, 2);
  });

  it("is deterministic for identical input", () => {
    const input = [
      { id: "a", timing: { intendedStart: 0, animation: 1.2 } },
      { id: "b", timing: { intendedStart: 2.2, anchorStart: 2.6, animation: 0.9 } },
    ];
    expect(JSON.stringify(resolveSliceTiming(input, 6))).toBe(
      JSON.stringify(resolveSliceTiming(input, 6)),
    );
  });

  it("maps resolved times to engine band fractions", () => {
    const { slices, sceneSeconds } = resolveSliceTiming(
      [
        { id: "a", timing: { intendedStart: 1, animation: 1 } },
        { id: "b", timing: { intendedStart: 3, animation: 1 } },
      ],
      4,
    );
    const bands = timingBands(slices, sceneSeconds);
    near(bands[0]?.start ?? -1, 0.25);
    near(bands[0]?.end ?? -1, 0.5);
    near(bands[1]?.start ?? -1, 0.75);
    near(bands[1]?.end ?? -1, 1);
  });
});

describe("trigger anchor resolution", () => {
  const repeated = words([
    ["the", 0, 0.3],
    ["same", 0.3, 0.6],
    ["thing", 0.6, 0.9],
    ["happened", 0.9, 1.3],
    ["again", 1.3, 1.6],
    ["then", 1.6, 1.8],
    ["revenue", 1.8, 2.1],
    ["actually", 2.1, 2.4],
    ["fell", 2.4, 2.7],
    ["the", 2.7, 3],
    ["same", 3, 3.3],
    ["thing", 3.3, 3.6],
    ["happened", 3.6, 4],
    ["again", 4, 4.3],
  ]);

  it("accepts a trigger that occurs once", () => {
    const resolution = resolveTriggerAnchor(repeated, "revenue actually fell", 0, 0);
    expect(resolution?.ambiguous).toBe(false);
    expect(resolution?.clamped).toBe(false);
    near(resolution?.intendedStart ?? -1, 1.8);
    near(resolution?.anchor.time ?? -1, 1.8);
  });

  it("widens a repeated trigger to the nearest unique forward bigram", () => {
    const resolution = resolveTriggerAnchor(repeated, "the same thing", 0, 0);
    expect(resolution?.ambiguous).toBe(true);
    expect(resolution?.clamped).toBe(false);
    expect(resolution?.anchor.kind).toBe("forward-bigram");
    // "happened again" repeats later in the script, so the nearest *unique*
    // bigram is "again then".
    near(resolution?.anchor.time ?? -1, 1.3);
    // The lag is measured from the occurrence the words point at, not the anchor.
    near(resolution?.intendedStart ?? -1, 0);
  });

  it("uses a forward single word when no unique bigram is free", () => {
    const script = words([
      ["night", 0, 0.2],
      ["the", 0.3, 0.5],
      ["night", 0.6, 0.8],
      ["revenue", 1.2, 1.5],
    ]);
    const resolution = resolveTriggerAnchor(script, "night", 0, 0.8);
    expect(resolution?.anchor.kind).toBe("forward-word");
    near(resolution?.anchor.time ?? -1, 1.2);
  });

  it("falls back to a backward anchor when nothing forward is free", () => {
    const script = words([
      ["the", 0, 0.3],
      ["same", 0.3, 0.6],
      ["thing", 0.6, 0.9],
      ["then", 0.9, 1.2],
      ["at", 1.5, 1.7],
      ["the", 2, 2.3],
      ["same", 2.3, 2.6],
      ["thing", 2.6, 2.9],
    ]);
    const resolution = resolveTriggerAnchor(script, "the same thing", 1, 0);
    expect(resolution?.ambiguous).toBe(true);
    expect(resolution?.anchor.kind).toBe("backward-bigram");
    near(resolution?.anchor.time ?? -1, 1.5);
    near(resolution?.intendedStart ?? -1, 2);
  });

  it("never widens past a clause break", () => {
    const script = words([
      ["stop", 0, 0.2],
      ["now", 0.2, 0.4],
      ["then", 0.5, 0.7],
      ["stop", 1, 1.2],
    ]);
    script[1] = { ...script[1], clauseBreakAfter: true } as TranscriptWord;
    const resolution = resolveTriggerAnchor(script, "stop", 0, 0.45);
    expect(resolution?.clamped).toBe(true);
    near(resolution?.anchor.time ?? -1, 0);
  });

  it("can cross a clause break once the cue search is widened", () => {
    const script = words([
      ["stop", 0, 0.2],
      ["now", 0.2, 0.4],
      ["then", 0.5, 0.7],
      ["stop", 1, 1.2],
    ]);
    script[1] = { ...script[1], clauseBreakAfter: true } as TranscriptWord;
    const resolution = resolveTriggerAnchor(script, "stop", 0, 0.45, {
      allowClauseCrossing: true,
    });
    expect(resolution?.clamped).toBe(false);
    near(resolution?.anchor.time ?? -1, 0.5);
  });

  it("clamps instead of borrowing an anchor outside the 1.5 second window", () => {
    const script = words([
      ["stop", 0, 0.2],
      ["xylophone", 2, 2.4],
      ["stop", 3, 3.2],
    ]);
    const resolution = resolveTriggerAnchor(script, "stop", 0, 0);
    expect(resolution?.clamped).toBe(true);
    near(resolution?.anchor.time ?? -1, 0);
  });
});
