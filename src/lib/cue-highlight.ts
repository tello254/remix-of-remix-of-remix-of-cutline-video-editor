/**
 * Splitting a transcript into the runs a cue actually claims.
 *
 * The voice transcript is the source of truth for trigger phrases, so the words
 * a slice waits for have to be visible in it. Matching follows the same rule the
 * cue validator uses — case and punctuation are ignored, word order is not — so
 * a cue still lights up when Whisper writes "She fell, and her food spilled".
 * Longer phrases win when two cues overlap, which is what makes "he was afraid
 * to tell her" light up as one run instead of "he was afraid" plus leftovers.
 */

export type CueSegment = {
  text: string;
  /** True when this run is one of the supplied cue phrases. */
  hit: boolean;
};

type Token = {
  /** The word as written, punctuation included. */
  raw: string;
  /** Where the word starts in the transcript. */
  index: number;
  /** The word with case and punctuation removed, as the cue solver compares it. */
  norm: string;
};

function normaliseToken(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "")
    .trim();
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    tokens.push({
      raw: match[0],
      index: match.index ?? 0,
      norm: normaliseToken(match[0]),
    });
  }
  return tokens;
}

function phraseTokens(phrase: string) {
  return phrase
    .split(/\s+/)
    .map(normaliseToken)
    .filter((token) => token.length > 0);
}

export function cuePhraseSegments(text: string, phrases: string[]): CueSegment[] {
  if (!text) return [];
  const tokens = tokenize(text);
  const targets = [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))]
    .map((phrase) => ({ raw: phrase, tokens: phraseTokens(phrase) }))
    .filter((target) => target.tokens.length > 0)
    .sort((a, b) => b.tokens.length - a.tokens.length);

  const spans: { start: number; end: number }[] = [];
  for (const target of targets) {
    for (let i = 0; i + target.tokens.length <= tokens.length; i += 1) {
      const matches = target.tokens.every((word, offset) => tokens[i + offset]?.norm === word);
      if (!matches) continue;
      const first = tokens[i]!;
      const last = tokens[i + target.tokens.length - 1]!;
      // Stop before punctuation that follows the cue ("spilled," keeps its
      // comma), unless the cue itself ends in it ("(really)?" keeps its "?").
      const wordEnd = last.raw.replace(/[^\p{L}\p{N}']+$/u, "").length;
      if (!first || !last || wordEnd <= 0) continue;
      const trailing = last.raw.slice(wordEnd);
      const end =
        trailing && target.raw.endsWith(trailing) ? last.index + last.raw.length : last.index + wordEnd;
      spans.push({ start: first.index, end });
      i += target.tokens.length - 1;
    }
  }

  if (!spans.length) return [{ text, hit: false }];
  spans.sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const segments: CueSegment[] = [];
  let last = 0;
  for (const span of merged) {
    if (span.start > last) segments.push({ text: text.slice(last, span.start), hit: false });
    segments.push({ text: text.slice(span.start, span.end), hit: true });
    last = span.end;
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments;
}
