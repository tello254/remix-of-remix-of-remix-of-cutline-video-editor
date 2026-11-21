/**
 * Slice timing inside one image clip.
 *
 * Every slice occupies three consecutive regions of the clip's own timeline:
 *
 *   lag        the cut exists but nothing is drawn yet (audio keeps playing)
 *   animation  the reveal is actually drawn
 *   hold       the finished reveal stays on screen until the next slice
 *
 * Only two of the three can be authored, because both ends of a slice are
 * pinned by the audio: the start by its trigger and the end by the next
 * slice's start. So `animation` is authored (with a minimum), while `lag` and
 * `hold` are derived. Storing all three would let them drift out of sync the
 * moment a neighbour moves.
 *
 * The resolver is a pure function over the slice list: same inputs, same
 * schedule, every time. Nothing here invents a solution silently — when the
 * audio and the drawing cannot both fit, the slice is flagged and the editor
 * offers the user a choice.
 */

import { SLICER_FPS, SLICER_PAINT_TICKS, SLICER_TRAVEL_TICKS, slicerBands } from "@/whiteboard/slicer";

/** A reveal shorter than this reads as a smear rather than a drawing. */
export const MIN_SLICE_ANIMATION = 0.25;
/** A completed reveal needs at least this long on screen to register. */
export const MIN_SLICE_HOLD = 0.3;
/**
 * Breathing room after the final reveal when the voice stops mid-slice. The
 * scene normally runs to the end of its narration; this only applies when a
 * drawing finishes later than the last word.
 */
export const SLICE_END_HOLD = 0.5;

const EPSILON = 1e-6;

export type SliceAnchor = {
  /** Index into the transcript's word list. */
  wordIndex: number;
  /** The spoken words that were matched. */
  text: string;
  /** Seconds from the start of the recording. */
  time: number;
};

export type SliceTimingInput = {
  /** Seconds into the clip where this slice's idea is first spoken. */
  intendedStart?: number;
  /** Authored reveal duration. */
  animation?: number;
  /** The shortest hold the editor will accept before flagging the slice. */
  minHold?: number;
  /** Set when the user dragged the reveal away from `intendedStart`. */
  startOverride?: number | null;
  /** Resolved from the transcript when the trigger phrase repeats. */
  anchor?: SliceAnchor | null;
  /** Where the anchor would start the slice, before collision clamping. */
  anchorStart?: number | null;
  /**
   * How far from the original trigger an anchor may be borrowed. Set by the
   * "widen cue search" fix when a reveal is too tight in place.
   */
  anchorWindow?: number | null;
  /** Allows the widened search to cross a clause break. */
  crossClause?: boolean | null;
  /**
   * Set when the slice's words could not be found and its position was fitted
   * between its neighbours instead. Estimation is never silent: the resolver
   * raises a flag so the editor can badge it.
   */
  estimated?: boolean | null;
};

export type SliceTimingFlag =
  /** The requested start would overlap the previous reveal, so it was pushed. */
  | "clamped"
  /** The authored reveal does not fit before the next slice, or hold is short. */
  | "tight"
  /** The user moved the start by hand. */
  | "override"
  /** The slice now begins before the words that describe it. */
  | "early"
  /** Its words were not found, so its place was fitted between its neighbours. */
  | "estimated"
  /**
   * The slice has a cue but no place in this scene: alignment could not find
   * its words (they belong to another image), so it has no reveal at all. The
   * engine must not paint it on a guessed uniform slot.
   */
  | "unplaced";

export type ResolvedSliceTiming = {
  id: string;
  /** Seconds into the clip. Always >= the previous reveal's end. */
  start: number;
  animation: number;
  animEnd: number;
  /** Seconds from the end of the reveal to the next slice's start. */
  hold: number;
  /** `start - intendedStart`. Negative means the slice runs ahead of the words. */
  lag: number;
  flags: SliceTimingFlag[];
};

export type SliceTimingResolution = {
  slices: ResolvedSliceTiming[];
  /** The clip length the schedule was solved against. */
  sceneSeconds: number;
};

type SliceLike = {
  id: string;
  /** Present on real slices; a cued scene never schedules uncued slices blindly. */
  cue?: string | undefined;
  timing?: SliceTimingInput | undefined;
};

/**
 * What the engine's uniform slicer would have done, expressed as authored
 * timing. Used when a slice carries no timing of its own, so existing projects
 * look exactly as they did before the schedule became explicit.
 */
export function defaultSliceTimings(
  count: number,
  clipDuration: number,
): { intendedStart: number; animation: number }[] {
  if (count <= 0) return [];
  return slicerBands(count, clipDuration).map((band) => ({
    intendedStart: band.start * Math.max(0.1, clipDuration),
    animation: Math.max(EPSILON, (band.end - band.start) * Math.max(0.1, clipDuration)),
  }));
}

