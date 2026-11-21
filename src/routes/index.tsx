import { createFileRoute } from "@tanstack/react-router";
import {
  AudioLines,
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Film,
  Flag,
  Globe,
  Image as ImageIcon,
  LibraryBig,
  Mic,
  MicOff,
  MoreHorizontal,
  Pause,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  ASR_LANGUAGES,
  DEFAULT_ASR_ENDPOINT,
  loadAsrConfig,
  saveAsrConfig,
  type AsrConfig,
} from "@/lib/asr-config";
import { buildFilmstrip, cachedFilmstrip, filmstripKey } from "@/lib/clip-filmstrip";
import { shouldAutoTranscribe } from "@/lib/asr-policy";
import { loadStoredMedia, requestPersistentStorage, storeMediaFile } from "@/lib/media-store";
import { parseSliceMap, type SliceMapReport } from "@/lib/slice-map";
import { ensureMinimumPoints } from "@/lib/slice-geometry";
import { alignScriptToTranscript } from "@/lib/script-align";
import { syncSliceBeats, syncSliceCues, narrationBeats } from "@/lib/slice-sync";
import { transcribeAudio, type TranscriptionResult } from "@/lib/transcribe-audio";
import { SliceEditorDialog, SliceSurface } from "@/components/slice-editor";
import { PromptBuilderDialog } from "@/components/prompt-builder";
import { PreviewBoard } from "@/whiteboard/PreviewBoard";
import { WhiteboardStage } from "@/whiteboard/WhiteboardStage";
import {
  ANCHOR_WINDOW_SECONDS,
  MIN_SLICE_ANIMATION,
  MIN_SLICE_HOLD,
  SLICE_END_HOLD,
  resolveSliceTiming,
  timingBands,
  transcriptHasPhrase,
  type SliceTimingFlag,
} from "@/lib/slice-timing";
import {
  measureWhiteboardDuration,
  warmUpWhiteboardMeasurement,
  whiteboardSceneSeconds,
  whiteboardSeekSeconds,
} from "@/whiteboard/measure";
import {
  DEFAULT_WHITEBOARD_CONFIG,
  HAND_OFF_MODES,
  WHITEBOARD_ANIMATION_STYLES,
  WHITEBOARD_BACKGROUNDS,
  WHITEBOARD_COLOR_STYLES,
  WHITEBOARD_DRAWING_STYLES,
  WHITEBOARD_HANDS,
  WHITEBOARD_OUTLINE_ALGORITHMS,
  WHITEBOARD_STROKE_STYLES,
  WHITEBOARD_STYLES,
  WHITEBOARD_TEXT_DIRECTIONS,
  WHITEBOARD_TEXT_DRAW_STYLES,
  makeWhiteboardConfig,
  type SlicePoint,
  type SliceShape,
  type WhiteboardConfig,
} from "@/whiteboard/types";
import {
  compatibleTrackId,
  canRemoveTrack,
  emptyTrackId,
  fadeToBlackOverlayOpacity,
  IMAGE_SCENE_SECONDS,
  isTrackCompatible,
  isTimelineRangeActive,
  nextTrackName,
  timelineTimeAtPointer,
  timelineWidth,
  trackInsertionIndex,
  transitionFrameStyle,
  transitionLayersAtTime,
  trimClipWithin,
  nearestFreeStart,
  type TrimEdge,
} from "@/lib/editor-timeline";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cutline — Video editor" },
      { name: "description", content: "A hands-on, multi-track video editing studio." },
      { property: "og:title", content: "Cutline — Video editor" },
      { property: "og:description", content: "A hands-on, multi-track video editing studio." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Editor,
});

type MediaKind = "visual" | "audio" | "voice";
type TrackCategory = "video" | "image" | "voice" | "music";
type Track = {
  id: string;
  kind: MediaKind;
  category: TrackCategory;
  name: string;
  muted?: boolean;
  hidden?: boolean;
  default?: boolean;
};
type Clip = {
  id: string;
  trackId: string;
  kind: MediaKind;
  mediaType: "video" | "image" | "audio";
  name: string;
  src: string;
  start: number;
  duration: number;
  sourceOffset: number;
  sourceDuration: number;
  /** Set when the editor trimmed or split the clip, so it keeps the user's length. */
  durationLocked?: boolean;
  /** User-drawn regions of an image; when present the scene animates them in order. */
  slices?: SliceShape[] | undefined;
  /** Timed words for an audio clip, produced by the narration worker. */
  transcript?: TranscriptionResult | undefined;
  /** When true this scene uses `whiteboard` instead of the project-wide settings. */
  whiteboardOverride?: boolean;
  whiteboard?: WhiteboardConfig | undefined;
  /** Set once this video's audio has been moved to a voice or music row. */
  audioShipped?: boolean;
  /** On a cut created by Audioship: the video clip its audio came from. */
  audioSourceClipId?: string;
  /** Size of the imported file, used for the library's storage readout. */
  size?: number;
};
type Transition = { id: string; leftId: string; rightId: string; effect: string; duration: number };
/** Settings shared by every scene; a clip can opt out with its own override. */
type ProjectSettings = {
  whiteboard: WhiteboardConfig;
  /**
   * The words the narrator was supposed to read. Cues are matched against this
   * first, then projected onto the transcript, so ASR spelling never has to be
   * exact. Empty means "match cues directly against the words that were heard".
   */
  narrationScript?: string | undefined;
};
type Project = {
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  settings: ProjectSettings;
};
type MediaItem = Omit<Clip, "trackId" | "start" | "transcript">;
/** Library sections; voice lives only on the timeline, so it is not listed here. */
type LibraryKind = "image" | "video" | "audio";
const LIBRARY_KINDS: { value: LibraryKind; label: string }[] = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Music" },
];
type DragState = {
  clipId: string;
  startX: number;
  originalStart: number;
  trackId: string;
  nextStart: number;
  nextTrackId: string;
  startLeft: number;
};
type TrimDragState = {
  clipId: string;
  edge: TrimEdge;
  startX: number;
  original: Clip;
  delta: number;
  startLeft: number;
};
type DropTarget = { type: "preview" | "lane"; trackId: string | null };

const STARTER_TRACKS: Track[] = [
  { id: "video-1", kind: "visual", category: "video", name: "Video 1", default: true },
  { id: "image-1", kind: "visual", category: "image", name: "Image 1", default: true },
  { id: "voice-1", kind: "voice", category: "voice", name: "Voice 1", default: true },
  { id: "audio-1", kind: "audio", category: "music", name: "Music 1", default: true },
];
const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { whiteboard: DEFAULT_WHITEBOARD_CONFIG };

/**
 * Every scene follows the global animation settings until it is given its own.
 * Keeping the lookup in one place means the preview, the timeline fitting and the
 * inspector all agree on which config a clip is actually using.
 */
function resolveWhiteboard(clip: Clip, settings: ProjectSettings): WhiteboardConfig {
  if (clip.whiteboardOverride && clip.whiteboard) return clip.whiteboard;
  return settings.whiteboard;
}

/**
 * Slices carry two independent numbers: a permanent label (`number`) and an
 * animation position (`order`). Both are compacted to unique 1..N values so a
 * slice can never share a number or run past the slice count.
 */
function normalizeSlices(slices: SliceShape[]): SliceShape[] {
  const byNumber = [...slices].sort((a, b) => (a.number ?? a.order) - (b.number ?? b.order));
  const numberOf = new Map(byNumber.map((slice, index) => [slice.id, index + 1]));
  const byPosition = [...slices].sort((a, b) => a.order - b.order);
  const positionOf = new Map(byPosition.map((slice, index) => [slice.id, index + 1]));
  return slices.map((slice) => ({
    ...slice,
    number: numberOf.get(slice.id) ?? 1,
    order: positionOf.get(slice.id) ?? 1,
  }));
}

/**
 * Moves a slice to `position` in the animation sequence. The slice keeps its
 * permanent number; only the positions of the slices around it shift.
 */
function reorderSlices(slices: SliceShape[], id: string, position: number): SliceShape[] {
  const normalized = normalizeSlices(slices);
  const sequence = [...normalized].sort((a, b) => a.order - b.order);
  const from = sequence.findIndex((slice) => slice.id === id);
  if (from < 0) return normalized;
  const to = Math.min(sequence.length - 1, Math.max(0, position - 1));
  const next = [...sequence];
  const [moved] = next.splice(from, 1);
  if (!moved) return normalized;
  next.splice(to, 0, moved);
  const positionOf = new Map(next.map((slice, index) => [slice.id, index + 1]));
  return normalized.map((slice) => ({ ...slice, order: positionOf.get(slice.id) ?? slice.order }));
}

const TRACK_RAIL_WIDTH = 146;
// The label column narrows on phones, so pointer math reads its rendered width.
const railWidth = (viewport: HTMLElement) =>
  viewport.querySelector<HTMLElement>(".track-rail")?.offsetWidth ?? TRACK_RAIL_WIDTH;

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const frames = Math.floor((safe - whole) * 30);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function makeId() {
  return crypto.randomUUID();
}

function isSameDropTarget(current: DropTarget | null, target: DropTarget) {
  return current !== null && current.type === target.type && current.trackId === target.trackId;
}

/**
 * Timeline artwork: images repeat whole across the cut, while videos show one
 * frame every third of a second so a scene stays recognisable when remixing.
 */
