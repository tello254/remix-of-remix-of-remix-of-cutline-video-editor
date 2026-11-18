/**
 * Turns per-slice narration cues into timing patches.
 *
 * A slice only stores the phrase a human wrote ("draw the circle"). This module
 * is what finds that phrase in the transcript and writes the two numbers the
 * timing solver needs: `intendedStart` (when the words are spoken, relative to
 * the clip) and `anchorStart` (where the reveal may actually begin without
 * overlapping the previous one).
 *
 * It is deterministic: slices are visited in order, a repeated cue uses the
 * next occurrence, and nothing is written when the phrase is absent. A cue that
 * cannot be placed is reported, not guessed.
 */

import {
  ANCHOR_WINDOW_SECONDS,
  resolveSliceTiming,
  resolveTriggerAnchor,
  type SliceAnchor,
  type SliceTimingInput,
  type TranscriptWord,
} from "@/lib/slice-timing";

const EPSILON = 1e-6;

export type CueSlice = {
  id: string;
  cue?: string | undefined;
  timing?: SliceTimingInput | undefined;
};

export type CueSyncOptions = {
  /**
   * Converts transcript time to clip time: `clipTime = transcriptTime - offset`.
   * Derived from where the audio clip sits on the timeline and how far it is
   * trimmed, so a narration that starts before the image still lines up.
   */
  offsetSeconds: number;
  clipDuration: number;
};

export type CueTimingPatch = {
  intendedStart: number;
  anchorStart: number;
  anchor: SliceAnchor;
};

export type CueSyncResult = {
  patches: { id: string; timing: CueTimingPatch }[];
  /** Cues whose words could not be found, or that fall outside this clip. */
  missing: { id: string; cue: string }[];
  /** Slices with no cue written yet. */
  noCue: string[];
  /** Slices whose words exist but had to be moved past the previous reveal. */
  clamped: string[];
};

function normaliseCue(cue: string) {
  return cue
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** All the ways this sync can fail, expressed as data rather than silence. */
export function syncSliceCues(
  slices: CueSlice[],
  words: TranscriptWord[],
  options: CueSyncOptions,
): CueSyncResult {
  const offset = options.offsetSeconds;
  const duration = Math.max(0, options.clipDuration);
  const patches: CueSyncResult["patches"] = [];
  const missing: CueSyncResult["missing"] = [];
  const noCue: string[] = [];
  const clamped: string[] = [];

  if (!slices.length) return { patches, missing, noCue, clamped };

  if (!words.length) {
    return {
      patches,
      missing: slices
        .filter((slice) => (slice.cue ?? "").trim())
        .map((slice) => ({ id: slice.id, cue: (slice.cue ?? "").trim() })),
      noCue: slices.filter((slice) => !(slice.cue ?? "").trim()).map((slice) => slice.id),
      clamped,
    };
  }

  // Authored reveal lengths keep the lower bound honest without solving the
  // whole schedule twice: the next slice may not start inside this reveal.
  const authored = resolveSliceTiming(
    slices.map((slice) => ({ id: slice.id, timing: slice.timing })),
    duration,
  ).slices;
  const animations = new Map(authored.map((timing) => [timing.id, timing.animation]));

  const seen = new Map<string, number>();
  let previousRevealEnd = 0;

  for (const slice of slices) {
    const cue = (slice.cue ?? "").trim();
    if (!cue) {
      noCue.push(slice.id);
      continue;
    }

    const key = normaliseCue(cue);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    const timing = slice.timing ?? {};
    const resolution = resolveTriggerAnchor(
      words,
      cue,
      occurrence,
      previousRevealEnd + offset,
      {
        windowSeconds: timing.anchorWindow ?? ANCHOR_WINDOW_SECONDS,
        allowClauseCrossing: timing.crossClause === true,
      },
    );

    if (!resolution) {
      missing.push({ id: slice.id, cue });
      continue;
    }

    const intendedStart = resolution.intendedStart - offset;
    const anchorStart = resolution.anchor.time - offset;

    // A cue before this image begins or after it ends belongs to another scene.
    // Clamping it would silently point the reveal at the wrong words.
    if (intendedStart < -EPSILON || intendedStart > duration + EPSILON) {
      missing.push({ id: slice.id, cue });
      continue;
    }

    patches.push({
      id: slice.id,
      timing: {
        intendedStart: Math.min(duration, Math.max(0, intendedStart)),
        anchorStart: Math.min(duration, Math.max(0, anchorStart)),
        anchor: resolution.anchor,
      },
    });

    if (resolution.clamped) clamped.push(slice.id);
    previousRevealEnd = Math.max(0, anchorStart) + (animations.get(slice.id) ?? 0);
  }

  return { patches, missing, noCue, clamped };
}
