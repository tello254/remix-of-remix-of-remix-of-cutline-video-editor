import { describe, expect, it } from "vitest";
import { cuePhraseSegments } from "@/lib/cue-highlight";

describe("cue phrase highlighting", () => {
  it("marks every spoken cue and leaves the rest plain", () => {
    const text = "John liked her very much, but he was afraid to tell her.";
    const segments = cuePhraseSegments(text, [
      "John liked her very much",
      "he was afraid to tell her",
    ]);

    expect(segments).toEqual([
      { text: "John liked her very much", hit: true },
      { text: ", but ", hit: false },
      { text: "he was afraid to tell her", hit: true },
      { text: ".", hit: false },
    ]);
  });

  it("ignores case and keeps the transcript's own spelling", () => {
    const segments = cuePhraseSegments("Can YOU guess what he did next?", [
      "can you guess what he did next",
    ]);
    expect(segments).toEqual([
      { text: "Can YOU guess what he did next", hit: true },
      { text: "?", hit: false },
    ]);
  });

  it("still finds a cue when Whisper adds punctuation inside it", () => {
    const segments = cuePhraseSegments("She fell, and her food spilled everywhere.", [
      "She fell and her food spilled",
    ]);
    expect(segments).toEqual([
      { text: "She fell, and her food spilled", hit: true },
      { text: " everywhere.", hit: false },
    ]);
  });

  it("prefers the longest phrase when cues overlap", () => {
    const segments = cuePhraseSegments("he was afraid to tell her", [
      "he was afraid",
      "he was afraid to tell her",
    ]);
    expect(segments).toEqual([{ text: "he was afraid to tell her", hit: true }]);
  });

  it("treats regex characters in a phrase as literal words", () => {
    const segments = cuePhraseSegments("wait (really)? yes", ["wait (really)?"]);
    expect(segments).toEqual([{ text: "wait (really)?", hit: true }, { text: " yes", hit: false }]);
  });

  it("returns the transcript untouched when no cue is set", () => {
    expect(cuePhraseSegments("something was said", [])).toEqual([
      { text: "something was said", hit: false },
    ]);
  });

  it("highlights repeated cues every time they are spoken", () => {
    const segments = cuePhraseSegments("yes and yes", ["yes"]);
    expect(segments).toEqual([
      { text: "yes", hit: true },
      { text: " and ", hit: false },
      { text: "yes", hit: true },
    ]);
  });
});