function ClipFilmstrip({ clip }: { clip: Clip }) {
  const key = clip.mediaType === "video" ? filmstripKey(clip) : "";
  const [strip, setStrip] = useState<string | null>(() =>
    clip.mediaType === "video" ? cachedFilmstrip(clip) : null,
  );

  useEffect(() => {
    if (clip.mediaType !== "video") return;
    const cached = cachedFilmstrip(clip);
    if (cached) {
      setStrip(cached);
      return;
    }
    let cancelled = false;
    setStrip(null);
    void buildFilmstrip(clip)
      .then((url) => {
        if (!cancelled) setStrip(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (clip.mediaType === "image") {
    return (
      <span
        className="clip-filmstrip image"
        style={{ backgroundImage: `url("${clip.src}")` }}
        aria-hidden="true"
      />
    );
  }
  if (clip.mediaType === "video") {
    return (
      <span
        className={`clip-filmstrip video ${strip ? "ready" : ""}`}
        style={strip ? { backgroundImage: `url("${strip}")` } : undefined}
        aria-hidden="true"
      />
    );
  }
  return null;
}

/** Which end of a slice's reveal a drag is moving. */
type SliceBoundary = "start" | "end";
/** The three fixes offered when a reveal cannot fit where it was asked to. */
type SliceFlagAction = "speed-up" | "widen-cue" | "drop";
type SliceDragPreview = { sliceId: string; edge: SliceBoundary; delta: number };
type SliceDragState = {
  clipId: string;
  sliceId: string;
  edge: SliceBoundary;
  startX: number;
  startLeft: number;
  delta: number;
  /** The clip as it was when the drag began, so the maths never compounds. */
  original: Clip;
};

const clampTo = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

const SLICE_FLAG_TEXT: Record<SliceTimingFlag, string> = {
  clamped: "pushed past the previous reveal",
  tight: "reveal does not fit before the next slice",
  override: "start moved by hand",
  early: "starts before the narration describes it",
  estimated: "placed by rule, not by its words",
};

/**
 * Turns the clip's authored timing into the fractions the engine paints in.
 * Slices without authored timing fall back to the uniform schedule, so older
 * projects keep exactly the reveal they had before.
 */
function bandedSlices(clip: Clip): SliceShape[] {
  const ordered = [...(clip.slices ?? [])].sort((a, b) => a.order - b.order);
  const { slices: timings, sceneSeconds } = resolveSliceTiming(ordered, clip.duration);
  const bands = timingBands(timings, sceneSeconds);
  return ordered.map((slice, index) => ({
    ...slice,
    band: bands[index] ?? { start: 0, end: 0 },
  }));
}

/**
 * Finds the voice narration covering an image clip, plus the offset that maps
 * transcript time onto the clip's own timeline.
 *
 * Only clips on Voice rows qualify: music is never transcribed and never drives
 * a reveal. Words before the image or after it stay in the list — the cue
 * resolver is the one that decides they are out of range.
 */
function narrationForClip(clip: Clip, clips: Clip[], tracks: Track[]) {
  const voiceTracks = new Set(
    tracks.filter((track) => track.category === "voice").map((track) => track.id),
  );
  const best = clips
    .filter(
      (candidate) =>
        candidate.mediaType === "audio" &&
        candidate.transcript &&
        voiceTracks.has(candidate.trackId),
    )
    .map((candidate) => ({
      candidate,
      overlap:
        Math.min(clip.start + clip.duration, candidate.start + candidate.duration) -
        Math.max(clip.start, candidate.start),
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)[0];

  const audio = best?.candidate;
  const transcript = audio?.transcript;
  if (!audio || !transcript) return null;
  return {
    clipId: audio.id,
    transcript,
    offsetSeconds: clip.start - audio.start + audio.sourceOffset,
    /**
     * Where the voice stops, in this image's own seconds. The scene is sized to
     * the narration, so this is the natural end of the cut — a picture that can
     * be drawn in 9 s still stays up for a 24 s voice.
     */
    endSeconds: audio.start + audio.duration - clip.start,
  };
}

/**
 * Shows the schedule of one image cut as the three regions the audio implies:
 *
 *   purple  lag  — the slice is queued but nothing is drawn yet. Opaque, so
 *                  the photo behind it reads as "not this slice yet".
 *   green   animation — the reveal itself; the photo shows through.
 *   orange  hold — the finished reveal, also showing the photo behind it.
 *
 * A lag is allowed to sit on top of the previous slice's hold (it is drawn
 * last, so purple wins where they overlap), but reveals never overlap: the
 * drag bounds are the previous reveal's end and the next reveal's start.
 */
function ClipSlices({
  clip,
  selected,
  drag,
  onBoundaryDrag,
  onFlagAction,
}: {
  clip: Clip;
  selected: boolean;
  drag: SliceDragPreview | null;
  onBoundaryDrag: (
    event: ReactPointerEvent<HTMLSpanElement>,
    clip: Clip,
    slice: SliceShape,
    edge: SliceBoundary,
  ) => void;
  onFlagAction: (clip: Clip, slice: SliceShape, action: SliceFlagAction, value?: number) => void;
}) {
  const slices = clip.slices ?? [];
  if (clip.mediaType !== "image" || slices.length < 2) return null;
  const ordered = [...slices].sort((a, b) => a.order - b.order);
  const { slices: timings } = resolveSliceTiming(ordered, clip.duration);
  const total = Math.max(0.01, clip.duration);
  const percent = (value: number) => `${clampTo(value / total, 0, 1) * 100}%`;

  // Solve the previewed boundary once, so the previous hold and the next lag
  // follow the handle while it is being dragged.
  const starts = timings.map((timing) => timing.start);
  const ends = timings.map((timing) => timing.animEnd);
  if (drag) {
    const index = ordered.findIndex((slice) => slice.id === drag.sliceId);
    if (index >= 0) {
      const timing = timings[index];
      const previousEnd = timings[index - 1]?.animEnd ?? 0;
      const nextStart = timings[index + 1]?.start ?? total;
      if (timing && drag.edge === "start") {
        starts[index] = clampTo(
          timing.start + drag.delta,
          previousEnd,
          Math.max(previousEnd, (ends[index] ?? 0) - MIN_SLICE_ANIMATION),
        );
      } else if (timing) {
        ends[index] = clampTo(
          timing.animEnd + drag.delta,
          (starts[index] ?? 0) + MIN_SLICE_ANIMATION,
          Math.max((starts[index] ?? 0) + MIN_SLICE_ANIMATION, nextStart),
        );
      }
    }
  }

  return (
    <span
      className={`clip-slices ${selected ? "is-editable" : ""}`}
      role="group"
      aria-label="Slice timing"
    >
      {ordered.map((slice, index) => {
        const timing = timings[index];
        if (!timing) return null;
        const start = starts[index] ?? 0;
        const animEnd = ends[index] ?? 0;
        const previousEnd = timings[index - 1]?.animEnd ?? 0;
        const nextStart = starts[index + 1] ?? total;
        const intended = timing.start - timing.lag;
        const holdEnd = Math.max(animEnd, nextStart);
        // The lag starts where the words said it should, but never inside the
        // previous reveal — only a hold may be overlapped.
        const lagFrom = clampTo(Math.min(intended, start), previousEnd, start);
        const lagWidth = Math.max(0, start - lagFrom);
        const holdWidth = Math.max(0, holdEnd - animEnd);
        const flags = timing.flags;
        // A hand-moved start is already visible as the purple lag, so the
        // warning badge is reserved for problems the user cannot see: a
        // collision, a missing hold, or a reveal running ahead of the words.
        // An estimate is not a problem, but it is not a measurement either, so
        // it gets its own badge rather than hiding among the timed slices.
        const problems = flags.filter((flag) => flag !== "override" && flag !== "estimated");
        const estimatedHere = flags.includes("estimated");
        const needsBadge = problems.length > 0 || estimatedHere;
        // A reveal may be shortened until it only just fits, but it must still
        // leave the minimum hold — below that, speeding up cannot fix it.
        const speedTarget = Math.max(MIN_SLICE_ANIMATION, nextStart - start - MIN_SLICE_HOLD);
        const canSpeedUp = speedTarget < timing.animation - 0.01;
        const label = [
          `Slice ${slice.number}`,
          `lag ${(start - intended).toFixed(2)}s`,
          `draw ${(animEnd - start).toFixed(2)}s`,
          `hold ${holdWidth.toFixed(2)}s`,
          ...flags.map((flag) => SLICE_FLAG_TEXT[flag]),
        ].join(" · ");

        return (
          <Fragment key={slice.id}>
            {lagWidth > 0.001 && (
              <span
                className="slice-region lag"
                style={{ left: percent(lagFrom), width: percent(lagWidth) }}
                title={`Slice ${slice.number} waits ${(start - intended).toFixed(2)}s for its cue`}
              />
            )}
            <span
              className={`slice-region anim ${problems.length ? "flagged" : ""}`}
              style={{ left: percent(start), width: percent(animEnd - start) }}
              title={label}
            >
              <span className="clip-slice-index">{slice.number}</span>
            </span>
            {holdWidth > 0.001 && (
              <span
                className="slice-region hold"
                style={{ left: percent(animEnd), width: percent(holdWidth) }}
                title={`Slice ${slice.number} holds for ${holdWidth.toFixed(2)}s`}
              />
            )}
            {selected && (
              <>
                <span
                  className="slice-handle start"
                  style={{ left: percent(start) }}
                  title="Drag to change how long this slice waits for its cue"
                  onPointerDown={(event) => onBoundaryDrag(event, clip, slice, "start")}
                />
                <span
                  className="slice-handle end"
                  style={{ left: percent(animEnd) }}
                  title="Drag to give the reveal more time and shorten the hold"
                  onPointerDown={(event) => onBoundaryDrag(event, clip, slice, "end")}
                />
              </>
            )}
            {needsBadge && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={`slice-flag${problems.length ? "" : " estimated"}`}
                    style={{ left: percent(start) }}
                    title={`Slice ${slice.number}: ${flags
                      .filter((flag) => flag !== "override")
                      .map((flag) => SLICE_FLAG_TEXT[flag])
                      .join("; ")}`}
                    aria-label={
                      problems.length
                        ? `Slice ${slice.number} timing needs attention`
                        : `Slice ${slice.number} was placed by estimation`
                    }
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {problems.length ? "!" : "≈"}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="slice-flag-menu">
                  <DropdownMenuLabel>{problems.length ? "Reveal timing" : "Placed by rule"}</DropdownMenuLabel>
                  {estimatedHere && (
                    <DropdownMenuItem disabled>
                      Its words were not found, so it was fitted between its neighbours
                    </DropdownMenuItem>
                  )}
                  {problems.length > 0 && (
                    <>
                      <DropdownMenuItem
                        disabled={!canSpeedUp}
                        title={
                          canSpeedUp
                            ? "Draw this reveal faster so it fits before the next slice"
                            : "This reveal is already as short as the speed limit allows"
                        }
                        onSelect={() => onFlagAction(clip, slice, "speed-up", speedTarget)}
                      >
                        Speed the reveal up to {speedTarget.toFixed(2)}s
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onFlagAction(clip, slice, "widen-cue")}>
                        Widen the cue search
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => onFlagAction(clip, slice, "drop")}>
                    Drop this slice
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}

function Editor() {
  const [project, setProject] = useState<Project>({
    tracks: STARTER_TRACKS,
    clips: [],
    transitions: [],
    settings: DEFAULT_PROJECT_SETTINGS,
  });
  const projectRef = useRef(project);
  const undoStack = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedClip, setCopiedClip] = useState<Clip | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(72);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingTrackId, setRecordingTrackId] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null);
  const [sliceDrag, setSliceDrag] = useState<SliceDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryKind, setLibraryKind] = useState<LibraryKind>("image");
  const [librarySelectedId, setLibrarySelectedId] = useState<string | null>(null);
  // Re-fitting every following scene after a global change takes a moment; the
  // settings panel shows that it is working instead of appearing to do nothing.
  const [fittingScenes, setFittingScenes] = useState(false);
  const fitTimer = useRef<number | null>(null);
  const fitRun = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Where the playhead sits on screen while the timeline scrolls under it,
  // stored as a share of the viewport width so a zoom keeps the framing.
  const playbackAnchor = useRef<number | null>(null);
  // Playback paints straight to the DOM: the clock's value, the playhead line,
  // the readouts and the preview frame all update without a React render.
  const playheadRef = useRef(0);
  const zoomRef = useRef(72);
  const playheadLineRef = useRef<HTMLDivElement>(null);
  const transportTimeRef = useRef<HTMLSpanElement>(null);
  const previewTimecodeRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const fadeOverlayRef = useRef<HTMLDivElement>(null);
  // Latest values for the imperative playback loop. While playing, the loop owns
  // the clock and the ref is ahead of the last committed playhead.
  if (!isPlaying) playheadRef.current = playhead;
  zoomRef.current = zoom;
  // Single swipe pans the timeline and a single tap selects a clip; a double tap (then drag)
  // moves the playhead, or picks up the clip under the finger so it can be moved.
  const lastTimelineTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const timelineGesture = useRef<{
    mode: "scrub" | "pan";
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    clipId: string | undefined;
    moved: boolean;
  } | null>(null);
  // Every finger currently on the timeline, so a second one can start a pinch.
  const timelinePointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchGesture = useRef<{ distance: number; zoom: number; time: number } | null>(null);
  // The pointer driving a drag, trim or scrub, so holding it near either end of
  // the strip can keep the strip scrolling.
  const heldPointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const [scrubHeld, setScrubHeld] = useState(false);
  // The project media sidebar can be tucked away to give the preview the full width.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Timeline height after the user drags the splitter. Null keeps the
  // responsive default, which already favours the preview on short screens.
  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  const timelineResize = useRef<{ id: number; startY: number; startHeight: number } | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartedAt = useRef(0);
  const recordingStream = useRef<MediaStream | null>(null);
  const mediaUrls = useRef<string[]>([]);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const audioPickerRef = useRef<HTMLInputElement>(null);
  const selectedClip = project.clips.find((clip) => clip.id === selectedId) ?? null;
  const selectedTrack = selectedClip
    ? (project.tracks.find((track) => track.id === selectedClip.trackId) ?? null)
    : null;
  // CUTS stays on the last image cut even while the playhead is being scrubbed,
  // otherwise deselecting (a lane tap) would hide the slicer mid-preview.
  const [lastImageId, setLastImageId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedClip?.mediaType === "image") setLastImageId(selectedClip.id);
  }, [selectedClip]);
  // The library drives CUTS too: picking a file there previews that exact image,
  // even while a different clip happens to be selected on the timeline.
  const [cutsSource, setCutsSource] = useState<"timeline" | "library">("timeline");
  useEffect(() => {
    if (selectedId) setCutsSource("timeline");
  }, [selectedId]);
  const libraryImage =
    cutsSource === "library"
      ? (media.find((item) => item.id === librarySelectedId && item.mediaType === "image") ?? null)
      : null;
  const libraryClip = libraryImage
    ? selectedClip && selectedClip.mediaType === "image" && selectedClip.src === libraryImage.src
      ? selectedClip
      : (project.clips.find(
          (clip) => clip.mediaType === "image" && clip.src === libraryImage.src,
        ) ?? null)
    : null;
  const cutsClip = libraryImage
    ? libraryClip
    : selectedClip && selectedClip.mediaType === "image"
      ? selectedClip
      : selectedClip
        ? null
        : (project.clips.find((clip) => clip.id === lastImageId && clip.mediaType === "image") ??
          null);
  // A library image can sit in CUTS before it has ever been placed on the timeline.
  const cutsImage = cutsClip ?? libraryImage;
  const selectedWhiteboard = selectedClip
    ? resolveWhiteboard(selectedClip, project.settings)
    : project.settings.whiteboard;
  const selectedFollowsGlobal = selectedClip ? !selectedClip.whiteboardOverride : true;
  const selectedSlices = selectedClip
    ? [...(selectedClip.slices ?? [])].sort((a, b) => a.order - b.order)
    : [];
  const cutsSlices = cutsClip?.slices ?? [];
  // Play position of the open image, so an exported map says which image it is.
  const cutsImageNumber = cutsClip
    ? [...project.clips]
        .filter((clip) => clip.mediaType === "image")
        .sort((a, b) => a.start - b.start)
        .findIndex((clip) => clip.id === cutsClip.id) + 1
    : 1;
  // The slicer's manual trigger field is powered by the voice under this scene.
  const cutsNarration = cutsClip
    ? narrationForClip(cutsClip, project.clips, project.tracks)
    : null;
  const [sliceEditorOpen, setSliceEditorOpen] = useState(false);
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(false);
  const [sliceSettingsOpen, setSliceSettingsOpen] = useState(false);
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null);
  const [asr, setAsr] = useState<AsrConfig>(() => loadAsrConfig());
  const [asrJob, setAsrJob] = useState<{
    clipId: string;
    name: string;
    done: number;
    total: number;
    /** True when the drop started it, so the status chip can report it. */
    background?: boolean;
  } | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  // A background failure has no inspector to land in, so it gets a chip.
  const [asrNotice, setAsrNotice] = useState<{
    clipId: string;
    name: string;
    message: string;
  } | null>(null);
  // Voice clips that land on a Voice row are transcribed without being asked.
  // Jobs run one at a time — Whisper is slow, and the progress chip is singular
  // — so each drop joins a queue instead of starting a parallel request.
  const asrQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedTranscriptions = useRef(new Set<string>());
  const runTranscription = useRef<
    (clip: Clip, options?: { background?: boolean }) => Promise<void>
  >(async () => {});
  /**
   * Queues a freshly landed audio clip for transcription, if its row is a Voice
   * row. Music never qualifies, and a clip that already has words is skipped.
   */
  const queueAutoTranscription = useCallback((clip: Clip) => {
    if (queuedTranscriptions.current.has(clip.id)) return;
    const track = projectRef.current.tracks.find((item) => item.id === clip.trackId);
    if (!shouldAutoTranscribe(clip, track)) return;
    queuedTranscriptions.current.add(clip.id);
    asrQueue.current = asrQueue.current
      .then(async () => {
        // The project may have changed while this clip waited its turn.
        const fresh = projectRef.current.clips.find((item) => item.id === clip.id);
        if (!fresh) return;
        const currentTrack = projectRef.current.tracks.find((item) => item.id === fresh.trackId);
        if (!shouldAutoTranscribe(fresh, currentTrack)) return;
        await runTranscription.current(fresh, { background: true });
      })
      .catch(() => {
        // transcribeNarration reports its own failure; keep the queue moving.
      });
  }, []);
  const [cueDrafts, setCueDrafts] = useState<Record<string, string>>({});
  const [cueStatus, setCueStatus] = useState<string | null>(null);
  const [scriptDraft, setScriptDraft] = useState(() => project.settings.narrationScript ?? "");

  // A sync report belongs to the clip it was run on, not the next one selected.
  useEffect(() => {
    setCueStatus(null);
  }, [selectedId]);

  // Undo and a fresh project can change the script without the textarea being
  // touched, so the draft follows the stored value.
  useEffect(() => {
    setScriptDraft(project.settings.narrationScript ?? "");
  }, [project.settings.narrationScript]);

  const commitProject = useCallback(
    (next: Project | ((current: Project) => Project), options?: { silent?: boolean }) => {
      const current = projectRef.current;
      const updated = typeof next === "function" ? next(current) : next;
      if (updated === current) return;
      if (!options?.silent) {
        undoStack.current.push(current);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
      }
      projectRef.current = updated;
      setProject(updated);
      // A sync report describes one exact schedule. As soon as the project
      // changes — an undo, a trim, a hand-moved boundary — the counts stop
      // matching the timeline, so the report must go with it.
      if (!options?.silent) setCueStatus(null);
    },
    [],
  );

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(projectRef.current);
    projectRef.current = previous;
    setProject(previous);
    // The sync report counted a schedule that no longer exists.
    setCueStatus(null);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(projectRef.current);
    projectRef.current = next;
    setProject(next);
    setCueStatus(null);
  }, []);

  // When the engine reports how long the drawing naturally takes (on first load
  // or after a speed change), stretch the clip to that length and ripple the
  // rest of its row. Runs silently so undo only tracks user edits.
  const applyNaturalDuration = useCallback(
    (clipId: string, naturalSeconds: number) => {
      const seconds = whiteboardSceneSeconds(naturalSeconds);
      if (!seconds) return;
      commitProject(
        (current) => {
          const clip = current.clips.find((item) => item.id === clipId);
          if (
            !clip ||
            clip.mediaType !== "image" ||
            !resolveWhiteboard(clip, current.settings).enabled ||
            clip.durationLocked ||
            // A sliced cut is timed against its audio, so its length is the
            // authority — growing it here would drag every cue out of place.
            (clip.slices?.length ?? 0) > 0
          )
            return current;
          if (Math.abs(clip.duration - seconds) < 0.05) return current;
          const delta = seconds - clip.duration;
          return {
            ...current,
            clips: current.clips.map((item) => {
              if (item.id === clipId) return { ...item, duration: seconds };
              // Later clips on the same row move with the resized scene so gaps and
              // scene order are preserved.
              if (item.trackId === clip.trackId && item.start >= clip.start + clip.duration - 0.001)
                return { ...item, start: item.start + delta };
              return item;
            }),
          };
        },
        { silent: true },
      );
    },
    [commitProject],
  );

  // A global change must re-measure every scene that follows it: the clip length
  // is what keeps the hand speed identical from scene to scene.
  const fitFollowingScenes = useCallback(() => {
    if (fitTimer.current) window.clearTimeout(fitTimer.current);
    const run = fitRun.current + 1;
    fitRun.current = run;
    setFittingScenes(true);
    fitTimer.current = window.setTimeout(() => {
      void (async () => {
        const settings = projectRef.current.settings.whiteboard;
        if (!settings.enabled) {
          if (run === fitRun.current) setFittingScenes(false);
          return;
        }
        // Snapshot the targets so a scene added mid-fit is left for the next run.
        const targets = projectRef.current.clips.filter(
          (clip) => clip.mediaType === "image" && !clip.whiteboardOverride && !clip.durationLocked,
        );
        for (const target of targets) {
          if (run !== fitRun.current) return;
          const natural = await measureWhiteboardDuration(target.src, settings);
          if (run !== fitRun.current) return;
          if (natural > 0) applyNaturalDuration(target.id, natural);
        }
        if (run === fitRun.current) setFittingScenes(false);
      })();
    }, 300);
  }, [applyNaturalDuration]);

  const updateGlobalWhiteboard = (patch: Partial<WhiteboardConfig>) => {
    commitProject((current) => ({
      ...current,
      settings: {
        ...current.settings,
        whiteboard: makeWhiteboardConfig({ ...current.settings.whiteboard, ...patch }),
      },
    }));
  };

  /**
   * Stores the script once, on blur, so typing does not fill the undo stack.
   * An empty script means "no script": cue matching falls back to the words
   * that were actually heard.
   */
  const commitNarrationScript = useCallback(
    (text: string) => {
      const next = text.trim() ? text : "";
      if ((projectRef.current.settings.narrationScript ?? "") === next) return;
      commitProject((current) => ({
        ...current,
        settings: { ...current.settings, narrationScript: next || undefined },
      }));
    },
    [commitProject],
  );

  /** Drops every per-scene override so the global settings take over again. */
  const applyGlobalToAllScenes = () => {
    commitProject((current) => ({
      ...current,
      clips: current.clips.map((clip) =>
        clip.mediaType === "image" && clip.whiteboardOverride
          ? { ...clip, whiteboardOverride: false, whiteboard: undefined }
          : clip,
      ),
    }));
    fitFollowingScenes();
  };

  // Any settings change — including undoing one — re-fits the scenes that
  // follow it, so the timeline never keeps yesterday's timing.
  const lastGlobalWhiteboard = useRef(project.settings.whiteboard);
  useEffect(() => {
    if (lastGlobalWhiteboard.current === project.settings.whiteboard) return;
    lastGlobalWhiteboard.current = project.settings.whiteboard;
    fitFollowingScenes();
  }, [project.settings.whiteboard, fitFollowingScenes]);

  // Playback stops with the last picture — audio may run on, but there is
  // nothing left to watch. The strip also keeps a fixed tail past the last clip
  // of any kind rather than scrolling forever.
  const visualEnd = useMemo(
    () =>
      project.clips.reduce(
        (end, clip) => (clip.kind === "visual" ? Math.max(end, clip.start + clip.duration) : end),
        0,
      ),
    [project.clips],
  );
  const timelineEnd = useMemo(
    () => project.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
    [project.clips],
  );

  // If the last picture is removed or shortened, the playhead cannot stay parked
  // beyond it (scrubbing into a music-only tail is still allowed).
  useEffect(() => {
    if (playheadRef.current <= visualEnd) return;
    playheadRef.current = visualEnd;
    setPlayhead(visualEnd);
    setIsPlaying(false);
  }, [visualEnd]);

  /** Play/pause commits the clock on entry and exit; the playback loop owns it in between. */
  const togglePlayback = useCallback(() => {
    if (isPlaying) {
      const time = playheadRef.current;
      setIsPlaying(false);
      setPlayhead(time);
      return;
    }
    if (visualEnd <= 0) return;
    if (playheadRef.current >= visualEnd) {
      playheadRef.current = 0;
      setPlayhead(0);
    }
    setIsPlaying(true);
  }, [isPlaying, visualEnd]);
  // How many times each library file sits on the timeline, keyed by its blob URL.
  const clipUsage = useMemo(() => {
    const counts = new Map<string, number>();
    project.clips.forEach((clip) => counts.set(clip.src, (counts.get(clip.src) ?? 0) + 1));
    return counts;
  }, [project.clips]);
  const selectedMediaActive = project.clips.some(
    (clip) => clip.kind === "visual" && isTimelineRangeActive(clip, playhead),
  );
  // Video rows that still have audio to hand over; the row menu uses this to
  // avoid offering Audioship when there is nothing left to ship.
  const rowsWithUnshippedAudio = useMemo(
    () =>
      new Set(
        project.clips
          .filter((clip) => clip.mediaType === "video" && !clip.audioShipped)
          .map((clip) => clip.trackId),
      ),
    [project.clips],
  );
  // How many image scenes use the global animation settings and how many carry
  // their own — shown in the global settings panel.
  const sceneCounts = useMemo(() => {
    let following = 0;
    let custom = 0;
    project.clips.forEach((clip) => {
      if (clip.mediaType !== "image") return;
      if (clip.whiteboardOverride) custom += 1;
      else following += 1;
    });
    return { following, custom };
  }, [project.clips]);

  const rowNeighbours = useCallback(
    (trackId: string, excludeId?: string) =>
      projectRef.current.clips.filter((clip) => clip.trackId === trackId && clip.id !== excludeId),
    [],
  );

  const snapStart = useCallback((candidate: number, clipId: string, trackId: string) => {
    const boundaries = [0];
    projectRef.current.clips.forEach((clip) => {
      if (clip.id === clipId || clip.trackId !== trackId) return;
      boundaries.push(clip.start, clip.start + clip.duration);
    });
    const nearest = boundaries.reduce(
      (best, boundary) =>
        Math.abs(boundary - candidate) < Math.abs(best - candidate) ? boundary : best,
      candidate,
    );
    const snapped = Math.abs(nearest - candidate) <= 0.2 ? nearest : candidate;
    return Math.max(0, Math.round(snapped * 4) / 4);
  }, []);

  const placeMedia = useCallback(
    (item: MediaItem, trackId?: string, at?: number) => {
      const state = projectRef.current;
      const matchingTrack = compatibleTrackId(state.tracks, item.kind, item.mediaType, trackId);
      if (!matchingTrack) return;
      const rowClips = state.clips.filter((clip) => clip.trackId === matchingTrack);
      const position = nearestFreeStart(
        at ?? Math.max(0, ...rowClips.map((clip) => clip.start + clip.duration)),
        item.duration,
        rowClips,
      );
      const clip: Clip = {
        ...item,
        id: makeId(),
        trackId: matchingTrack,
        start: position,
      };
      commitProject((current) => ({ ...current, clips: [...current.clips, clip] }));
      setSelectedId(clip.id);
      // Landing on a Voice row is the whole gesture: transcribe it right away
      // so its words are ready before the user reaches the slicer.
      queueAutoTranscription(clip);
      // The library length was measured when the file was imported. If the
      // global animation settings changed since then, re-fit this scene so it
      // lands with the timing every other scene is using.
      if (clip.mediaType === "image") {
        const animation = resolveWhiteboard(clip, projectRef.current.settings);
        if (animation.enabled && !clip.durationLocked) {
          void measureWhiteboardDuration(clip.src, animation).then((natural) =>
            applyNaturalDuration(clip.id, natural),
          );
        }
      }
    },
    [applyNaturalDuration, commitProject, queueAutoTranscription],
  );

  const ingestFiles = useCallback(
    async (files: File[], forcedKind?: "audio", destination?: { trackId?: string; at: number }) => {
      for (const file of files) {
        const isImage = file.type.startsWith("image/");
        const isVideo = file.type.startsWith("video/");
        const isAudio = file.type.startsWith("audio/");
        if (!isImage && !isVideo && !isAudio) continue;
        const mediaKind: MediaKind = forcedKind ?? (isImage || isVideo ? "visual" : "audio");
        const mediaType: MediaItem["mediaType"] = isImage ? "image" : isVideo ? "video" : "audio";
        const src = URL.createObjectURL(file);
        let duration = IMAGE_SCENE_SECONDS;
        if (mediaType === "image") {
          // The scene is as long as the hand needs to finish the drawing, so the
          // animation is never squeezed or cut off by a fixed clip length.
          const natural = await measureWhiteboardDuration(
            src,
            projectRef.current.settings.whiteboard,
          );
          duration = whiteboardSceneSeconds(natural) || IMAGE_SCENE_SECONDS;
        } else {
          duration = await new Promise<number>((resolve) => {
            // A file Chromium cannot decode never fires loadedmetadata or error, so the
            // queue needs a deadline or one unreadable file stalls every later import.
            const url = URL.createObjectURL(file);
            let timer = 0;
            let settled = false;
            const finish = (value: number) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              URL.revokeObjectURL(url);
              resolve(value);
            };
            timer = window.setTimeout(() => finish(0), 4000);
            const probe = document.createElement(mediaType === "video" ? "video" : "audio");
            probe.preload = "metadata";
            probe.onloadedmetadata = () =>
              finish(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0);
            probe.onerror = () => finish(0);
            probe.src = url;
          });
        }
        if (duration <= 0) {
          URL.revokeObjectURL(src);
          continue;
        }
        const item: MediaItem = {
          id: makeId(),
          kind: mediaKind,
          mediaType,
          name: file.name,
          src,
          duration,
          sourceDuration: duration,
          sourceOffset: 0,
          size: file.size,
        };
        mediaUrls.current.push(item.src);
        setMedia((current) => [...current, item]);
        // Keep a copy in the browser so the library survives a reload.
        requestPersistentStorage();
        void storeMediaFile({
          id: item.id,
          name: item.name,
          kind: item.kind,
          mediaType: item.mediaType,
          duration: item.duration,
          size: item.size ?? file.size,
          createdAt: Date.now(),
          blob: file,
        }).catch((error) => console.error("Media could not be stored", error));
        // Imported files land in the library first. Only an explicit drop onto a
        // track or the canvas places a clip straight away.
        if (destination) placeMedia(item, destination.trackId, destination.at);
      }
    },
    [placeMedia],
  );

  // The library opens on Image. If there are no images (say the user only
  // imported music), fall back to the first section that has files so the
  // library is never an empty box.
  useEffect(() => {
    const libraryMedia = media.filter((item) => item.kind !== "voice");
    if (libraryMedia.some((item) => item.mediaType === libraryKind)) return;
    const fallback = LIBRARY_KINDS.find((kind) =>
      libraryMedia.some((item) => item.mediaType === kind.value),
    );
    if (fallback) setLibraryKind(fallback.value);
  }, [media, libraryKind]);

  // Imported files live in IndexedDB; rebuild their object URLs on startup so
  // the library is still there after a reload.
  const storedMediaLoaded = useRef(false);
  useEffect(() => {
    if (storedMediaLoaded.current) return;
    storedMediaLoaded.current = true;
    let disposed = false;
    void loadStoredMedia()
      .then((records) => {
        if (disposed || !records.length) return;
        const restored: MediaItem[] = records.map((record) => {
          const src = URL.createObjectURL(record.blob);
          mediaUrls.current.push(src);
          return {
            id: record.id,
            kind: record.kind,
            mediaType: record.mediaType,
            name: record.name,
            src,
            duration: record.duration,
            sourceDuration: record.duration,
            sourceOffset: 0,
            size: record.size,
          };
        });
        setMedia((current) => {
          const existing = new Set(current.map((item) => item.id));
          return [...restored.filter((item) => !existing.has(item.id)), ...current];
        });
      })
      .catch((error) => console.error("Stored media could not be restored", error));
    return () => {
      disposed = true;
    };
  }, []);

  const placeLibraryItem = useCallback(
    (item: MediaItem) => {
      placeMedia(item, undefined, playhead);
    },
    [placeMedia, playhead],
  );

  const selectLibraryItem = useCallback((id: string) => {
    setLibrarySelectedId(id);
    // Clicking a file previews it in CUTS; the next timeline selection takes over.
    setCutsSource("library");
  }, []);

  const importFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>, forcedKind?: "audio") => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      ingestFiles(files, forcedKind).catch((error) => {
        console.error("Import failed", error);
      });
    },
    [ingestFiles],
  );

  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLElement>, destination?: { trackId?: string; at: number }) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      void ingestFiles(files, undefined, destination ?? { at: playhead });
    },
    [ingestFiles, playhead],
  );

  const allowFileDrop = useCallback(
    (target: DropTarget) => (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget(target);
    },
    [],
  );

  const clearFileDrop = useCallback(
    (target: DropTarget) => (event: ReactDragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropTarget((current) => (isSameDropTarget(current, target) ? null : current));
    },
    [],
  );

  const timelineDropTime = useCallback(
    (clientX: number) => {
      const viewport = timelineRef.current;
      if (!viewport) return playhead;
      return timelineTimeAtPointer(
        clientX,
        viewport.getBoundingClientRect().left + railWidth(viewport),
        viewport.scrollLeft,
        zoom,
      );
    },
    [playhead, zoom],
  );

  const addTrack = useCallback(
    (category: TrackCategory, belowTrackId?: string) => {
      const kind: MediaKind =
        category === "video" || category === "image"
          ? "visual"
          : category === "voice"
            ? "voice"
            : "audio";
      commitProject((current) => {
        const track = {
          id: makeId(),
          kind,
          category,
          name: nextTrackName(current.tracks, category),
        };
        const insertionIndex = trackInsertionIndex(current.tracks, category, belowTrackId);
        return {
          ...current,
          tracks: [
            ...current.tracks.slice(0, insertionIndex),
            track,
            ...current.tracks.slice(insertionIndex),
          ],
        };
      });
    },
    [commitProject],
  );

  /**
   * Moves a video row's audio onto its own voice or music row, leaving the
   * picture behind. The extracted cut keeps the source clip's start, length and
   * in-point so playback stays in sync, and the source video is silenced so the
   * same voice cannot play twice. An occupied row is never displaced: the audio
   * gets a new row of its category instead.
   */
  const shipAudioToRow = useCallback(
    (sourceTrackId: string, target: "voice" | "music") => {
      const state = projectRef.current;
      const videos = state.clips
        .filter(
          (clip) =>
            clip.trackId === sourceTrackId &&
            clip.mediaType === "video" &&
            !clip.audioShipped,
        )
        .sort((a, b) => a.start - b.start);
      if (!videos.length) return;

      const category: TrackCategory = target === "voice" ? "voice" : "music";
      const tracks = [...state.tracks];
      let targetTrackId = emptyTrackId(tracks, category, state.clips);
      if (!targetTrackId) {
        const track: Track = {
          id: makeId(),
          kind: target === "voice" ? "voice" : "audio",
          category,
          name: nextTrackName(tracks, category),
        };
        tracks.splice(trackInsertionIndex(tracks, category), 0, track);
        targetTrackId = track.id;
      }

      const copies: Clip[] = videos.map((clip) => {
        // Scene-only fields would make the audio cut look like an image scene.
        const { slices, whiteboard, whiteboardOverride, ...audioSource } = clip;
        return {
          ...audioSource,
          id: makeId(),
          trackId: targetTrackId,
          kind: target === "voice" ? "voice" : "audio",
          mediaType: "audio",
          name: `${clip.name} · audio`,
          audioSourceClipId: clip.id,
        };
      });
      const shippedIds = new Set(videos.map((clip) => clip.id));

      commitProject((current) => ({
        ...current,
        tracks,
        clips: [
          ...current.clips.map((clip) =>
            shippedIds.has(clip.id) ? { ...clip, audioShipped: true } : clip,
          ),
          ...copies,
        ],
      }));
      setSelectedId(copies[0]?.id ?? null);
      // Shipped narration is transcribed as soon as it reaches the voice row;
      // a music row is left alone forever.
      if (target === "voice") copies.forEach(queueAutoTranscription);
    },
    [commitProject, queueAutoTranscription],
  );

  const removeTrack = useCallback(
    (trackId: string) => {
      if (!canRemoveTrack(trackId, projectRef.current.tracks, projectRef.current.clips)) return;
      commitProject((current) => ({
        ...current,
        tracks: current.tracks.filter((track) => track.id !== trackId),
      }));
    },
    [commitProject],
  );

  const toggleTrack = useCallback(
    (trackId: string, key: "muted" | "hidden") => {
      commitProject((current) => ({
        ...current,
        tracks: current.tracks.map((track) =>
          track.id === trackId ? { ...track, [key]: !track[key] } : track,
        ),
      }));
    },
    [commitProject],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commitProject((current) => {
      const removed = current.clips.find((clip) => clip.id === selectedId);
      const remaining = current.clips.filter((clip) => clip.id !== selectedId);
      // Deleting a shipped copy gives the sound back to its video, unless
      // another copy still plays it (a split half or a duplicate).
      const stillReferenced = new Set(
        remaining
          .map((clip) => clip.audioSourceClipId)
          .filter((id): id is string => Boolean(id)),
      );
      const restoredSourceId =
        removed?.audioSourceClipId && !stillReferenced.has(removed.audioSourceClipId)
          ? removed.audioSourceClipId
          : null;
      return {
        ...current,
        clips: remaining.map((clip) =>
          clip.id === restoredSourceId ? { ...clip, audioShipped: false } : clip,
        ),
        transitions: current.transitions.filter(
          (item) => item.leftId !== selectedId && item.rightId !== selectedId,
        ),
      };
    });
    setSelectedId(null);
  }, [commitProject, selectedId]);

  const duplicateSelected = useCallback(() => {
    if (!selectedClip) return;
    const duplicate = {
      ...selectedClip,
      id: makeId(),
      start: nearestFreeStart(
        selectedClip.start + selectedClip.duration,
        selectedClip.duration,
        rowNeighbours(selectedClip.trackId),
      ),
    };
    commitProject((current) => ({ ...current, clips: [...current.clips, duplicate] }));
    setSelectedId(duplicate.id);
  }, [commitProject, rowNeighbours, selectedClip]);

  const splitSelected = useCallback(() => {
    if (!selectedClip) return;
    const offset = playhead - selectedClip.start;
    if (offset <= 0.02 || offset >= selectedClip.duration - 0.02) return;
    const left = { ...selectedClip, duration: offset, durationLocked: true };
    const right = {
      ...selectedClip,
      id: makeId(),
      start: playhead,
      duration: selectedClip.duration - offset,
      sourceOffset: selectedClip.sourceOffset + offset,
      durationLocked: true,
    };
    commitProject((current) => ({
      ...current,
      clips: current.clips.flatMap((clip) =>
        clip.id === selectedClip.id ? [left, right] : [clip],
      ),
      transitions: current.transitions.filter(
        (item) => item.leftId !== selectedClip.id && item.rightId !== selectedClip.id,
      ),
    }));
    setSelectedId(right.id);
  }, [commitProject, playhead, selectedClip]);

  const copySelected = useCallback(() => {
    if (selectedClip) setCopiedClip(selectedClip);
  }, [selectedClip]);

  const pasteClip = useCallback(() => {
    if (!copiedClip) return;
    const clip = {
      ...copiedClip,
      id: makeId(),
      start: nearestFreeStart(
        snapStart(playhead, copiedClip.id, copiedClip.trackId),
        copiedClip.duration,
        rowNeighbours(copiedClip.trackId),
      ),
    };
    commitProject((current) => ({ ...current, clips: [...current.clips, clip] }));
    setSelectedId(clip.id);
  }, [commitProject, copiedClip, playhead, rowNeighbours, snapStart]);

  const beginRecording = useCallback(
    async (targetTrackId?: string) => {
      if (isRecording) return;
      setRecordingError(null);
      let capture: MediaStream | null = null;
      try {
        capture = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingStream.current = capture;
        const stream = capture;
        const recorder = new MediaRecorder(stream);
        const voiceTrackId =
          targetTrackId ?? projectRef.current.tracks.find((track) => track.kind === "voice")?.id;
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const duration = Math.max(0.1, (Date.now() - recordingStartedAt.current) / 1000);
          const item: MediaItem = {
            id: makeId(),
            kind: "voice",
            mediaType: "audio",
            name: `Voice recording ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            src: URL.createObjectURL(blob),
            duration,
            sourceOffset: 0,
            sourceDuration: duration,
            size: blob.size,
          };
          mediaUrls.current.push(item.src);
          setMedia((current) => [...current, item]);
          placeMedia(item, voiceTrackId, playhead);
          stream.getTracks().forEach((track) => track.stop());
          recordingStream.current = null;
          setIsRecording(false);
          setRecordingTrackId(null);
          setRecordingSeconds(0);
        };
        recordingStartedAt.current = Date.now();
        recorderRef.current = recorder;
        recorder.start();
        setRecordingTrackId(voiceTrackId ?? null);
        setIsRecording(true);
      } catch (error) {
        // The microphone is the one thing we cannot edit around. If it is blocked
        // or missing, say so instead of leaving the button looking dead.
        capture?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        recorderRef.current = null;
        setIsRecording(false);
        setRecordingTrackId(null);
        setRecordingSeconds(0);
        setRecordingError(recordingErrorMessage(error));
      }
    },
    [isRecording, placeMedia, playhead],
  );

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(
      () => setRecordingSeconds((Date.now() - recordingStartedAt.current) / 1000),
      100,
    );
    return () => window.clearInterval(timer);
  }, [isRecording]);

  // A failed microphone attempt should fade out rather than sit there forever.
  useEffect(() => {
    if (!recordingError) return;
    const timer = window.setTimeout(() => setRecordingError(null), 9000);
    return () => window.clearTimeout(timer);
  }, [recordingError]);

  const lastLayerKeyRef = useRef<string | null>(null);
  const mediaSyncFrames = useRef(0);

  /**
   * Paints one playback frame straight into the DOM.
   *
   * A `setPlayhead` tick used to re-render the whole editor — and re-seek every
   * preview stage — which, even with a handful of clips, only completed a few
   * times a second: the playhead and the strip moved in visible jumps. Painting
   * here runs at display rate instead, and React state is only committed when
   * the set of visible clips changes (a scene cut, or audio starting/stopping).
   */
  const paintPlaybackFrame = useCallback(
    (time: number) => {
      const state = projectRef.current;
      const pixelsPerSecond = zoomRef.current;
      if (playheadLineRef.current)
        playheadLineRef.current.style.left = `${time * pixelsPerSecond}px`;
      if (transportTimeRef.current) transportTimeRef.current.textContent = formatTime(time);
      if (previewTimecodeRef.current) previewTimecodeRef.current.textContent = formatTime(time);

      const hiddenTracks = new Set(
        state.tracks.filter((track) => track.hidden).map((track) => track.id),
      );
      const layers = transitionLayersAtTime(state.clips, state.transitions, time);
      const active = state.clips.filter(
        (clip) =>
          clip.kind === "visual" &&
          !hiddenTracks.has(clip.trackId) &&
          (isTimelineRangeActive(clip, time) || layers.has(clip.id)),
      );
      const stage = previewFrameRef.current;
      if (stage) {
        active.forEach((clip, index) => {
          const node = stage.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`);
          if (!node) return;
          node.style.zIndex = String(index + 2);
          const layer = layers.get(clip.id);
          const layerStyle = layer
            ? transitionFrameStyle(layer.effect, layer.progress, layer.side)
            : {};
          node.style.opacity = layerStyle.opacity === undefined ? "" : String(layerStyle.opacity);
          node.style.clipPath = layerStyle.clipPath ?? "";
          node.style.transform = layerStyle.transform ?? "";
        });
        let fade = 0;
        layers.forEach((layer) => {
          if (layer.effect === "fade-black")
            fade = Math.max(fade, fadeToBlackOverlayOpacity(layer.progress));
        });
        if (fadeOverlayRef.current) {
          fadeOverlayRef.current.style.opacity = String(fade);
          fadeOverlayRef.current.style.visibility = fade > 0 ? "visible" : "hidden";
        }
        // Seeks are incremental and cheap (well under a millisecond per frame), so
        // the drawing can follow the clock at display rate even while React rests.
        stage
          .querySelectorAll<HTMLElement>(".whiteboard-stage.is-active[data-clip-id]")
          .forEach((element) => {
            const clip = state.clips.find((item) => item.id === element.dataset["clipId"]);
            if (!clip) return;
            const host = (
              element.querySelector("iframe")?.contentWindow as
                | (Window & {
                    InkplainerHost?: {
                      ready?: boolean;
                      seek?: (local: number, duration: number) => unknown;
                    };
                  })
                | null
            )?.InkplainerHost;
            if (!host?.ready || !host.seek) return;
            try {
              // A sliced cut maps frame-for-frame; an unscheduled one still
              // holds the blank lead-in before the drawing starts.
              host.seek(
                whiteboardSeekSeconds(
                  Math.max(0, time - clip.start),
                  (clip.slices?.length ?? 0) > 0,
                ),
                clip.duration,
              );
            } catch {
              // A stage that is still booting simply stays where it is.
            }
          });
      }

      // Video and audio still play through their elements. Nudge any that drift a
      // few times a second instead of re-syncing them on every frame.
      if (mediaSyncFrames.current > 0) mediaSyncFrames.current -= 1;
      if (mediaSyncFrames.current === 0) {
        mediaSyncFrames.current = 30;
        state.clips.forEach((clip) => {
          if (clip.mediaType !== "video" && clip.mediaType !== "audio") return;
          const element =
            clip.mediaType === "video"
              ? videoRefs.current.get(clip.id)
              : audioRefs.current.get(clip.id);
          if (!element || element.paused) return;
          const localTime =
            clip.sourceOffset + Math.min(clip.duration, Math.max(0, time - clip.start));
          if (Math.abs(element.currentTime - localTime) > 0.35) element.currentTime = localTime;
        });
      }

      const viewport = timelineRef.current;
      if (viewport && viewport.clientWidth > 0) {
        const playheadPx = time * pixelsPerSecond;
        if (playbackAnchor.current === null) {
          // Start from wherever the playhead already sits; only bring it to the
          // middle when it is outside the visible part of the strip.
          const offset = playheadPx - viewport.scrollLeft;
          if (offset <= 0 || offset >= viewport.clientWidth) {
            playbackAnchor.current = 0.5;
            viewport.scrollLeft = Math.max(0, playheadPx - viewport.clientWidth / 2);
          } else {
            playbackAnchor.current = offset / viewport.clientWidth;
          }
        }
        viewport.scrollLeft = Math.max(
          0,
          playheadPx - playbackAnchor.current * viewport.clientWidth,
        );
      }

      const audioKey = state.clips
        .filter((clip) => clip.mediaType === "audio" && isTimelineRangeActive(clip, time))
        .map((clip) => clip.id)
        .join("|");
      // Prewarmed scenes must keep entering the window even though React no longer
      // re-renders every frame; mounting one is what lets the next scene open on a
      // loaded engine instead of a blank board. Keeping the next two warm mirrors
      // `prewarmLayers` so the set only changes at scene cuts.
      const activeIds = new Set(active.map((clip) => clip.id));
      const prewarmKey = state.clips
        .filter(
          (clip) =>
            clip.kind === "visual" &&
            clip.mediaType === "image" &&
            resolveWhiteboard(clip, state.settings).enabled &&
            !hiddenTracks.has(clip.trackId) &&
            !activeIds.has(clip.id) &&
            clip.start + clip.duration > time,
        )
        .sort((a, b) => a.start - b.start)
        .slice(0, 2)
        .map((clip) => clip.id)
        .join("|");
      const layerKey = `${active.map((clip) => clip.id).join("|")}#${prewarmKey}#${audioKey}`;
      if (lastLayerKeyRef.current === null) {
        lastLayerKeyRef.current = layerKey;
      } else if (layerKey !== lastLayerKeyRef.current) {
        lastLayerKeyRef.current = layerKey;
        // A scene change needs a real render to mount the incoming stage, but it
        // must not freeze the clock: a transition lets React work in short slices
        // between animation frames while the playhead keeps moving.
        startTransition(() => setPlayhead(time));
      }
    },
    [setPlayhead],
  );

  // A render can still happen mid-playback (a scene cut, a selection, a settings
  // change). Repaint before the browser paints so the frame never shows the
  // playhead's last committed position.
  useLayoutEffect(() => {
    if (!isPlaying) return;
    paintPlaybackFrame(playheadRef.current);
  });

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let last = -1;
    let currentTime = playheadRef.current;

    const tick = (now: number) => {
      // The first animation-frame timestamp can predate the effect, which would
      // make the clock step backwards (and rewind the whiteboard engine).
      if (last < 0) last = now;
      const next = currentTime + Math.max(0, (now - last) / 1000);
      last = now;
      currentTime = next;
      playheadRef.current = next;
      if (next >= visualEnd) {
        playheadRef.current = visualEnd;
        setPlayhead(visualEnd);
        setIsPlaying(false);
        return;
      }
      paintPlaybackFrame(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, visualEnd, paintPlaybackFrame]); // Playback starts at the current playhead; the animation owns its clock.

  useEffect(() => {
    const mutedTracks = new Set(
      project.tracks.filter((track) => track.muted).map((track) => track.id),
    );
    const activeVisuals = project.clips.filter(
      (clip) => clip.kind === "visual" && isTimelineRangeActive(clip, playhead),
    );
    const hasAnyClip = project.clips.some((clip) => isTimelineRangeActive(clip, playhead));
    project.clips
      .filter((clip) => clip.mediaType === "video")
      .forEach((clip) => {
        const element = videoRefs.current.get(clip.id);
        if (!element) return;
        const active = isPlaying && activeVisuals.some((item) => item.id === clip.id);
        const localTime =
          clip.sourceOffset + Math.min(clip.duration, Math.max(0, playhead - clip.start));
        if (Math.abs(element.currentTime - localTime) > 0.35) element.currentTime = localTime;
        element.muted = !active || mutedTracks.has(clip.trackId) || Boolean(clip.audioShipped);
        if (active && element.paused) void element.play().catch(() => undefined);
        if (!active && !element.paused) element.pause();
      });
    project.clips
      .filter((clip) => clip.mediaType === "audio")
      .forEach((clip) => {
        const element = audioRefs.current.get(clip.id);
        if (!element) return;
        const active = isPlaying && isTimelineRangeActive(clip, playhead);
        const localTime =
          clip.sourceOffset + Math.min(clip.duration, Math.max(0, playhead - clip.start));
        if (Math.abs(element.currentTime - localTime) > 0.35) element.currentTime = localTime;
        element.muted = !hasAnyClip || mutedTracks.has(clip.trackId);
        if (active && element.paused) void element.play().catch(() => undefined);
        if (!active && !element.paused) element.pause();
      });
  }, [isPlaying, playhead, project.clips, project.tracks]);

  // The playback loop owns the scroll while playing; dropping the anchor on stop
  // lets the next Play re-evaluate where the playhead sits on screen.
  useEffect(() => {
    if (!isPlaying) playbackAnchor.current = null;
  }, [isPlaying]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
        return;
      // Some environments deliver a space without a `code`, so match the key too.
      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlayback();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        copySelected();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        pasteClip();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelected, deleteSelected, pasteClip, redo, togglePlayback, undo]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const clip = projectRef.current.clips.find((item) => item.id === drag.clipId);
      if (!clip) return;
      heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      // Screen delta plus however far the strip scrolled under the pointer.
      const scrolled = (timelineRef.current?.scrollLeft ?? 0) - drag.startLeft;
      const raw = Math.max(0, drag.originalStart + (event.clientX - drag.startX + scrolled) / zoom);
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-track-id]");
      const targetTrackId = target?.dataset["trackId"];
      const track = projectRef.current.tracks.find(
        (item) => item.id === targetTrackId && isTrackCompatible(item, clip.mediaType),
      );
      const nextTrackId = track?.id ?? drag.trackId;
      // Follow the pointer freely while held — snapping to a free slot on every
      // move made the clip jump (often off-screen); it settles when dropped.
      setDrag({ ...drag, nextStart: raw, nextTrackId });
    };
    const onUp = () => {
      const dragged = projectRef.current.clips.find((item) => item.id === drag.clipId);
      const pointer = heldPointer.current;
      let nextStart = drag.nextStart;
      let nextTrackId = drag.nextTrackId;
      // The edge auto-scroll moves the clip's preview directly, so settle the
      // real position from the pointer and the strip's final scroll.
      if (pointer && dragged) {
        const scrolled = (timelineRef.current?.scrollLeft ?? 0) - drag.startLeft;
        const raw = Math.max(0, drag.originalStart + (pointer.x - drag.startX + scrolled) / zoom);
        const target = document
          .elementFromPoint(pointer.x, pointer.y)
          ?.closest<HTMLElement>("[data-track-id]");
        const track = projectRef.current.tracks.find(
          (item) =>
            item.id === target?.dataset["trackId"] && isTrackCompatible(item, dragged.mediaType),
        );
        nextTrackId = track?.id ?? drag.trackId;
        nextStart = nearestFreeStart(
          snapStart(raw, dragged.id, nextTrackId),
          dragged.duration,
          rowNeighbours(nextTrackId, dragged.id),
        );
      }
      heldPointer.current = null;
      if (nextStart !== drag.originalStart || nextTrackId !== drag.trackId) {
        commitProject((current) => ({
          ...current,
          clips: current.clips.map((item) =>
            item.id === drag.clipId ? { ...item, start: nextStart, trackId: nextTrackId } : item,
          ),
        }));
        // Dragging audio onto a Voice row is another way to land narration
        // there, so it gets the same automatic transcription as a drop.
        if (nextTrackId !== drag.trackId) {
          const moved = projectRef.current.clips.find((item) => item.id === drag.clipId);
          if (moved) queueAutoTranscription(moved);
        }
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [commitProject, drag, queueAutoTranscription, rowNeighbours, snapStart, zoom]);

  useEffect(() => {
    if (!trimDrag) return;
    const onMove = (event: PointerEvent) => {
      heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      const scrolled = (timelineRef.current?.scrollLeft ?? 0) - trimDrag.startLeft;
      setTrimDrag({ ...trimDrag, delta: (event.clientX - trimDrag.startX + scrolled) / zoom });
    };
    const onUp = () => {
      const pointer = heldPointer.current;
      // The last throttled gesture re-dispatch can trail the strip, so settle
      // the trim from the pointer's final position.
      const delta = pointer
        ? (pointer.x -
            trimDrag.startX +
            ((timelineRef.current?.scrollLeft ?? 0) - trimDrag.startLeft)) /
          zoom
        : trimDrag.delta;
      heldPointer.current = null;
      const trimmed = trimClipWithin(
        trimDrag.original,
        trimDrag.edge,
        delta,
        rowNeighbours(trimDrag.original.trackId, trimDrag.clipId),
      );
      if (
        trimmed.start !== trimDrag.original.start ||
        trimmed.duration !== trimDrag.original.duration ||
        trimmed.sourceOffset !== trimDrag.original.sourceOffset
      ) {
        commitProject((current) => ({
          ...current,
          clips: current.clips.map((clip) =>
            clip.id === trimDrag.clipId
              ? {
                  ...clip,
                  start: trimmed.start,
                  duration: trimmed.duration,
                  sourceOffset: trimmed.sourceOffset,
                  durationLocked: true,
                }
              : clip,
          ),
        }));
      }
      setTrimDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [commitProject, rowNeighbours, trimDrag, zoom]);

  // Holding a clip, trim handle or the playhead near either end of the strip
  // scrolls the strip and re-applies the gesture against the new scroll
  // position, so a clip can be trimmed or thrown from one end to the other.
  useEffect(() => {
    if (!drag && !trimDrag && !sliceDrag && !scrubHeld) return;
    const viewport = timelineRef.current;
    if (!viewport) return;
    const EDGE_ZONE = 64;
    const SPEED = 1800; // px per second at the very edge
    let frame = 0;
    let lastTime = 0;
    let lastApplied = 0;
    const step = (now: number) => {
      const elapsed = lastTime ? Math.min(80, now - lastTime) : 16;
      lastTime = now;
      const pointer = heldPointer.current;
      if (pointer) {
        const rect = viewport.getBoundingClientRect();
        const left = rect.left + railWidth(viewport);
        const right = Math.min(rect.right, left + viewport.clientWidth);
        const toLeft = Math.min(1, Math.max(0, (left + EDGE_ZONE - pointer.x) / EDGE_ZONE));
        const toRight = Math.min(1, Math.max(0, (pointer.x - (right - EDGE_ZONE)) / EDGE_ZONE));
        const depth = toRight - toLeft;
        if (depth !== 0) {
          const before = viewport.scrollLeft;
          viewport.scrollLeft = Math.max(
            0,
            before + Math.sign(depth) * depth * depth * SPEED * (elapsed / 1000),
          );
          if (viewport.scrollLeft !== before) {
            if (drag) {
              // A dragged clip glides with the strip without re-rendering the
              // editor; the snapped position is settled when the pointer lifts.
              const element = viewport.querySelector<HTMLElement>(".clip-block.dragging");
              if (element) {
                const scrolled = viewport.scrollLeft - drag.startLeft;
                const preview = Math.max(
                  0,
                  drag.originalStart + (pointer.x - drag.startX + scrolled) / zoom,
                );
                element.style.left = `${preview * zoom}px`;
              }
            } else if (now - lastApplied > 40) {
              // Scrubbing and trimming re-render the editor, so re-apply those
              // gestures in steps while the strip itself keeps gliding.
              lastApplied = now;
              viewport.dispatchEvent(
                new PointerEvent("pointermove", {
                  bubbles: true,
                  cancelable: true,
                  pointerId: pointer.id,
                  pointerType: "mouse",
                  isPrimary: true,
                  button: 0,
                  buttons: 1,
                  clientX: pointer.x,
                  clientY: pointer.y,
                }),
              );
            }
          }
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [drag, trimDrag, sliceDrag, scrubHeld]);

  useEffect(
    () => () => {
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      mediaUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(
    () => () => {
      if (fitTimer.current) window.clearTimeout(fitTimer.current);
    },
    [],
  );

  // Warm the measuring engine while the editor is idle so image imports can lay
  // scenes down at their natural length without a visible delay.
  useEffect(() => {
    warmUpWhiteboardMeasurement();
  }, []);

  const updateTransition = (transitionId: string, change: Partial<Transition>) => {
    commitProject((current) => ({
      ...current,
      transitions: current.transitions.map((item) =>
        item.id === transitionId ? { ...item, ...change } : item,
      ),
    }));
  };

  const updateClip = useCallback(
    (clipId: string, patch: Partial<Clip>) => {
      commitProject((current) => ({
        ...current,
        clips: current.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
      }));
    },
    [commitProject],
  );

  const updateWhiteboard = (patch: Partial<WhiteboardConfig>) => {
    if (!selectedClip) return;
    // Touching any control turns the scene into a custom one, so later global
    // changes leave it alone while the rest of the timeline keeps moving.
    const base = resolveWhiteboard(selectedClip, projectRef.current.settings);
    updateClip(selectedClip.id, {
      whiteboardOverride: true,
      whiteboard: makeWhiteboardConfig({ ...base, ...patch }),
    });
  };

  const resetClipWhiteboard = (clipId: string) => {
    updateClip(clipId, { whiteboardOverride: false, whiteboard: undefined });
  };

  /** Writes a slice list back to the clip and re-measures it via its stage. */
  const applyClipSlices = (clip: Clip, slices: SliceShape[]) => {
    const next = normalizeSlices(slices);
    const animation = resolveWhiteboard(clip, projectRef.current.settings);
    const countChanged = next.length !== (clip.slices?.length ?? 0);
    updateClip(clip.id, {
      slices: next.length ? next : undefined,
      // Every slice adds paint plus a hand exit and re-entry, so the scene has
      // to be allowed to grow even if the clip was trimmed before it was sliced.
      ...(next.length && countChanged ? { durationLocked: false } : {}),
      ...(next.length && !animation.enabled
        ? {
            whiteboardOverride: true,
            whiteboard: makeWhiteboardConfig({ ...animation, enabled: true }),
          }
        : {}),
    });
  };

  const addSlice = (points: SlicePoint[]) => {
    if (!cutsClip) return;
    const existing = cutsClip.slices ?? [];
    const nextNumber = existing.length + 1;
    // Drawn borders get the same minimum as imported ones, so every slice in
    // the editor can be reshaped the same way.
    const slice: SliceShape = {
      id: makeId(),
      number: nextNumber,
      order: nextNumber,
      points: ensureMinimumPoints(points).points,
    };
    applyClipSlices(cutsClip, [...existing, slice]);
    setSelectedSliceId(slice.id);
  };

  /** Writes a border the user reshaped in the slicer. One drag, one undo step. */
  const changeSlicePoints = (sliceId: string, points: SlicePoint[]) => {
    if (!cutsClip) return;
    applyClipSlices(
      cutsClip,
      (cutsClip.slices ?? []).map((slice) =>
        slice.id === sliceId ? { ...slice, points } : slice,
      ),
    );
  };

  const reorderSlice = (id: string, order: number) => {
    if (!cutsClip) return;
    applyClipSlices(cutsClip, reorderSlices(cutsClip.slices ?? [], id, order));
  };

  const deleteSlice = (id: string) => {
    if (!cutsClip) return;
    applyClipSlices(
      cutsClip,
      (cutsClip.slices ?? []).filter((slice) => slice.id !== id),
    );
    setSelectedSliceId((current) => (current === id ? null : current));
  };

  const clearSlices = () => {
    if (!cutsClip) return;
    applyClipSlices(cutsClip, []);
    setSelectedSliceId(null);
  };

  /**
   * Imports borders authored outside the editor. Geometry and order come from
   * the map; nothing about time does. An invalid map changes nothing at all, so
   * a bad paste can never leave the image half-sliced.
   */
  const importSliceMap = (text: string): SliceMapReport => {
    const report = parseSliceMap(text, { fileName: cutsClip?.name });
    if (report.errors.length > 0 || !cutsClip) return report;

    const shapes: SliceShape[] = report.slices.map((slice, index) => ({
      id: makeId(),
      number: slice.number ?? index + 1,
      order: slice.order,
      points: slice.points.map((point) => ({ x: point.x, y: point.y })),
      ...(slice.cue ? { cue: slice.cue } : {}),
    }));
    applyClipSlices(cutsClip, shapes);
    setSelectedSliceId(shapes[0]?.id ?? null);
    return report;
  };

  /**
   * Writes one slice's authored timing. Only the inputs live on the clip; the
   * start, lag and hold they produce are always re-derived, so moving a
   * neighbour is enough to reschedule the rest of the cut.
   */
  const patchSliceTiming = useCallback(
    (
      clipId: string,
      sliceId: string,
      patch: Partial<NonNullable<SliceShape["timing"]>>,
    ) => {
      commitProject((current) => ({
        ...current,
        clips: current.clips.map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                slices: (clip.slices ?? []).map((slice) =>
                  slice.id === sliceId ? { ...slice, timing: { ...slice.timing, ...patch } } : slice,
                ),
              }
            : clip,
        ),
      }));
    },
    [commitProject],
  );

  /** Remembers where the narration worker lives; never written into the project. */
  const updateAsr = useCallback((patch: Partial<AsrConfig>) => {
    setAsr((current) => {
      const next = { ...current, ...patch };
      saveAsrConfig(next);
      return next;
    });
  }, []);

  /**
   * Transcribes one narration clip and hangs the words on that clip.
   *
   * The transcript is derived data, not an edit: it is written silently so undo
   * never throws away a transcription the user waited minutes for. Re-running it
   * overwrites the words in place.
   */
  const transcribeNarration = useCallback(
    async (clip: Clip, options?: { background?: boolean }) => {
      const background = options?.background === true;
      setAsrError(null);
      const track = projectRef.current.tracks.find((item) => item.id === clip.trackId);
      if (track?.category !== "voice") {
        setAsrError("Whisper only transcribes voice rows. Move this audio to a Voice row first.");
        return;
      }
      setAsrJob({
        clipId: clip.id,
        name: clip.name,
        done: 0,
        total: 0,
        ...(background ? { background: true } : {}),
      });
      try {
        const response = await fetch(clip.src);
        if (!response.ok) throw new Error(`Could not read "${clip.name}".`);
        const blob = await response.blob();
        const transcript = await transcribeAudio(blob, {
          endpoint: DEFAULT_ASR_ENDPOINT,
          language: asr.language || undefined,
          onProgress: (done, total) =>
            setAsrJob({
              clipId: clip.id,
              name: clip.name,
              done,
              total,
              ...(background ? { background: true } : {}),
            }),
        });
        commitProject(
          (current) => ({
            ...current,
            clips: current.clips.map((item) =>
              item.id === clip.id ? { ...item, transcript } : item,
            ),
          }),
          { silent: true },
        );
        if (!transcript.words.length) {
          setAsrError("No speech was found in this clip.");
        }
        setAsrNotice((current) => (current?.clipId === clip.id ? null : current));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Transcription failed.";
        setAsrError(message);
        // A background job has no open inspector to show the reason, so leave a
        // chip on the timeline naming the voice that failed.
        if (background) setAsrNotice({ clipId: clip.id, name: clip.name, message });
      } finally {
        setAsrJob(null);
      }
    },
    [asr, commitProject],
  );

  // The queue is built before this callback exists, so it reaches it by ref.
  useEffect(() => {
    runTranscription.current = transcribeNarration;
  }, [transcribeNarration]);

  /**
   * Saves one slice's cue phrase. Drafts live in component state so typing does
   * not push a history entry per keystroke; this runs on blur or Enter and only
   * records a commit when the phrase actually changed.
   *
   * Returns true when a cue changed, so the caller can re-run alignment.
   */
  const commitSliceCue = useCallback(
    (clipId: string, sliceId: string, cue: string) => {
      const trimmed = cue.replace(/\s+/g, " ").trim();
      setCueDrafts((current) => {
        if (!(sliceId in current)) return current;
        const next = { ...current };
        delete next[sliceId];
        return next;
      });
      const clip = projectRef.current.clips.find((item) => item.id === clipId);
      const slice = clip?.slices?.find((item) => item.id === sliceId);
      if (!clip || !slice || (slice.cue ?? "") === trimmed) return false;
      commitProject((current) => ({
        ...current,
        clips: current.clips.map((item) =>
          item.id === clipId
            ? {
                ...item,
                slices: (item.slices ?? []).map((entry) =>
                  entry.id === sliceId
                    ? {
                        ...entry,
                        cue: trimmed || undefined,
                        ...(entry.timing?.estimated === true
                          ? { timing: { ...entry.timing, estimated: false } }
                          : {}),
                      }
                    : entry,
                ),
              }
            : item,
        ),
      }));
      return true;
    },
    [commitProject],
  );

  /**
   * Resolves every cue on this image against the narration underneath it and
   * writes the resulting reveals in one history entry. Cues that are not spoken,
   * or that belong to another scene, are reported instead of approximated.
   */
  const syncCuesToNarration = useCallback(
    (clip: Clip) => {
      const narration = narrationForClip(clip, projectRef.current.clips, projectRef.current.tracks);
      if (!narration) {
        setCueStatus("Add narration audio under this image, then transcribe it.");
        return;
      }

      const ordered = [...(clip.slices ?? [])].sort((a, b) => a.order - b.order);
      // A scene is as long as the narration that belongs to it. The picture's
      // natural draw time is only a floor: cues spoken at 12 s must not be
      // squeezed into a 9 s cut. Growth stops at whatever comes next — the next
      // clip on this row, or the end of the voice itself.
      const nextStart = projectRef.current.clips
        .filter(
          (item) =>
            item.trackId === clip.trackId && item.id !== clip.id && item.start > clip.start + 0.001,
        )
        .reduce((earliest, item) => Math.min(earliest, item.start), Number.POSITIVE_INFINITY);
      const ceiling = Math.min(narration.endSeconds, nextStart - clip.start);
      const maxDuration = Math.max(clip.duration, ceiling);
      const options = {
        offsetSeconds: narration.offsetSeconds,
        clipDuration: clip.duration,
        maxDuration,
        candidates: narrationBeats(narration.transcript.words),
      };

      // With a script, alignment happens once for the whole scene: the script
      // text is the source of truth for wording, and the transcript only says
      // when those words were heard. Without one, fall back to matching each
      // cue directly against the transcript.
      const script = (projectRef.current.settings.narrationScript ?? "").trim();
      const cueBeats = ordered
        .filter((slice) => (slice.cue ?? "").trim())
        .map((slice) => ({ id: slice.id, cue: (slice.cue ?? "").trim() }));
      const alignment = script
        ? alignScriptToTranscript(script, cueBeats, narration.transcript.words)
        : null;
      const result = alignment
        ? syncSliceBeats(
            ordered,
            alignment.beats.map((beat) => ({
              id: beat.id,
              cue: beat.cue,
              anchor: beat.anchor,
            })),
            options,
          )
        : syncSliceCues(ordered, narration.transcript.words, options);

      // Grow to the voice, or a little past the final reveal if that drawing
      // runs longer than the words. Never shrink: a scene the user lengthened
      // by hand stays that way.
      const needed = Math.max(ceiling, result.spanEnd + SLICE_END_HOLD);
      const duration = Math.max(
        clip.duration,
        Math.round(Math.min(maxDuration, needed) * 100) / 100,
      );
      const grows = duration > clip.duration + 0.01;

      if (result.patches.length || grows) {
        const patches = new Map(result.patches.map((entry) => [entry.id, entry.timing]));
        commitProject((current) => ({
          ...current,
          clips: current.clips.map((item) =>
            item.id === clip.id
              ? {
                  ...item,
                  ...(grows ? { duration } : {}),
                  slices: (item.slices ?? []).map((slice) => {
                    const timing = patches.get(slice.id);
                    return timing ? { ...slice, timing: { ...slice.timing, ...timing } } : slice;
                  }),
                }
              : item,
          ),
        }));
      }

      const parts: string[] = [];
      const timed = result.patches.length - result.estimated.length;
      if (timed) parts.push(`${timed} timed`);
      if (result.estimated.length) {
        // Explain *why* these were fitted, but never count them twice: they are
        // already in `estimated`, not in the miss tally.
        const fitted = new Set(result.estimated);
        const reasons = alignment
          ? alignment.misses.filter((miss) => fitted.has(miss.id)).map((miss) => miss.reason)
          : [];
        const reason =
          reasons.length === 1
            ? reasons[0] === "not-in-script"
              ? "not in the script"
              : "not spoken"
            : null;
        parts.push(`${result.estimated.length} estimated${reason ? ` (${reason})` : ""}`);
      }
      if (alignment?.weak.length) parts.push(`${alignment.weak.length} uncertain`);
      if (result.missing.length) {
        parts.push(
          alignment
            ? `${result.missing.length} could not be placed`
            : `${result.missing.length} not in the narration`,
        );
      }
      if (result.noCue.length) parts.push(`${result.noCue.length} without a cue`);
      if (result.clamped.length) parts.push(`${result.clamped.length} pushed later`);
      setCueStatus(parts.length ? parts.join(" · ") : "This image has no slices yet.");
    },
    [commitProject],
  );

  /**
   * Re-aligns one image from its newest slices.
   *
   * Alignment is part of writing a cue, not a second action: the schedule the
   * editor needs is derived as soon as the words change. An image whose slices
   * have no cues at all is left alone so its default timing is not overwritten.
   */
  const alignCuesForClip = useCallback(
    (clipId: string) => {
      const clip = projectRef.current.clips.find((item) => item.id === clipId);
      if (!clip || clip.mediaType !== "image") return;
      if (!(clip.slices ?? []).some((slice) => (slice.cue ?? "").trim())) return;
      syncCuesToNarration(clip);
    },
    [syncCuesToNarration],
  );

  /**
   * Manual trigger phrases from the slicer.
   *
   * This is the authoring path that starts from the voice instead of the
   * script: the user picks a slice and types words Whisper actually heard. It
   * stays unavailable until the scene has a transcribed voice, and it refuses
   * phrases the transcript does not contain, so a cue can never point at
   * silence. A saved phrase aligns the scene immediately.
   */
  const setSlicerCue = useCallback(
    (sliceId: string, cue: string) => {
      if (!cutsClip) return "No scene is open in the slicer.";
      const state = projectRef.current;
      const narration = narrationForClip(cutsClip, state.clips, state.tracks);
      if (!narration) {
        return "Upload the voice for this scene and transcribe it first.";
      }
      const trimmed = cue.replace(/\s+/g, " ").trim();
      if (trimmed && !transcriptHasPhrase(narration.transcript.words, trimmed)) {
        return "Those words are not in the voice transcript. Copy a phrase from the transcript below.";
      }
      if (commitSliceCue(cutsClip.id, sliceId, trimmed)) alignCuesForClip(cutsClip.id);
      return null;
    },
    [alignCuesForClip, commitSliceCue, cutsClip],
  );

  /**
   * One click from the slicer to the preview: resolve every cue against the
   * voice, close the slicer, and play the scene from its first frame so the
   * reveals can be watched instead of read as a report.
   */
  const autoAlignAndPreview = useCallback(() => {
    if (!cutsClip) return;
    alignCuesForClip(cutsClip.id);
    const clip = projectRef.current.clips.find((item) => item.id === cutsClip.id) ?? cutsClip;
    setSliceEditorOpen(false);
    setSelectedSliceId(null);
    playheadRef.current = clip.start;
    setPlayhead(clip.start);
    setIsPlaying(true);
  }, [alignCuesForClip, cutsClip]);

  // A transcript that just landed can place cues that were written before the
  // voice existed, so alignment follows Whisper instead of waiting for a click.
  const alignedTranscripts = useRef(new Map<string, unknown>());
  useEffect(() => {
    const state = projectRef.current;
    const fresh = state.clips.filter((clip) => {
      if (clip.mediaType !== "audio" || !clip.transcript) return false;
      if (alignedTranscripts.current.get(clip.id) === clip.transcript) return false;
      alignedTranscripts.current.set(clip.id, clip.transcript);
      return true;
    });
    if (!fresh.length) return;
    fresh.forEach((voice) => {
      state.clips.forEach((image) => {
        if (image.mediaType !== "image") return;
        if (!(image.slices ?? []).some((slice) => (slice.cue ?? "").trim())) return;
        if (narrationForClip(image, state.clips, state.tracks)?.clipId !== voice.id) return;
        syncCuesToNarration(image);
      });
    });
  }, [project.clips, syncCuesToNarration]);

  /** Turns a finished boundary drag into authored timing on the clip. */
  const applySliceDrag = useCallback(
    (gesture: SliceDragState, delta: number) => {
      const clip = gesture.original;
      const ordered = [...(clip.slices ?? [])].sort((a, b) => a.order - b.order);
      const { slices: timings } = resolveSliceTiming(ordered, clip.duration);
      const index = ordered.findIndex((slice) => slice.id === gesture.sliceId);
      const timing = timings[index];
      if (!timing) return;
      const round = (value: number) => Math.round(value * 100) / 100;

      if (gesture.edge === "start") {
        const previousEnd = timings[index - 1]?.animEnd ?? 0;
        const start = clampTo(
          timing.start + delta,
          previousEnd,
          Math.max(previousEnd, timing.animEnd - MIN_SLICE_ANIMATION),
        );
        if (Math.abs(start - timing.start) < 0.005) return;
        // Taking the boundary off its cue is exactly what `startOverride`
        // records, so the resolver stops re-anchoring this slice. A hand-placed
        // slice is no longer an estimate.
        patchSliceTiming(clip.id, gesture.sliceId, { startOverride: round(start), estimated: false });
        return;
      }

      const nextStart = timings[index + 1]?.start ?? clip.duration;
      const animation = clampTo(
        timing.animation + delta,
        MIN_SLICE_ANIMATION,
        Math.max(MIN_SLICE_ANIMATION, nextStart - timing.start),
      );
      if (Math.abs(animation - timing.animation) < 0.005) return;
      patchSliceTiming(clip.id, gesture.sliceId, { animation: round(animation), estimated: false });
    },
    [patchSliceTiming],
  );

  // A boundary drag previews directly from its pointer delta (see ClipSlices)
  // and only writes timing on release, so a slow drag never floods the project
  // history with intermediate states.
  useEffect(() => {
    if (!sliceDrag) return;
    const onMove = (event: PointerEvent) => {
      heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      const scrolled = (timelineRef.current?.scrollLeft ?? 0) - sliceDrag.startLeft;
      setSliceDrag({ ...sliceDrag, delta: (event.clientX - sliceDrag.startX + scrolled) / zoom });
    };
    const onUp = () => {
      const pointer = heldPointer.current;
      const delta = pointer
        ? (pointer.x -
            sliceDrag.startX +
            ((timelineRef.current?.scrollLeft ?? 0) - sliceDrag.startLeft)) /
          zoom
        : sliceDrag.delta;
      heldPointer.current = null;
      applySliceDrag(sliceDrag, delta);
      setSliceDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applySliceDrag, sliceDrag, zoom]);

  const beginSliceBoundaryDrag = (
    event: ReactPointerEvent<HTMLSpanElement>,
    clip: Clip,
    slice: SliceShape,
    edge: SliceBoundary,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(clip.id);
    setCutsSource("timeline");
    setSelectedTransition(null);
    heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setSliceDrag({
      clipId: clip.id,
      sliceId: slice.id,
      edge,
      startX: event.clientX,
      startLeft: timelineRef.current?.scrollLeft ?? 0,
      delta: 0,
      original: clip,
    });
  };

  /**
   * The three fixes a too-tight reveal is allowed to have. Each one is a real
   * edit the user asked for — nothing here quietly guesses a new schedule.
   */
  const sliceFlagAction = (
    clip: Clip,
    slice: SliceShape,
    action: SliceFlagAction,
    value?: number,
  ) => {
    if (action === "drop") {
      applyClipSlices(
        clip,
        (clip.slices ?? []).filter((item) => item.id !== slice.id),
      );
      return;
    }
    if (action === "widen-cue") {
      // Crossing the clause break is what lets an earlier cue be borrowed when
      // the tight one sits too late in its sentence.
      patchSliceTiming(clip.id, slice.id, {
        anchorWindow: ANCHOR_WINDOW_SECONDS * 2,
        crossClause: true,
      });
      return;
    }
    if (value === undefined) return;
    patchSliceTiming(clip.id, slice.id, { animation: Math.round(value * 100) / 100 });
  };

  /**
   * Opens the slicer for whatever CUTS is showing. A library image that is not
   * on the timeline yet is placed first, so its slices have a clip to live on.
   */
  const openCutSlicer = () => {
    setSelectedSliceId(null);
    // The slicer takes over the screen, so the quick settings list steps aside.
    setSliceSettingsOpen(false);
    if (!cutsClip && libraryImage) placeLibraryItem(libraryImage);
    setSliceEditorOpen(true);
  };

  const addOrSelectTransition = (left: Clip, right: Clip) => {
    const existing = project.transitions.find(
      (item) => item.leftId === left.id && item.rightId === right.id,
    );
    if (existing) {
      setSelectedTransition(existing.id);
      return;
    }
    const transition: Transition = {
      id: makeId(),
      leftId: left.id,
      rightId: right.id,
      effect: "crossfade",
      duration: 0.5,
    };
    commitProject((current) => ({ ...current, transitions: [...current.transitions, transition] }));
    setSelectedTransition(transition.id);
  };

  const transitionLayers = useMemo(
    () => transitionLayersAtTime(project.clips, project.transitions, playhead),
    [project.clips, project.transitions, playhead],
  );

  const previewLayers = useMemo(() => {
    const hiddenTracks = new Set(
      project.tracks.filter((track) => track.hidden).map((track) => track.id),
    );
    return project.clips.filter(
      (clip) =>
        clip.kind === "visual" &&
        !hiddenTracks.has(clip.trackId) &&
        (isTimelineRangeActive(clip, playhead) || transitionLayers.has(clip.id)),
    );
  }, [project.clips, project.tracks, playhead, transitionLayers]);

  // Image scenes are prewarmed shortly before they reach the playhead so their
  // whiteboard engine is already loaded when the scene opens. Without this the
  // preview would show the untouched photo while the engine boots, then snap
  // into the animation.
  //
  // The next two scenes are kept warm rather than a sliding time window: during
  // playback the set then only changes at scene cuts, so prewarming cannot force
  // extra editor renders (and stutters) while the clock is running.
  const prewarmLayers = useMemo(() => {
    const hiddenTracks = new Set(
      project.tracks.filter((track) => track.hidden).map((track) => track.id),
    );
    const activeIds = new Set(previewLayers.map((clip) => clip.id));
    return project.clips
      .filter(
        (clip) =>
          clip.kind === "visual" &&
          clip.mediaType === "image" &&
          resolveWhiteboard(clip, project.settings).enabled &&
          !hiddenTracks.has(clip.trackId) &&
          !activeIds.has(clip.id) &&
          clip.start + clip.duration > playhead,
      )
      .sort((a, b) => a.start - b.start)
      .slice(0, 2);
  }, [project.clips, project.tracks, project.settings, playhead, previewLayers]);

  // Keep the selected image's engine mounted even when the playhead is
  // elsewhere, so changing its settings can re-measure and resize the clip.
  const inspectorScene = useMemo(() => {
    const clip = selectedClip;
    if (!clip || clip.mediaType !== "image" || !resolveWhiteboard(clip, project.settings).enabled)
      return null;
    if (
      previewLayers.some((item) => item.id === clip.id) ||
      prewarmLayers.some((item) => item.id === clip.id)
    )
      return null;
    return clip;
  }, [selectedClip, previewLayers, prewarmLayers, project.settings]);

  const previewEntries = useMemo(
    () => [
      ...previewLayers.map((clip, index) => ({ clip, active: true, order: index })),
      ...prewarmLayers.map((clip) => ({ clip, active: false, order: -1 })),
      ...(inspectorScene ? [{ clip: inspectorScene, active: false, order: -1 }] : []),
    ],
    [previewLayers, prewarmLayers, inspectorScene],
  );

  // The blank board is part of the preview too: before, between and after
  // scenes it takes the same background as the scene it belongs to, so a
  // Background change is visible even while nothing is drawn on it.
  const previewBoardBackground = useMemo(() => {
    const active = previewEntries.find((entry) => entry.active)?.clip;
    if (active && active.mediaType === "image")
      return resolveWhiteboard(active, project.settings).background;
    if (cutsClip) return resolveWhiteboard(cutsClip, project.settings).background;
    return project.settings.whiteboard.background;
  }, [previewEntries, cutsClip, project.settings]);

  const fadeOverlayOpacity = useMemo(() => {
    let opacity = 0;
    transitionLayers.forEach((layer) => {
      if (layer.effect === "fade-black")
        opacity = Math.max(opacity, fadeToBlackOverlayOpacity(layer.progress));
    });
    return opacity;
  }, [transitionLayers]);

  const clipWindow = (clip: Clip) => {
    if (trimDrag?.clipId === clip.id) {
      const trimmed = trimClipWithin(
        trimDrag.original,
        trimDrag.edge,
        trimDrag.delta,
        rowNeighbours(trimDrag.original.trackId, trimDrag.clipId),
      );
      return { start: trimmed.start, duration: trimmed.duration };
    }
    if (drag?.clipId === clip.id) return { start: drag.nextStart, duration: clip.duration };
    return { start: clip.start, duration: clip.duration };
  };

  const visibleTracks = [...project.tracks].reverse();
  // The grid is always drawn across a healthy stretch (over four screens), and
  // after the last clip of any kind there is about two screens of grid left to
  // scroll into. Past that the strip stops — the grid is never cut down to the
  // clips, and never runs on forever either.
  const TAIL_WIDTH = 1000;
  const BASE_WIDTH = 2400;
  const contentWidth = Math.max(BASE_WIDTH, timelineWidth(timelineEnd, zoom) + TAIL_WIDTH);
  const selectedTransitionData = project.transitions.find((item) => item.id === selectedTransition);

  const scrubTo = (clientX: number) => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    setPlayhead(
      Math.max(
        0,
        timelineTimeAtPointer(
          clientX,
          viewport.getBoundingClientRect().left + railWidth(viewport),
          viewport.scrollLeft,
          zoom,
        ),
      ),
    );
  };

  const beginTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const viewport = event.currentTarget;
    timelinePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (timelinePointers.current.size === 2) {
      // A second finger turns the gesture into a pinch: keep the timeline time
      // under the fingers' midpoint fixed while the scale changes.
      timelineGesture.current = null;
      lastTimelineTap.current = null;
      const [first, second] = [...timelinePointers.current.values()];
      if (!first || !second) return;
      pinchGesture.current = {
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        zoom,
        time: timelineTimeAtPointer(
          (first.x + second.x) / 2,
          viewport.getBoundingClientRect().left + railWidth(viewport),
          viewport.scrollLeft,
          zoom,
        ),
      };
      return;
    }
    const target = event.target as HTMLElement;
    // Dropdown menus render in a portal but still bubble through the React tree,
    // so ignore events that did not originate inside the timeline itself.
    if (!event.currentTarget.contains(target)) return;
    if (target.closest(".transition-chip, .track-rail, .trim-handle, button")) return;
    const clipId = target.closest<HTMLElement>("[data-clip-id]")?.dataset["clipId"];
    const last = lastTimelineTap.current;
    const isDoubleTap =
      !!last &&
      performance.now() - last.time < 350 &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < 32;
    lastTimelineTap.current = null;
    if (isDoubleTap && clipId) {
      const clip = projectRef.current.clips.find((item) => item.id === clipId);
      if (clip) beginDrag(event, clip);
      return;
    }
    timelineGesture.current = {
      mode: isDoubleTap ? "scrub" : "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: viewport.scrollLeft,
      startTop: viewport.scrollTop,
      clipId,
      moved: false,
    };
    heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId);
    if (isDoubleTap) {
      setIsPlaying(false);
      scrubTo(event.clientX);
      setScrubHeld(true);
    }
  };

  const moveTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    if (timelinePointers.current.has(event.pointerId)) {
      timelinePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    const pinch = pinchGesture.current;
    if (pinch && timelinePointers.current.size >= 2) {
      const [first, second] = [...timelinePointers.current.values()];
      if (!first || !second) return;
      const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      const nextZoom = Math.min(
        144,
        Math.max(32, Math.round((pinch.zoom * distance) / pinch.distance)),
      );
      setZoom((current) => (current === nextZoom ? current : nextZoom));
      const viewport = event.currentTarget;
      const midpoint = (first.x + second.x) / 2;
      // Same maths as `zoomRef`: the pinch anchor stays under the midpoint.
      viewport.scrollLeft = Math.max(
        0,
        pinch.time * nextZoom -
          (midpoint - viewport.getBoundingClientRect().left - railWidth(viewport)),
      );
      return;
    }
    const gesture = timelineGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6)
      gesture.moved = true;
    if (gesture.mode === "pan") {
      event.currentTarget.scrollLeft = gesture.startLeft - (event.clientX - gesture.startX);
      event.currentTarget.scrollTop = gesture.startTop - (event.clientY - gesture.startY);
    } else {
      scrubTo(event.clientX);
    }
  };

  const endTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    timelinePointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (pinchGesture.current) {
      if (timelinePointers.current.size < 2) pinchGesture.current = null;
      timelineGesture.current = null;
      return;
    }
    const gesture = timelineGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;
    timelineGesture.current = null;
    if (gesture.mode === "scrub") {
      // The throttled re-dispatch can trail the strip; land on the pointer's
      // exact time before letting go.
      if (event.type !== "pointercancel") scrubTo(event.clientX);
      heldPointer.current = null;
      setScrubHeld(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.mode !== "pan" || gesture.moved || event.type === "pointercancel") return;
    // A single tap: select the clip under it (or clear the selection) and arm a double tap.
    setSelectedId(gesture.clipId ?? null);
    if (gesture.clipId) setCutsSource("timeline");
    setSelectedTransition(null);
    lastTimelineTap.current = { time: performance.now(), x: event.clientX, y: event.clientY };
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setSelectedId(clip.id);
    setCutsSource("timeline");
    heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setDrag({
      clipId: clip.id,
      startX: event.clientX,
      originalStart: clip.start,
      trackId: clip.trackId,
      nextStart: clip.start,
      nextTrackId: clip.trackId,
      startLeft: timelineRef.current?.scrollLeft ?? 0,
    });
  };

  const beginTrim = (event: ReactPointerEvent<HTMLSpanElement>, clip: Clip, edge: TrimEdge) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(clip.id);
    setCutsSource("timeline");
    setSelectedTransition(null);
    heldPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setTrimDrag({
      clipId: clip.id,
      edge,
      startX: event.clientX,
      original: clip,
      delta: 0,
      startLeft: timelineRef.current?.scrollLeft ?? 0,
    });
  };

  const beginTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    timelineResize.current = {
      id: event.pointerId,
      startY: event.clientY,
      startHeight: panel.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = timelineResize.current;
    if (!drag || drag.id !== event.pointerId) return;
    // The preview can take over almost the whole window; the timeline keeps
    // just enough room for its toolbar and a scrollable lane strip.
    const max = Math.max(200, window.innerHeight - 51 - 260);
    const next = drag.startHeight - (event.clientY - drag.startY);
    setTimelineHeight(Math.round(Math.min(max, Math.max(92, next))));
  };

  const endTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (timelineResize.current?.id !== event.pointerId) return;
    timelineResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <main
      className={`video-editor${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
      style={
        timelineHeight !== null
          ? { gridTemplateRows: `51px minmax(0, 1fr) ${timelineHeight}px` }
          : undefined
      }
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length > 0) event.preventDefault();
      }}
    >
      <header className="editor-topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <Film size={17} />
          </span>
          <span>cutline</span>
          <span className="topbar-divider" />
          <span className="project-name">Untitled project</span>
          <ChevronDown size={14} />
        </div>
        <Popover open={sliceSettingsOpen} onOpenChange={setSliceSettingsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="topbar-settings"
              title="Slices for the image in CUTS"
              aria-label="Slice settings"
            >
              <Scissors size={14} />
              <span>Slice settings</span>
              <ChevronDown size={11} className="settings-chevron" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            sideOffset={6}
            className="settings-popover slice-settings-popover"
          >
            <div className="settings-popover-head">
              <span className="settings-eyebrow">SLICE SETTINGS</span>
              {cutsImage ? (
                <p className="settings-clip-name" title={cutsImage.name}>
                  {cutsImage.name}
                </p>
              ) : null}
            </div>
            {!cutsImage ? (
              <p className="settings-lead">
                Pick an image in the library or on the timeline to slice it.
              </p>
            ) : (
              <>
                <div className={`settings-inherit ${cutsSlices.length > 0 ? "is-custom" : ""}`}>
                  <span>
                    {cutsSlices.length > 0
                      ? `${cutsSlices.length} slice${cutsSlices.length === 1 ? "" : "s"} · ${cutsClip ? `${cutsClip.duration.toFixed(2)}s` : "not on the timeline"}`
                      : cutsClip
                        ? "Whole image · no slices yet"
                        : "Not on the timeline yet"}
                  </span>
                </div>
                {cutsSlices.length > 0 ? (
                  <>
                    <p className="settings-note slice-quick-lead">
                      Position sets the drawing order. Numbers stay with their slice.
                    </p>
                    <ol className="slice-quick-list">
                      {[...cutsSlices]
                        .sort((a, b) => a.order - b.order)
                        .map((slice, index) => (
                          <li
                            key={slice.id}
                            className={`slice-quick-row ${selectedSliceId === slice.id ? "active" : ""}`}
                          >
                            <button
                              type="button"
                              className="slice-quick-open"
                              title={`Edit slice ${slice.number}`}
                              onClick={() => {
                                setSelectedSliceId(slice.id);
                                setSliceEditorOpen(true);
                                setSliceSettingsOpen(false);
                              }}
                            >
                              <span className="slice-quick-badge">{slice.number}</span>
                              <span className="slice-quick-name">Slice {slice.number}</span>
                              <span className="slice-quick-plays">plays {index + 1}</span>
                            </button>
                            <button
                              type="button"
                              className="slice-row-step"
                              disabled={slice.order <= 1}
                              aria-label={`Play slice ${slice.number} earlier`}
                              title="Play earlier"
                              onClick={() => reorderSlice(slice.id, slice.order - 1)}
                            >
                              <ChevronUp size={11} />
                            </button>
                            <button
                              type="button"
                              className="slice-row-step"
                              disabled={slice.order >= cutsSlices.length}
                              aria-label={`Play slice ${slice.number} later`}
                              title="Play later"
                              onClick={() => reorderSlice(slice.id, slice.order + 1)}
                            >
                              <ChevronDown size={11} />
                            </button>
                          </li>
                        ))}
                    </ol>
                  </>
                ) : (
                  <p className="settings-lead">
                    {cutsClip
                      ? "Draw a box or a loop around the part you want next — every closed border becomes a slice."
                      : "Adding the image puts it on the timeline at the playhead, then the slicer opens."}
                  </p>
                )}
                <div className="settings-foot">
                  <span className="settings-count">
                    {cutsSlices.length > 0
                      ? "Numbers only change on delete"
                      : "Each slice animates on its own"}
                  </span>
                  <div className="settings-foot-actions">
                    {cutsClip && cutsSlices.length > 0 ? (
                      <Button size="sm" variant="ghost" onClick={clearSlices}>
                        Clear
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={openCutSlicer}>
                      {!cutsClip
                        ? "Add & slice"
                        : cutsSlices.length > 0
                          ? "Edit slices"
                          : "Slice image"}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>
        <div className="topbar-actions">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="topbar-settings"
                title="Settings for the selected scene or animation"
                aria-label="Clip settings"
              >
                <SlidersHorizontal size={14} />
                <span>Clip settings</span>
                <ChevronDown size={11} className="settings-chevron" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="settings-popover clip-settings-popover"
            >
              <div className="settings-popover-head">
                <span className="settings-eyebrow">CLIP SETTINGS</span>
                {selectedClip ? (
                  <p className="settings-clip-name" title={selectedClip.name}>
                    {selectedClip.name}
                  </p>
                ) : null}
              </div>
              {!selectedClip ? (
                <p className="settings-lead">
                  Select a scene on the timeline to give that one its own animation settings.
                </p>
              ) : selectedClip.mediaType !== "image" ? (
                <p className="settings-lead">
                  This is {selectedClip.mediaType === "video" ? "a video" : "an audio"} clip.
                  Animation settings apply to image scenes.
                </p>
              ) : (
                <>
                  <div
                    className={`settings-inherit ${selectedFollowsGlobal ? "is-global" : "is-custom"}`}
                  >
                    <span>
                      {selectedFollowsGlobal ? "Following global" : "Custom for this clip"}
                    </span>
                    {selectedFollowsGlobal ? null : (
                      <button type="button" onClick={() => resetClipWhiteboard(selectedClip.id)}>
                        Use global
                      </button>
                    )}
                  </div>
                  <ClipWhiteboardSettings config={selectedWhiteboard} onChange={updateWhiteboard} />
                  <p className="settings-note">
                    {selectedFollowsGlobal
                      ? "Editing any control makes this scene custom; every other scene keeps following global."
                      : "Global changes skip this scene."}
                  </p>
                  {selectedClip.durationLocked ? (
                    <p className="settings-note">Trimmed by hand, so its length stays fixed.</p>
                  ) : null}
                </>
              )}
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="topbar-settings"
                title="Settings applied to every scene"
                aria-label="Global settings"
              >
                <Globe size={14} />
                <span>Global settings</span>
                <ChevronDown size={11} className="settings-chevron" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="settings-popover global-settings-popover"
            >
              <div className="settings-popover-head">
                <span className="settings-eyebrow">GLOBAL SETTINGS</span>
                <p className="settings-lead">Every scene follows these until it gets its own.</p>
              </div>
              <GlobalSettings
                config={project.settings.whiteboard}
                onChange={updateGlobalWhiteboard}
                asr={asr}
                onAsrChange={updateAsr}
                script={scriptDraft}
                onScriptChange={setScriptDraft}
                onScriptCommit={() => commitNarrationScript(scriptDraft)}
                onOpenPromptBuilder={() => setPromptBuilderOpen(true)}
              />
              <div className="settings-foot">
                <span className="settings-count">
                  {sceneCounts.following} following · {sceneCounts.custom} custom
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sceneCounts.custom === 0}
                  onClick={applyGlobalToAllScenes}
                >
                  Apply to all
                </Button>
              </div>
              {fittingScenes ? (
                <p className="settings-note settings-busy">Fitting scenes to the new timing…</p>
              ) : null}
            </PopoverContent>
          </Popover>
          <Sheet open={libraryOpen} onOpenChange={setLibraryOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="media-drawer-trigger"
                title="Open media library"
                aria-label="Open media library"
              >
                <LibraryBig />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="media-drawer">
              <SheetHeader className="media-drawer-header">
                <SheetTitle>Media</SheetTitle>
              </SheetHeader>
              <div className="media-drawer-actions">
                <Button variant="outline" size="sm" onClick={() => filePickerRef.current?.click()}>
                  <Upload size={14} /> Import media
                </Button>
                <Button variant="outline" size="sm" onClick={() => audioPickerRef.current?.click()}>
                  <AudioLines size={14} /> Import audio
                </Button>
              </div>
              <div className="media-drawer-body">
                <MediaLibrary
                  media={media}
                  kind={libraryKind}
                  onKindChange={setLibraryKind}
                  selectedId={librarySelectedId}
                  onSelect={selectLibraryItem}
                  onUse={(item) => {
                    placeLibraryItem(item);
                    setLibraryOpen(false);
                  }}
                  usage={clipUsage}
                />
              </div>
            </SheetContent>
          </Sheet>
          <span className="format-label">1080p · 30 fps</span>
          <Button size="sm" className="export-button" disabled={project.clips.length === 0}>
            <Check size={15} /> Export
          </Button>
        </div>
      </header>

      <input
        ref={filePickerRef}
        className="file-input"
        type="file"
        accept="video/*,image/*"
        multiple
        onChange={(event) => void importFiles(event)}
      />
      <input
        ref={audioPickerRef}
        className="file-input"
        type="file"
        accept="audio/*"
        multiple
        onChange={(event) => void importFiles(event, "audio")}
      />

      <div className="editor-media-rail">
        <Button
          variant="ghost"
          size="icon"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeftOpen />
        </Button>
      </div>

      <aside className="media-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-eyebrow">PROJECT</span>
            <h2>Media</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose />
          </Button>
        </div>
        <Button
          className="import-button"
          variant="outline"
          onClick={() => filePickerRef.current?.click()}
        >
          <Upload size={15} /> Import media
        </Button>
        <Button
          className="import-audio-button"
          variant="ghost"
          onClick={() => audioPickerRef.current?.click()}
        >
          <AudioLines size={14} /> Import audio
        </Button>
        <MediaLibrary
          media={media}
          kind={libraryKind}
          onKindChange={setLibraryKind}
          selectedId={librarySelectedId}
          onSelect={selectLibraryItem}
          onUse={placeLibraryItem}
          usage={clipUsage}
        />
        <section className="cuts-card">
          <div className="cuts-card-head">
            <span>CUTS</span>
            <span className="cuts-card-tag">
              {cutsSlices.length > 0
                ? `${cutsSlices.length} slice${cutsSlices.length === 1 ? "" : "s"}`
                : "Slicer"}
            </span>
          </div>
          {cutsImage ? (
            <div className="cuts-slicer">
              <div className="cuts-slicer-media">
                <div className="cuts-slicer-meta">
                  <p>{cutsImage.name}</p>
                  <span>
                    {cutsClip
                      ? `${cutsClip.duration.toFixed(2)}s scene · ${cutsSlices.length > 0 ? `${cutsSlices.length} slice${cutsSlices.length === 1 ? "" : "s"}` : "whole image"}`
                      : "Library image · not on the timeline"}
                  </span>
                </div>
                {cutsClip && cutsSlices.length > 0 && (
                  <button type="button" className="cuts-slicer-clear" onClick={clearSlices}>
                    Clear
                  </button>
                )}
              </div>
              <button
                type="button"
                className="cuts-slice-image"
                title={
                  cutsClip
                    ? "Draw slices on this image"
                    : "Add this image to the timeline and slice it"
                }
                onClick={openCutSlicer}
              >
                <SliceSurface src={cutsImage.src} slices={cutsSlices} interactive={false} />
                <span className="cuts-slice-hint">
                  {!cutsClip
                    ? "Click to add it and slice"
                    : cutsSlices.length > 0
                      ? "Click to edit slices"
                      : "Click to slice this image"}
                </span>
              </button>
              {cutsClip && cutsSlices.length > 0 ? (
                <div className="cuts-slice-orders" aria-label="Slice animation order">
                  {[...cutsSlices]
                    .sort((a, b) => a.order - b.order)
                    .map((slice, index) => (
                      <button
                        key={slice.id}
                        type="button"
                        className={selectedSliceId === slice.id ? "active" : ""}
                        title={`Slice ${slice.number} · plays ${index + 1}`}
                        onClick={() => {
                          setSelectedSliceId(slice.id);
                          setSliceEditorOpen(true);
                        }}
                      >
                        {slice.number}
                      </button>
                    ))}
                </div>
              ) : (
                <p className="cuts-slicer-note">
                  {!cutsClip
                    ? "Picking a library image previews it here — slicing adds it to the timeline first."
                    : "Every closed border becomes a slice. Numbers stay with their slice — positions decide the order."}
                </p>
              )}
              <button type="button" className="cuts-slice-open" onClick={openCutSlicer}>
                {!cutsClip ? "Add & slice" : "Slice image"}
              </button>
              <p className="cuts-slicer-note">
                {cutsSlices.length > 0
                  ? "Slices are drawn one after another. The hand leaves the scene between them, so each slice makes the cut longer."
                  : cutsClip
                    ? "The whole image stays one scene until you draw a slice."
                    : "The image joins the timeline at the playhead before the slicer opens."}
              </p>
            </div>
          ) : (
            <div className="cuts-card-body">
              <span className="cuts-card-icon">
                <Scissors size={15} />
              </span>
              <p>{selectedClip ? "No slicer for this cut" : "Select an image"}</p>
              <span>
                {selectedClip
                  ? "Slicer works on image cuts"
                  : "Pick a file in the library, or an image cut"}
              </span>
            </div>
          )}
        </section>
      </aside>

      <section className="editor-workspace">
        <section className="preview-panel">
          <div className="preview-heading">
            <div>
              <span className="panel-eyebrow">PREVIEW</span>
              <h2>Canvas</h2>
            </div>
            <span className="canvas-size">
              16:9 <span>·</span> 1920 × 1080
            </span>
          </div>
          <div className="preview-canvas">
            <div
              className={`preview-frame ${dropTarget?.type === "preview" ? "is-drop-target" : ""}`}
              ref={previewFrameRef}
              onDragOver={allowFileDrop({ type: "preview", trackId: null })}
              onDragLeave={clearFileDrop({ type: "preview", trackId: null })}
              onDrop={(event) => handleDropFiles(event, { at: playhead })}
            >
              {/* The stage is always a whiteboard: gaps, intros and audio-only
                stretches read as blank board rather than an empty panel. */}
              <PreviewBoard background={previewBoardBackground} />
              {previewEntries.map(({ clip, active, order }) => {
                const layer = active ? transitionLayers.get(clip.id) : undefined;
                const style = {
                  zIndex: active ? order + 2 : 0,
                  ...(layer ? transitionFrameStyle(layer.effect, layer.progress, layer.side) : {}),
                };
                if (clip.mediaType === "image") {
                  const animation = resolveWhiteboard(clip, project.settings);
                  const slices = clip.slices ?? [];
                  if (animation.enabled) {
                    // Slices replace the base style: the engine paints each closed
                    // border in the user's order, with the hand leaving the scene
                    // and coming back in between slices.
                    const stageConfig = slices.length
                      ? makeWhiteboardConfig({
                          ...animation,
                          style: "slicer",
                          // The clip owns the schedule, so the scene runs for
                          // exactly the clip's length and seeks frame-for-frame.
                          timingSeconds: clip.duration,
                          slices: bandedSlices(clip),
                        })
                      : animation;
                    return (
                      <WhiteboardStage
                        key={clip.id}
                        clipId={clip.id}
                        src={clip.src}
                        config={stageConfig}
                        active={active}
                        playing={isPlaying && active}
                        time={active ? Math.max(0, playheadRef.current - clip.start) : 0}
                        duration={clip.duration}
                        style={style}
                        onNaturalDuration={(seconds) => applyNaturalDuration(clip.id, seconds)}
                      />
                    );
                  }
                  return active ? (
                    <img
                      key={clip.id}
                      data-clip-id={clip.id}
                      className="preview-media"
                      style={style}
                      src={clip.src}
                      alt={clip.name}
                    />
                  ) : null;
                }
                if (!active) return null;
                return (
                  <video
                    key={clip.id}
                    data-clip-id={clip.id}
                    ref={(node) => {
                      if (node) videoRefs.current.set(clip.id, node);
                      else videoRefs.current.delete(clip.id);
                    }}
                    className="preview-media"
                    style={style}
                    src={clip.src}
                    muted
                    playsInline
                    preload="auto"
                    onLoadedMetadata={(event) => {
                      const node = event.currentTarget;
                      const local = clip.sourceOffset + Math.max(0, playhead - clip.start);
                      if (Math.abs(node.currentTime - local) > 0.1) node.currentTime = local;
                      if (isPlaying) void node.play().catch(() => undefined);
                    }}
                  />
                );
              })}
              <div
                ref={fadeOverlayRef}
                className="preview-fade-black"
                style={{
                  opacity: fadeOverlayOpacity,
                  visibility: fadeOverlayOpacity > 0 ? "visible" : "hidden",
                }}
              />
              <div className="preview-timecode" ref={previewTimecodeRef}>
                {formatTime(playhead)}
              </div>
              <div className="preview-resolution">FULL HD</div>
            </div>
          </div>
          <div className="transport-bar">
            <span className="transport-readout">
              <span ref={transportTimeRef}>{formatTime(playhead)}</span> <span>/</span>{" "}
              {formatTime(visualEnd)}
            </span>
            <div className="transport-center">
              <Button
                variant="ghost"
                size="icon"
                title="Split at playhead"
                aria-label="Split at playhead"
                disabled={
                  !selectedClip ||
                  playhead <= selectedClip.start ||
                  playhead >= selectedClip.start + selectedClip.duration
                }
                onClick={splitSelected}
              >
                <Scissors />
              </Button>
              <Button
                className="play-button"
                size="icon"
                title={isPlaying ? "Pause" : "Play"}
                aria-label={isPlaying ? "Pause" : "Play"}
                onClick={togglePlayback}
              >
                {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={selectedMediaActive ? "Audio follows clips" : "Audio muted in empty gaps"}
                aria-label={
                  selectedMediaActive ? "Audio follows clips" : "Audio muted in empty gaps"
                }
              >
                {selectedMediaActive ? <Volume2 /> : <VolumeX />}
              </Button>
            </div>
            <span className="playback-speed">1.0×</span>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading inspector-title">
            <div>
              <span className="panel-eyebrow">INSPECTOR</span>
              <h2>
                {selectedTransitionData
                  ? "Transition"
                  : selectedClip
                    ? "Clip details"
                    : "Properties"}
              </h2>
            </div>
          </div>
          {selectedTransitionData ? (
            <div className="inspector-content">
              <label className="field-label" htmlFor="transition-effect">
                Effect
              </label>
              <select
                id="transition-effect"
                className="editor-select"
                value={selectedTransitionData.effect}
                onChange={(event) =>
                  updateTransition(selectedTransitionData.id, { effect: event.target.value })
                }
              >
                <option value="crossfade">Crossfade</option>
                <option value="wipe">Wipe</option>
                <option value="slide">Slide</option>
                <option value="fade-black">Fade to black</option>
              </select>
              <label className="field-label" htmlFor="transition-duration">
                Duration <span>{selectedTransitionData.duration.toFixed(1)} sec</span>
              </label>
              <input
                id="transition-duration"
                className="range-input"
                type="range"
                min="0.1"
                max="2"
                step="0.1"
                value={selectedTransitionData.duration}
                onChange={(event) =>
                  updateTransition(selectedTransitionData.id, {
                    duration: Number(event.target.value),
                  })
                }
              />
              <div className="transition-preview">
                <span className="transition-swatch" />
                <span>{selectedTransitionData.effect.replace("-", " ")} transition</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  commitProject((current) => ({
                    ...current,
                    transitions: current.transitions.filter(
                      (item) => item.id !== selectedTransitionData.id,
                    ),
                  }));
                  setSelectedTransition(null);
                }}
              >
                <Trash2 size={14} /> Remove transition
              </Button>
            </div>
          ) : selectedClip ? (
            <div className="inspector-content">
              <div className="inspector-clip-icon">
                {selectedClip.mediaType === "video" ? (
                  <Video />
                ) : selectedClip.mediaType === "image" ? (
                  <ImageIcon />
                ) : (
                  <AudioLines />
                )}
              </div>
              <p className="inspector-clip-name">{selectedClip.name}</p>
              <div className="property-row">
                <span>Start</span>
                <span>{formatTime(selectedClip.start)}</span>
              </div>
              <div className="property-row">
                <span>Duration</span>
                <span>{selectedClip.duration.toFixed(2)} sec</span>
              </div>
              <div className="property-row">
                <span>Layer</span>
                <span>
                  {project.tracks.find((track) => track.id === selectedClip.trackId)?.name}
                </span>
              </div>
              {selectedClip.mediaType === "audio" && selectedTrack?.category === "voice" && (
                <div className="whiteboard-controls">
                  <div className="whiteboard-controls-head">
                    <span>Narration</span>
                    <span className="narration-count">
                      {selectedClip.transcript
                        ? `${selectedClip.transcript.words.length} words`
                        : "Not transcribed"}
                    </span>
                  </div>
                  {selectedClip.transcript ? (
                    <>
                      <p className="narration-text">{selectedClip.transcript.text}</p>
                      <p className="whiteboard-hint">
                        {selectedClip.transcript.duration.toFixed(1)}s ·{" "}
                        {selectedClip.transcript.chunks}{" "}
                        {selectedClip.transcript.chunks === 1 ? "chunk" : "chunks"} ·{" "}
                        {selectedClip.transcript.model ?? "whisper"}
                      </p>
                    </>
                  ) : (
                    <p className="whiteboard-hint">
                      Transcribe this narration so image slices can wait for the words that
                      describe them.
                    </p>
                  )}
                  {asrJob?.clipId === selectedClip.id && (
                    <p className="narration-status">
                      <RefreshCw size={12} className="spin" />
                      {asrJob.total
                        ? `Transcribing ${asrJob.done} of ${asrJob.total}…`
                        : "Reading audio…"}
                    </p>
                  )}
                  <div className="narration-actions">
                    <Button
                      size="sm"
                      variant={selectedClip.transcript ? "outline" : "default"}
                      disabled={asrJob !== null}
                      onClick={() => void transcribeNarration(selectedClip)}
                    >
                      <Captions size={14} />
                      {selectedClip.transcript ? "Re-transcribe" : "Transcribe"}
                    </Button>
                    {selectedClip.transcript && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={asrJob !== null}
                        onClick={() => updateClip(selectedClip.id, { transcript: undefined })}
                      >
                        <Trash2 size={14} /> Clear
                      </Button>
                    )}
                  </div>
                  {asrError && <p className="narration-error">{asrError}</p>}
                </div>
              )}
              {selectedClip.mediaType === "audio" && selectedTrack?.category === "music" && (
                <div className="whiteboard-controls">
                  <div className="whiteboard-controls-head">
                    <span>Music</span>
                    <span className="narration-count">Never transcribed</span>
                  </div>
                  <p className="whiteboard-hint">
                    Whisper only listens to Voice rows. Trigger phrases come from the spoken
                    narration, never from music.
                  </p>
                </div>
              )}
              {selectedClip.mediaType === "image" && (
                <div className="whiteboard-controls">
                  <div className="whiteboard-controls-head">
                    <span>Whiteboard animation</span>
                    <label className="whiteboard-toggle">
                      <input
                        type="checkbox"
                        checked={selectedWhiteboard.enabled}
                        onChange={(event) => updateWhiteboard({ enabled: event.target.checked })}
                      />
                      <span>{selectedWhiteboard.enabled ? "On" : "Off"}</span>
                    </label>
                  </div>
                  <div
                    className={`whiteboard-inherit ${selectedFollowsGlobal ? "is-global" : "is-custom"}`}
                  >
                    <span>
                      {selectedFollowsGlobal ? "Following global" : "Custom for this clip"}
                    </span>
                    {selectedFollowsGlobal ? null : (
                      <button type="button" onClick={() => resetClipWhiteboard(selectedClip.id)}>
                        Use global
                      </button>
                    )}
                  </div>
                  {selectedWhiteboard.enabled && (
                    <>
                      <label className="field-label" htmlFor="whiteboard-style">
                        Style
                      </label>
                      <select
                        id="whiteboard-style"
                        className="editor-select"
                        value={selectedWhiteboard.style}
                        onChange={(event) =>
                          updateWhiteboard({
                            style: event.target.value as WhiteboardConfig["style"],
                          })
                        }
                      >
                        {WHITEBOARD_STYLES.map((style) => (
                          <option key={style.value} value={style.value}>
                            {style.label}
                          </option>
                        ))}
                      </select>
                      <label className="field-label" htmlFor="whiteboard-hand">
                        Hand
                      </label>
                      <select
                        id="whiteboard-hand"
                        className="editor-select"
                        value={selectedWhiteboard.hand}
                        onChange={(event) =>
                          updateWhiteboard({ hand: event.target.value as WhiteboardConfig["hand"] })
                        }
                      >
                        {WHITEBOARD_HANDS.map((hand) => (
                          <option key={hand.value} value={hand.value}>
                            {hand.label}
                          </option>
                        ))}
                      </select>
                      <label className="field-label" htmlFor="whiteboard-speed">
                        Speed <span>{selectedWhiteboard.speed}</span>
                      </label>
                      <input
                        id="whiteboard-speed"
                        className="range-input"
                        type="range"
                        min="1"
                        max="100"
                        step="1"
                        value={selectedWhiteboard.speed}
                        onChange={(event) =>
                          updateWhiteboard({ speed: Number(event.target.value) })
                        }
                      />
                      <p className="whiteboard-hint">
                        The drawing is fitted to this clip's length. Trim the clip longer for a
                        calmer animation.
                      </p>
                    </>
                  )}
                </div>
              )}
              {selectedClip.mediaType === "image" && selectedSlices.length > 0 && (
                <div className="cue-panel">
                  <div className="cue-panel-head">
                    <span>Cue each reveal</span>
                    <button
                      type="button"
                      className="cue-sync"
                      onClick={() => syncCuesToNarration(selectedClip)}
                    >
                      <RefreshCw size={11} /> Sync to narration
                    </button>
                  </div>
                  <p className="whiteboard-hint">
                    Type the words that should start a reveal. Sync finds them in the
                    narration under this image.
                  </p>
                  <label className="cue-script">
                    <span>
                      Script <small>paste only the spoken lines</small>
                    </span>
                    <textarea
                      className="cue-script-input"
                      value={scriptDraft}
                      spellCheck={false}
                      rows={4}
                      placeholder="With the script here, Sync aligns it to the narration once, so a cue still lands when speech-to-text spells a word differently."
                      onChange={(event) => setScriptDraft(event.target.value)}
                      onBlur={() => commitNarrationScript(scriptDraft)}
                    />
                  </label>
                  <div className="cue-list">
                    {selectedSlices.map((slice) => {
                      const visible = cueDrafts[slice.id] ?? slice.cue ?? "";
                      return (
                        <label className="cue-row" key={slice.id}>
                          <span className="cue-number">{slice.number}</span>
                          <input
                            className="cue-input"
                            type="text"
                            value={visible}
                            placeholder="words that start this reveal"
                            aria-label={`Narration cue for slice ${slice.number}`}
                            onChange={(event) =>
                              setCueDrafts((current) => ({
                                ...current,
                                [slice.id]: event.target.value,
                              }))
                            }
                            onBlur={() => {
                              if (commitSliceCue(selectedClip.id, slice.id, visible))
                                alignCuesForClip(selectedClip.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                  {cueStatus && <p className="cue-status">{cueStatus}</p>}
                </div>
              )}
              <div className="inspector-actions">
                <Button variant="outline" size="sm" onClick={duplicateSelected}>
                  <Copy size={14} /> Duplicate
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Delete clip"
                  aria-label="Delete clip"
                  onClick={deleteSelected}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ) : (
            <div className="inspector-empty">
              <span className="inspector-empty-symbol">✳</span>
              <p>Select a clip to see its properties</p>
              <span>Clip position, duration and layer</span>
            </div>
          )}
          <div className="inspector-foot">
            <span>PROJECT SETTINGS</span>
            <div>
              <span>Aspect ratio</span>
              <b>16:9</b>
            </div>
            <div>
              <span>Frame rate</span>
              <b>30 fps</b>
            </div>
          </div>
        </aside>
      </section>

      <section className="timeline-panel">
        <div
          className="timeline-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize timeline"
          title="Drag to resize the timeline · double-click to reset"
          onPointerDown={beginTimelineResize}
          onPointerMove={moveTimelineResize}
          onPointerUp={endTimelineResize}
          onPointerCancel={endTimelineResize}
          onDoubleClick={() => setTimelineHeight(null)}
        />
        <div className="timeline-toolbar">
          <div className="timeline-title">
            <span className="panel-eyebrow">EDIT</span>
            <h2>Timeline</h2>
            <span className="timeline-divider" />
            <span className="track-count">{project.tracks.length} tracks</span>
          </div>
          <div className="edit-actions">
            <Button
              variant="ghost"
              size="icon"
              title="Undo"
              aria-label="Undo"
              disabled={undoStack.current.length === 0}
              onClick={undo}
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Redo"
              aria-label="Redo"
              disabled={redoStack.current.length === 0}
              onClick={redo}
            >
              <Redo2 />
            </Button>
            <span className="action-divider" />
            <Button
              variant="ghost"
              size="icon"
              title="Split at playhead"
              aria-label="Split at playhead"
              disabled={
                !selectedClip ||
                playhead <= selectedClip.start ||
                playhead >= selectedClip.start + selectedClip.duration
              }
              onClick={splitSelected}
            >
              <Scissors />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Copy clip"
              aria-label="Copy clip"
              disabled={!selectedClip}
              onClick={copySelected}
            >
              <Copy />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Paste clip"
              aria-label="Paste clip"
              disabled={!copiedClip}
              onClick={pasteClip}
            >
              <ClipboardPaste />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Duplicate clip"
              aria-label="Duplicate clip"
              disabled={!selectedClip}
              onClick={duplicateSelected}
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete clip"
              aria-label="Delete clip"
              disabled={!selectedClip}
              onClick={deleteSelected}
            >
              <Trash2 />
            </Button>
          </div>
          <div className="zoom-actions">
            {asrJob?.background ? (
              <span
                className="asr-chip"
                title={`Whisper is transcribing ${asrJob.name}. Music rows are never transcribed.`}
              >
                <RefreshCw size={11} className="spin" />
                {asrJob.total ? `Voice ${asrJob.done}/${asrJob.total}` : "Reading voice…"}
              </span>
            ) : null}
            {!asrJob && asrNotice ? (
              <span
                className="asr-chip is-error"
                title={`${asrNotice.name}: ${asrNotice.message}`}
              >
                <TriangleAlert size={11} />
                Voice not transcribed
                <button
                  type="button"
                  className="asr-chip-close"
                  aria-label="Dismiss transcription error"
                  onClick={() => setAsrNotice(null)}
                >
                  ×
                </button>
              </span>
            ) : null}
            {isRecording || recordingError ? (
              <span
                className={`recording-chip${recordingError ? " record-error" : ""}`}
                title={
                  recordingError
                    ? `${recordingError}. Allow microphone access, then use Record into this row on a voice row.`
                    : "Recording a voice row"
                }
              >
                {isRecording ? (
                  <>
                    <span className="recording-dot" />
                    {recordingSeconds.toFixed(1)}s
                    <button type="button" className="recording-stop" onClick={stopRecording}>
                      Stop
                    </button>
                  </>
                ) : (
                  <>
                    <MicOff size={11} />
                    Mic unavailable
                  </>
                )}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              title="Zoom out"
              aria-label="Zoom out"
              disabled={zoom <= 32}
              onClick={() => setZoom((value) => Math.max(32, value - 12))}
            >
              <ZoomOut />
            </Button>
            <span>{Math.round((zoom / 72) * 100)}%</span>
            <Button
              variant="ghost"
              size="icon"
              title="Zoom in"
              aria-label="Zoom in"
              disabled={zoom >= 144}
              onClick={() => setZoom((value) => Math.min(144, value + 12))}
            >
              <ZoomIn />
            </Button>
          </div>
        </div>

        <div className="timeline-body">
          <div
            ref={timelineRef}
            className="timeline-scroll"
            onPointerDown={beginTimelineGesture}
            onPointerMove={moveTimelineGesture}
            onPointerUp={endTimelineGesture}
            onPointerCancel={endTimelineGesture}
          >
            <div className="timeline-grid">
              <div className="track-rail">
                <div className="rail-ruler">00:00:00</div>
                <div className="track-rail-list">
                  {visibleTracks.map((track) => (
                    <div
                      className={`track-label ${track.kind} ${track.muted ? "muted" : ""} ${track.hidden ? "hidden" : ""}`}
                      key={track.id}
                    >
                      <span className="track-type-icon">
                        {track.kind === "visual" ? (
                          <Film size={14} />
                        ) : track.kind === "voice" ? (
                          <Mic size={14} />
                        ) : (
                          <AudioLines size={14} />
                        )}
                      </span>
                      <span className="track-name">{track.name}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="track-menu"
                            title={`${track.name} options`}
                            aria-label={`${track.name} options`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="track-menu-content">
                          <DropdownMenuLabel>{track.name}</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => addTrack(track.category, track.id)}>
                            <Plus size={13} /> Add row
                          </DropdownMenuItem>
                          {track.category === "video" && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger
                                disabled={!rowsWithUnshippedAudio.has(track.id)}
                                title={
                                  rowsWithUnshippedAudio.has(track.id)
                                    ? "Move this row's audio onto a voice or music row"
                                    : "No unshipped video audio on this row"
                                }
                              >
                                <VolumeX size={13} /> Audioship
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="track-menu-content">
                                <DropdownMenuLabel>Ship audio to</DropdownMenuLabel>
                                <DropdownMenuItem
                                  onSelect={() => shipAudioToRow(track.id, "voice")}
                                >
                                  <Mic size={13} /> Voice row
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => shipAudioToRow(track.id, "music")}
                                >
                                  <AudioLines size={13} /> Music row
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {track.kind === "voice" && (
                            <DropdownMenuItem
                              disabled={isRecording && recordingTrackId !== track.id}
                              onSelect={() => {
                                if (isRecording) stopRecording();
                                else void beginRecording(track.id);
                              }}
                            >
                              {isRecording && recordingTrackId === track.id ? (
                                <span className="track-record-square" />
                              ) : (
                                <Mic size={13} />
                              )}
                              {isRecording && recordingTrackId === track.id
                                ? " Stop recording"
                                : " Record into this row"}
                            </DropdownMenuItem>
                          )}
                          {!track.default && (
                            <DropdownMenuItem
                              disabled={!canRemoveTrack(track.id, project.tracks, project.clips)}
                              title={
                                project.clips.some((clip) => clip.trackId === track.id)
                                  ? "Move or delete this track's clips first"
                                  : undefined
                              }
                              onSelect={() => removeTrack(track.id)}
                            >
                              <Trash2 size={13} /> Remove row
                              {project.clips.some((clip) => clip.trackId === track.id)
                                ? " · clips exist"
                                : ""}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => toggleTrack(track.id, "muted")}>
                            {track.muted ? <Volume2 size={13} /> : <VolumeX size={13} />}
                            {track.muted ? " Unmute audio" : " Mute audio"}
                          </DropdownMenuItem>
                          {track.kind === "visual" && (
                            <DropdownMenuItem onSelect={() => toggleTrack(track.id, "hidden")}>
                              {track.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                              {track.hidden ? " Show in preview" : " Hide from preview"}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              </div>
              <div className="timeline-content" style={{ width: `${contentWidth}px` }}>
                <div className="timeline-ruler">
                  {Array.from({ length: Math.ceil(contentWidth / (zoom * 5)) }, (_, index) => (
                    <span
                      key={index}
                      className="ruler-tick major"
                      style={{ left: `${index * zoom * 5}px` }}
                    >
                      <span>{formatTime(index * 5).slice(0, 5)}</span>
                    </span>
                  ))}
                </div>
                {visibleTracks.map((track) => {
                  const trackClips = project.clips.filter((clip) => clip.trackId === track.id);
                  const ordered = [...trackClips].sort((a, b) => a.start - b.start);
                  const laneTarget: DropTarget = { type: "lane", trackId: track.id };
                  const isLaneTarget =
                    dropTarget?.type === "lane" && dropTarget.trackId === track.id;
                  return (
                    <div
                      className={`track-lane ${track.kind} ${isLaneTarget ? "is-drop-target" : ""} ${isRecording && recordingTrackId === track.id ? "is-recording" : ""}`}
                      data-track-id={track.id}
                      key={track.id}
                      onDragOver={allowFileDrop(laneTarget)}
                      onDragLeave={clearFileDrop(laneTarget)}
                      onDrop={(event) =>
                        handleDropFiles(event, {
                          trackId: track.id,
                          at: timelineDropTime(event.clientX),
                        })
                      }
                    >
                      {trackClips.map((clip) => {
                        const isDragged = drag?.clipId === clip.id;
                        if (isDragged && drag.nextTrackId !== track.id) return null;
                        const geometry = clipWindow(clip);
                        const isTrimming = trimDrag?.clipId === clip.id;
                        return (
                          <div
                            key={clip.id}
                            className={`clip-block ${clip.kind} ${clip.mediaType} ${selectedId === clip.id ? "selected" : ""} ${isDragged ? "dragging" : ""} ${isTrimming ? "trimming" : ""}`}
                            style={{
                              left: `${geometry.start * zoom}px`,
                              width: `${geometry.duration * zoom}px`,
                            }}
                            data-clip-id={clip.id}
                            title={`${clip.name} · ${geometry.duration.toFixed(2)} sec${
                              clip.audioShipped ? " · audio moved to an audio row" : ""
                            }`}
                          >
                            <ClipFilmstrip clip={clip} />
                          {clip.mediaType === "image" && (
                            <ClipSlices
                              clip={clip}
                              selected={selectedId === clip.id}
                              drag={sliceDrag?.clipId === clip.id ? sliceDrag : null}
                              onBoundaryDrag={beginSliceBoundaryDrag}
                              onFlagAction={sliceFlagAction}
                            />
                          )}
                            <span className="clip-thumb">
                              {clip.mediaType === "image" ? (
                                <ImageIcon size={13} />
                              ) : clip.mediaType === "video" ? (
                                <Video size={13} />
                              ) : (
                                <AudioLines size={13} />
                              )}
                            </span>
                            <span className="clip-label">{clip.name}</span>
                            {clip.mediaType !== "image" && (
                              <span className="clip-duration">{geometry.duration.toFixed(1)}s</span>
                            )}
                            {clip.audioShipped && (
                              <span
                                className="clip-audio-shipped"
                                title="Audio plays from a separate audio row"
                              >
                                <VolumeX size={10} />
                              </span>
                            )}
                            {clip.mediaType === "audio" && (
                              <span className="waveform" aria-hidden="true">
                                {Array.from({ length: 32 }, (_, index) => (
                                  <i
                                    key={index}
                                    style={{
                                      height: `${14 + ((index * 17 + clip.id.charCodeAt(0)) % 72)}%`,
                                    }}
                                  />
                                ))}
                              </span>
                            )}
                            {selectedId === clip.id && (
                              <>
                                <span
                                  className={`trim-handle left ${isTrimming && trimDrag.edge === "left" ? "active" : ""}`}
                                  onPointerDown={(event) => beginTrim(event, clip, "left")}
                                />
                                <span
                                  className={`trim-handle right ${isTrimming && trimDrag.edge === "right" ? "active" : ""}`}
                                  onPointerDown={(event) => beginTrim(event, clip, "right")}
                                />
                              </>
                            )}
                          </div>
                        );
                      })}
                      {ordered.slice(0, -1).map((left) => {
                        const right = ordered.find(
                          (clip) =>
                            clip.start >= left.start + left.duration - 0.04 && clip.id !== left.id,
                        );
                        if (!right || Math.abs(left.start + left.duration - right.start) > 0.08)
                          return null;
                        const transition = project.transitions.find(
                          (item) => item.leftId === left.id && item.rightId === right.id,
                        );
                        return (
                          <button
                            key={`${left.id}-${right.id}`}
                            className={`transition-chip ${transition ? "configured" : ""}`}
                            style={{ left: `${right.start * zoom - 12}px` }}
                            title={
                              transition ? `Edit ${transition.effect} transition` : "Add transition"
                            }
                            aria-label={transition ? "Edit transition" : "Add transition"}
                            onClick={(event) => {
                              event.stopPropagation();
                              addOrSelectTransition(left, right);
                            }}
                          >
                            {transition ? <Check size={11} /> : <Plus size={12} />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                <div
                  className="timeline-playhead"
                  ref={playheadLineRef}
                  style={{ left: `${playhead * zoom}px` }}
                >
                  <span className="playhead-head" />
                  <span className="playhead-line" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {project.clips
        .filter((clip) => clip.mediaType === "audio")
        .map((clip) => (
          <audio
            className="hidden-audio"
            key={clip.id}
            ref={(node) => {
              if (node) audioRefs.current.set(clip.id, node);
              else audioRefs.current.delete(clip.id);
            }}
            src={clip.src}
            preload="auto"
          />
        ))}

      {promptBuilderOpen && (
        <PromptBuilderDialog
          script={scriptDraft}
          onScriptCommit={commitNarrationScript}
          onClose={() => setPromptBuilderOpen(false)}
        />
      )}
      {sliceEditorOpen && cutsClip && (
        <SliceEditorDialog
          name={cutsClip.name}
          imageNumber={cutsImageNumber}
          sceneSeconds={cutsClip.duration}
          src={cutsClip.src}
          slices={cutsSlices}
          selectedId={selectedSliceId}
          onSelect={setSelectedSliceId}
          onCreate={addSlice}
          onChangePoints={changeSlicePoints}
          onImportMap={importSliceMap}
          onReorder={reorderSlice}
          onDelete={deleteSlice}
          onClear={clearSlices}
          narrationText={cutsNarration?.transcript.text ?? null}
          onSetCue={setSlicerCue}
          onAutoAlign={autoAlignAndPreview}
          onClose={() => setSliceEditorOpen(false)}
        />
      )}
    </main>
  );
}

/** Turns a getUserMedia/MediaRecorder failure into something short enough for the footer. */
function recordingErrorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone blocked — allow mic access";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found";
  if (name === "NotReadableError" || name === "AbortError")
    return "Microphone is busy in another app";
  return "Could not start recording";
}

function libraryKindIcon(kind: LibraryKind, size = 13) {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "video") return <Video size={size} />;
  return <AudioLines size={size} />;
}

/** Normalises old colour values so the Background dropdown selects the right pill. */
function backgroundValue(background: string): string {
  if (background === "#ffffff") return "white";
  if (background === "#000000") return "black";
  if (background === "none") return "transparent";
  return background;
}

const DRAWING_STYLE_VALUES = new Set<string>(WHITEBOARD_DRAWING_STYLES.map((style) => style.value));

/**
 * The style family picker plus the engine knobs that belong to the chosen
 * style. Global settings and clip settings render the same block: the global
 * copy is what every following scene inherits, and the clip copy writes an
 * override that wins for that one scene.
 */
function WhiteboardStyleControls({
  idPrefix,
  config,
  onChange,
  disabled = false,
}: {
  idPrefix: string;
  config: WhiteboardConfig;
  onChange: (patch: Partial<WhiteboardConfig>) => void;
  disabled?: boolean;
}) {
  const drawing = DRAWING_STYLE_VALUES.has(config.style);
  const styleOptions = drawing ? WHITEBOARD_DRAWING_STYLES : WHITEBOARD_ANIMATION_STYLES;
  const style = config.style;
  const chunkStyle = style === "chunkjump" || style === "outlinechunks";
  const zigzagStyle = style === "scanner" || style === "chunkjump";
  const colourStyle = style === "outlinefill" || style === "illustfill";
  const outlineStyle =
    style === "contour" ||
    style === "outlineonly" ||
    style === "outlinefill" ||
    style === "illustfill";
  const strokeStyle = style === "contour" || style === "outlineonly";
  const textStyle = style === "spec-text";

  return (
    <>
      <div className="settings-subhead">Style</div>
      <div className="style-mode-toggle" role="tablist" aria-label="Style family">
        <button
          type="button"
          role="tab"
          aria-selected={!drawing}
          className={!drawing ? "active" : ""}
          onClick={() => onChange({ style: WHITEBOARD_ANIMATION_STYLES[0].value })}
        >
          Animation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={drawing}
          className={drawing ? "active" : ""}
          onClick={() => onChange({ style: WHITEBOARD_DRAWING_STYLES[0].value })}
        >
          Drawing
        </button>
      </div>
      <div className="style-choice-grid">
        {styleOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={config.style === option.value ? "active" : ""}
            onClick={() => onChange({ style: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>

      {chunkStyle || textStyle ? (
        <>
          <label className="field-label" htmlFor={`${idPrefix}-chunks`}>
            {textStyle ? "Text chunks" : "Chunks"}{" "}
            <span>{textStyle ? config.specChunks : config.chunks}</span>
          </label>
          <input
            id={`${idPrefix}-chunks`}
            className="range-input"
            type="range"
            min={textStyle ? "12" : "6"}
            max={textStyle ? "80" : "60"}
            step="1"
            value={textStyle ? config.specChunks : config.chunks}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                textStyle
                  ? { specChunks: Number(event.target.value) }
                  : { chunks: Number(event.target.value) },
              )
            }
          />
        </>
      ) : null}

      {zigzagStyle ? (
        <div className="settings-row">
          <span>Zig-zag rows</span>
          <label className="switch-field">
            <input
              type="checkbox"
              checked={config.zigzag !== false}
              disabled={disabled}
              onChange={(event) => onChange({ zigzag: event.target.checked })}
            />
            <span>{config.zigzag !== false ? "On" : "Off"}</span>
          </label>
        </div>
      ) : null}

      {colourStyle ? (
        <>
          <div className="field-label">Colour</div>
          <div className="pill-row" role="group" aria-label="Colour style">
            {WHITEBOARD_COLOR_STYLES.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                className={config.colorStyle === option.value ? "active" : ""}
                onClick={() => onChange({ colorStyle: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {outlineStyle ? (
        <>
          <label className="field-label" htmlFor={`${idPrefix}-detail`}>
            Outline detail <span>{config.outlineDetect}</span>
          </label>
          <input
            id={`${idPrefix}-detail`}
            className="range-input"
            type="range"
            min="0"
            max="100"
            step="1"
            value={config.outlineDetect}
            disabled={disabled}
            onChange={(event) => onChange({ outlineDetect: Number(event.target.value) })}
          />
          <label className="field-label" htmlFor={`${idPrefix}-algorithm`}>
            Outline algorithm
          </label>
          <select
            id={`${idPrefix}-algorithm`}
            className="editor-select"
            value={config.outlineAlgorithm}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                outlineAlgorithm: event.target.value as WhiteboardConfig["outlineAlgorithm"],
              })
            }
          >
            {WHITEBOARD_OUTLINE_ALGORITHMS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {strokeStyle ? (
        <>
          <label className="field-label" htmlFor={`${idPrefix}-stroke`}>
            Pen stroke
          </label>
          <select
            id={`${idPrefix}-stroke`}
            className="editor-select"
            value={config.outlineStrokeStyle}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                outlineStrokeStyle: event.target.value as WhiteboardConfig["outlineStrokeStyle"],
              })
            }
          >
            {WHITEBOARD_STROKE_STYLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {textStyle ? (
        <>
          <label className="field-label" htmlFor={`${idPrefix}-text-dir`}>
            Text direction
          </label>
          <select
            id={`${idPrefix}-text-dir`}
            className="editor-select"
            value={config.textAnimDir}
            disabled={disabled}
            onChange={(event) =>
              onChange({ textAnimDir: event.target.value as WhiteboardConfig["textAnimDir"] })
            }
          >
            {WHITEBOARD_TEXT_DIRECTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="field-label" htmlFor={`${idPrefix}-text-style`}>
            Text drawing
          </label>
          <select
            id={`${idPrefix}-text-style`}
            className="editor-select"
            value={config.textDrawStyle}
            disabled={disabled}
            onChange={(event) =>
              onChange({ textDrawStyle: event.target.value as WhiteboardConfig["textDrawStyle"] })
            }
          >
            {WHITEBOARD_TEXT_DRAW_STYLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </>
  );
}

/**
 * Global whiteboard controls. These feed every scene that has not been given
 * its own settings, so the style picker is grouped into the two families
 * Inkplainer exposes: Animation and Drawing.
 */
function GlobalSettings({
  config,
  onChange,
  asr,
  onAsrChange,
  script,
  onScriptChange,
  onScriptCommit,
  onOpenPromptBuilder,
}: {
  config: WhiteboardConfig;
  onChange: (patch: Partial<WhiteboardConfig>) => void;
  asr: AsrConfig;
  onAsrChange: (patch: Partial<AsrConfig>) => void;
  script: string;
  onScriptChange: (text: string) => void;
  onScriptCommit: () => void;
  onOpenPromptBuilder: () => void;
}) {
  return (
    <div className="settings-fields global-settings-fields">
      <div className="settings-row">
        <span>Whiteboard animation</span>
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          <span>{config.enabled ? "On" : "Off"}</span>
        </label>
      </div>
      <div className="settings-row">
        <span>Smooth hand movement</span>
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.smoothHand !== false}
            onChange={(event) => onChange({ smoothHand: event.target.checked })}
          />
          <span>{config.smoothHand !== false ? "On" : "Off"}</span>
        </label>
      </div>
      <div className="settings-row">
        <span>Board writing sound</span>
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.writingSound !== false}
            onChange={(event) => onChange({ writingSound: event.target.checked })}
          />
          <span>{config.writingSound !== false ? "On" : "Off"}</span>
        </label>
      </div>
      <div className="settings-row">
        <span>Hand</span>
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.handVisible !== false}
            onChange={(event) => onChange({ handVisible: event.target.checked })}
          />
          <span>{config.handVisible !== false ? "On" : "Off"}</span>
        </label>
      </div>
      {config.handVisible === false ? (
        <div className="hand-off-grid" role="group" aria-label="Hand off style">
          {HAND_OFF_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={(config.handOffMode ?? "pencil") === mode.value ? "active" : ""}
              onClick={() => onChange({ handOffMode: mode.value })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      ) : null}

      <WhiteboardStyleControls
        idPrefix="global"
        config={config}
        onChange={onChange}
        disabled={!config.enabled}
      />

      <label className="field-label" htmlFor="global-background">
        Background
      </label>
      <select
        id="global-background"
        className="editor-select"
        value={backgroundValue(config.background)}
        onChange={(event) => onChange({ background: event.target.value })}
      >
        {WHITEBOARD_BACKGROUNDS.map((background) => (
          <option key={background.value} value={background.value}>
            {background.label}
          </option>
        ))}
      </select>

      <label className="field-label" htmlFor="global-speed">
        Reveal speed <span>{config.speed}</span>
      </label>
      <input
        id="global-speed"
        className="range-input"
        type="range"
        min="1"
        max="100"
        step="1"
        value={config.speed}
        onChange={(event) => onChange({ speed: Number(event.target.value) })}
      />

      <div className="settings-divider" />
      <span className="settings-eyebrow">NARRATION</span>
      <p className="settings-note">
        Audio is transcribed by Cutline&rsquo;s Cloudflare Worker. Pick the spoken language so
        Whisper listens for the right sounds.
      </p>
      <label className="field-label" htmlFor="script-input">
        Narration script
      </label>
      <textarea
        id="script-input"
        className="cue-script-input settings-script"
        value={script}
        spellCheck={false}
        rows={5}
        placeholder="Paste only the spoken lines. Sync aligns this text to the transcript once, then places every cue against the script."
        onChange={(event) => onScriptChange(event.target.value)}
        onBlur={onScriptCommit}
      />
      <p className="settings-note">
        This is the source of truth for cue words: Polish fixes the wording, the image prompt builds
        cues from it, and Sync matches every cue against these exact words.
      </p>
      <button type="button" className="prompt-open" onClick={onOpenPromptBuilder}>
        <Sparkles size={12} />
        Polish script &amp; build image prompt
      </button>
      <label className="field-label label-with-icon" htmlFor="asr-language">
        <span>
          <Flag size={11} />
          Language
        </span>
        <span>{ASR_LANGUAGES.find((entry) => entry.value === asr.language)?.flag ?? "🌐"}</span>
      </label>
      <select
        id="asr-language"
        className="editor-select"
        value={asr.language}
        onChange={(event) => onAsrChange({ language: event.target.value })}
      >
        {ASR_LANGUAGES.map((language) => (
          <option key={language.value} value={language.value}>
            {language.flag} {language.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Per-scene settings. The style block is the same one the global panel shows,
 * but here every change is written as an override for this clip only.
 */
function ClipWhiteboardSettings({
  config,
  onChange,
}: {
  config: WhiteboardConfig;
  onChange: (patch: Partial<WhiteboardConfig>) => void;
}) {
  return (
    <div className="settings-fields">
      <div className="settings-row">
        <span>Whiteboard animation</span>
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          <span>{config.enabled ? "On" : "Off"}</span>
        </label>
      </div>
      <WhiteboardStyleControls
        idPrefix="clip"
        config={config}
        onChange={onChange}
        disabled={!config.enabled}
      />
      <label className="field-label" htmlFor="clip-hand">
        Hand
      </label>
      <select
        id="clip-hand"
        className="editor-select"
        value={config.hand}
        disabled={!config.enabled}
        onChange={(event) => onChange({ hand: event.target.value as WhiteboardConfig["hand"] })}
      >
        {WHITEBOARD_HANDS.map((hand) => (
          <option key={hand.value} value={hand.value}>
            {hand.label}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="clip-hand-speed">
        Hand speed <span>{config.handSpeed}</span>
      </label>
      <input
        id="clip-hand-speed"
        className="range-input"
        type="range"
        min="1"
        max="20"
        step="1"
        value={config.handSpeed}
        disabled={!config.enabled}
        onChange={(event) => onChange({ handSpeed: Number(event.target.value) })}
      />
      <label className="field-label" htmlFor="clip-speed">
        Reveal speed <span>{config.speed}</span>
      </label>
      <input
        id="clip-speed"
        className="range-input"
        type="range"
        min="1"
        max="100"
        step="1"
        value={config.speed}
        disabled={!config.enabled}
        onChange={(event) => onChange({ speed: Number(event.target.value) })}
      />
    </div>
  );
}

function MediaLibrary({
  media,
  kind,
  onKindChange,
  selectedId,
  onSelect,
  onUse,
  usage,
}: {
  media: MediaItem[];
  kind: LibraryKind;
  onKindChange: (kind: LibraryKind) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUse: (item: MediaItem) => void;
  /** Timeline use count per file URL, so files already placed can be marked. */
  usage: Map<string, number>;
}) {
  const kindLabel = LIBRARY_KINDS.find((option) => option.value === kind)?.label ?? "Image";
  // Voice recordings already live on the timeline, so they stay out of the library.
  const pool = media.filter((item) => item.kind !== "voice");
  const items = pool.filter((item) => item.mediaType === kind);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  return (
    <div className="library-card">
      <div className="library-heading">
        <span className="library-title">
          LIBRARY <b>{items.length.toString().padStart(2, "0")}</b>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="library-filter"
              aria-label={`Library section: ${kindLabel}`}
            >
              {kindLabel}
              <ChevronDown size={11} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="library-filter-menu">
            {LIBRARY_KINDS.map((option) => {
              const count = pool.filter((item) => item.mediaType === option.value).length;
              return (
                <DropdownMenuItem
                  key={option.value}
                  disabled={count === 0}
                  onSelect={() => onKindChange(option.value)}
                >
                  {libraryKindIcon(option.value)}
                  {option.label}
                  <span className="library-filter-count">{count}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {items.length === 0 ? (
        <div className="empty-library">
          <div className="empty-icon">{libraryKindIcon(kind, 19)}</div>
          <p>No {kindLabel.toLowerCase()} files yet</p>
          <span>Import media to add them here</span>
        </div>
      ) : (
        <div className="media-list">
          {items.map((item) => {
            const uses = usage.get(item.src) ?? 0;
            return (
              <button
                key={item.id}
                type="button"
                className={`media-item ${selectedId === item.id ? "is-selected" : ""} ${uses > 0 ? "is-used" : ""}`}
                onClick={() => onSelect(item.id)}
                onDoubleClick={() => onUse(item)}
                title={uses > 0 ? `${item.name} — on timeline ×${uses}` : item.name}
                aria-label={`${item.name}${uses > 0 ? ` (in use ×${uses})` : ""}`}
                aria-pressed={selectedId === item.id}
              >
                <span className={`media-thumb ${item.mediaType}`}>
                  <MediaThumb item={item} />
                  <span className="thumb-kind">
                    {item.mediaType === "image" ? (
                      <ImageIcon size={12} />
                    ) : item.mediaType === "video" ? (
                      <Video size={12} />
                    ) : (
                      <AudioLines size={12} />
                    )}
                  </span>
                  {uses > 0 && (
                    <span className="thumb-used">
                      {uses > 1 ? `×${uses}` : <Check size={10} />}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {items.length > 0 && (
        <div className="library-footer">
          <span className="library-pick" title={selected?.name}>
            {selected ? selected.name : "Select a file"}
          </span>
          <Button
            size="sm"
            className="library-use"
            disabled={!selected}
            onClick={() => {
              if (selected) onUse(selected);
            }}
          >
            Use
          </Button>
        </div>
      )}
    </div>
  );
}

function MediaThumb({ item }: { item: MediaItem }) {
  if (item.mediaType === "image") return <img src={item.src} alt="" />;
  if (item.mediaType === "video") return <video src={item.src} muted preload="metadata" />;
  return <AudioLines size={20} />;
}
