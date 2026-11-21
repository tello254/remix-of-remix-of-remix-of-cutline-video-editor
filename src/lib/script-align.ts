/**
 * Script → transcript alignment.
 *
 * Whisper does not repeat what was read. It drops fillers, writes "there" for
 * "their", splits contractions, and merges the odd word. Matching a trigger
 * phrase directly against that output therefore fails exactly when the audio is
 * imperfect — which is always.
 *
 * This module solves the problem once, at the level of the whole script: it
 * aligns the words the narrator was *supposed* to say against the words the
 * recogniser *heard*, then reports where every beat landed and how much of the
 * match is trustworthy. Slices keep pointing at script phrases; only this
 * alignment ever touches the transcript.
 *
 * The alignment is a plain global edit-distance alignment (Needleman–Wunsch)
 * with a similarity-based substitution cost. It is deterministic: same script,
 * same transcript, same result.
 */

import type { TranscriptWord } from "@/lib/slice-timing";

export type ScriptBeatInput = {
  id: string;
  cue: string;
};

export type BeatAlignment = {
  id: string;
  cue: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Index into the transcript's word list. */
  wordIndex: number;
  endWordIndex: number;
  /** 0–1; average token similarity weighted by how much of the cue was heard. */
  confidence: number;
  /** Share of the cue's words that exist in the recording. */
  coverage: number;
  /** Words the recogniser heard differently. Useful in the review panel. */
  mismatches: { script: string; heard: string }[];
  /** Anchored form the slice scheduler stores on the slice. */
  anchor: { wordIndex: number; text: string; time: number };
};

export type BeatMissReason = "empty" | "not-in-script" | "not-in-transcript";

export type BeatMiss = { id: string; cue: string; reason: BeatMissReason };

export type ScriptAlignment = {
  /** Beats that were placed, in the order they were requested. */
  beats: BeatAlignment[];
  /** Beats that could not be placed at all. */
  misses: BeatMiss[];
  /** Placed beats whose match is too weak to trust without review. */
  weak: string[];
  /** 0–1 overall quality of the script/transcript alignment. */
  score: number;
  scriptWords: number;
  transcriptWords: number;
};

export type AlignScriptOptions = {
  /** Below this, a placed beat is reported in `weak`. */
  minConfidence?: number;
};

type Token = { text: string; norm: string };

const EPSILON = 1e-9;
const GAP_COST = 0.6;
const DEFAULT_MIN_CONFIDENCE = 0.55;

/** Lowercase, strip punctuation, keep letters/numbers and inner apostrophes. */
export function normaliseScriptToken(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .map((part) => ({ text: part, norm: normaliseScriptToken(part) }))
    .filter((token) => token.norm.length > 0);
}

/** Levenshtein distance, abandoned once it exceeds `cap`. */
function editDistance(a: string, b: string, cap: number) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j - 1] ?? 0) + cost,
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
      );
      rowMin = Math.min(rowMin, current[j] ?? 0);
    }
    if (rowMin > cap) return cap + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? cap + 1;
}

/** 1 for identical words, falling to 0 for unrelated ones. */
export function tokenSimilarity(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Most cells in the matrix are unrelated words; reject them cheaply.
  if (a.length > 2 && b.length > 2 && a[0] !== b[0] && Math.abs(a.length - b.length) > 2) {
    return 0;
  }
  const longest = Math.max(a.length, b.length);
  const distance = editDistance(a, b, Math.ceil(longest * 0.55));
  if (distance > longest * 0.55) return 0;
  return 1 - distance / longest;
}

type Alignment = {
  /** script token index → transcript token index, or -1. */
  map: Int32Array;
  score: number;
};

/**
 * Global alignment. Direction codes in `trace` double as the backtrace, so the
 * matrix costs one byte per cell rather than a tuple.
 */
