/**
 * Whiteboard animation settings shared by the editor and the engine host.
 * These defaults mirror Inkplainer's original (pre-change) defaults, except the
 * background, which is an explicit white board so every photo reads correctly.
 */
export const WHITEBOARD_STYLES = [
  { value: "chunkjump", label: "Chunk Jump" },
  { value: "scanner", label: "Scanner" },
  { value: "contour", label: "Contour" },
  { value: "outlinechunks", label: "Outline Chunks" },
  { value: "scribble", label: "Scribble" },
  { value: "illustfill", label: "Illust Fill" },
  { value: "outlinefill", label: "Outline Fill" },
  { value: "outlineonly", label: "Outline Only" },
  { value: "spec-text", label: "Text" },
  { value: "spec-human", label: "Human" },
  { value: "spec-animal", label: "Animal" },
  { value: "spec-portrait", label: "Portrait" },
  { value: "spec-vehicle", label: "Vehicle" },
  { value: "spec-building", label: "Building" },
  { value: "spec-landscape", label: "Landscape" },
  { value: "spec-spiral", label: "Spiral" },
] as const;

/** The two groups shown in the global settings style picker. */
export const WHITEBOARD_ANIMATION_STYLES = [
  { value: "scanner", label: "Scanner" },
  { value: "outlinechunks", label: "Outline Chunks" },
  { value: "chunkjump", label: "Chunk Jump" },
  { value: "contour", label: "Contour" },
] as const;

export const WHITEBOARD_DRAWING_STYLES = [
  { value: "outlinefill", label: "Outline Fill" },
  { value: "illustfill", label: "Illust Fill" },
  { value: "outlineonly", label: "Outline Only" },
  { value: "spec-text", label: "Text" },
] as const;

/**
 * Backgrounds ported from Inkplainer: three solids plus the ten canvas presets.
 * Gradient keys are resolved by the engine host; the rest are CSS colours.
 */
export const WHITEBOARD_BACKGROUNDS = [
  { value: "white", label: "White" },
  { value: "black", label: "Black" },
  { value: "transparent", label: "None" },
  { value: "notebook", label: "Notebook" },
  { value: "graph", label: "Graph" },
  { value: "cream", label: "Cream" },
  { value: "chalk", label: "Chalkboard" },
  { value: "softgrad", label: "Soft Gradient" },
  { value: "warmwhite", label: "Warm White" },
  { value: "blueprint", label: "Blueprint" },
  { value: "kraft", label: "Kraft" },
  { value: "dark", label: "Dark" },
  { value: "linen", label: "Linen" },
] as const;

export type WhiteboardStyle = (typeof WHITEBOARD_STYLES)[number]["value"] | "slicer";

export const WHITEBOARD_HANDS = [
  { value: "custom1", label: "Hand 1" },
  { value: "custom2", label: "Hand 2" },
  { value: "custom3", label: "Hand 3" },
  { value: "custom4", label: "Pen" },
  { value: "ghost", label: "No hand" },
] as const;

export type WhiteboardHand = (typeof WHITEBOARD_HANDS)[number]["value"];

/** Choices shown when the Hand switch is turned off. */
export const HAND_OFF_MODES = [
  { value: "pencil", label: "Pencil only" },
  { value: "invisible", label: "Invisible" },
] as const;

export type HandOffMode = (typeof HAND_OFF_MODES)[number]["value"];

/**
 * A user-drawn region of the photo. Points are normalised (0–1) across the
 * image, so a slice survives zooming, resizing and re-measuring.
 */
export type SlicePoint = { x: number; y: number };

export type SliceShape = {
  id: string;
  /**
   * Permanent label shown on the slice (1..N). It never changes when the slice
   * is moved; it only renumbers if a slice is deleted.
   */
  number: number;
  /** 1-based position in the animation sequence: 1 plays first. */
  order: number;
  points: SlicePoint[];
  /**
   * The narration phrase that should start this slice's reveal. It is only a
   * lookup key into the transcript; `timing.intendedStart` holds the resolved
   * time once the cue is synced.
   */
  cue?: string | undefined;
  /**
   * Resolved timing, as fractions of the scene (0–1). The engine paints this
   * slice only inside `band`, so a slice can wait its turn while the previous
   * reveal holds — the lag/animation/hold split from `slice-timing.ts`.
   */
  band?: { start: number; end: number };
  /** Authored timing inputs; lag and hold are derived from them. */
  timing?: {
    intendedStart?: number;
    animation?: number;
    minHold?: number;
    startOverride?: number | null;
    anchor?: { wordIndex: number; text: string; time: number } | null;
    anchorStart?: number | null;
    /** Widened cue search, set by the "too tight" fix. */
    anchorWindow?: number | null;
    crossClause?: boolean | null;
  };
};

