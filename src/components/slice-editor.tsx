import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  Expand,
  MousePointer2,
  PenLine,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { SlicePoint, SliceShape } from "@/whiteboard/types";

type SliceMode = "select" | "rect" | "pen";

type SliceSurfaceProps = {
  src: string;
  slices: SliceShape[];
  selectedId?: string | null;
  mode?: SliceMode;
  interactive?: boolean;
  onSelect?: (id: string | null) => void;
  onCreate?: (points: SlicePoint[]) => void;
  className?: string;
};

function polygonArea(points: SlicePoint[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function clampPoint(x: number, y: number): SlicePoint {
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
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
  className,
}: SliceSurfaceProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 16, h: 9 });
  const [rectStart, setRectStart] = useState<SlicePoint | null>(null);
  const [rectCurrent, setRectCurrent] = useState<SlicePoint | null>(null);
  const [draft, setDraft] = useState<SlicePoint[] | null>(null);

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

  const pointOf = (event: ReactPointerEvent<Element>) => {
    const element = wrapRef.current;
    if (!element) return { x: 0, y: 0 };
    const bounds = element.getBoundingClientRect();
    return clampPoint(
      (event.clientX - bounds.left - content.x) / Math.max(1, content.w),
      (event.clientY - bounds.top - content.y) / Math.max(1, content.h),
    );
  };

  const capture = (event: ReactPointerEvent<Element>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events (tests) have no capture target.
    }
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
        className="slice-overlay"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w || 1} ${size.h || 1}`}
        onPointerDown={beginDraw}
        onPointerMove={moveDraw}
        onPointerUp={finishDraw}
        onPointerCancel={finishDraw}
      >
        {slices.map((slice) => {
          const selected = selectedId === slice.id;
          const label = centerOf(slice.points);
          return (
            <g key={slice.id} className={`slice-shape ${selected ? "selected" : ""}`}>
              <polygon
                points={px(slice.points)}
                onPointerDown={(event) => {
                  if (!interactive) return;
                  event.stopPropagation();
                  onSelect?.(slice.id);
                }}
              />
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">
                {slice.number}
              </text>
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
  src: string;
  slices: SliceShape[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (points: SlicePoint[]) => void;
  onReorder: (id: string, order: number) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
};

/** Full-size slicing studio, opened from the CUTS card. */
export function SliceEditorDialog({
  name,
  src,
  slices,
  selectedId,
  onSelect,
  onCreate,
  onReorder,
  onDelete,
  onClear,
  onClose,
}: SliceEditorDialogProps) {
  const [mode, setMode] = useState<SliceMode>("rect");
  // Rows stay in permanent number order, so moving a slice never renumbers it
  // or shuffles the list — only its Position changes.
  const total = slices.length;
  const labelled = [...slices].sort((a, b) => a.number - b.number);

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
                {mode === "select" && "Click a slice to set its position."}
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
                    <span className="slice-row-name">Slice {slice.number}</span>
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
