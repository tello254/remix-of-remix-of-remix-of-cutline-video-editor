/**
 * Reads slice borders authored outside the editor.
 *
 * The whiteboard engine paints each slice by clipping the image to a polygon,
 * so the only thing a slice map has to provide is geometry plus intent: which
 * polygon, in what order, triggered by which words. It never carries time —
 * seconds come from the narration, not from the model that drew the map.
 *
 * Parsing is deliberately strict. A coordinate outside the image, a polygon
 * with two points, or a self-intersecting border is reported with the path that
 * caused it and the whole map is rejected. Clamping bad geometry would silently
 * paint the wrong part of the picture, which is worse than refusing the import.
 */

export const SLICE_MAP_SCHEMA = "cutline.slice-map/1";

export type SliceMapPoint = { x: number; y: number };

export type SliceMapSlice = {
  /** Polygon in image space, normalised to 0..1. */
  points: SliceMapPoint[];
  /** 1-based position in the animation sequence. */
  order: number;
  /** Words that should start this reveal, copied from the script. */
  cue?: string | undefined;
};

export type SliceMapIssue = {
  /** JSON-ish path, e.g. `slices[2].points`. */
  path: string;
  message: string;
};

export type SliceMapOverlap = { a: number; b: number };

export type SliceMapReport = {
  slices: SliceMapSlice[];
  errors: SliceMapIssue[];
  warnings: SliceMapIssue[];
  /** Fraction of the image covered by at least one slice, 0..1. */
  coverage: number;
  /** Pairs of slice numbers whose areas overlap. */
  overlaps: SliceMapOverlap[];
};

export type ParseSliceMapOptions = {
  /** How bare coordinates should be read. Defaults to `normalized`. */
  space?: "normalized" | "pixels";
  width?: number;
  height?: number;
};

const EPSILON = 1e-6;
/** 0.01% of the image. Smaller than this is a click, not a region. */
const MIN_AREA = 1e-4;
const GRID_COLUMNS = 64;
const GRID_ROWS = 36;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function issue(path: string, message: string): SliceMapIssue {
  return { path, message };
}

/** Accepts a bare array, `{ slices }`, `{ beats }`, or a single scene of a bundle. */
function extractEntries(input: unknown): { entries: unknown[]; path: string } | null {
  if (Array.isArray(input)) return { entries: input, path: "$" };
  const root = asRecord(input);
  if (!root) return null;

  if (Array.isArray(root["slices"])) return { entries: root["slices"], path: "$.slices" };
  if (Array.isArray(root["beats"])) return { entries: root["beats"], path: "$.beats" };

  const scenes = root["scenes"];
  if (Array.isArray(scenes)) {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = asRecord(scenes[index]);
      if (!scene) continue;
      const inner = Array.isArray(scene["beats"]) ? scene["beats"] : scene["slices"];
      if (Array.isArray(inner)) return { entries: inner, path: `$.scenes[${index}]` };
    }
  }

  const scene = asRecord(root["scene"]);
  if (scene) {
    const inner = Array.isArray(scene["beats"]) ? scene["beats"] : scene["slices"];
    if (Array.isArray(inner)) return { entries: inner, path: "$.scene" };
  }

  return null;
}

function readPoint(raw: unknown): SliceMapPoint | null {
  if (Array.isArray(raw)) {
    const x = raw[0];
    const y = raw[1];
    return typeof x === "number" && typeof y === "number" ? { x, y } : null;
  }
  const record = asRecord(raw);
  if (!record) return null;
  const x = record["x"];
  const y = record["y"];
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

function areaOf(points: SliceMapPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

function orientation(a: SliceMapPoint, b: SliceMapPoint, c: SliceMapPoint) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True for a proper crossing; touching corners are tolerated. */
function segmentsCross(a: SliceMapPoint, b: SliceMapPoint, c: SliceMapPoint, d: SliceMapPoint) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return (
    ((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON)) &&
    ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON))
  );
}

