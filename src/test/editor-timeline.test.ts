import { describe, expect, it } from "vitest";
import { canRemoveTrack, compatibleTrackId, emptyTrackId, fadeToBlackOverlayOpacity, IMAGE_SCENE_SECONDS, isTimelineGap, isTimelineRangeActive, nextTrackName, timelineTimeAtPointer, timelineWidth, trackInsertionIndex, transitionFrameStyle, transitionLayersAtTime, transitionProgress, trimClip } from "@/lib/editor-timeline";

describe("timeline behavior", () => {
  it("uses four seconds for inserted image scenes", () => {
    expect(IMAGE_SCENE_SECONDS).toBe(4);
  });

  it("treats clip ends as gaps and clip starts as active", () => {
    const clip = { start: 2, duration: 4 };
    expect(isTimelineRangeActive(clip, 2)).toBe(true);
    expect(isTimelineRangeActive(clip, 6)).toBe(false);
    expect(isTimelineGap([clip], 6)).toBe(true);
  });

  it("scales clip widths uniformly by the timeline zoom", () => {
    expect(timelineWidth(8, 72)).toBe(576);
  });

  it("maps a pointer into timeline time with scroll and zoom applied", () => {
    expect(timelineTimeAtPointer(220, 100, 360, 80)).toBe(6);
  });

  it("trims video in-points while preserving source timing and the minimum duration", () => {
    expect(trimClip({ start: 2, duration: 5, sourceOffset: 1, sourceDuration: 10, mediaType: "video" }, "left", 2)).toEqual({
      start: 4,
      duration: 3,
      sourceOffset: 3,
    });
    expect(trimClip({ start: 2, duration: 1, sourceOffset: 0, sourceDuration: 10, mediaType: "video" }, "left", 4).duration).toBe(0.1);
  });

  it("limits video out-points to available source and lets images extend", () => {
    expect(trimClip({ start: 0, duration: 4, sourceOffset: 2, sourceDuration: 5, mediaType: "video" }, "right", 3).duration).toBe(3);
    expect(trimClip({ start: 0, duration: 4, sourceOffset: 0, sourceDuration: 4, mediaType: "image" }, "right", 20).duration).toBe(24);
  });

  it("returns transition progress only inside its centered cut window", () => {
    expect(transitionProgress(5, 2, 3.9)).toBeNull();
    expect(transitionProgress(5, 2, 5)).toBe(0.5);
    expect(transitionProgress(5, 2, 6)).toBe(1);
  });

  it("computes crossfade, wipe, slide, and fade-to-black preview frames", () => {
    expect(transitionFrameStyle("crossfade", 0.25, "right")).toEqual({ opacity: 0.25 });
    expect(transitionFrameStyle("wipe", 0.25, "right")).toEqual({ clipPath: "inset(0 75% 0 0)" });
    expect(transitionFrameStyle("slide", 0.25, "left")).toEqual({ transform: "translateX(-25%)" });
    expect(transitionFrameStyle("fade-black", 0.5, "left")).toEqual({ opacity: 0 });
    expect(fadeToBlackOverlayOpacity(0.5)).toBe(1);
  });

  it("previews both clips meeting at a cut for the whole transition window", () => {
    const clips = [
      { id: "a", start: 0, duration: 4 },
      { id: "b", start: 4, duration: 4 },
    ];
    const transitions = [{ leftId: "a", rightId: "b", effect: "crossfade", duration: 2 }];

    expect(transitionLayersAtTime(clips, transitions, 2.9).size).toBe(0);

    const during = transitionLayersAtTime(clips, transitions, 3.5);
    expect(during.get("a")).toEqual({ progress: 0.25, side: "left", effect: "crossfade" });
    expect(during.get("b")).toEqual({ progress: 0.25, side: "right", effect: "crossfade" });

    expect(transitionLayersAtTime(clips, transitions, 5.1).size).toBe(0);
  });

  it("places media on its category row and keeps a dropped clip on its lane", () => {
    type Row = { id: string; kind: "visual" | "audio" | "voice"; category: "video" | "image" | "voice" | "music" };
    const tracks: Row[] = [
      { id: "video-1", kind: "visual", category: "video" },
      { id: "image-1", kind: "visual", category: "image" },
      { id: "voice-1", kind: "voice", category: "voice" },
      { id: "audio-1", kind: "audio", category: "music" },
    ];

    expect(compatibleTrackId(tracks, "visual", "image")).toBe("image-1");
    expect(compatibleTrackId(tracks, "visual", "video")).toBe("video-1");
    expect(compatibleTrackId(tracks, "audio", "audio")).toBe("audio-1");
    expect(compatibleTrackId(tracks, "voice", "audio")).toBe("voice-1");

    expect(compatibleTrackId(tracks, "visual", "image", "image-1")).toBe("image-1");
    expect(compatibleTrackId(tracks, "audio", "audio", "video-1")).toBe("audio-1");
    expect(compatibleTrackId(tracks, "voice", "audio", "video-1")).toBe("voice-1");
    expect(compatibleTrackId(tracks, "voice", "audio", "audio-1")).toBe("audio-1");
    expect(compatibleTrackId(tracks, "audio", "audio", "voice-1")).toBe("voice-1");
    expect(compatibleTrackId(tracks, "voice", "video", "image-1")).toBe("image-1");
  });

  it("inserts category rows under their category or directly after the selected row", () => {
    const tracks = [
      { id: "video-1", kind: "visual" as const, category: "video" as const, name: "Video 1" },
      { id: "image-1", kind: "visual" as const, category: "image" as const, name: "Image 1" },
      { id: "voice-1", kind: "voice" as const, category: "voice" as const, name: "Voice 1" },
      { id: "audio-1", kind: "audio" as const, category: "music" as const, name: "Music 1" },
    ];
    expect(trackInsertionIndex(tracks, "video")).toBe(0);
    expect(trackInsertionIndex(tracks, "image")).toBe(1);
    expect(trackInsertionIndex(tracks, "image", "image-1")).toBe(1);
    expect(nextTrackName([...tracks, { id: "video-2", kind: "visual" as const, category: "video" as const, name: "Video 2" }], "video")).toBe("Video 3");
  });

  it("adds a same-type row directly below the clicked row on screen, keeping groups together", () => {
    const tracks = [
      { id: "video-1", kind: "visual" as const, category: "video" as const, name: "Video 1" },
      { id: "image-1", kind: "visual" as const, category: "image" as const, name: "Image 1" },
      { id: "image-2", kind: "visual" as const, category: "image" as const, name: "Image 2" },
      { id: "voice-1", kind: "voice" as const, category: "voice" as const, name: "Voice 1" },
    ];
    const added = { id: "image-3", kind: "visual" as const, category: "image" as const, name: "Image 3" };
    const index = trackInsertionIndex(tracks, "image", "image-2");
    const next = [...tracks.slice(0, index), added, ...tracks.slice(index)];
    const onScreen = [...next].reverse().map((track) => track.id);
    expect(onScreen).toEqual(["voice-1", "image-2", "image-3", "image-1", "video-1"]);
  });

  it("ships audio to an empty row and steps around rows that already have a cut", () => {
    const tracks = [
      { id: "voice-1", kind: "voice" as const, category: "voice" as const },
      { id: "voice-2", kind: "voice" as const, category: "voice" as const },
      { id: "audio-1", kind: "audio" as const, category: "music" as const },
    ];
    expect(emptyTrackId(tracks, "voice", [])).toBe("voice-1");
    expect(emptyTrackId(tracks, "voice", [{ trackId: "video-1" }])).toBe("voice-1");
    expect(emptyTrackId(tracks, "voice", [{ trackId: "voice-1" }])).toBe("voice-2");
    expect(
      emptyTrackId(tracks, "voice", [{ trackId: "voice-1" }, { trackId: "voice-2" }]),
    ).toBeUndefined();
    expect(emptyTrackId(tracks, "music", [])).toBe("audio-1");
  });

  it("allows removing only existing tracks with no clips", () => {
    const tracks = [{ id: "video-1" }, { id: "image-1" }];
    expect(canRemoveTrack("image-1", tracks, [{ trackId: "video-1" }])).toBe(true);
    expect(canRemoveTrack("video-1", tracks, [{ trackId: "video-1" }])).toBe(false);
    expect(canRemoveTrack("missing", tracks, [])).toBe(false);
  });

  it("never lets a default row be removed, even with no clips on it", () => {
    const tracks = [{ id: "video-1", default: true }, { id: "video-2" }];
    expect(canRemoveTrack("video-1", tracks, [])).toBe(false);
    expect(canRemoveTrack("video-2", tracks, [])).toBe(true);
  });
});