function alignTokens(script: Token[], transcript: Token[]): Alignment {
  const n = script.length;
  const m = transcript.length;
  const map = new Int32Array(n).fill(-1);
  if (!n || !m) return { map, score: 0 };

  const trace = new Uint8Array(n * m);
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  for (let j = 0; j <= m; j += 1) previous[j] = j * GAP_COST;

  for (let i = 1; i <= n; i += 1) {
    current[0] = i * GAP_COST;
    const scriptToken = script[i - 1]!.norm;
    for (let j = 1; j <= m; j += 1) {
      const similarity = tokenSimilarity(scriptToken, transcript[j - 1]!.norm);
      const diagonal = (previous[j - 1] ?? 0) + (1 - similarity);
      const up = (previous[j] ?? 0) + GAP_COST;
      const left = (current[j - 1] ?? 0) + GAP_COST;

      let best = diagonal;
      let direction = 0;
      if (up < best - EPSILON) {
        best = up;
        direction = 1;
      }
      if (left < best - EPSILON) {
        best = left;
        direction = 2;
      }
      current[j] = best;
      trace[(i - 1) * m + (j - 1)] = direction;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  let matched = 0;
  let totalSimilarity = 0;
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const direction = trace[(i - 1) * m + (j - 1)] ?? 0;
    if (direction === 0) {
      map[i - 1] = j - 1;
      matched += 1;
      totalSimilarity += tokenSimilarity(script[i - 1]!.norm, transcript[j - 1]!.norm);
      i -= 1;
      j -= 1;
    } else if (direction === 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  const denominator = Math.max(1, Math.max(n, m));
  return { map, score: matched ? totalSimilarity / denominator : 0 };
}

function findOccurrences(haystack: string[], needles: string[]) {
  const found: number[] = [];
  if (!needles.length) return found;
  for (let index = 0; index + needles.length <= haystack.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needles.length; offset += 1) {
      if (haystack[index + offset] !== needles[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) found.push(index);
  }
  return found;
}

/**
 * Places every beat in the recording.
 *
 * A beat is found by its literal phrase in the script (the script is the source
 * of truth for wording), then projected onto the transcript through the
 * alignment. Its start is the first heard word of that span, its end the last.
 * A phrase that never appears in the script is a miss; a phrase whose words
 * never appear in the recording is a miss of a different kind, so the user can
 * tell "the model paraphrased" from "I skipped that line".
 */
export function alignScriptToTranscript(
  script: string,
  beats: ScriptBeatInput[],
  words: TranscriptWord[],
  options?: AlignScriptOptions,
): ScriptAlignment {
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const scriptTokens = tokenize(script);
  const transcriptWords: TranscriptWord[] = [];
  const transcriptTokens: Token[] = [];
  const wordIndices: number[] = [];
  words.forEach((word, index) => {
    const norm = normaliseScriptToken(word.text);
    if (!norm) return;
    transcriptWords.push(word);
    transcriptTokens.push({ text: word.text, norm });
    wordIndices.push(index);
  });

  const scriptNorms = scriptTokens.map((token) => token.norm);
  const transcriptNorms = transcriptTokens.map((token) => token.norm);
  const alignment = alignTokens(scriptTokens, transcriptTokens);

  const seen = new Map<string, number>();
  const placed: BeatAlignment[] = [];
  const misses: BeatMiss[] = [];
  const weak: string[] = [];

  beats.forEach((beat) => {
    const cueTokens = tokenize(beat.cue);
    if (!cueTokens.length) {
      misses.push({ id: beat.id, cue: beat.cue, reason: "empty" });
      return;
    }

    const key = cueTokens.map((token) => token.norm).join(" ");
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    const occurrences = findOccurrences(scriptNorms, cueTokens.map((token) => token.norm));
    if (!occurrences.length) {
      misses.push({ id: beat.id, cue: beat.cue, reason: "not-in-script" });
      return;
    }

    const startToken = occurrences[Math.min(occurrence, occurrences.length - 1)]!;
    const mappedTokens: number[] = [];
    let similarityTotal = 0;
    const mismatches: { script: string; heard: string }[] = [];

    for (let offset = 0; offset < cueTokens.length; offset += 1) {
      const scriptIndex = startToken + offset;
      const transcriptIndex = alignment.map[scriptIndex] ?? -1;
      if (transcriptIndex < 0) continue;
      mappedTokens.push(transcriptIndex);
      const similarity = tokenSimilarity(
        cueTokens[offset]!.norm,
        transcriptNorms[transcriptIndex] ?? "",
      );
      similarityTotal += similarity;
      if (similarity < 0.6) {
        mismatches.push({
          script: cueTokens[offset]!.text,
          heard: transcriptTokens[transcriptIndex]?.text ?? "",
        });
      }
    }

    if (!mappedTokens.length) {
      misses.push({ id: beat.id, cue: beat.cue, reason: "not-in-transcript" });
      return;
    }

    const firstToken = Math.min(...mappedTokens);
    const lastToken = Math.max(...mappedTokens);
    const firstWord = transcriptWords[firstToken];
    const lastWord = transcriptWords[lastToken];
    if (!firstWord || !lastWord) {
      misses.push({ id: beat.id, cue: beat.cue, reason: "not-in-transcript" });
      return;
    }

    const coverage = mappedTokens.length / cueTokens.length;
    const confidence = (similarityTotal / mappedTokens.length) * (0.5 + 0.5 * coverage);

    placed.push({
      id: beat.id,
      cue: beat.cue,
      start: firstWord.start,
      end: Math.max(firstWord.start, lastWord.end),
      wordIndex: wordIndices[firstToken] ?? 0,
      endWordIndex: wordIndices[lastToken] ?? 0,
      confidence,
      coverage,
      mismatches,
      anchor: {
        wordIndex: wordIndices[firstToken] ?? 0,
        text: beat.cue,
        time: firstWord.start,
      },
    });

    if (confidence < minConfidence) weak.push(beat.id);
  });

  return {
    beats: placed,
    misses,
    weak,
    score: alignment.score,
    scriptWords: scriptTokens.length,
    transcriptWords: transcriptTokens.length,
  };
}
