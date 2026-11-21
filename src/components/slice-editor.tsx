import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Check,
  Expand,
  MousePointer2,
  PenLine,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { SlicePoint, SliceShape } from "@/whiteboard/types";
import {
  clampPoint,
  movePoint,
  polygonArea,
  samePoints,
  translatePoints,
} from "@/lib/slice-geometry";
import { serializeSliceMap, type SliceMapReport } from "@/lib/slice-map";
import { resolveSliceTiming } from "@/lib/slice-timing";

type SliceMode = "select" | "rect" | "pen";

type SliceSurfaceProps = {
  src: string;
  slices: SliceShape[];
  selectedId?: string | null;
  mode?: SliceMode;
  interactive?: boolean;
  onSelect?: (id: string | null) => void;
  onCreate?: (points: SlicePoint[]) => void;
  /** Called once when a border drag ends, never on every pixel of the drag. */
  onChangePoints?: (id: string, points: SlicePoint[]) => void;
  className?: string;
};

/** Distance from a point to a line segment, in the surface's pixels. */
function distanceToSegment(point: SlicePoint, a: SlicePoint, b: SlicePoint, w: number, h: number) {
  const ax = a.x * w;
  const ay = a.y * h;
  const bx = b.x * w;
  const by = b.y * h;
  const px = point.x * w;
  const py = point.y * h;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
      : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function rectPoints(a: SlicePoint, b: SlicePoint): SlicePoint[] {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x, b.x);
  const y2 = Math.max(a.y, b.y);
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

/**
 * The image with its slice borders drawn over it. Used read-only inside the
 * CUTS card and interactively inside the slicer dialog, where the user draws
 * rectangles or freehand loops.
 */
export function SliceSurface({
  src,
  slices,
  selectedId = null,
  mode = "select",
  interactive = true,
  onSelect,
  onCreate,
  onChangePoints,
  className,
}: SliceSurfaceProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 16, h: 9 });
  const [rectStart, setRectStart] = useState<SlicePoint | null>(null);
  const [rectCurrent, setRectCurrent] = useState<SlicePoint | null>(null);
  const [draft, setDraft] = useState<SlicePoint[] | null>(null);
  const [preview, setPreview] = useState<{ id: string; points: SlicePoint[] } | null>(null);
  const [blockedVertex, setBlockedVertex] = useState<{ id: string; index: number } | null>(null);
  const shaping = mode === "select" && interactive;

  // The drag is kept in a ref: pointer moves arrive faster than React renders,
  // and every position is computed from where the drag *started*, so a fast
  // drag cannot drift away from the cursor.
  const shapeDrag = useRef<{
    kind: "body" | "vertex";
    id: string;
    index?: number;
    origin: SlicePoint;
    points: SlicePoint[];
    current: SlicePoint[];
  } | null>(null);

  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The photo is letterboxed inside the surface. Points are normalised to the
  // visible photo, not the surface, so a slice lines up in the small CUTS card
  // and in the full-size studio.
  const scale = size.w && size.h ? Math.min(size.w / natural.w, size.h / natural.h) : 0;
  const content = {
    x: (size.w - natural.w * scale) / 2,
    y: (size.h - natural.h * scale) / 2,
    w: natural.w * scale,
    h: natural.h * scale,
  };

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const element = wrapRef.current;
    if (!element) return { x: 0, y: 0 };
    const bounds = element.getBoundingClientRect();
    return clampPoint({
      x: (event.clientX - bounds.left - content.x) / Math.max(1, content.w),
      y: (event.clientY - bounds.top - content.y) / Math.max(1, content.h),
    });
  };

  const capture = (event: ReactPointerEvent<Element>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events (tests) have no capture target.
    }
  };

  /**
   * Starts moving a border: a corner when `index` is given, the whole outline
   * otherwise. Selecting happens immediately, so the handles appear even for a
   * click that never moves.
   */
  const beginShapeDrag = (
    event: ReactPointerEvent<Element>,
    slice: SliceShape,
    index?: number,
  ) => {
    if (!interactive) return;
    event.stopPropagation();
    onSelect?.(slice.id);
    if (mode !== "select") return;
    event.preventDefault();
    capture(event);
    const points = slice.points.map((point) => ({ x: point.x, y: point.y }));
    shapeDrag.current = {
      kind: index === undefined ? "body" : "vertex",
      id: slice.id,
      ...(index === undefined ? {} : { index }),
      origin: pointOf(event),
      points,
      current: points,
    };
    setBlockedVertex(null);
    setPreview({ id: slice.id, points });
  };

  const moveShapeDrag = (event: ReactPointerEvent<Element>) => {
    const drag = shapeDrag.current;
    if (!drag) return;
    const point = pointOf(event);
    if (drag.kind === "vertex" && drag.index !== undefined) {
      const outcome = movePoint(drag.points, drag.index, point);
      if (!outcome.moved) {
        // The border would fold or vanish: keep the last good position and say
        // so by colouring the handle, rather than snapping the shape away.
        setBlockedVertex({ id: drag.id, index: drag.index });
        return;
      }
      setBlockedVertex(null);
      drag.current = outcome.points;
      setPreview({ id: drag.id, points: outcome.points });
      return;
    }
    const moved = translatePoints(drag.points, point.x - drag.origin.x, point.y - drag.origin.y);
    drag.current = moved;
    setPreview({ id: drag.id, points: moved });
  };

  /** Returns true when a border drag was in progress, so drawing is skipped. */
  const endShapeDrag = () => {
    const drag = shapeDrag.current;
    if (!drag) return false;
    shapeDrag.current = null;
    setBlockedVertex(null);
    setPreview(null);
    if (!samePoints(drag.points, drag.current)) onChangePoints?.(drag.id, drag.current);
    return true;
  };

  /**
   * Double-clicking an edge inserts a corner at its midpoint. Five points is the
   * floor, not a limit: a drawing with arms and legs needs more handles to hug.
   */
  const addVertex = (
    event: { clientX: number; clientY: number; stopPropagation: () => void },
    slice: SliceShape,
  ) => {
    if (!interactive || mode !== "select" || !onChangePoints) return;
    event.stopPropagation();
    const point = pointOf(event);
    let edge = 0;
    let nearest = Number.POSITIVE_INFINITY;
    slice.points.forEach((a, index) => {
      const b = slice.points[(index + 1) % slice.points.length]!;
      const distance = distanceToSegment(point, a, b, content.w || 1, content.h || 1);
      if (distance < nearest) {
        nearest = distance;
        edge = index;
      }
    });
    const a = slice.points[edge]!;
    const b = slice.points[(edge + 1) % slice.points.length]!;
    const next = slice.points.map((entry) => ({ x: entry.x, y: entry.y }));
    next.splice(edge + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    onChangePoints(slice.id, next);
  };

  const beginDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (mode === "select") {
      onSelect?.(null);
      return;
    }
    event.preventDefault();
    capture(event);
    const point = pointOf(event);
    if (mode === "rect") {
      setRectStart(point);
      setRectCurrent(point);
    } else {
      setDraft([point]);
    }
  };

  const moveDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const point = pointOf(event);
    if (mode === "rect" && rectStart) {
      setRectCurrent(point);
      return;
    }
    if (mode === "pen" && draft) {
      const last = draft[draft.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.004) return;
      setDraft([...draft, point]);
    }
  };

  const finishDraw = () => {
    if (!interactive) return;
    if (mode === "rect" && rectStart && rectCurrent) {
      const points = rectPoints(rectStart, rectCurrent);
      if (polygonArea(points) > 0.0008) onCreate?.(points);
      setRectStart(null);
      setRectCurrent(null);
      return;
    }
    if (mode === "pen" && draft) {
      // The path is closed automatically by the polygon; short scribbles or
      // shapes without an interior are ignored rather than becoming a slice.
      if (draft.length >= 3 && polygonArea(draft) > 0.0008) onCreate?.(draft);
      setDraft(null);
    }
  };

  const px = (points: SlicePoint[]) =>
    points.map((p) => `${content.x + p.x * content.w},${content.y + p.y * content.h}`).join(" ");
  const centerOf = (points: SlicePoint[]) => {
    const sum = points.reduce((total, p) => ({ x: total.x + p.x, y: total.y + p.y }), {
      x: 0,
      y: 0,
    });
    return {
      x: content.x + (sum.x / points.length) * content.w,
      y: content.y + (sum.y / points.length) * content.h,
    };
  };

  return (
    <div
      ref={wrapRef}
      className={`slice-surface ${interactive ? "is-editable" : "is-readonly"} ${className ?? ""}`}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0)
            setNatural({ w: image.naturalWidth, h: image.naturalHeight });
        }}
      />
      <svg
        className={`slice-overlay ${shaping ? "is-shaping" : ""}`}
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w || 1} ${size.h || 1}`}
        onPointerDown={beginDraw}
        onPointerMove={(event) => {
          if (shapeDrag.current) {
            moveShapeDrag(event);
            return;
          }
          moveDraw(event);
        }}
        onPointerUp={() => {
          if (endShapeDrag()) return;
          finishDraw();
        }}
        onPointerCancel={() => {
          if (endShapeDrag()) return;
          finishDraw();
        }}
      >
        {slices.map((slice) => {
          const selected = selectedId === slice.id;
          const shown = preview?.id === slice.id ? preview.points : slice.points;
          const label = centerOf(shown);
          return (
            <g key={slice.id} className={`slice-shape ${selected ? "selected" : ""}`}>
              <polygon
                points={px(shown)}
                onPointerDown={(event) => beginShapeDrag(event, slice)}
                onDoubleClick={(event) => addVertex(event, slice)}
              />
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">
                {slice.number}
              </text>
              {selected && shaping && (
                <g className="slice-vertices">
                  {shown.map((point, index) => (
                    <circle
                      key={`${slice.id}-${index}`}
                      className={`slice-vertex${
                        blockedVertex?.id === slice.id && blockedVertex.index === index
                          ? " blocked"
                          : ""
                      }`}
                      cx={content.x + point.x * content.w}
                      cy={content.y + point.y * content.h}
                      r={6}
                      onPointerDown={(event) => beginShapeDrag(event, slice, index)}
                    >
                      <title>Drag this point to reshape the border</title>
                    </circle>
                  ))}
                </g>
              )}
            </g>
          );
        })}
        {rectStart && rectCurrent && (
          <rect
            className="slice-draft"
            x={content.x + Math.min(rectStart.x, rectCurrent.x) * content.w}
            y={content.y + Math.min(rectStart.y, rectCurrent.y) * content.h}
            width={Math.abs(rectCurrent.x - rectStart.x) * content.w}
            height={Math.abs(rectCurrent.y - rectStart.y) * content.h}
          />
        )}
        {draft && draft.length > 1 && <polyline className="slice-draft" points={px(draft)} />}
      </svg>
    </div>
  );
}

type SliceEditorDialogProps = {
  name: string;
  /** 1-based play position of this image, written into an exported map. */
  imageNumber: number;
  /** The cut's own length, so reveal times can be resolved as they will play. */
  sceneSeconds: number;
  src: string;
  slices: SliceShape[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (points: SlicePoint[]) => void;
  onChangePoints: (id: string, points: SlicePoint[]) => void;
  onImportMap: (text: string) => SliceMapReport;
  onReorder: (id: string, order: number) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  /** The voice transcript under this scene, or null until one exists. */
  narrationText: string | null;
  /** Returns a human error, or null when the cue was accepted. */
  onSetCue: (sliceId: string, cue: string) => string | null;
  /** Resolves the cues, closes the slicer and plays the scene from its start. */
  onAutoAlign: () => void;
  onClose: () => void;
};

/**
 * A small timestamp for the slicer: seconds under a minute, `m:ss.s` above.
 */
function revealStamp(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return minutes ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${rest.toFixed(1)}s`;
}

