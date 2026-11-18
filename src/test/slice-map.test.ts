import { describe, expect, it } from "vitest";

import { parseSliceMap, serializeSliceMap, SLICE_MAP_SCHEMA } from "@/lib/slice-map";

const square = (left: number, top: number, right: number, bottom: number) => [
  [left, top],
  [right, top],
  [right, bottom],
  [left, bottom],
];

describe("parseSliceMap", () => {
  it("reads normalised polygons and keeps the authored order", () => {
    const report = parseSliceMap([
      { points: square(0, 0, 0.5, 1) },
      { points: square(0.5, 0, 1, 1), order: 1, cue: "  then the idea  " },
    ]);

    expect(report.errors).toEqual([]);
    expect(report.slices).toHaveLength(2);
    expect(report.slices[0]?.order).toBe(1);
    expect(report.slices[1]?.order).toBe(2);
    expect(report.slices[1]?.cue).toBe("then the idea");
    expect(report.coverage).toBeCloseTo(1, 1);
    expect(report.overlaps).toEqual([]);
  });

  it("takes a whole array, an object with slices, or bundle beats", () => {
    const points = square(0.1, 0.1, 0.4, 0.9);
    expect(parseSliceMap({ slices: [{ points }] }).slices).toHaveLength(1);
    expect(parseSliceMap({ beats: [{ slice: { points } }] }).slices).toHaveLength(1);
    expect(
      parseSliceMap({ scenes: [{ beats: [{ slice: { points } }] }] }).slices,
    ).toHaveLength(1);
  });

  it("converts pixel coordinates using the declared image size", () => {
    const report = parseSliceMap(
      [{ points: square(0, 0, 960, 1080), width: 1920, height: 1080 }],
      { space: "pixels" },
    );

    expect(report.errors).toEqual([]);
    expect(report.slices[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it("accepts {x, y} points as well as pairs", () => {
    const report = parseSliceMap([
      {
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
      },
    ]);
    expect(report.errors).toEqual([]);
    expect(report.slices).toHaveLength(1);
  });

  it("refuses pixels when the image size is missing", () => {
    const report = parseSliceMap([{ points: square(0, 0, 960, 540), space: "pixels" }]);
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.message).toContain("width");
    expect(report.errors[0]?.path).toBe("$[0].points");
  });

  it("rejects out-of-range normalised coordinates instead of clamping", () => {
    const report = parseSliceMap([{ points: square(0, 0, 1.2, 1) }]);
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.path).toBe("$[0].points[1]");
    expect(report.errors[0]?.message).toContain("between 0 and 1");
  });

  it("rejects a polygon with fewer than three corners", () => {
    const report = parseSliceMap([{ points: [[0, 0], [1, 1]] }]);
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.message).toContain("three corners");
  });

  it("rejects a self-intersecting border", () => {
    const report = parseSliceMap([
      {
        points: [
          [0.1, 0.1],
          [0.9, 0.9],
          [0.9, 0.1],
          [0.1, 0.9],
        ],
      },
    ]);
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.message).toContain("crosses itself");
  });

  it("reports a polygon with no area", () => {
    const report = parseSliceMap([{ points: [[0.2, 0.2], [0.4, 0.4], [0.3, 0.3]] }]);
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.message).toContain("no visible area");
  });

  it("keeps good slices and rejects the whole map when one is broken", () => {
    const report = parseSliceMap([
      { points: square(0, 0, 0.5, 1) },
      { points: [[0, 0]] },
    ]);
    expect(report.slices).toEqual([]);
    expect(report.errors).toHaveLength(1);
  });

  it("moves a duplicate order to the next free position and warns", () => {
    const report = parseSliceMap([
      { points: square(0, 0, 0.4, 1), order: 2 },
      { points: square(0.4, 0, 0.8, 1), order: 2 },
    ]);
    expect(report.errors).toEqual([]);
    expect(report.slices.map((slice) => slice.order)).toEqual([2, 3]);
    expect(report.warnings.some((warning) => warning.path === "$[1].order")).toBe(true);
  });

  it("reports coverage gaps and overlapping slices as warnings", () => {
    const gap = parseSliceMap([{ points: square(0, 0, 0.2, 1) }]);
    expect(gap.warnings.some((warning) => warning.message.includes("cover"))).toBe(true);

    const overlap = parseSliceMap([
      { points: square(0, 0, 0.6, 1) },
      { points: square(0.4, 0, 1, 1) },
    ]);
    expect(overlap.overlaps).toEqual([{ a: 1, b: 2 }]);
    expect(overlap.warnings.some((warning) => warning.message.includes("overlap"))).toBe(true);
  });

  it("reports broken JSON without touching the project", () => {
    const report = parseSliceMap("{ not json");
    expect(report.slices).toEqual([]);
    expect(report.errors[0]?.message).toContain("not valid JSON");
  });

  it("never invents timing fields", () => {
    const report = parseSliceMap([
      { points: square(0, 0, 0.5, 1), startSeconds: 4.2, duration: 2 },
    ]);
    expect(report.errors).toEqual([]);
    expect(Object.keys(report.slices[0] ?? {})).toEqual(["points", "order"]);
  });
});

describe("serializeSliceMap", () => {
  it("round-trips a map through the parser", () => {
    const report = parseSliceMap([
      { points: square(0.03, 0.08, 0.3, 0.92), cue: "problem" },
      { points: square(0.36, 0.08, 0.62, 0.92), cue: "idea", order: 2 },
    ]);

    const text = serializeSliceMap(report.slices);
    const parsed = JSON.parse(text) as { schema: string; slices: unknown[] };
    expect(parsed.schema).toBe(SLICE_MAP_SCHEMA);
    expect(parsed.slices).toHaveLength(2);

    const again = parseSliceMap(text);
    expect(again.errors).toEqual([]);
    expect(again.slices.map((slice) => slice.cue)).toEqual(["problem", "idea"]);
    expect(again.slices[0]?.points).toEqual(report.slices[0]?.points);
  });
});
