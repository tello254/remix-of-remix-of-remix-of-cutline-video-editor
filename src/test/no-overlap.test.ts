import { describe, expect, it } from "vitest";
import { nearestFreeStart, trimClipWithin } from "@/lib/editor-timeline";

// Rule: no clip on a row may ever sit on top of another clip.
describe("clips never overlap on a row", () => {
  const row = [{ start: 2, duration: 3 }, { start: 8, duration: 2 }];

  it("pushes a clip dropped onto another clip to the nearest free spot", () => {
    expect(nearestFreeStart(3, 2, row)).toBe(5);
    expect(nearestFreeStart(2.5, 2, row)).toBe(0);
  });

  it("keeps a clip where it was dropped when the spot is free", () => {
    expect(nearestFreeStart(5.5, 2, row)).toBe(5.5);
  });

  it("skips gaps too small for the clip", () => {
    expect(nearestFreeStart(5, 4, row)).toBe(10);
  });

  it("stops stretching the right edge at the next clip", () => {
    const clip = { start: 5, duration: 1, mediaType: "image" as const, sourceOffset: 0, sourceDuration: 1 };
    expect(trimClipWithin(clip, "right", 10, row).duration).toBe(3);
  });

  it("stops stretching the left edge at the previous clip", () => {
    const clip = { start: 6, duration: 1, mediaType: "image" as const, sourceOffset: 0, sourceDuration: 1 };
    expect(trimClipWithin(clip, "left", -10, row).start).toBe(5);
  });
});
