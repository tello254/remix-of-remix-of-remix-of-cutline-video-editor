import { describe, expect, it } from "vitest";

import {
  MIN_POLYGON_AREA,
  ensureMinimumPoints,
  isSelfIntersecting,
  movePoint,
  polygonArea,
  samePoints,
  translatePoints,
  type SliceGeometryPoint,
} from "@/lib/slice-geometry";

const rect = (x: number, y: number, w: number, h: number): SliceGeometryPoint[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const square = rect(0.1, 0.1, 0.3, 0.3);

describe("ensureMinimumPoints", () => {
  it("adds the midpoint of the longest edge and changes no pixel", () => {
    const before = polygonArea(square);
    const { points, added } = ensureMinimumPoints(square);

    expect(added).toBe(1);
    expect(points).toHaveLength(5);
    expect(points[1]).toEqual({ x: 0.25, y: 0.1 });
    // The midpoint lies exactly on the edge, so the area is untouched.
    expect(polygonArea(points)).toBeCloseTo(before, 12);
  });

  it("keeps adding until the border reaches the minimum", () => {
    const triangle: SliceGeometryPoint[] = [
      { x: 0.1, y: 0.1 },
      { x: 0.6, y: 0.1 },
      { x: 0.35, y: 0.5 },
    ];
    const { points, added } = ensureMinimumPoints(triangle);

    expect(added).toBe(2);
    expect(points).toHaveLength(5);
    expect(polygonArea(points)).toBeCloseTo(polygonArea(triangle), 12);
    expect(isSelfIntersecting(points)).toBe(false);
  });

  it("leaves a border that already has enough points unchanged", () => {
    const five = ensureMinimumPoints(square).points;
    const again = ensureMinimumPoints(five);

    expect(again.added).toBe(0);
    expect(again.points).toEqual(five);
  });

  it("is deterministic on ties", () => {
    const first = ensureMinimumPoints(square);
    const second = ensureMinimumPoints(square);
    expect(first.points).toEqual(second.points);
  });

  it("keeps the original order of the existing points", () => {
    const { points } = ensureMinimumPoints(square);
    expect(points.filter((_, index) => index !== 1)).toEqual(square);
  });
});

describe("translatePoints", () => {
  it("moves the whole border without distorting it", () => {
    const moved = translatePoints(square, 0.1, 0.2);

    expect(moved[0]?.x).toBeCloseTo(0.2, 12);
    expect(moved[0]?.y).toBeCloseTo(0.3, 12);
    expect(polygonArea(moved)).toBeCloseTo(polygonArea(square), 12);
  });

  it("stops at the image edge instead of letting a corner fall outside", () => {
    const moved = translatePoints(square, 0.9, -1);

    expect(moved[2]?.x).toBeCloseTo(1, 12);
    expect(moved[0]?.y).toBeCloseTo(0, 12);
    // Translated, not squashed: every point moved by the same delta.
    const dx = (moved[0]?.x ?? 0) - (square[0]?.x ?? 0);
    moved.forEach((point, index) => {
      expect(point.x - (square[index]?.x ?? 0)).toBeCloseTo(dx, 12);
    });
  });
});

describe("movePoint", () => {
  it("moves one corner and leaves the others where they were", () => {
    const border = ensureMinimumPoints(square).points;
    const outcome = movePoint(border, 2, { x: 0.45, y: 0.4 });

    expect(outcome.moved).toBe(true);
    expect(outcome.points[2]).toEqual({ x: 0.45, y: 0.4 });
    expect(outcome.points[0]).toEqual(border[0]);
    expect(outcome.points).toHaveLength(5);
  });

  it("refuses a drag that would make the border cross itself", () => {
    const border = ensureMinimumPoints(square).points;
    // Pulling the top-right corner down through the bottom edge folds the outline.
    const outcome = movePoint(border, 2, { x: 0.35, y: 0.5 });

    expect(outcome.moved).toBe(false);
    expect(outcome.blocked).toBe("crossing");
    expect(outcome.points).toBe(border);
  });

  it("refuses a drag that would flatten it below a paintable area", () => {
    // A thin triangle just above the floor of paintable area, with two corners
    // sitting on its straight edges so it already has five points.
    const border: SliceGeometryPoint[] = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 1, y: 0 },
      { x: 0.75, y: 0.0002 },
      { x: 0.5, y: 0.0004 },
    ];
    expect(polygonArea(border)).toBeCloseTo(0.0002, 12);
    expect(polygonArea(border)).toBeGreaterThan(MIN_POLYGON_AREA);

    // Lowering the apex leaves a simple outline that covers too little to paint.
    const outcome = movePoint(border, 4, { x: 0.5, y: 0.0001 });

    expect(outcome.moved).toBe(false);
    expect(outcome.blocked).toBe("flat");
  });

  it("clamps the point to the image", () => {
    const border = ensureMinimumPoints(square).points;
    const outcome = movePoint(border, 2, { x: 2, y: -1 });

    expect(outcome.moved).toBe(true);
    expect(outcome.points[2]).toEqual({ x: 1, y: 0 });
  });

  it("ignores an index that is not on the border", () => {
    const outcome = movePoint(square, 9, { x: 0.5, y: 0.5 });
    expect(outcome.moved).toBe(false);
    expect(outcome.points).toBe(square);
  });
});

describe("samePoints", () => {
  it("compares position by position", () => {
    expect(samePoints(square, square.map((point) => ({ ...point })))).toBe(true);
    expect(samePoints(square, [...square].reverse())).toBe(false);
    expect(samePoints(square, square.slice(1))).toBe(false);
  });
});
