/**
 * Slice maps: the bridge between an image authored elsewhere and the slicer.
 *
 * A model (or an annotation tool) emits polygons around the parts of a picture
 * that should appear one at a time. This module is the only place that decides
 * whether such a map is usable. It is deliberately strict: a map either turns
 * into every slice it described, or it is rejected with reasons. Nothing is
 * clamped, dropped, or reordered silently, because a quietly moved polygon
 * produces a video that is wrong in a way nobody can see while editing.
 *
 * Coordinates are normalised to the image (0–1, origin top-left) unless a slice
 * explicitly declares pixel space together with the image's dimensions.
 */

import {
  MIN_POLYGON_AREA,
  MIN_SLICE_POINTS,
  ensureMinimumPoints,
  isSelfIntersecting,
  signedPolygonArea,
  type SliceGeometryPoint,
} from "@/lib/slice-geometry";

export type SliceMapPoint = SliceGeometryPoint;

/** Re-exported so callers validating their own geometry share one rule. */
export { isSelfIntersecting };

export type SliceMapSpace = "normalized" | "pixels";

/** The one schema string Cutline writes and ChatGPT is asked to produce. */
export const SLICE_MAP_SCHEMA = "cutline.slice-map/1";

export type ParsedSlice = {
  /** 1-based animation position, always a contiguous 1..N. */
  order: number;
  /** Permanent slice label, kept apart from `order` so reordering is reversible. */
  number: number;
  /** Optional narration phrase; the scheduler turns it into a time later. */
  cue?: string;
  points: SliceMapPoint[];
};

/** A single rejection or warning, addressed so the UI can point at the field. */
export type SliceMapIssue = { path: string; message: string };

export type SliceMapReport = {
  slices: ParsedSlice[];
  errors: SliceMapIssue[];
  warnings: SliceMapIssue[];
  /** The space the map was authored in, after defaults were applied. */
  space: SliceMapSpace;
  /**
   * Share of the image covered by at least one slice (0–1). Sampled on a grid,
   * so it is a review figure rather than an exact geometric area.
   */
  coverage: number;
};

export type ParseSliceMapOptions = {
  /** Used when neither the map nor a slice declares a space. */
  defaultSpace?: SliceMapSpace;
  /**
   * The image being sliced. A bundle that describes several images is matched
   * on its `file`/`name`, so pasting the whole bundle imports the right scene
   * instead of whichever one happened to be first.
   */
  fileName?: string | undefined;
};

const EPSILON = 1e-9;
/** Grid resolution used to estimate how much of the picture is sliced. */
const COVERAGE_GRID = 128;
/** Fields a model tends to invent; Cutline measures all of these itself. */
const TIMING_KEYS = [
  "start",
  "startSeconds",
  "intendedStart",
  "duration",
  "durationSeconds",
  "animation",
  "hold",
  "lag",
  "timing",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositive(value: unknown): number | null {
  const number = asNumber(value);
  return number !== null && number > 0 ? number : null;
}

function readSpace(value: unknown): SliceMapSpace | null {
  if (value === undefined || value === null) return null;
  if (value === "normalized" || value === "norm") return "normalized";
  if (value === "pixels" || value === "pixel" || value === "px") return "pixels";
  return null;
}

type PointRead = { points: SliceMapPoint[] } | { error: string };

function readPoints(raw: unknown): PointRead {
  if (!Array.isArray(raw)) return { error: "points must be an array" };
  if (raw.length < 3) return { error: `needs at least 3 points, found ${raw.length}` };

  const points: SliceMapPoint[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    let x: number | null = null;
    let y: number | null = null;

    if (Array.isArray(entry)) {
      x = asNumber(entry[0]);
      y = asNumber(entry[1]);
    } else if (isRecord(entry)) {
      x = asNumber(entry["x"]);
      y = asNumber(entry["y"]);
    }

    if (x === null || y === null) {
      return { error: `point ${index + 1} is not a pair of numbers` };
    }
    points.push({ x, y });
  }
  return { points };
}

/** Even-odd containment test, used only for the coverage estimate. */
function pointInPolygon(x: number, y: number, points: SliceMapPoint[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > y !== b.y > y) {
      const crossing = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < crossing) inside = !inside;
    }
  }
  return inside;
}

