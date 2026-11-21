/**
 * Geometry of a slice border.
 *
 * A slice is the shape the hand paints inside, so its border has to be editable
 * after it exists: a border authored from JSON describes where an object was
 * *supposed* to be, and the picture is the only authority on where it actually
 * is. Two rules keep that editing safe:
 *
 *  - a slice always has at least `MIN_SLICE_POINTS` corners. A four-corner box
 *    offers nowhere to grab when a drawing is not a box, so fewer corners are
 *    topped up by inserting points on the longest edges — the covered pixels do
 *    not change, only the number of handles;
 *  - a border never crosses itself. A bow-tie polygon paints unpredictably, so
 *    a drag that would fold the outline is refused instead of applied.
 *
 * Everything here is pure and deterministic: the same points and the same drag
 * always produce the same border.
 */

export type SliceGeometryPoint = { x: number; y: number };

/** Fewest corners a slice may have, and therefore the fewest handles it shows. */
export const MIN_SLICE_POINTS = 5;

/** Smallest polygon we accept, as a fraction of the image's area. */
export const MIN_POLYGON_AREA = 0.0001;

const EPSILON = 1e-9;

export function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampPoint(point: SliceGeometryPoint): SliceGeometryPoint {
  return { x: clampUnit(point.x), y: clampUnit(point.y) };
}

/** Signed area; the sign says which way the border winds. */
export function signedPolygonArea(points: SliceGeometryPoint[]) {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

export function polygonArea(points: SliceGeometryPoint[]) {
  return Math.abs(signedPolygonArea(points));
}

export function polygonBounds(points: SliceGeometryPoint[]) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function samePoints(a: SliceGeometryPoint[], b: SliceGeometryPoint[]) {
  return (
    a.length === b.length &&
    a.every(
      (point, index) =>
        Math.abs(point.x - (b[index]?.x ?? Number.NaN)) < 1e-9 &&
        Math.abs(point.y - (b[index]?.y ?? Number.NaN)) < 1e-9,
    )
  );
}

function orientation(a: SliceGeometryPoint, b: SliceGeometryPoint, c: SliceGeometryPoint) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: SliceGeometryPoint, b: SliceGeometryPoint, c: SliceGeometryPoint) {
  return (
    b.x <= Math.max(a.x, c.x) + EPSILON &&
    b.x >= Math.min(a.x, c.x) - EPSILON &&
    b.y <= Math.max(a.y, c.y) + EPSILON &&
    b.y >= Math.min(a.y, c.y) - EPSILON
  );
}

function segmentsIntersect(
  a: SliceGeometryPoint,
  b: SliceGeometryPoint,
  c: SliceGeometryPoint,
  d: SliceGeometryPoint,
) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/** A bow-tie polygon paints unpredictably; better to refuse it than guess. */
export function isSelfIntersecting(points: SliceGeometryPoint[]) {
  const count = points.length;
  for (let first = 0; first < count; first += 1) {
    const a = points[first]!;
    const b = points[(first + 1) % count]!;
    for (let second = first + 2; second < count; second += 1) {
      // Skip the shared vertex between adjacent edges.
      if ((second + 1) % count === first) continue;
      const c = points[second]!;
      const d = points[(second + 1) % count]!;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Adds corners on the longest edges until the border has `minimum` points.
 *
 * The midpoint of a straight edge lies exactly on that edge, so the outline
 * covers the same pixels it did before; there is simply something to grab when
 * the user needs to pull the border around a part of the drawing that sticks
 * out. Existing points keep their order, and ties go to the earliest edge, so
 * the same input always yields the same border.
 */
export function ensureMinimumPoints(
  points: SliceGeometryPoint[],
  minimum = MIN_SLICE_POINTS,
): { points: SliceGeometryPoint[]; added: number } {
  const next = points.map((point) => ({ x: point.x, y: point.y }));
  if (next.length < 2) return { points: next, added: 0 };

  let added = 0;
  while (next.length < minimum) {
    let longest = 0;
    let longestLength = -1;
    for (let index = 0; index < next.length; index += 1) {
      const a = next[index]!;
      const b = next[(index + 1) % next.length]!;
      const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (length > longestLength) {
        longestLength = length;
        longest = index;
      }
    }
    const a = next[longest]!;
    const b = next[(longest + 1) % next.length]!;
    next.splice(longest + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    added += 1;
  }

  return { points: next, added };
}

/**
 * Moves the whole border by a delta, stopping at the image edge instead of
 * letting any corner leave the picture. The delta is clamped, not each point,
 * so the shape is translated rather than squashed.
 */
export function translatePoints(
  points: SliceGeometryPoint[],
  dx: number,
  dy: number,
): SliceGeometryPoint[] {
  if (!points.length) return [];
  const bounds = polygonBounds(points);
  const safeX = Math.min(1 - bounds.maxX, Math.max(-bounds.minX, dx));
  const safeY = Math.min(1 - bounds.maxY, Math.max(-bounds.minY, dy));
  return points.map((point) => ({ x: point.x + safeX, y: point.y + safeY }));
}

export type PointMoveResult = {
  points: SliceGeometryPoint[];
  moved: boolean;
  /** Why the drag was refused, when it was. */
  blocked?: "crossing" | "flat";
};

/**
 * Moves one corner. A drag that would make the border cross itself or collapse
 * it to nothing is refused, so the last valid border stays on screen and the
 * user can keep pulling.
 */
export function movePoint(
  points: SliceGeometryPoint[],
  index: number,
  next: SliceGeometryPoint,
): PointMoveResult {
  if (index < 0 || index >= points.length) return { points, moved: false };
  const candidate = points.map((point, at) =>
    at === index ? clampPoint(next) : { x: point.x, y: point.y },
  );
  if (isSelfIntersecting(candidate)) return { points, moved: false, blocked: "crossing" };
  if (polygonArea(candidate) < MIN_POLYGON_AREA) return { points, moved: false, blocked: "flat" };
  return { points: candidate, moved: true };
}