/** The reveal length the engine produces before any timing is authored. */
export function naturalSliceAnimation() {
  return SLICER_PAINT_TICKS / SLICER_FPS;
}

/** One slice's share of the natural (uniform) slicer schedule, in seconds. */
export function naturalSliceBlock() {
  return (SLICER_PAINT_TICKS + 2 * SLICER_TRAVEL_TICKS) / SLICER_FPS;
}

/**
 * Solves the slice schedule for one clip.
 *
 * Starts are resolved first, each pushed past the previous reveal's end; only
 * then are reveals and holds measured against the following start. That order
 * is what guarantees the one hard rule: two reveals never overlap, while a
 * lag is allowed to sit on top of the previous hold (nothing is being drawn
 * there, so the overlap costs nothing visually).
 */
export function resolveSliceTiming(
  orderedSlices: SliceLike[],
  clipDuration: number,
  options?: { minAnimation?: number; minHold?: number },
): SliceTimingResolution {
  const scene = Math.max(0, clipDuration);
  const minAnimation = options?.minAnimation ?? MIN_SLICE_ANIMATION;
  const defaultMinHold = options?.minHold ?? MIN_SLICE_HOLD;
  if (!orderedSlices.length) return { slices: [], sceneSeconds: scene };

  // A scene whose slices carry trigger phrases is timed by the narration. Only
  // a scene with no cues at all keeps the uniform fallback. Otherwise a slice
  // that alignment could not place (its words belong to another image) would
  // still steal a default slot ahead of the cues that *were* measured, which is
  // exactly what makes reveals look like they animate wherever they like.
  const cuedScene = orderedSlices.some((slice) => (slice.cue ?? "").trim().length > 0);

  const defaults = defaultSliceTimings(orderedSlices.length, scene);
  const authored = orderedSlices.map((slice, index) => {
    const timing = slice.timing ?? {};
    // Once a slice has been placed by the narration it no longer shares the
    // scene evenly with its neighbours. Its reveal keeps the engine's natural
    // paint time and the hold absorbs the rest, so growing the scene to fit a
    // long voice never turns a one-second drawing into a slow one.
    const placed = timing.intendedStart !== undefined || (timing.anchorStart ?? null) !== null;
    const unplaced = cuedScene && !placed;
    return {
      id: slice.id,
      unplaced,
      intended: unplaced ? 0 : timing.intendedStart ?? defaults[index]?.intendedStart ?? 0,
      animation: unplaced
        ? 0
        : Math.max(
            EPSILON,
            timing.animation ?? (placed ? naturalSliceAnimation() : defaults[index]?.animation) ?? 1,
          ),
      minHold: timing.minHold ?? defaultMinHold,
      override: unplaced ? null : (timing.startOverride ?? null),
      anchorStart: unplaced ? null : (timing.anchorStart ?? null),
    };
  });

  // Desired starts first: they come from the anchors and overrides alone.
  const desired = authored.map((slice) =>
    slice.unplaced ? null : (slice.override ?? slice.anchorStart ?? slice.intended),
  );

  // The next slice that owns a reveal. An unplaced slice must not shorten the
  // animation of the slice before it, nor push the one after it.
  const nextPlaced = (index: number) => {
    for (let cursor = index + 1; cursor < authored.length; cursor += 1) {
      if (!authored[cursor]?.unplaced) return cursor;
    }
    return -1;
  };

  // One forward pass. A reveal may be shortened to fit before the *next*
  // slice's intended start — drawing a little faster is always preferable to
  // dragging the next slice off its trigger. Only when even the minimum
  // animation would collide does the next slice get pushed, and that shows up
  // as a `clamped` flag on it rather than being hidden.
  const slices: ResolvedSliceTiming[] = [];
  let previousRevealEnd = 0;

  authored.forEach((slice, index) => {
    if (slice.unplaced) {
      slices.push({
        id: slice.id,
        start: 0,
        animation: 0,
        animEnd: 0,
        hold: 0,
        lag: 0,
        flags: ["unplaced"],
      });
      return;
    }

    const flags: SliceTimingFlag[] = [];
    const want = desired[index] ?? 0;
    let start = Math.max(want, previousRevealEnd);

    if (start > want + EPSILON) flags.push("clamped");
    if (slice.override !== null) flags.push("override");
    if (start < slice.intended - EPSILON) flags.push("early");
    if (orderedSlices[index]?.timing?.estimated === true) flags.push("estimated");

    start = Math.max(0, Math.min(start, Math.max(0, scene - minAnimation)));

    const next = nextPlaced(index);
    const nextDesired = (next >= 0 ? desired[next] : null) ?? scene;
    const nextIntended = (next >= 0 ? authored[next]?.intended : null) ?? scene;
    // Room is measured against whichever of the next slice's positions is
    // later. A slice dragged *earlier* than its cue must not eat into the
    // previous reveal — it gets clamped instead, and the previous slice keeps
    // the animation the user authored.
    const room = Math.max(0, Math.max(nextDesired, nextIntended) - start);
    let animation = slice.animation;
    if (animation > room + EPSILON) {
      animation = Math.max(minAnimation, room);
      flags.push("tight");
    }
    const animEnd = start + animation;
    previousRevealEnd = animEnd;

    slices.push({
      id: slice.id,
      start,
      animation,
      animEnd,
      hold: 0,
      lag: start - slice.intended,
      flags,
    });
  });

  // Holds are residual: everything between the end of a reveal and the next
  // slice's start. A lag on the next slice may sit on top of it.
  return {
    slices: slices.map((slice, index) => {
      if (slice.flags.includes("unplaced")) {
        return { ...slice, flags: [...new Set(slice.flags)] };
      }
      const next = nextPlaced(index);
      const nextStart = next >= 0 ? (slices[next]?.start ?? scene) : scene;
      const hold = Math.max(0, Math.max(slice.start, nextStart) - slice.animEnd);
      const sliceMinHold = authored[index]?.minHold ?? defaultMinHold;
      const flags = [...slice.flags];
      if (hold + EPSILON < sliceMinHold) flags.push("tight");
      return { ...slice, hold, flags: [...new Set(flags)] };
    }),
    sceneSeconds: scene,
  };
}

