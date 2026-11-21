/**
 * Which clips may be sent to Whisper automatically.
 *
 * Only audio that landed on a Voice row is transcribed. Music never is, and a
 * clip that already carries a transcript is left alone so moving a voice clip
 * between rows does not re-run speech-to-text.
 */
export type AutoTranscribeClip = {
  mediaType: string;
  transcript?: unknown;
};

export type AutoTranscribeTrack = {
  category: string;
};

export function shouldAutoTranscribe(
  clip: AutoTranscribeClip,
  track: AutoTranscribeTrack | null | undefined,
) {
  return track?.category === "voice" && clip.mediaType === "audio" && !clip.transcript;
}
