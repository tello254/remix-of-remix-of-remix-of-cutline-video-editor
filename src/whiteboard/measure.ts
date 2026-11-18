import type { WhiteboardConfig } from "./types";

type HostResult = { stale?: boolean; frames?: number; duration?: number };
type HostApi = {
  ready: boolean;
  load: (src: string, config: WhiteboardConfig) => Promise<HostResult>;
};

/** Extra time after the last stroke so the finished drawing can be read. */
export const WHITEBOARD_TAIL_SECONDS = 0.4;

/**
 * A beat of blank board before the first stroke. Without it the first frame of
 * paint lands the instant the scene opens (and the hand appears mid-drawing).
 */
export const WHITEBOARD_LEAD_IN_SECONDS = 0.4;

/** Turns scene time into engine time, holding the blank board during the lead-in. */
export function whiteboardSeekSeconds(localSeconds: number) {
  return Math.max(0, localSeconds - WHITEBOARD_LEAD_IN_SECONDS);
}

/**
 * Turns the engine's natural drawing time into a Cutline scene length.
 *
 * The engine animates at 30 fps and reports how many frames a photo needs, so
 * the clip is exactly long enough for the lead-in beat, the hand's drawing and
 * a short hold on the finished image.
 */
export function whiteboardSceneSeconds(naturalSeconds: number) {
  if (!(naturalSeconds > 0)) return 0;
  return (
    Math.round((naturalSeconds + WHITEBOARD_LEAD_IN_SECONDS + WHITEBOARD_TAIL_SECONDS) * 100) / 100
  );
}

let measurer: Promise<HostApi | null> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function createMeasurer() {
  return new Promise<HostApi | null>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.src = "/whiteboard/engine.html";
    iframe.title = "Whiteboard animation measurement";
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    // Rendered offscreen rather than display:none so the engine's timers and
    // canvas work normally; the canvas resolution lives inside the iframe.
    iframe.style.cssText =
      "position:fixed;left:-10000px;top:0;width:320px;height:180px;border:0;opacity:0;pointer-events:none;";
    iframe.onerror = () => resolve(null);
    iframe.onload = () => {
      let attempts = 0;
      const waitForHost = () => {
        const host = (iframe.contentWindow as (Window & { InkplainerHost?: HostApi }) | null)
          ?.InkplainerHost;
        if (host?.ready) {
          resolve(host);
          return;
        }
        attempts += 1;
        if (attempts > 200) {
          iframe.remove();
          resolve(null);
          return;
        }
        window.setTimeout(waitForHost, 50);
      };
      waitForHost();
    };
    document.body.appendChild(iframe);
  });
}

function getMeasurer() {
  if (!measurer) measurer = createMeasurer();
  return measurer;
}

/** Boots the measuring engine in the background so the first import is quick. */
export function warmUpWhiteboardMeasurement() {
  void getMeasurer();
}

/**
 * Runs the real engine headlessly to find how long this photo takes to draw at
 * the given settings. Calls are serialised because one iframe holds one image.
 */
export function measureWhiteboardDuration(src: string, config: WhiteboardConfig): Promise<number> {
  const run = queue.then(async () => {
    const host = await getMeasurer();
    if (!host) return 0;
    try {
      const result = await host.load(src, config);
      return result.stale ? 0 : (result.duration ?? 0);
    } catch {
      return 0;
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
