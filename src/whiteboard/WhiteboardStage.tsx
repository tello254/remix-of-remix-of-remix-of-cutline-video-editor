import { useEffect, useRef, useState, type CSSProperties } from "react";
import { whiteboardSeekSeconds } from "./measure";
import type { WhiteboardConfig } from "./types";

type HostResult = { stale?: boolean; frames?: number; duration?: number };
type HostApi = {
  ready: boolean;
  load: (src: string, config: WhiteboardConfig) => Promise<HostResult>;
  configure: (config: WhiteboardConfig) => HostResult;
  seek: (
    localSeconds: number,
    clipDuration: number,
  ) => { frame: number; done: boolean; naturalFrames: number };
  getNaturalFrames: () => number;
  setPlaying?: (playing: boolean) => void;
};

type WhiteboardStageProps = {
  /** Lets the editor's playback loop find and seek this stage without a re-render. */
  clipId?: string;
  src: string;
  config: WhiteboardConfig;
  /** Seconds since the start of the image clip. */
  time: number;
  /** Length of the image clip on the Cutline timeline. */
  duration: number;
  /** Prewarmed stages stay mounted and loaded so a scene can start drawing immediately. */
  active?: boolean;
  /** Only audible while the editor transport is actually playing. */
  playing?: boolean;
  className?: string;
  style?: CSSProperties;
  onNaturalDuration?: (seconds: number) => void;
};

function hostFrom(iframe: HTMLIFrameElement | null): HostApi | null {
  const host = (iframe?.contentWindow as (Window & { InkplainerHost?: HostApi }) | null)
    ?.InkplainerHost;
  return host?.ready ? host : null;
}

/**
 * Renders one image clip through Inkplainer's whiteboard engine.
 *
 * Each stage owns an isolated iframe: the engine keeps its entire drawing state
 * on globals, so an iframe per visible photo is what lets parallel video rows
 * animate without stomping on each other.
 *
 * A stage that is not active yet is "prewarmed": it loads the photo and runs
 * the engine's setup while hidden, so the scene opens on a blank board that is
 * already mid-animation instead of flashing the untouched photo.
 */
export function WhiteboardStage({
  clipId,
  src,
  config,
  time,
  duration,
  active = true,
  playing = false,
  className,
  style,
  onNaturalDuration,
}: WhiteboardStageProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const latestTime = useRef({ time, duration });
  const naturalDuration = useRef(0);
  const loadToken = useRef(0);
  const configKey = JSON.stringify(config);

  useEffect(() => {
    latestTime.current = { time, duration };
  }, [time, duration]);

  useEffect(() => {
    if (!frameReady) return;
    const host = hostFrom(iframeRef.current);
    if (!host) return;
    let cancelled = false;
    const token = ++loadToken.current;
    setLoading(true);
    setFailed(false);
    host
      .load(src, config)
      .then((result) => {
        if (cancelled || token !== loadToken.current || result.stale) return;
        naturalDuration.current = result.duration ?? 0;
        onNaturalDuration?.(result.duration ?? 0);
        setLoading(false);
        host.seek(
          whiteboardSeekSeconds(latestTime.current.time, Boolean(config.timingSeconds)),
          latestTime.current.duration,
        );
      })
      .catch((error) => {
        console.error("Whiteboard engine failed to load", error);
        if (!cancelled && token === loadToken.current) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // configKey serialises the settings so object identity does not retrigger loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameReady, src, configKey]);

  useEffect(() => {
    if (!frameReady || loading || failed) return;
    const host = hostFrom(iframeRef.current);
    if (!host) return;
    try {
      host.seek(
        whiteboardSeekSeconds(Math.max(0, time), Boolean(config.timingSeconds)),
        Math.max(0, duration),
      );
    } catch (error) {
      console.error("Whiteboard engine seek failed", error);
      setFailed(true);
    }
  }, [frameReady, loading, failed, time, duration, config.timingSeconds]);

  useEffect(() => {
    if (!frameReady) return;
    hostFrom(iframeRef.current)?.setPlaying?.(playing);
  }, [frameReady, playing]);

  const handleFrameLoad = () => {
    let attempts = 0;
    const waitForHost = () => {
      if (!iframeRef.current) return;
      if (hostFrom(iframeRef.current)) {
        setFrameReady(true);
        return;
      }
      attempts += 1;
      if (attempts > 200) {
        setFailed(true);
        setLoading(false);
        return;
      }
      window.setTimeout(waitForHost, 50);
    };
    waitForHost();
  };

  return (
    <div
      className={`whiteboard-stage ${active ? "is-active" : "is-prewarm"} ${className ?? ""}`}
      style={style}
      data-clip-id={clipId}
      aria-hidden={!active}
    >
      {failed && <img className="whiteboard-stage-fallback" src={src} alt="" draggable={false} />}
      <iframe
        ref={iframeRef}
        className={`whiteboard-stage-frame ${loading ? "" : "is-ready"}`}
        src="/whiteboard/engine.html"
        title="Whiteboard animation"
        tabIndex={-1}
        onLoad={handleFrameLoad}
      />
      {failed && <span className="whiteboard-stage-note">Whiteboard engine unavailable</span>}
    </div>
  );
}
