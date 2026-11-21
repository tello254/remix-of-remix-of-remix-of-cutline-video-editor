import { describe, expect, it } from "vitest";

import {
  isSelfIntersecting,
  parseSliceMap,
  parseSliceMapBundle,
  serializeSliceMap,
  serializeSliceMapProject,
  type SliceMapIssue,
} from "@/lib/slice-map";

const square = [
  [0.1, 0.1],
  [0.4, 0.1],
  [0.4, 0.4],
  [0.1, 0.4],
];

/** Issue paths and messages in one string, for readable assertions. */
const text = (issues: SliceMapIssue[]) =>
  issues.map((issue) => `${issue.path} ${issue.message}`).join(" ");

describe("parseSliceMap", () => {
  it("reads normalised tuple polygons in file order", () => {
    const result = parseSliceMap({
      slices: [
        { points: square },
        { points: square.map(([x, y]) => ({ x: (x ?? 0) + 0.5, y })) },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.slices).toHaveLength(2);
    expect(result.slices.map((slice) => slice.order)).toEqual([1, 2]);
    expect(result.slices[0]?.points[0]).toEqual({ x: 0.1, y: 0.1 });
  });

  it("accepts a bare array and optional cues", () => {
    const result = parseSliceMap([{ points: square, cue: "  draw the   problem " }]);

    expect(result.errors).toEqual([]);
    expect(result.slices[0]?.cue).toBe("draw the problem");
  });

  it("normalises pixel coordinates against the image size", () => {
    const result = parseSliceMap({
      space: "pixels",
      width: 1000,
      height: 500,
      slices: [
        {
          points: [
            [0, 0],
            [500, 0],
            [500, 250],
            [0, 250],
          ],
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.slices[0]?.points).toEqual([
      { x: 0, y: 0 },
      { x: 0.25, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: 0.5 },
    ]);
  });

  it("tops a four-corner map up to the editing minimum without changing its shape", () => {
    const result = parseSliceMap([{ points: square }]);

    expect(result.errors).toEqual([]);
    const points = result.slices[0]?.points ?? [];
    expect(points).toHaveLength(5);
    // The extra point is the midpoint of the first (longest) edge, so every
    // pixel the old border covered is still covered.
    expect(points[1]).toEqual({ x: 0.25, y: 0.1 });
    expect(text(result.warnings)).toContain("draggable points");
    expect(result.coverage).toBeGreaterThan(0.07);
    expect(result.coverage).toBeLessThan(0.11);
  });

  it("tops a triangle up to five points too", () => {
    const result = parseSliceMap([
      { points: [[0.1, 0.1], [0.6, 0.1], [0.35, 0.5]] },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slices[0]?.points).toHaveLength(5);
  });

  it("leaves a border with enough points alone", () => {
    const five = [
      [0.1, 0.1],
      [0.3, 0.05],
      [0.5, 0.1],
      [0.5, 0.5],
      [0.1, 0.5],
    ];
    const result = parseSliceMap([{ points: five }]);

    expect(result.errors).toEqual([]);
    expect(result.slices[0]?.points).toHaveLength(5);
    expect(text(result.warnings)).not.toContain("draggable points");
  });

  it("refuses percentages instead of scaling them silently", () => {
    const result = parseSliceMap([
      {
        points: [
          [0, 0],
          [50, 0],
          [50, 50],
          [0, 50],
        ],
      },
    ]);

    expect(result.slices).toEqual([]);
    expect(text(result.errors)).toContain("percentages");
  });

  it("rejects pixel space without dimensions", () => {
    const result = parseSliceMap({
      space: "pixels",
      slices: [
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
        },
      ],
    });

    expect(text(result.errors)).toContain("width");
  });

  it("rejects polygons with fewer than three points", () => {
    const result = parseSliceMap([{ points: [[0, 0], [1, 1]] }]);
    expect(result.slices).toEqual([]);
    expect(text(result.errors)).toContain("3 points");
  });

  it("rejects a degenerate polygon", () => {
    const result = parseSliceMap([
      {
        points: [
          [0, 0],
          [1, 0],
          [1, 0.00001],
        ],
      },
    ]);
    expect(result.slices).toEqual([]);
    expect(text(result.errors)).toContain("too thin");
  });

  it("warns about self-intersecting edges but still imports them", () => {
    // A zig-zag whose diagonal lands back on the closing edge: it has real
    // area, so only the crossing rule is under test.
    const crossed = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.9, 0.9],
      [0.1, 0.9],
    ];
    expect(isSelfIntersecting(crossed.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 })))).toBe(true);
    const result = parseSliceMap([{ points: crossed }]);
    expect(result.errors).toEqual([]);
    expect(text(result.warnings)).toContain("cross themselves");
  });

  it("rejects duplicate orders", () => {
    const result = parseSliceMap([
      { points: square, order: 1 },
      { points: square, order: 1 },
    ]);
    expect(result.slices).toEqual([]);
    expect(text(result.errors)).toContain("used by another slice");
  });

  it("compacts a sparse order into 1..N and says so", () => {
    const result = parseSliceMap([
      { points: square, order: 30 },
      { points: square, order: 10 },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slices.map((slice) => slice.order)).toEqual([1, 2]);
    expect(text(result.warnings)).toContain("compacted");
  });

  it("warns that authored timing is ignored", () => {
    const result = parseSliceMap([
      { points: square, startSeconds: 4.2, duration: 1.5, timing: { hold: 2 } },
    ]);

    expect(result.errors).toEqual([]);
    expect(text(result.warnings)).toContain("startSeconds");
    expect(text(result.warnings)).toContain("timing");
  });

  it("explains invalid JSON instead of throwing", () => {
    const result = parseSliceMap("{ slices: oops");
    expect(result.slices).toEqual([]);
    expect(result.errors[0]?.message).toContain("not valid JSON");
  });

  it("estimates how much of the image the slices cover", () => {
    const result = parseSliceMap([{ points: square }]);

    // 0.3 × 0.3 = 0.09, measured on a sampling grid.
    expect(result.coverage).toBeGreaterThan(0.07);
    expect(result.coverage).toBeLessThan(0.11);
  });

  it("does not double-count overlapping slices", () => {
    const single = parseSliceMap([{ points: square }]);
    const overlapping = parseSliceMap([{ points: square }, { points: square }]);

    expect(overlapping.coverage).toBeCloseTo(single.coverage, 5);
  });

  it("round-trips through the exporter", () => {
    const parsed = parseSliceMap({
      slices: [{ points: square, cue: "draw" }, { points: square }],
    });
    const exported = serializeSliceMap(parsed.slices);
    const again = parseSliceMap(exported);

    expect(again.errors).toEqual([]);
    expect(again.slices).toEqual(parsed.slices);
  });

  it("imports one scene out of a multi-image bundle by file name", () => {
    const bundle = {
      schema: "cutline.slice-map/1",
      images: [
        { image: 1, file: "scene-01.png", slices: [{ points: square }] },
        {
          image: 2,
          file: "scene-02.png",
          slices: [{ points: square }, { points: square.map(([x, y]) => ({ x: (x ?? 0) + 0.5, y })) }],
        },
      ],
    };

    const picked = parseSliceMap(bundle, { fileName: "scene-02.png" });
    expect(picked.errors).toEqual([]);
    expect(picked.slices).toHaveLength(2);
    expect(picked.warnings.map((issue) => issue.message).join(" ")).toContain("2 images");

    const fallback = parseSliceMap(bundle, { fileName: "not-here.png" });
    expect(fallback.slices).toHaveLength(1);
  });

  it("parses every image in a bundle so one paste can cover the timeline", () => {
    const bundle = {
      schema: "cutline.slice-map/1",
      space: "normalized",
      images: [
        { image: 2, file: "scene-02.png", scene: "the meal", slices: [{ points: square, cue: "two" }] },
        {
          image: 1,
          file: "scene-01.png",
          slices: [{ points: square }, { points: square }],
        },
      ],
    };

    const result = parseSliceMapBundle(bundle);

    expect(result.errors).toEqual([]);
    expect(result.images.map((image) => image.file)).toEqual(["scene-02.png", "scene-01.png"]);
    expect(result.images.map((image) => image.image)).toEqual([2, 1]);
    expect(result.images.map((image) => image.slices.length)).toEqual([1, 2]);
    expect(result.images[0]?.scene).toBe("the meal");
    expect(result.images[0]?.slices[0]?.cue).toBe("two");
  });

  it("names the broken image instead of half-importing a bundle", () => {
    const result = parseSliceMapBundle({
      images: [
        { image: 1, file: "good.png", slices: [{ points: square }] },
        { image: 2, file: "bad.png", slices: [{ points: [[0, 0], [1, 1]] }] },
      ],
    });

    expect(result.images[1]?.errors[0]?.path).toContain("points");
    expect(result.errors[0]?.path).toContain("images[1]");
  });

  it("treats a single-image map as a bundle of one", () => {
    const result = parseSliceMapBundle({ slices: [{ points: square }] });
    expect(result.errors).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.slices).toHaveLength(1);
  });

  it("exports the image, slice numbers and trigger phrases", () => {
    const points = square.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 }));
    const map = JSON.parse(
      serializeSliceMap(
        [
          { order: 2, number: 7, cue: "ask what you can do", points },
          { order: 1, number: 3, points },
        ],
        { image: 4, file: "storyboard.png" },
      ),
    );

    expect(map.schema).toBe("cutline.slice-map/1");
    expect(map.images[0].image).toBe(4);
    expect(map.images[0].file).toBe("storyboard.png");
    expect(map.images[0].slices).toEqual([
      {
        number: 3,
        order: 1,
        points: [
          [0.1, 0.1],
          [0.4, 0.1],
          [0.4, 0.4],
          [0.1, 0.4],
        ],
      },
      {
        number: 7,
        order: 2,
        cue: "ask what you can do",
        points: [
          [0.1, 0.1],
          [0.4, 0.1],
          [0.4, 0.4],
          [0.1, 0.4],
        ],
      },
    ]);
  });

  it("exports every image in one bundle that re-imports unchanged", () => {
    const points = square.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 }));
    const text = serializeSliceMapProject([
      {
        image: 2,
        file: "scene-02.png",
        slices: [{ order: 1, number: 1, cue: "the meal", points }],
      },
      {
        image: 1,
        file: "scene-01.png",
        slices: [
          { order: 2, number: 2, cue: "the bully", points },
          { order: 1, number: 1, points },
        ],
      },
    ]);

    const parsed = parseSliceMapBundle(text);

    expect(parsed.errors).toEqual([]);
    expect(parsed.images.map((image) => [image.image, image.file])).toEqual([
      [2, "scene-02.png"],
      [1, "scene-01.png"],
    ]);
    expect(parsed.images[1]?.slices.map((slice) => [slice.number, slice.order, slice.cue])).toEqual([
      [1, 1, undefined],
      [2, 2, "the bully"],
    ]);
  });
});
