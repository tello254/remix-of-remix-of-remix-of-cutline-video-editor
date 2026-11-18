import { WHITEBOARD_LEAD_IN_SECONDS } from "./measure";

/**
 * Slicer timing, mirrored by public/whiteboard/animations.js. Every slice gets
 * the same painting time, and the hand leaves the scene after each one and
 * comes back in for the next, so adding a slice always makes the scene longer.
 */
export const SLICER_FPS = 30;
export const SLICER_PAINT_TICKS = 36;
export const SLICER_TRAVEL_TICKS = 10;

export type SliceBand = {
  /** 1-based animation order. */
  order: number;
  /** Fractions of the whole clip where this slice's painting starts/ends. */
  start: number;
  end: number;
};

/** One slice = travel in + paint + travel out. */
export function slicerTotalTicks(count: number) {
  return count * (SLICER_PAINT_TICKS + 2 * SLICER_TRAVEL_TICKS);
}

export function slicerNaturalSeconds(count: number) {
  return slicerTotalTicks(count) / SLICER_FPS;
}

/**
 * Where each slice lands on the timeline. The engine enters, paints and exits
 * within one block per slice, so the markers match the reveal no matter how
 * many slices there are.
 */
export function slicerBands(count: number, clipDuration: number): SliceBand[] {
  const naturalSeconds = slicerNaturalSeconds(count);
  const duration = Math.max(0.1, clipDuration);
  // Host seeks by time unless the drawing is longer than the clip, in which
  // case it stretches the drawing over the whole clip.
  const scale = duration < naturalSeconds ? duration / naturalSeconds : 1;
  const fractionOf = (frame: number) =>
    Math.min(1, (WHITEBOARD_LEAD_IN_SECONDS + (frame / SLICER_FPS) * scale) / duration);
  const block = SLICER_PAINT_TICKS + 2 * SLICER_TRAVEL_TICKS;
  return Array.from({ length: count }, (_, index) => {
    const startFrame = index * block + SLICER_TRAVEL_TICKS;
    return {
      order: index + 1,
      start: fractionOf(startFrame),
      end: fractionOf(startFrame + SLICER_PAINT_TICKS),
    };
  });
}