/**
 * The voice-first way to author a cue: pick a slice, type words that were
 * actually spoken. It is locked until the scene has a transcript, and the
 * owner validates the phrase so a cue cannot point at silence.
 */
function SliceCueField({
  slice,
  narrationText,
  revealSeconds,
  estimated,
  onSetCue,
  canStep,
  onStepSlice,
}: {
  slice: SliceShape;
  narrationText: string | null;
  /** The resolved start of this reveal, not just when its words are spoken. */
  revealSeconds?: number | undefined;
  estimated?: boolean | undefined;
  onSetCue: (sliceId: string, cue: string) => string | null;
  canStep: boolean;
  onStepSlice: (delta: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState(slice.cue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const commit = () => {
    const message = onSetCue(slice.id, draft);
    setError(message);
    setSaved(!message && draft.trim() !== (slice.cue ?? "").trim());
  };

  const stepButtons = canStep ? (
    <div className="slice-cue-nav">
      <button
        type="button"
        className="slice-cue-step"
        aria-label="Previous slice"
        title="Previous slice"
        onClick={() => onStepSlice(-1)}
      >
        <ChevronLeft size={12} />
      </button>
      <button
        type="button"
        className="slice-cue-step"
        aria-label="Next slice"
        title="Next slice"
        onClick={() => onStepSlice(1)}
      >
        <ChevronRight size={12} />
      </button>
    </div>
  ) : null;

  if (narrationText === null) {
    return (
      <div className="slice-cue-panel is-locked">
        <div className="slice-cue-head">
          <span className="slice-cue-title">Trigger phrase</span>
          {stepButtons}
        </div>
        <p className="slice-cue-locked">
          Upload the voice for this scene and transcribe it first. Trigger phrases must be words
          Whisper actually heard.
        </p>
      </div>
    );
  }

  return (
    <div className="slice-cue-panel">
      <div className="slice-cue-head">
        <label className="slice-cue-title" htmlFor="slice-trigger">
          Trigger phrase
        </label>
        {stepButtons}
      </div>
      <input
        id="slice-trigger"
        className="slice-cue-input"
        type="text"
        value={draft}
        spellCheck={false}
        placeholder="Type words from the voice transcript"
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
          setSaved(false);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <p className="slice-cue-hint">
        Must appear in the voice transcript. Sync waits for these words.
      </p>
      {revealSeconds !== undefined ? (
        <p className="slice-cue-timing">
          Reveals at {revealStamp(revealSeconds)}
          {estimated ? " · estimated between its neighbours" : ""}
        </p>
      ) : null}
      {error ? <p className="slice-cue-error">{error}</p> : null}
      {saved ? <p className="slice-cue-saved">Saved.</p> : null}
      <details className="slice-cue-transcript">
        <summary>Voice transcript</summary>
        <p>{narrationText}</p>
      </details>
    </div>
  );
}

/** Full-size slicing studio, opened from the CUTS card. */
export function SliceEditorDialog({
  name,
  imageNumber,
  sceneSeconds,
  src,
  slices,
  selectedId,
  onSelect,
  onCreate,
  onChangePoints,
  onImportMap,
  onReorder,
  onDelete,
  onClear,
  narrationText,
  onSetCue,
  onAutoAlign,
  onClose,
}: SliceEditorDialogProps) {
  const [mode, setMode] = useState<SliceMode>("rect");
  const [mapOpen, setMapOpen] = useState(false);
  const [mapText, setMapText] = useState("");
  const [mapReport, setMapReport] = useState<SliceMapReport | null>(null);
  const [copied, setCopied] = useState(false);
  // Rows stay in permanent number order, so moving a slice never renumbers it
  // or shuffles the list — only its Position changes.
  const total = slices.length;
  const labelled = [...slices].sort((a, b) => a.number - b.number);
  const selectedSlice = slices.find((slice) => slice.id === selectedId) ?? null;
  // The slicer reports the reveal the viewer will actually see, not the cue's
  // word time: when a reveal is pushed past its neighbour those differ.
  const revealById = new Map(
    resolveSliceTiming(
      [...slices].sort((a, b) => a.order - b.order),
      sceneSeconds,
    ).slices.map((timing) => [timing.id, timing]),
  );
  // A slice nobody cued is still given a default slot; showing that as a reveal
  // time would claim knowledge the narration never provided.
  const revealOf = (slice: SliceShape) =>
    (slice.cue ?? "").trim() || slice.timing?.intendedStart !== undefined
      ? revealById.get(slice.id)?.start
      : undefined;
  const cued = slices.filter((slice) => (slice.cue ?? "").trim()).length;
  const alignBlocked =
    narrationText === null
      ? "Upload the voice for this scene and transcribe it first."
      : cued === 0
        ? "Give at least one slice a trigger phrase."
        : null;

  const applyMap = () => {
    const report = onImportMap(mapText);
    setMapReport(report);
    // An imported border is only a starting point: the picture says whether it
    // actually surrounds the drawing, so hand the user the handles at once.
    if (report.errors.length === 0) setMode("select");
  };

  const copyMap = () => {
    const text = serializeSliceMap(slices, { image: imageNumber, file: name });
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => {
        // Clipboard denied: leave the map in the box so it can be copied by hand.
        setMapOpen(true);
        setMapText(text);
      });
      return;
    }
    setMapOpen(true);
    setMapText(text);
  };

  return createPortal(
    <div className="slice-dialog-backdrop" onPointerDown={onClose}>
      <div
        className="slice-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Slice this image"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="slice-dialog-head">
          <div>
            <span className="panel-eyebrow">SLICER</span>
            <h3>{name}</h3>
          </div>
          <button
            type="button"
            className="slice-dialog-close"
            onClick={onClose}
            aria-label="Close slicer"
          >
            <X size={16} />
          </button>
        </header>
        <div className="slice-dialog-body">
          <div className="slice-stage">
            <SliceSurface
              src={src}
              slices={slices}
              selectedId={selectedId}
              mode={mode}
              onSelect={onSelect}
              onCreate={onCreate}
              onChangePoints={onChangePoints}
            />
            <div className="slice-tools">
              <button
                type="button"
                className={mode === "rect" ? "active" : ""}
                onClick={() => setMode("rect")}
              >
                <Square size={12} /> Rectangle
              </button>
              <button
                type="button"
                className={mode === "pen" ? "active" : ""}
                onClick={() => setMode("pen")}
              >
                <PenLine size={12} /> Freehand
              </button>
              <button
                type="button"
                className={mode === "select" ? "active" : ""}
                onClick={() => setMode("select")}
              >
                <MousePointer2 size={12} /> Select
              </button>
              <span className="slice-tools-hint">
                {mode === "rect" && "Drag a box around the part you want next."}
                {mode === "pen" && "Draw a loop; the border closes itself."}
                {mode === "select" &&
                  "Drag a point to reshape, drag inside to move, double-click an edge to add a point."}
              </span>
            </div>
          </div>
          <aside className="slice-side">
            <p className="slice-side-lead">
              Every slice keeps its number. Position decides when it animates — slice 3 can play
              first, last, or anywhere in between.
            </p>
            {total === 0 ? (
              <div className="slice-side-empty">
                <Expand size={14} />
                <span>No slices yet</span>
                <small>Drag a rectangle or draw a loop on the photo.</small>
              </div>
            ) : (
              <ol className="slice-list">
                {labelled.map((slice) => (
                  <li
                    key={slice.id}
                    className={`slice-row ${selectedId === slice.id ? "selected" : ""}`}
                    onClick={() => onSelect(slice.id)}
                  >
                    <span className="slice-row-badge">{slice.number}</span>
                    <span className="slice-row-name">
                      Slice {slice.number}
                      <small className="slice-row-points">
                        {slice.points.length} points
                        {revealOf(slice) !== undefined
                          ? ` · ${revealStamp(revealOf(slice) ?? 0)}`
                          : ""}
                      </small>
                    </span>
                    <div className="slice-row-order" onClick={(event) => event.stopPropagation()}>
                      <span>Position</span>
                      <button
                        type="button"
                        className="slice-row-step"
                        disabled={slice.order <= 1}
                        aria-label={`Play slice ${slice.number} earlier`}
                        title="Play earlier"
                        onClick={() => onReorder(slice.id, slice.order - 1)}
                      >
                        <ChevronUp size={11} />
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={total}
                        value={slice.order}
                        onChange={(event) => {
                          const typed = Math.round(Number(event.target.value));
                          if (!Number.isFinite(typed)) return;
                          onReorder(slice.id, Math.min(total, Math.max(1, typed)));
                        }}
                        aria-label={`Play position for slice ${slice.number}`}
                      />
                      <button
                        type="button"
                        className="slice-row-step"
                        disabled={slice.order >= total}
                        aria-label={`Play slice ${slice.number} later`}
                        title="Play later"
                        onClick={() => onReorder(slice.id, slice.order + 1)}
                      >
                        <ChevronDown size={11} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="slice-row-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDelete(slice.id);
                      }}
                      aria-label={`Delete slice ${slice.number}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {total > 0 &&
              (selectedSlice ? (
                <SliceCueField
                  key={selectedSlice.id}
                  slice={selectedSlice}
                  narrationText={narrationText}
                  revealSeconds={revealOf(selectedSlice)}
                  estimated={selectedSlice.timing?.estimated === true}
                  onSetCue={onSetCue}
                  canStep={total > 1}
                  onStepSlice={(delta) => {
                    const index = labelled.findIndex((item) => item.id === selectedSlice.id);
                    if (index < 0) return;
                    const next = labelled[(index + delta + labelled.length) % labelled.length];
                    if (next) onSelect(next.id);
                  }}
                />
              ) : (
                <p className="slice-cue-empty">Select a slice to give it a trigger phrase.</p>
              ))}
            <div className="slice-align-panel">
              <button
                type="button"
                className="slice-align-button"
                disabled={alignBlocked !== null}
                title={alignBlocked ?? "Resolve the cues and play the scene from its start"}
                onClick={onAutoAlign}
              >
                <Sparkles size={12} />
                Auto-align & preview
              </button>
              <p className="slice-align-hint">
                {alignBlocked ??
                  `Every cue is placed in the voice, then the scene plays so you can watch the reveals land.`}
              </p>
            </div>
            <div className="slice-map-panel">
              <button
                type="button"
                className="slice-map-toggle"
                aria-expanded={mapOpen}
                onClick={() => setMapOpen((open) => !open)}
              >
                <ClipboardPaste size={12} />
                <span>Slice map</span>
                <small>{mapOpen ? "hide JSON" : "paste JSON borders"}</small>
                {mapOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
              {mapOpen && (
                <div className="slice-map-body">
                  <textarea
                    className="slice-map-input"
                    value={mapText}
                    spellCheck={false}
                    placeholder={
                      '{\n  "slices": [\n    { "order": 1, "cue": "most teams start…",\n      "points": [[0.03,0.08],[0.30,0.08],[0.30,0.92],[0.03,0.92]] }\n  ]\n}'
                    }
                    onChange={(event) => {
                      setMapText(event.target.value);
                      setMapReport(null);
                    }}
                  />
                  <div className="slice-map-actions">
                    <button
                      type="button"
                      className="slice-map-primary"
                      disabled={!mapText.trim()}
                      onClick={applyMap}
                    >
                      Import map
                    </button>
                    <button type="button" disabled={total === 0} onClick={copyMap}>
                      {copied ? <Check size={11} /> : <ClipboardPaste size={11} />}
                      {copied ? "Copied" : "Copy current"}
                    </button>
                  </div>
                  {mapReport && (
                    <div className="slice-map-report">
                      {mapReport.errors.length > 0 ? (
                        <ul className="slice-map-errors">
                          {mapReport.errors.map((problem, index) => (
                            <li key={`${problem.path}-${index}`}>
                              <code>{problem.path}</code> {problem.message}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <>
                          <p className="slice-map-ok">
                            Imported {mapReport.slices.length} slice
                            {mapReport.slices.length === 1 ? "" : "s"} · covers{" "}
                            {Math.round(mapReport.coverage * 100)}% of the image
                          </p>
                          {mapReport.warnings.length > 0 && (
                            <ul className="slice-map-warnings">
                              {mapReport.warnings.map((warning, index) => (
                                <li key={`${warning.path}-${index}`}>{warning.message}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <p className="slice-map-hint">
                    Coordinates are 0–1 of the image. A map replaces every slice on this image; if
                    anything is invalid, nothing is imported.
                  </p>
                </div>
              )}
            </div>
            <div className="slice-side-foot">
              <span>
                {total} slice{total === 1 ? "" : "s"} · positions set the drawing order; the hand
                leaves and returns between each one
              </span>
              {total > 0 && (
                <button type="button" className="slice-clear" onClick={onClear}>
                  Clear all slices
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