function coveredFraction(slices: ParsedSlice[]) {
  if (!slices.length) return 0;
  let hits = 0;
  for (let row = 0; row < COVERAGE_GRID; row += 1) {
    const y = (row + 0.5) / COVERAGE_GRID;
    for (let column = 0; column < COVERAGE_GRID; column += 1) {
      const x = (column + 0.5) / COVERAGE_GRID;
      if (slices.some((slice) => pointInPolygon(x, y, slice.points))) hits += 1;
    }
  }
  return hits / (COVERAGE_GRID * COVERAGE_GRID);
}

/**
 * The slice list inside one entry, under any of the names accepted so far.
 * `beats` comes from a video bundle, while `slices` is what Cutline writes.
 */
function sliceListOf(entry: unknown): unknown {
  if (!isRecord(entry)) return undefined;
  return entry["slices"] ?? entry["regions"] ?? entry["beats"];
}

/** Compares image names by their file part, ignoring case and folders. */
function sameFileName(candidate: unknown, wanted: string) {
  if (typeof candidate !== "string") return false;
  const normalise = (value: string) => value.trim().toLowerCase().replace(/^.*[\\/]/, "");
  return normalise(candidate) === normalise(wanted);
}

/**
 * Parses a slice map and returns either every slice or every reason it was
 * rejected. The result is atomic on purpose: a partial import would look like
 * success while leaving some regions permanently unpainted.
 */
