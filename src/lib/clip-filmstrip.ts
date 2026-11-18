/** Filmstrip thumbnails for timeline clips. */

const FPS = 3;
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const MAX_CACHED = 24;

/** Trimmed clips reuse the same source, so the key follows what is actually shown. */
export type FilmstripClip = { src: string; sourceOffset: number; duration: number };

const strips = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

export function filmstripKey(clip: FilmstripClip) {
  return `${clip.src}|${clip.sourceOffset.toFixed(2)}|${clip.duration.toFixed(2)}`;
}

export function cachedFilmstrip(clip: FilmstripClip) {
  return strips.get(filmstripKey(clip)) ?? null;
}

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error("Video frame could not be read"));
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

function loadVideo(src: string) {
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    video.addEventListener("loadeddata", () => resolve(video), { once: true });
    video.addEventListener("error", () => reject(new Error("Video could not be loaded")), { once: true });
    video.load();
  });
}

/**
 * One frame every third of a second, laid out left to right. The strip spans the
 * clip's full width, so zooming scales the frames with the cut.
 */
export async function buildFilmstrip(clip: FilmstripClip) {
  const key = filmstripKey(clip);
  const cached = strips.get(key);
  if (cached) return cached;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const video = await loadVideo(clip.src);
    try {
      const frames = Math.max(1, Math.ceil(clip.duration * FPS));
      const canvas = document.createElement("canvas");
      canvas.width = frames * FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas context");
      context.fillStyle = "#0b0f12";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const end = Math.max(0, (video.duration || clip.sourceOffset + clip.duration) - 0.04);
      // Cover-fit each frame so tall and wide sources fill their cell evenly.
      const scale = Math.max(FRAME_WIDTH / video.videoWidth, FRAME_HEIGHT / video.videoHeight) || 1;
      const drawWidth = video.videoWidth * scale;
      const drawHeight = video.videoHeight * scale;
      for (let index = 0; index < frames; index += 1) {
        const time = Math.min(end, Math.max(0, clip.sourceOffset + index / FPS));
        await seek(video, time);
        context.drawImage(
          video,
          index * FRAME_WIDTH + (FRAME_WIDTH - drawWidth) / 2,
          (FRAME_HEIGHT - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
      }
      const url = canvas.toDataURL("image/jpeg", 0.72);
      strips.set(key, url);
      if (strips.size > MAX_CACHED) {
        const oldest = strips.keys().next().value;
        if (oldest !== undefined) strips.delete(oldest);
      }
      return url;
    } finally {
      video.removeAttribute("src");
      video.load();
      pending.delete(key);
    }
  })();

  pending.set(key, task);
  return task;
}
