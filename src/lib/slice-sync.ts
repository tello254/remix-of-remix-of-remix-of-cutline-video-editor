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
 * next occurrence, and nothing is invented silently. When a cue cannot be found
 * at all, the slice is not dropped — it is *fitted* between its neighbours using
 * the narration's own pauses, and marked `estimated` so the editor can show it.
 */

import {
  ANCHOR_WINDOW_SECONDS,
  MIN_SLICE_ANIMATION,
  defaultSliceTimings,
  naturalSliceAnimation,
  resolveTriggerAnchor,
  type SliceAnchor,
  type SliceTimingInput,
  type TranscriptWord,
} from "@/lib/slice-timing";

const EPSILON = 1e-6;

/** A silence this long between words reads as a phrase boundary. */
const BEAT_PAUSE_SECONDS = 0.12;
/** A silence this long reads as a clause boundary on its own. */
const BEAT_STRONG_PAUSE_SECONDS = 0.25;
/** Only beats this close to the target count as candidates for "nearest". */
const BEAT_NEAR_SECONDS = 1;
/** A gap longer than this share of the previous draw looks like dead air. */
const DEAD_AIR_RATIO = 0.5;

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
  /**
   * How long this scene may become. The scene is sized by its narration, so a
   * cue spoken at 12 s is not dropped because the picture drew in 9 s. Callers
   * pass the nearest boundary the scene may not cross (the next clip on the
   * row, or the end of the voice). Omitted means "stay inside `clipDuration`".
   */
  maxDuration?: number | undefined;
  /**
   * Every place the narration takes a breath, used only to place slices whose
   * words are missing. Without it a missing cue stays missing.
   */
  candidates?: BeatCandidate[] | undefined;
};

export type CueTimingPatch = {
  intendedStart: number;
  anchorStart: number;
  anchor: SliceAnchor;
  /** Rarely authored: estimation may shorten a reveal to fit its gap. */
  animation?: number;
  /** True when this position was fitted, not measured from the words. */
  estimated: boolean;
};

export type CueSyncResult = {
  patches: { id: string; timing: CueTimingPatch }[];
  /** Cues whose words could not be found *and* could not be fitted. */
  missing: { id: string; cue: string }[];
  /** Slices with no cue written yet. */
  noCue: string[];
  /** Slices whose words exist but had to be moved past the previous reveal. */
  clamped: string[];
  /** Slices placed by rule because their words were not heard. */
  estimated: string[];
  /**
   * Clip-local second where the last reveal finishes. The caller grows the
   * scene to this, so the narration — not the picture's natural draw time —
   * decides how long the cut is. Zero when nothing could be placed.
   */
  spanEnd: number;
};

/** A beat placed by the script aligner, addressed by slice id. */
export type BeatAnchor = {
  id: string;
  cue: string;
  /** The first heard word of the beat, in recording time. */
  anchor: SliceAnchor;
};

/**
 * A boundary the narration actually makes: the start of a word that follows a
 * pause or a clause mark. `strength` orders them — a full stop beats a comma,
 * which beats a breath, which beats an ordinary word.
 */
export type BeatCandidate = {
  wordIndex: number;
  text: string;
  /** Seconds from the start of the recording. */
  time: number;
  strength: 1 | 2 | 3;
};