/** Band fractions for the whiteboard engine, which thinks in 0–1 clip time. */
export function timingBands(timings: ResolvedSliceTiming[], sceneSeconds: number) {
  const scene = Math.max(1e-6, sceneSeconds);
  return timings.map((timing) => ({
    start: Math.min(1, Math.max(0, timing.start / scene)),
    end: Math.min(1, Math.max(0, timing.animEnd / scene)),
  }));
}

// ── Trigger resolution ─────────────────────────────────────────────────────
// The transcript gives times for *spoken* words. A trigger phrase copied into
// the slice map is only a lookup key, and a repeated phrase is ambiguous — so
// the resolver widens it to the nearest phrase that occurs exactly once. The
// widening is ordered, which is what keeps it deterministic: the same
// transcript and trigger always produce the same anchor.

export type TranscriptWord = {
  text: string;
  start: number;
  end: number;
  /** True when the word ends a clause, so a phrase cannot be widened past it. */
  clauseBreakAfter?: boolean;
};

export type AnchorKind = "forward-bigram" | "forward-word" | "backward-bigram" | "backward-word";

export type AnchorCandidate = {
  kind: AnchorKind;
  wordIndex: number;
  text: string;
  time: number;
};

export type TriggerResolution = {
  /** Time of the occurrence the slice was pointed at. */
  intendedStart: number;
  /** The unique phrase used to place the slice. */
  anchor: AnchorCandidate;
  /** How many times the original trigger appears. */
  occurrences: number;
  /** True when the trigger repeats and an anchor had to be found. */
  ambiguous: boolean;
  /** True when no candidate was free; the start must be clamped. */
  clamped: boolean;
};

/** How far around the original trigger an anchor may be borrowed from. */
export const ANCHOR_WINDOW_SECONDS = 1.5;

const WORD_SPLIT = /\s+/;

function normaliseToken(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "")
    .trim();
}

function endsClause(value: string) {
  return /[.,;:!?]["')\]]*$/.test(value.trim());
}

function transcriptTokens(words: TranscriptWord[]) {
  return words.map((word) => normaliseToken(word.text)).filter((token) => token.length > 0);
}

/** Indices where `phrase` appears as consecutive words. */
function findOccurrences(tokens: string[], phrase: string[]) {
  const found: number[] = [];
  if (!phrase.length) return found;
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    let matches = true;
    for (let j = 0; j < phrase.length; j += 1) {
      if (tokens[i + j] !== phrase[j]) {
        matches = false;
        break;
      }
    }
    if (matches) found.push(i);
  }
  return found;
}

function countNgram(tokens: string[], at: number, length: number) {
  const phrase = tokens.slice(at, at + length);
  return findOccurrences(tokens, phrase).length;
}

/**
 * True when the phrase appears as consecutive words in the transcript.
 *
 * Used by the slicer's manual trigger field: a cue typed there must be words
 * Whisper actually heard, not words from the written script that were never
 * spoken. Punctuation and case are ignored, word order is not.
 */
export function transcriptHasPhrase(words: TranscriptWord[], phrase: string) {
  const target = phrase
    .split(WORD_SPLIT)
    .map(normaliseToken)
    .filter((token) => token.length > 0);
  if (!target.length) return false;
  return findOccurrences(transcriptTokens(words), target).length > 0;
}