function selfIntersects(points: SliceMapPoint[]): boolean {
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % count]!;
    for (let j = i + 1; j < count; j += 1) {
      // Adjacent edges share a corner by design, and so do the first and last.
      if (j === i || j === (i + 1) % count || (i === 0 && j === count - 1)) continue;
      const c = points[j]!;
      const d = points[(j + 1) % count]!;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function insidePolygon(points: SliceMapPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!;
    const b = points[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function measure(slices: SliceMapSlice[]) {
  const cells = GRID_COLUMNS * GRID_ROWS;
  let covered = 0;
  const overlaps = new Map<string, SliceMapOverlap>();

  if (!slices.length) return { coverage: 0, overlaps: [] };

  for (let row = 0; row < GRID_ROWS; row += 1) {
    const y = (row + 0.5) / GRID_ROWS;
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x = (column + 0.5) / GRID_COLUMNS;
      const hits: number[] = [];
      for (let index = 0; index < slices.length; index += 1) {
        if (insidePolygon(slices[index]!.points, x, y)) hits.push(index + 1);
      }
      if (hits.length) covered += 1;
      for (let i = 0; i < hits.length; i += 1) {
        for (let j = i + 1; j < hits.length; j += 1) {
          const a = hits[i]!;
          const b = hits[j]!;
          overlaps.set(`${a}-${b}`, { a, b });
        }
      }
    }
  }

  return {
    coverage: covered / cells,
    overlaps: [...overlaps.values()].sort((left, right) => left.a - right.a || left.b - right.b),
  };
}

/**
 * Parses a slice map. Geometry errors empty `slices`, so a caller can decide to
 * import nothing rather than half a picture. Warnings never block.
 */
export function parseSliceMap(
  input: unknown,
  options?: ParseSliceMapOptions,
): SliceMapReport {
  const errors: SliceMapIssue[] = [];
  const warnings: SliceMapIssue[] = [];

  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      errors.push(issue("$", "This is not valid JSON."));
      return { slices: [], errors, warnings, coverage: 0, overlaps: [] };
    }
  }

  const extracted = extractEntries(raw);
  if (!extracted) {
    errors.push(
      issue("$", "Expected a list of slices, or an object with `slices`, `beats` or `scenes`."),
    );
    return { slices: [], errors, warnings, coverage: 0, overlaps: [] };
  }

  const slices: SliceMapSlice[] = [];
  const usedOrders = new Set<number>();

  const claimOrder = (preferred: number) => {
    let order = Math.max(1, Math.round(preferred));
    while (usedOrders.has(order)) order += 1;
    usedOrders.add(order);
    return order;
  };

  extracted.entries.forEach((entry, index) => {
    const path = `${extracted.path}[${index}]`;
    const record = asRecord(entry);
    if (!record) {
      errors.push(issue(path, "Each slice must be an object."));
      return;
    }

    const holder = asRecord(record["slice"]) ?? record;
    const rawPoints = holder["points"] ?? record["points"];
    if (!Array.isArray(rawPoints)) {
      errors.push(issue(`${path}.points`, "Missing a `points` array."));
      return;
    }

    const space =
      (holder["space"] as string | undefined) ??
      (record["space"] as string | undefined) ??
      options?.space ??
      "normalized";
    if (space !== "normalized" && space !== "pixels") {
      errors.push(issue(`${path}.space`, 'Use `"normalized"` or `"pixels"`.'));
      return;
    }

    const width = Number(holder["width"] ?? record["width"] ?? options?.width);
    const height = Number(holder["height"] ?? record["height"] ?? options?.height);
    if (space === "pixels" && !(width > 0 && height > 0)) {
      errors.push(
        issue(
          `${path}.points`,
          "Pixel coordinates need the image size: add `width` and `height` next to the points.",
        ),
      );
      return;
    }

    const points: SliceMapPoint[] = [];
    let pointError = false;
    rawPoints.forEach((rawPoint, pointIndex) => {
      const point = readPoint(rawPoint);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        errors.push(
          issue(
            `${path}.points[${pointIndex}]`,
            "Use `[x, y]` or `{ \"x\": number, \"y\": number }`.",
          ),
        );
        pointError = true;
        return;
      }
      const x = space === "pixels" ? point.x / width : point.x;
      const y = space === "pixels" ? point.y / height : point.y;
      if (x < -EPSILON || x > 1 + EPSILON || y < -EPSILON || y > 1 + EPSILON) {
        errors.push(
          issue(
            `${path}.points[${pointIndex}]`,
            space === "pixels"
              ? `Point (${point.x}, ${point.y}) is outside the ${width}×${height} image.`
              : `Point (${point.x}, ${point.y}) must be between 0 and 1; scale it, or set "space": "pixels" with width and height.`,
          ),
        );
        pointError = true;
        return;
      }
      const previous = points[points.length - 1];
      const clamped = {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      };
      if (previous && Math.hypot(previous.x - clamped.x, previous.y - clamped.y) < EPSILON) {
        warnings.push(issue(`${path}.points[${pointIndex}]`, "Duplicate point skipped."));
        return;
      }
      points.push(clamped);
    });
    if (pointError) return;

    if (points.length >= 2) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      if (Math.hypot(first.x - last.x, first.y - last.y) < EPSILON) points.pop();
    }

    if (points.length < 3) {
      errors.push(issue(`${path}.points`, "A slice needs at least three corners."));
      return;
    }
    // A bowtie has two lobes whose signed areas cancel, so this has to run
    // before the area check or it reads as "no visible area" instead.
    if (selfIntersects(points)) {
      errors.push(
        issue(`${path}.points`, "This border crosses itself; draw one simple polygon."),
      );
      return;
    }
    if (areaOf(points) < MIN_AREA) {
      errors.push(issue(`${path}.points`, "This polygon has no visible area."));
      return;
    }

    const rawOrder = record["order"] ?? holder["order"];
    const preferred =
      typeof rawOrder === "number" && Number.isFinite(rawOrder) ? rawOrder : index + 1;
    if (typeof rawOrder === "number" && usedOrders.has(Math.max(1, Math.round(rawOrder)))) {
      warnings.push(
        issue(`${path}.order`, `Order ${Math.round(rawOrder)} is already taken; moved to the next free position.`),
      );
    }
    const order = claimOrder(preferred);

    const rawCue = record["cue"] ?? record["trigger"] ?? record["phrase"] ?? holder["cue"];
    const cue = typeof rawCue === "string" ? rawCue.replace(/\s+/g, " ").trim() : "";
    if (cue.length > 120) {
      warnings.push(issue(`${path}.cue`, "A cue longer than 120 characters is hard to match."));
    }

    slices.push({ points, order, ...(cue ? { cue } : {}) });
  });

  if (!slices.length && !errors.length) {
    errors.push(issue(extracted.path, "The map does not contain any slices."));
  }

  // All or nothing: importing the good half of a map would leave the image
  // painted in a shape nobody asked for. Callers check `errors` first anyway.
  const accepted = errors.length ? [] : slices;
  const { coverage, overlaps } = measure(accepted);
  if (slices.length && coverage < 0.5) {
    warnings.push(
      issue(
        "$",
        `These slices cover ${Math.round(coverage * 100)}% of the image; the rest is never drawn.`,
      ),
    );
  }
  for (const overlap of overlaps) {
    warnings.push(
      issue("$", `Slices ${overlap.a} and ${overlap.b} overlap; both will paint the same pixels.`),
    );
  }

  return { slices: accepted, errors, warnings, coverage, overlaps };
}

/** Writes the current slices back out in the same shape the parser accepts. */
export function serializeSliceMap(
  slices: { points: SliceMapPoint[]; order?: number; cue?: string | undefined }[],
): string {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return JSON.stringify(
    {
      schema: SLICE_MAP_SCHEMA,
      slices: slices.map((slice, index) => ({
        number: index + 1,
        order: slice.order ?? index + 1,
        ...(slice.cue ? { cue: slice.cue } : {}),
        points: slice.points.map((point) => [round(point.x), round(point.y)]),
      })),
    },
    null,
    2,
  );
}
