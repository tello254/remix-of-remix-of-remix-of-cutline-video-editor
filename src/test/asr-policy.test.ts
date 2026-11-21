import { describe, expect, it } from "vitest";
import { shouldAutoTranscribe } from "@/lib/asr-policy";

const voice = { category: "voice" };
const music = { category: "music" };
const audio = { mediaType: "audio" };
const transcript = { text: "hello", words: [] };

describe("automatic voice transcription", () => {
  it("transcribes audio that lands on a voice row", () => {
    expect(shouldAutoTranscribe(audio, voice)).toBe(true);
  });

  it("never transcribes music, even on a row named voice", () => {
    expect(shouldAutoTranscribe({ ...audio, mediaType: "audio" }, music)).toBe(false);
  });

  it("ignores picture clips and clips that already have a transcript", () => {
    expect(shouldAutoTranscribe({ mediaType: "image" }, voice)).toBe(false);
    expect(shouldAutoTranscribe({ ...audio, transcript }, voice)).toBe(false);
  });

  it("waits for a row before deciding", () => {
    expect(shouldAutoTranscribe(audio, null)).toBe(false);
    expect(shouldAutoTranscribe(audio, undefined)).toBe(false);
  });
});
