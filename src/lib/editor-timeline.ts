export const IMAGE_SCENE_SECONDS = 4;

export type TimelineRange = {
  start: number;
  duration: number;
};

export type TrimEdge = "left" | "right";
export type TrimmableClip = TimelineRange & {
  mediaType: "video" | "image" | "audio";
  sourceOffset: number;
  sourceDuration: number;
};

export type TrimmedClip = TimelineRange & { sourceOffset: number };

export function trimClip(clip: TrimmableClip, edge: TrimEdge, delta: number): TrimmedClip {
  const minimumDuration = 0.1;
  if (edge === "left") {
    const earliestDelta = clip.mediaType === "image" ? -clip.start : -Math.min(clip.start, clip.sourceOffset);
    const latestDelta = clip.duration - minimumDuration;
    const appliedDelta = Math.min(latestDelta, Math.max(earliestDelta, delta));
    return {
      start: clip.start + appliedDelta,
      duration: Math.max(minimumDuration, clip.duration - appliedDelta),
      sourceOffset: clip.mediaType === "image" ? clip.sourceOffset : clip.sourceOffset + appliedDelta,
    };
  }

  const availableDuration = clip.mediaType === "image"
    ? Number.POSITIVE_INFINITY
    : clip.sourceDuration - clip.sourceOffset;
  return {
    start: clip.start,
    duration: Math.max(minimumDuration, Math.min(clip.duration + delta, availableDuration)),
    sourceOffset: clip.sourceOffset,
  };
}

export function transitionProgress(cutTime: number, duration: number, time: number) {
  const safeDuration = Math.max(0, duration);
  const start = cutTime - safeDuration / 2;
  if (safeDuration === 0 || time < start || time > start + safeDuration) return null;
  return Math.min(1, Math.max(0, (time - start) / safeDuration));
}

export function isTimelineRangeActive(range: TimelineRange, time: number) {
  return time >= range.start && time < range.start + range.duration;
}

export function isTimelineGap(ranges: TimelineRange[], time: number) {
  return !ranges.some((range) => isTimelineRangeActive(range, time));
}

export function timelineWidth(duration: number, pixelsPerSecond: number) {
  return duration * pixelsPerSecond;
}

export function timelineTimeAtPointer(clientX: number, viewportLeft: number, scrollLeft: number, pixelsPerSecond: number) {
  return Math.max(0, (clientX - viewportLeft + scrollLeft) / Math.max(1, pixelsPerSecond));
}

export function transitionFrameStyle(effect: string, progress: number, side: "left" | "right") {
  const safeProgress = Math.min(1, Math.max(0, progress));
  if (effect === "crossfade") return { opacity: side === "left" ? 1 - safeProgress : safeProgress };
  if (effect === "wipe") return side === "right" ? { clipPath: `inset(0 ${(1 - safeProgress) * 100}% 0 0)` } : {};
  if (effect === "slide") {
    const offset = side === "left" ? -safeProgress * 100 : (1 - safeProgress) * 100;
    return { transform: `translateX(${offset}%)` };
  }
  if (effect === "fade-black") {
    if (side === "left") return { opacity: Math.max(0, 1 - safeProgress * 2) };
    return { opacity: Math.max(0, (safeProgress - 0.5) * 2) };
  }
  return {};
}

export function fadeToBlackOverlayOpacity(progress: number) {
  const safeProgress = Math.min(1, Math.max(0, progress));
  return safeProgress <= 0.5 ? safeProgress * 2 : (1 - safeProgress) * 2;
}

export type TransitionLayer = { progress: number; side: "left" | "right"; effect: string };

/**
 * Both clips meeting at a cut must be previewable for the whole transition window,
 * which is centered on the cut, so one of them is usually outside its own timeline bounds.
 */
export function transitionLayersAtTime<T extends TimelineRange & { id: string }>(
  clips: T[],
  transitions: { leftId: string; rightId: string; effect: string; duration: number }[],
  time: number,
): Map<string, TransitionLayer> {
  const layers = new Map<string, TransitionLayer>();
  transitions.forEach((transition) => {
    const left = clips.find((clip) => clip.id === transition.leftId);
    const right = clips.find((clip) => clip.id === transition.rightId);
    if (!left || !right) return;
    const progress = transitionProgress(right.start, transition.duration, time);
    if (progress === null) return;
    layers.set(left.id, { progress, side: "left", effect: transition.effect });
    layers.set(right.id, { progress, side: "right", effect: transition.effect });
  });
  return layers;
}

/** A drop onto a lane only keeps that lane when the lane accepts the media kind. */
export type TrackLike = {
  id: string;
  kind: "visual" | "audio" | "voice";
  category: "video" | "image" | "voice" | "music";
};

const CATEGORY_BY_MEDIA: Record<"video" | "image" | "audio", TrackLike["category"]> = {
  video: "video",
  image: "image",
  audio: "music",
};