const SENTENCE_END = /[.!?]["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;

/**
 * Derives the narration's own beat grid from the transcript. Pure and stable:
 * the same words always produce the same candidates, so a missing cue is placed
 * the same way on every sync.
 */
export function narrationBeats(words: TranscriptWord[]): BeatCandidate[] {
  const beats: BeatCandidate[] = [];

  words.forEach((word, index) => {
    const previous = words[index - 1];
    const gap = previous ? Math.max(0, word.start - previous.end) : 0;
    if (previous && gap < BEAT_PAUSE_SECONDS) return;

    let strength: BeatCandidate["strength"] = 1;
    if (previous) {
      if (SENTENCE_END.test(previous.text) || previous.clauseBreakAfter) strength = 3;
      else if (CLAUSE_END.test(previous.text)) strength = 2;
      else if (gap >= BEAT_STRONG_PAUSE_SECONDS) strength = 2;
    }

    beats.push({ wordIndex: index, text: word.text, time: word.start, strength });
  });

  return beats;
}

/**
 * The "nearest biggest" beat inside a window: among the beats closest to the
 * window's end, take the strongest, and prefer the later one on a tie. Keeps a
 * comma near the end from dragging the slice to a full stop a paragraph back.
 */
function pickBeat(candidates: BeatCandidate[], from: number, to: number) {
  const inside = candidates.filter(
    (candidate) => candidate.time >= from - EPSILON && candidate.time <= to + EPSILON,
  );
  if (!inside.length) return null;

  const near = inside.filter((candidate) => candidate.time >= to - BEAT_NEAR_SECONDS - EPSILON);
  const pool = near.length ? near : inside;
  const best = Math.max(...pool.map((candidate) => candidate.strength));
  const strongest = pool.filter((candidate) => candidate.strength === best);
  return strongest[strongest.length - 1] ?? null;
}

type Plan = {
  slice: CueSlice;
  cue: string;
  status: "matched" | "no-cue" | "not-found" | "outside";
  anchor?: SliceAnchor;
  /** Seconds into the clip where the words are spoken. */
  intended?: number;
  /** Seconds into the clip where the reveal may begin. */
  start?: number;
  /** Set only when the fitted gap forced a shorter drawing. */
  animation?: number;
  clamped?: boolean;
  estimated?: boolean;
};

function normaliseCue(cue: string) {
  return cue
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Anchored = { anchor: SliceAnchor; clamped: boolean };

/**
 * Shared solver for both paths. `resolve` is the only part that differs: the
 * transcript path searches for the cue's words, the script path looks up the
 * beat the aligner already placed.
 */
function solve(
  slices: CueSlice[],
  options: CueSyncOptions,
  resolve: (slice: CueSlice, cue: string, lowerBoundRecording: number) => Anchored | null,
): CueSyncResult {
  const offset = options.offsetSeconds;
  const duration = Math.max(0, options.clipDuration);
  // The scene may be longer than the picture's natural draw time, but never
  // shorter: `maxDuration` only widens the boundary the solver works inside.
  const limit = Math.max(duration, options.maxDuration ?? duration);
  const patches: CueSyncResult["patches"] = [];
  const missing: CueSyncResult["missing"] = [];
  const noCue: string[] = [];
  const clamped: string[] = [];
  const estimated: string[] = [];
  let spanEnd = 0;

  if (!slices.length)
    return { patches, missing, noCue, clamped, estimated, spanEnd };

  // What each slice *wants* to draw. Deliberately the authored length rather
  // than the solver's possibly-shortened one: planning a neighbour against a
  // drawing that was itself squeezed would shrink every gap in turn.
  const defaults = defaultSliceTimings(slices.length, duration);
  const animations = new Map(
    slices.map((slice, index) => {
      const timing = slice.timing ?? {};
      const placed = timing.intendedStart !== undefined || (timing.anchorStart ?? null) !== null;
      return [
        slice.id,
        Math.max(
          EPSILON,
          timing.animation ?? (placed ? naturalSliceAnimation() : defaults[index]?.animation) ?? 1,
        ),
      ];
    }),
  );
  const animationOf = (id: string) => animations.get(id) ?? 0;

  const plans: Plan[] = [];
  let previousRevealEnd = 0;

  for (const slice of slices) {
    const cue = (slice.cue ?? "").trim();
    if (!cue) {
      plans.push({ slice, cue, status: "no-cue" });
      continue;
    }

    const resolution = resolve(slice, cue, previousRevealEnd + offset);
    if (!resolution) {
      plans.push({ slice, cue, status: "not-found" });
      continue;
    }

    const intended = resolution.anchor.time - offset;

    // A cue before this image begins belongs to an earlier scene; a cue after
    // the picture has finished is allowed while the scene may still grow.
    if (intended < -EPSILON || intended > limit + EPSILON) {
      plans.push({ slice, cue, status: "outside" });
      continue;
    }

    const start = Math.max(intended, previousRevealEnd);
    plans.push({
      slice,
      cue,
      status: "matched",
      anchor: resolution.anchor,
      intended,
      start,
      clamped: resolution.clamped || start > intended + EPSILON,
    });

    previousRevealEnd = Math.max(0, start) + animationOf(slice.id);
  }

  // ── Estimation ───────────────────────────────────────────────────────────
  // A cue that was written but not heard still tells us something: it belongs
  // somewhere before the next slice's cue. So the slice is fitted into the gap
  // its neighbours leave, using the narration's own beats as the grid. The
  // position is a rule, not a measurement, so it is always flagged.
  const candidates = options.candidates ?? [];
  if (candidates.length) {
    let index = 0;
    while (index < plans.length) {
      if (plans[index]?.status !== "not-found") {
        index += 1;
        continue;
      }

      let end = index;
      while (plans[end + 1]?.status === "not-found") end += 1;

      const previous = plans[index - 1];
      const left = previous?.start !== undefined
        ? previous.start + animationOf(previous.slice.id)
        : 0;
      const next = plans[end + 1];
      const right = Math.max(left, next?.start ?? limit);
      const run = plans.slice(index, end + 1);

      const placed = run.length === 1
        ? placeOne(
            run[0]!,
            left,
            right,
            animationOf(run[0]!.slice.id),
            previous?.start !== undefined ? animationOf(previous.slice.id) : 0,
            candidates,
            offset,
            limit,
          )
        : placeRun(run, left, right, animationOf);

      placed.forEach((position, positionIndex) => {
        const plan = run[positionIndex]!;
        plan.status = "matched";
        plan.estimated = true;
        plan.intended = position.start;
        plan.start = position.start;
        plan.clamped = false;
        plan.anchor = {
          wordIndex: position.beat?.wordIndex ?? -1,
          text: position.beat?.text ?? "",
          time: position.beat?.time ?? position.start + offset,
        };
        if (Math.abs(position.animation - animationOf(plan.slice.id)) > EPSILON) {
          plan.animation = position.animation;
        }
      });

      index = end + 1;
    }
  }

  // ── Result ───────────────────────────────────────────────────────────────
  for (const plan of plans) {
    if (plan.status === "no-cue") {
      noCue.push(plan.slice.id);
      continue;
    }
    if (plan.status === "outside" || plan.status === "not-found") {
      missing.push({ id: plan.slice.id, cue: plan.cue });
      continue;
    }

    const start = Math.min(limit, Math.max(0, plan.start ?? 0));
    const intended = Math.min(limit, Math.max(0, plan.intended ?? start));
    patches.push({
      id: plan.slice.id,
      timing: {
        intendedStart: intended,
        anchorStart: start,
        anchor: plan.anchor!,
        ...(plan.animation !== undefined ? { animation: plan.animation } : {}),
        estimated: plan.estimated === true,
      },
    });
    spanEnd = Math.max(spanEnd, start + (plan.animation ?? animationOf(plan.slice.id)));

    if (plan.estimated) estimated.push(plan.slice.id);
    else if (plan.clamped) clamped.push(plan.slice.id);
  }

  return { patches, missing, noCue, clamped, estimated, spanEnd };
}

type Placed = { start: number; animation: number; beat?: BeatCandidate };

/**
 * One slice, one gap. Sit it on the latest beat that leaves room for its
 * reveal; if that would push the drawing into the next slice, pull the whole
 * slice back until the drawing ends exactly where the next one starts. When the
 * pulled-back position leaves the previous slice holding for more than half its
 * own drawing time, the gap is dead air — centre the slice in it instead.
 */
function placeOne(
  plan: Plan,
  left: number,
  right: number,
  animation: number,
  previousAnimation: number,
  candidates: BeatCandidate[],
  offset: number,
  duration: number,
): Placed[] {
  const gap = Math.max(0, right - left);
  const limit = Math.min(duration, left + gap);

  if (gap + EPSILON < animation) {
    // No room at all: keep the slice at the previous reveal's end and shorten
    // the drawing. The solver will flag it as tight rather than hide it.
    const shortened = Math.max(MIN_SLICE_ANIMATION, Math.min(animation, gap));
    return [
      {
        start: Math.max(0, Math.min(left, duration - MIN_SLICE_ANIMATION)),
        animation: shortened,
      },
    ];
  }

  const latest = Math.max(0, limit - animation);
  const beat = pickBeat(candidates, left, latest);
  let start = beat ? beat.time - offset : latest;
  start = Math.min(Math.max(start, left), latest);

  if (previousAnimation > EPSILON && start - left > previousAnimation * DEAD_AIR_RATIO) {
    start = left + Math.max(0, gap - animation) / 2;
  }

  return [
    {
      start: Math.min(Math.max(0, start), duration),
      animation,
      ...(beat ? { beat } : {}),
    },
  ];
}

/**
 * Several missing cues in a row share one gap. Beats can no longer tell them
 * apart, so the gap is split evenly and each drawing is centred in its share.
 */
function placeRun(run: Plan[], left: number, right: number, animationOf: (id: string) => number): Placed[] {
  const gap = Math.max(0, right - left);
  const slot = gap / Math.max(1, run.length);

  return run.map((plan, index) => {
    const animation = Math.max(
      MIN_SLICE_ANIMATION,
      Math.min(animationOf(plan.slice.id), slot),
    );
    const start = left + slot * index + Math.max(0, (slot - animation) / 2);
    return { start, animation };
  });
}

/** All the ways this sync can fail, expressed as data rather than silence. */
export function syncSliceCues(
  slices: CueSlice[],
  words: TranscriptWord[],
  options: CueSyncOptions,
): CueSyncResult {
  if (!slices.length)
    return { patches: [], missing: [], noCue: [], clamped: [], estimated: [], spanEnd: 0 };

  if (!words.length) {
    return {
      patches: [],
      missing: slices
        .filter((slice) => (slice.cue ?? "").trim())
        .map((slice) => ({ id: slice.id, cue: (slice.cue ?? "").trim() })),
      noCue: slices.filter((slice) => !(slice.cue ?? "").trim()).map((slice) => slice.id),
      clamped: [],
      estimated: [],
      spanEnd: 0,
    };
  }

  const seen = new Map<string, number>();

  return solve(slices, options, (slice, cue, lowerBound) => {
    const key = normaliseCue(cue);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    const timing = slice.timing ?? {};
    const resolution = resolveTriggerAnchor(words, cue, occurrence, lowerBound, {
      windowSeconds: timing.anchorWindow ?? ANCHOR_WINDOW_SECONDS,
      allowClauseCrossing: timing.crossClause === true,
    });
    if (!resolution) return null;

    return { anchor: resolution.anchor, clamped: resolution.clamped };
  });
}

/**
 * The script-aligned path.
 *
 * When the full narration script is known, phrases have already been matched
 * against the transcript once, tolerating the recogniser's substitutions. Here
 * each slice simply receives the beat that owns its cue, so nothing is searched
 * for again. A beat that starts inside the previous reveal is pushed to that
 * reveal's end and reported as `clamped`; a cue with no beat is fitted between
 * its neighbours and reported as `estimated`.
 */
export function syncSliceBeats(
  slices: CueSlice[],
  beats: BeatAnchor[],
  options: CueSyncOptions,
): CueSyncResult {
  if (!slices.length)
    return { patches: [], missing: [], noCue: [], clamped: [], estimated: [], spanEnd: 0 };

  const anchors = new Map(beats.map((beat) => [beat.id, beat.anchor]));

  return solve(slices, options, (slice) => {
    const anchor = anchors.get(slice.id);
    return anchor ? { anchor, clamped: false } : null;
  });
}