export function parseSliceMap(
  input: string | unknown,
  options?: ParseSliceMapOptions,
): SliceMapReport {
  const errors: SliceMapIssue[] = [];
  const warnings: SliceMapIssue[] = [];
  const empty = (space: SliceMapSpace): SliceMapReport => ({
    slices: [],
    errors,
    warnings,
    space,
    coverage: 0,
  });

  let value: unknown = input;
  if (typeof input === "string") {
    if (!input.trim()) {
      errors.push({ path: "map", message: "The slice map is empty." });
      return empty(options?.defaultSpace ?? "normalized");
    }
    try {
      value = JSON.parse(input);
    } catch (error) {
      errors.push({
        path: "map",
        message: `That is not valid JSON: ${
          error instanceof Error ? error.message : "parse failed"
        }`,
      });
      return empty(options?.defaultSpace ?? "normalized");
    }
  }

  let root: Record<string, unknown> | null = null;
  /** The image/scene entry that owns the slices, when the map is a bundle. */
  let container: Record<string, unknown> | null = null;
  let rawSlices: unknown;
  if (Array.isArray(value)) {
    rawSlices = value;
  } else if (isRecord(value)) {
    root = value;
    rawSlices = sliceListOf(value);

    // A bundle of images is what the master prompt asks a model to produce:
    // { schema, images: [{ file, scene, slices }] }. Import the entry for the
    // image that is open, so a whole-project map can be pasted scene by scene.
    const images = value["images"];
    if (rawSlices === undefined && Array.isArray(images)) {
      const described = images.filter((entry) => Array.isArray(sliceListOf(entry)));
      const wanted = options?.fileName;
      const selected = wanted
        ? (described.find((entry) => sameFileName(entry["file"] ?? entry["name"], wanted)) ??
          described[0])
        : described[0];
      if (selected) {
        container = selected;
        rawSlices = sliceListOf(selected);
      }
      if (described.length > 1) {
        const label =
          selected && typeof (selected["file"] ?? selected["name"]) === "string"
            ? String(selected["file"] ?? selected["name"])
            : "the first image";
        warnings.push({
          path: "images",
          message: `This map describes ${described.length} images; imported the slices for ${label}.`,
        });
      }
    }

    if (rawSlices === undefined && Array.isArray(value["scenes"])) {
      const scene = value["scenes"].find((entry) => Array.isArray(sliceListOf(entry)));
      if (isRecord(scene)) {
        container = scene;
        rawSlices = sliceListOf(scene);
      }
    }

    if (rawSlices === undefined && isRecord(value["scene"])) {
      container = value["scene"];
      rawSlices = sliceListOf(container);
    }
  } else {
    errors.push({
      path: "map",
      message:
        "Expected an object with a `slices` array, or a bare array of slices. A bundle with `images` works too.",
    });
    return empty(options?.defaultSpace ?? "normalized");
  }

  if (!Array.isArray(rawSlices)) {
    errors.push({ path: "slices", message: "The slice map needs a `slices` array." });
    return empty(options?.defaultSpace ?? "normalized");
  }
  if (rawSlices.length === 0) {
    errors.push({ path: "slices", message: "The slice map contains no slices." });
    return empty(options?.defaultSpace ?? "normalized");
  }

  // Space and pixel size may live on the bundle, the chosen image, or a slice.
  const meta = container ?? root;
  const rootSpace = readSpace(meta?.["space"]) ?? readSpace(root?.["space"]);
  if (meta && meta["space"] !== undefined && rootSpace === null) {
    warnings.push({
      path: "space",
      message: `Unknown space "${String(meta["space"])}"; using ${
        options?.defaultSpace ?? "normalized"
      }.`,
    });
  }
  const space = rootSpace ?? options?.defaultSpace ?? "normalized";
  const rootWidth = readPositive(meta?.["width"]) ?? readPositive(root?.["width"]);
  const rootHeight = readPositive(meta?.["height"]) ?? readPositive(root?.["height"]);

  const seenOrders = new Set<number>();
  const seenNumbers = new Set<number>();
  const parsed: {
    order: number;
    number?: number | undefined;
    cue?: string | undefined;
    points: SliceMapPoint[];
  }[] = [];

  rawSlices.forEach((entry, index) => {
    const path = `slices[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ path, message: "expected an object." });
      return;
    }

    for (const key of TIMING_KEYS) {
      if (entry[key] !== undefined) {
        warnings.push({
          path: `${path}.${key}`,
          message: `"${key}" is ignored — Cutline measures timing from the narration.`,
        });
      }
    }

    const sliceSpace = readSpace(entry["space"]) ?? space;
    const width = readPositive(entry["width"]) ?? rootWidth;
    const height = readPositive(entry["height"]) ?? rootHeight;

    const read = readPoints(entry["points"] ?? entry["polygon"]);
    if ("error" in read) {
      errors.push({ path: `${path}.points`, message: `${read.error}.` });
      return;
    }

    let points = read.points;
    if (sliceSpace === "pixels") {
      if (width === null || height === null) {
        errors.push({
          path: `${path}.points`,
          message: 'pixel coordinates need "width" and "height" on the slice or the map.',
        });
        return;
      }
      points = points.map((point) => ({ x: point.x / width, y: point.y / height }));
    } else {
      const outside = points.some(
        (point) =>
          point.x < -EPSILON ||
          point.x > 1 + EPSILON ||
          point.y < -EPSILON ||
          point.y > 1 + EPSILON,
      );
      if (outside) {
        const looksLikePercent = points.some(
          (point) => Math.abs(point.x) > 1 + EPSILON || Math.abs(point.y) > 1 + EPSILON,
        );
        errors.push({
          path: `${path}.points`,
          message: `coordinates must be 0–1.${
            looksLikePercent ? " These look like percentages — divide by 100." : ""
          }`,
        });
        return;
      }
    }

    const area = Math.abs(signedPolygonArea(points));
    if (isSelfIntersecting(points)) {
      // A crossed border still paints (the engine fills it even-odd), and a
      // freehand stroke can easily double back on itself. Rejecting it would
      // make Cutline's own exported maps impossible to re-import, so this is
      // reported and the user can untangle it with the handles.
      warnings.push({
        path: `${path}.points`,
        message:
          "the polygon's edges cross themselves, so it paints with a gap — drag the handles to untangle it.",
      });
    }
    if (area < MIN_POLYGON_AREA) {
      errors.push({
        path: `${path}.points`,
        message: `the polygon is too thin or flat to paint (area ${area.toFixed(5)}).`,
      });
      return;
    }

    // A border the user can only look at is a border they cannot fix. Fewer
    // corners than the editing minimum are topped up on their longest edges,
    // which adds handles without moving a single edge.
    const topped = ensureMinimumPoints(points);
    if (topped.added > 0) {
      warnings.push({
        path: `${path}.points`,
        message: `added ${topped.added} point${topped.added === 1 ? "" : "s"} on the longest edge${
          topped.added === 1 ? "" : "s"
        } so this border has ${MIN_SLICE_POINTS} draggable points — the shape is unchanged.`,
      });
      points = topped.points;
    }

    const rawOrder = entry["order"] ?? entry["position"];
    let order = 0;
    if (rawOrder !== undefined && rawOrder !== null) {
      const number = asNumber(rawOrder);
      if (number === null || !Number.isInteger(number) || number < 1) {
        errors.push({
          path: `${path}.order`,
          message: '"order" must be a whole number starting at 1.',
        });
        return;
      }
      if (seenOrders.has(number)) {
        errors.push({
          path: `${path}.order`,
          message: `order ${number} is used by another slice.`,
        });
        return;
      }
      seenOrders.add(number);
      order = number;
    }

    const rawCue = entry["cue"] ?? entry["trigger"] ?? entry["phrase"];
    let cue: string | undefined;
    if (rawCue !== undefined && rawCue !== null) {
      if (typeof rawCue !== "string") {
        errors.push({ path: `${path}.cue`, message: '"cue" must be text.' });
        return;
      }
      cue = rawCue.replace(/\s+/g, " ").trim() || undefined;
    }

    // `number` is the slice's permanent label, separate from its play order.
    // Honouring it makes an exported-then-reimported map keep the same names.
    const rawNumber = entry["number"] ?? entry["sliceNumber"];
    let number: number | undefined;
    if (rawNumber !== undefined && rawNumber !== null) {
      const value = asNumber(rawNumber);
      if (value === null || !Number.isInteger(value) || value < 1) {
        warnings.push({
          path: `${path}.number`,
          message: '"number" must be a whole number starting at 1; using the list position instead.',
        });
      } else if (seenNumbers.has(value)) {
        warnings.push({
          path: `${path}.number`,
          message: `slice number ${value} appears twice; using the list position for this one.`,
        });
      } else {
        seenNumbers.add(value);
        number = value;
      }
    }

    parsed.push({ order: order || index + 1, number, cue, points });
  });

  if (errors.length) return empty(space);

  const explicitOrders = parsed.filter((slice) => seenOrders.has(slice.order));
  if (explicitOrders.length && explicitOrders.length !== parsed.length) {
    warnings.push({
      path: "slices",
      message: "Only some slices had an order; the rest keep the file's own order.",
    });
  }

  // Compact whatever came in into a contiguous 1..N while keeping the relative
  // order the author chose. This is where "order 10, 20, 30" becomes 1, 2, 3.
  const ordered = [...parsed].sort((a, b) => a.order - b.order);
  const slices = ordered.map((slice, index) => ({
    order: index + 1,
    number: slice.number ?? index + 1,
    ...(slice.cue ? { cue: slice.cue } : {}),
    points: slice.points,
  }));

  if (ordered.some((slice, index) => slice.order !== index + 1)) {
    warnings.push({
      path: "slices",
      message: `Orders were compacted to 1–${slices.length}.`,
    });
  }

  return { slices, errors, warnings, space, coverage: coveredFraction(slices) };
}

export type SerializeSliceMapOptions = {
  pretty?: boolean;
  /** 1-based play position of this image on the timeline. */
  image?: number | undefined;
  /** The image's file or library name. */
  file?: string | undefined;
  /** One line describing the scene, when the caller has one. */
  scene?: string | undefined;
};

/**
 * The inverse of `parseSliceMap`, in the same bundle shape the master prompt
 * asks a model to write:
 *
 *   { schema, space, images: [{ image, file, slices: [{ number, order, cue, points }] }] }
 *
 * Everything the manual workflow decided is preserved — the borders and their
 * points, which slice is which, the play order, and the trigger phrase — so the
 * work can be handed to another image, another chat, or back into Cutline.
 * Timing is still intentionally absent: it belongs to the audio.
 */
export function serializeSliceMap(
  slices: {
    order: number;
    number?: number | undefined;
    cue?: string | undefined;
    points: SliceMapPoint[];
  }[],
  options?: SerializeSliceMapOptions,
) {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  const ordered = [...slices].sort((a, b) => a.order - b.order);
  const map = {
    schema: SLICE_MAP_SCHEMA,
    space: "normalized" as const,
    images: [
      {
        ...(options?.image ? { image: options.image } : {}),
        ...(options?.file ? { file: options.file } : {}),
        ...(options?.scene ? { scene: options.scene } : {}),
        slices: ordered.map((slice, index) => ({
          number: slice.number ?? index + 1,
          order: slice.order,
          ...(slice.cue ? { cue: slice.cue } : {}),
          points: slice.points.map((point) => [round(point.x), round(point.y)]),
        })),
      },
    ],
  };
  return JSON.stringify(map, null, options?.pretty === false ? 0 : 2);
}