export function isTrackCompatible(track: Pick<TrackLike, "kind">, mediaType: "video" | "image" | "audio") {
  return mediaType === "audio"
    ? track.kind === "audio" || track.kind === "voice"
    : track.kind === "visual";
}

export function compatibleTrackId<T extends TrackLike>(
  tracks: T[],
  itemKind: T["kind"],
  mediaType: "video" | "image" | "audio",
  preferredTrackId?: string,
): string | undefined {
  const accepts = (track: T) => isTrackCompatible(track, mediaType);
  const preferred = preferredTrackId ? tracks.find((track) => track.id === preferredTrackId) : undefined;
  if (preferred && accepts(preferred)) return preferred.id;
  const wantedCategory = itemKind === "voice" ? "voice" : CATEGORY_BY_MEDIA[mediaType];
  return tracks.find((track) => accepts(track) && track.category === wantedCategory)?.id
    ?? tracks.find((track) => accepts(track) && track.kind === itemKind)?.id
    ?? tracks.find(accepts)?.id;
}

/**
 * Rows are displayed in reverse array order (last track on top), so inserting at the
 * clicked row's own index places the new row directly BELOW it on screen.
 */
export function trackInsertionIndex<T extends TrackLike>(tracks: T[], category: T["category"], belowTrackId?: string) {
  if (belowTrackId) {
    const index = tracks.findIndex((track) => track.id === belowTrackId);
    if (index !== -1) return index;
  }

  const firstInCategory = tracks.findIndex((track) => track.category === category);
  if (firstInCategory !== -1) return firstInCategory;

  const order: TrackLike["category"][] = ["video", "image", "voice", "music"];
  const categoryRank = order.indexOf(category);
  const nextCategory = tracks.findIndex((track) => order.indexOf(track.category) > categoryRank);
  return nextCategory === -1 ? tracks.length : nextCategory;
}

/**
 * Shipping audio never lands on a row that already has a cut: an occupied row
 * keeps its own clips untouched, and the caller adds a fresh row instead.
 */
export function emptyTrackId<T extends TrackLike>(
  tracks: T[],
  category: T["category"],
  clips: { trackId: string }[],
): string | undefined {
  return tracks.find(
    (track) =>
      track.category === category && !clips.some((clip) => clip.trackId === track.id),
  )?.id;
}

export function nextTrackName<T extends TrackLike & { name: string }>(tracks: T[], category: T["category"]) {
  const labels: Record<TrackLike["category"], string> = { video: "Video", image: "Image", voice: "Voice", music: "Music" };
  let number = 1;
  while (tracks.some((track) => track.category === category && track.name === `${labels[category]} ${number}`)) number += 1;
  return `${labels[category]} ${number}`;
}

/**
 * The starter rows are the precursors every other row is added from, so they always stay.
 * Any other row can go once its own clips are gone.
 */
export function canRemoveTrack<T extends { id: string; default?: boolean }>(trackId: string, tracks: T[], clips: { trackId: string }[]) {
  const track = tracks.find((item) => item.id === trackId);
  if (!track || track.default) return false;
  return !clips.some((clip) => clip.trackId === trackId);
}
const OVERLAP_EPSILON = 1e-6;

/** Moves a clip's start to the nearest spot on its row where it does not cover any other clip. */
export function nearestFreeStart(candidate: number, duration: number, others: TimelineRange[]) {
  const sorted = [...others].sort((a, b) => a.start - b.start);
  const gaps: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const clip of sorted) {
    if (clip.start > cursor) gaps.push({ from: cursor, to: clip.start });
    cursor = Math.max(cursor, clip.start + clip.duration);
  }
  gaps.push({ from: cursor, to: Number.POSITIVE_INFINITY });
  const wanted = Math.max(0, candidate);
  let best = cursor;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const gap of gaps) {
    if (gap.to - gap.from + OVERLAP_EPSILON < duration) continue;
    const placed = Math.min(Math.max(wanted, gap.from), gap.to - duration);
    const distance = Math.abs(placed - wanted);
    if (distance < bestDistance) {
      best = placed;
      bestDistance = distance;
    }
  }
  return best;
}

/** Trims a clip without letting either edge cross into a neighbouring clip on the same row. */
export function trimClipWithin(clip: TrimmableClip, edge: TrimEdge, delta: number, others: TimelineRange[]): TrimmedClip {
  const end = clip.start + clip.duration;
  if (edge === "left") {
    const previousEnd = others
      .filter((other) => other.start + other.duration <= clip.start + OVERLAP_EPSILON)
      .reduce((latest, other) => Math.max(latest, other.start + other.duration), 0);
    return trimClip(clip, edge, Math.max(delta, previousEnd - clip.start));
  }
  const nextStart = others
    .filter((other) => other.start >= end - OVERLAP_EPSILON)
    .reduce((earliest, other) => Math.min(earliest, other.start), Number.POSITIVE_INFINITY);
  return trimClip(clip, edge, Math.min(delta, nextStart - end));
}