/**
 * Places one slice's trigger in the transcript.
 *
 * Order is fixed and intentional: nearest forward bigram, forward single word,
 * backward bigram, backward single word. The first candidate that does not
 * start before `lowerBound` (the previous reveal's end) wins. If none is free,
 * the original occurrence is returned with `clamped: true` so the caller can
 * push the start to `lowerBound` and flag the slice.
 */
export function resolveTriggerAnchor(
  words: TranscriptWord[],
  trigger: string,
  occurrence: number,
  lowerBound: number,
  options?: { windowSeconds?: number; allowClauseCrossing?: boolean },
): TriggerResolution | null {
  const tokens = transcriptTokens(words);
  if (!tokens.length) return null;
  const phrase = trigger
    .split(WORD_SPLIT)
    .map(normaliseToken)
    .filter((token) => token.length > 0);
  if (!phrase.length) return null;

  const occurrences = findOccurrences(tokens, phrase);
  if (!occurrences.length) return null;

  const chosenIndex = occurrences[Math.min(Math.max(0, occurrence), occurrences.length - 1)] ?? 0;
  const chosenWord = words[chosenIndex];
  if (!chosenWord) return null;

  const window = options?.windowSeconds ?? ANCHOR_WINDOW_SECONDS;
  const crossClause = options?.allowClauseCrossing === true;
  const unambiguous = occurrences.length === 1;
  const base: AnchorCandidate = {
    kind: "forward-word",
    wordIndex: chosenIndex,
    text: trigger,
    time: chosenWord.start,
  };

  if (unambiguous) {
    return {
      intendedStart: chosenWord.start,
      anchor: base,
      occurrences: occurrences.length,
      ambiguous: false,
      clamped: false,
    };
  }

  // Widen the phrase until it is unique, without leaving the clause or the
  // time window. Nearest first, then wider kinds — never a different order.
  const forwardBigram: AnchorCandidate[] = [];
  const forwardWord: AnchorCandidate[] = [];
  const backwardBigram: AnchorCandidate[] = [];
  const backwardWord: AnchorCandidate[] = [];

  let blocked = false;
  for (let i = chosenIndex + phrase.length; i < words.length; i += 1) {
    const word = words[i];
    if (!word) break;
    if (word.start - chosenWord.start > window) break;
    if (blocked) break;
    const token = tokens[i];
    if (!token) continue;
    const spansClause = endsClause(word.text) || Boolean(word.clauseBreakAfter);
    if (i + 1 < tokens.length && !spansClause && countNgram(tokens, i, 2) === 1) {
      forwardBigram.push({
        kind: "forward-bigram",
        wordIndex: i,
        text: `${word.text} ${words[i + 1]?.text ?? ""}`.trim(),
        time: word.start,
      });
    }
    if (countNgram(tokens, i, 1) === 1) {
      forwardWord.push({ kind: "forward-word", wordIndex: i, text: word.text, time: word.start });
    }
    if (spansClause && !crossClause) blocked = true;
  }

  blocked = false;
  for (let i = chosenIndex - 1; i >= 0; i -= 1) {
    const word = words[i];
    if (!word) break;
    if (chosenWord.start - word.start > window) break;
    if (blocked) break;
    const token = tokens[i];
    if (!token) continue;
    const spansClause = endsClause(word.text) || Boolean(words[i + 1]?.clauseBreakAfter);
    if (i + 1 < tokens.length && !spansClause && countNgram(tokens, i, 2) === 1) {
      backwardBigram.push({
        kind: "backward-bigram",
        wordIndex: i,
        text: `${word.text} ${words[i + 1]?.text ?? ""}`.trim(),
        time: word.start,
      });
    }
    if (countNgram(tokens, i, 1) === 1) {
      backwardWord.push({ kind: "backward-word", wordIndex: i, text: word.text, time: word.start });
    }
    if (spansClause && !crossClause) blocked = true;
  }

  const ordered = [...forwardBigram, ...forwardWord, ...backwardBigram, ...backwardWord];
  const free = ordered.find((candidate) => candidate.time >= lowerBound - EPSILON);

  if (!free) {
    return {
      intendedStart: chosenWord.start,
      anchor: base,
      occurrences: occurrences.length,
      ambiguous: true,
      clamped: true,
    };
  }

  return {
    intendedStart: chosenWord.start,
    anchor: free,
    occurrences: occurrences.length,
    ambiguous: true,
    clamped: false,
  };
}

/** Midpoint of a word, used when only an onset estimate is available. */
export function wordMidpoint(word: TranscriptWord) {
  return (word.start + word.end) / 2;
}