export type WhiteboardRevealStyle =
  "instant" | "fade" | "dissolve" | "wipe-right" | "iris" | "scan-lines";

/** Text-only knobs for the Text drawing style. */
export const WHITEBOARD_TEXT_DIRECTIONS = [
  { value: "ltr", label: "Left → right" },
  { value: "rtl", label: "Right → left" },
  { value: "ttb", label: "Top → bottom" },
  { value: "btt", label: "Bottom → top" },
] as const;

export const WHITEBOARD_TEXT_DRAW_STYLES = [
  { value: "reveal", label: "Reveal" },
  { value: "outline", label: "Outline" },
  { value: "outline-fill", label: "Outline + fill" },
] as const;

export const WHITEBOARD_COLOR_STYLES = [
  { value: "sparse", label: "Sparse" },
  { value: "filled", label: "Filled" },
  { value: "watercolor", label: "Watercolor" },
] as const;

export const WHITEBOARD_OUTLINE_ALGORITHMS = [
  { value: "classic", label: "Classic" },
  { value: "adaptive", label: "Adaptive" },
  { value: "morph-shell", label: "Morph shell" },
  { value: "canny2", label: "Canny" },
] as const;

export const WHITEBOARD_STROKE_STYLES = [
  { value: "default", label: "Default" },
  { value: "charcoal", label: "Charcoal" },
  { value: "multipass", label: "Multipass" },
  { value: "fountain", label: "Fountain" },
  { value: "blueprint", label: "Blueprint" },
] as const;

export type WhiteboardConfig = {
  enabled: boolean;
  style: WhiteboardStyle;
  speed: number;
  handSpeed: number;
  hand: WhiteboardHand;
  /** Smooth glide between hand positions instead of snapping each frame. */
  smoothHand: boolean;
  /** Play the board-writing sound while the pen is moving. */
  writingSound: boolean;
  /** When false, the hand is replaced by `handOffMode`. */
  handVisible: boolean;
  handOffMode: HandOffMode;
  background: string;
  revealStyle: WhiteboardRevealStyle;
  colorStyle: "sparse" | "filled" | "watercolor";
  outlineDetect: number;
  outlineAlgorithm: "classic" | "adaptive" | "morph-shell" | "canny2";
  outlineStrokeStyle: "default" | "charcoal" | "multipass" | "fountain" | "blueprint";
  /** Tile count for the chunk-based animation styles. */
  chunks: number;
  /** Tile count for the Text style. */
  specChunks: number;
  /** Scanner/Chunk Jump alternate direction each row. */
  zigzag: boolean;
  textAnimDir: "ltr" | "rtl" | "ttb" | "btt";
  textDrawStyle: "reveal" | "outline" | "outline-fill";
  /** User-drawn regions; when present the engine animates them in order. */
  slices?: SliceShape[];
  /**
   * Length of the slice schedule in seconds. When set, the engine's frame count
   * follows it instead of the uniform `slices × block` estimate, so seeking
   * maps one engine frame to one timeline frame.
   */
  timingSeconds?: number;
};

export const DEFAULT_WHITEBOARD_CONFIG: WhiteboardConfig = {
  enabled: true,
  style: "chunkjump",
  speed: 40,
  handSpeed: 6,
  hand: "custom1",
  smoothHand: true,
  writingSound: true,
  handVisible: true,
  handOffMode: "pencil",
  background: "white",
  revealStyle: "fade",
  colorStyle: "filled",
  outlineDetect: 50,
  outlineAlgorithm: "classic",
  outlineStrokeStyle: "default",
  chunks: 30,
  specChunks: 35,
  zigzag: true,
  textAnimDir: "ltr",
  textDrawStyle: "reveal",
};

export function makeWhiteboardConfig(overrides?: Partial<WhiteboardConfig>): WhiteboardConfig {
  return { ...DEFAULT_WHITEBOARD_CONFIG, ...overrides };
}
