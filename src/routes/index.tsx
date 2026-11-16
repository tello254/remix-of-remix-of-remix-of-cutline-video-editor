import { createFileRoute } from "@tanstack/react-router";
import {
  AudioLines,
  Check,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Film,
  Image as ImageIcon,
  LibraryBig,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  compatibleTrackId,
  canRemoveTrack,
  fadeToBlackOverlayOpacity,
  IMAGE_SCENE_SECONDS,
  isTrackCompatible,
  isTimelineRangeActive,
  nextTrackName,
  timelineTimeAtPointer,
  timelineWidth,
  trackInsertionIndex,
  transitionFrameStyle,
  transitionLayersAtTime,
  trimClip,
  type TrimEdge,
} from "@/lib/editor-timeline";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cutline — Video editor" },
      { name: "description", content: "A hands-on, multi-track video editing studio." },
      { property: "og:title", content: "Cutline — Video editor" },
      { property: "og:description", content: "A hands-on, multi-track video editing studio." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Editor,
});

type MediaKind = "visual" | "audio" | "voice";
type TrackCategory = "video" | "image" | "voice" | "music";
type Track = { id: string; kind: MediaKind; category: TrackCategory; name: string; muted?: boolean; hidden?: boolean; default?: boolean };
type Clip = {
  id: string;
  trackId: string;
  kind: MediaKind;
  mediaType: "video" | "image" | "audio";
  name: string;
  src: string;
  start: number;
  duration: number;
  sourceOffset: number;
  sourceDuration: number;
};
type Transition = { id: string; leftId: string; rightId: string; effect: string; duration: number };
type Project = { tracks: Track[]; clips: Clip[]; transitions: Transition[] };
type MediaItem = Omit<Clip, "trackId" | "start">;
type DragState = { clipId: string; startX: number; originalStart: number; trackId: string; nextStart: number; nextTrackId: string };
type TrimDragState = { clipId: string; edge: TrimEdge; startX: number; original: Clip; delta: number };
type DropTarget = { type: "preview" | "lane"; trackId: string | null };

const STARTER_TRACKS: Track[] = [
  { id: "video-1", kind: "visual", category: "video", name: "Video 1", default: true },
  { id: "image-1", kind: "visual", category: "image", name: "Image 1", default: true },
  { id: "voice-1", kind: "voice", category: "voice", name: "Voice 1", default: true },
  { id: "audio-1", kind: "audio", category: "music", name: "Music 1", default: true },
];
const TRACK_RAIL_WIDTH = 146;
// The label column narrows on phones, so pointer math reads its rendered width.
const railWidth = (viewport: HTMLElement) => viewport.querySelector<HTMLElement>(".track-rail")?.offsetWidth ?? TRACK_RAIL_WIDTH;

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const frames = Math.floor((safe - whole) * 30);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function makeId() {
  return crypto.randomUUID();
}

function isSameDropTarget(current: DropTarget | null, target: DropTarget) {
  return current !== null && current.type === target.type && current.trackId === target.trackId;
}

function Editor() {
  const [project, setProject] = useState<Project>({ tracks: STARTER_TRACKS, clips: [], transitions: [] });
  const projectRef = useRef(project);
  const undoStack = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedClip, setCopiedClip] = useState<Clip | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(72);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Single drag scrubs the playhead; a double tap followed by a drag pans the timeline.
  const lastTimelineTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const timelineGesture = useRef<{ mode: "scrub" | "pan"; pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartedAt = useRef(0);
  const recordingStream = useRef<MediaStream | null>(null);
  const mediaUrls = useRef<string[]>([]);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const audioPickerRef = useRef<HTMLInputElement>(null);
  const selectedClip = project.clips.find((clip) => clip.id === selectedId) ?? null;

  const commitProject = useCallback((next: Project | ((current: Project) => Project)) => {
    const current = projectRef.current;
    const updated = typeof next === "function" ? next(current) : next;
    undoStack.current.push(current);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    projectRef.current = updated;
    setProject(updated);
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(projectRef.current);
    projectRef.current = previous;
    setProject(previous);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(projectRef.current);
    projectRef.current = next;
    setProject(next);
  }, []);

  const totalDuration = useMemo(
    () => Math.max(12, ...project.clips.map((clip) => clip.start + clip.duration), 0),
    [project.clips],
  );
  const selectedMediaActive = project.clips.some(
    (clip) => clip.kind === "visual" && isTimelineRangeActive(clip, playhead),
  );

  const snapStart = useCallback(
    (candidate: number, clipId: string, trackId: string) => {
      const boundaries = [0];
      projectRef.current.clips.forEach((clip) => {
        if (clip.id === clipId || clip.trackId !== trackId) return;
        boundaries.push(clip.start, clip.start + clip.duration);
      });
      const nearest = boundaries.reduce(
        (best, boundary) => (Math.abs(boundary - candidate) < Math.abs(best - candidate) ? boundary : best),
        candidate,
      );
      const snapped = Math.abs(nearest - candidate) <= 0.2 ? nearest : candidate;
      return Math.max(0, Math.round(snapped * 4) / 4);
    },
    [],
  );

  const placeMedia = useCallback(
    (item: MediaItem, trackId?: string, at?: number) => {
      const state = projectRef.current;
      const matchingTrack = compatibleTrackId(state.tracks, item.kind, item.mediaType, trackId);
      if (!matchingTrack) return;
      const position = at ?? Math.max(0, ...state.clips.filter((clip) => clip.trackId === matchingTrack).map((clip) => clip.start + clip.duration));
      const clip: Clip = { ...item, id: makeId(), trackId: matchingTrack, start: position };
      commitProject((current) => ({ ...current, clips: [...current.clips, clip] }));
      setSelectedId(clip.id);
    },
    [commitProject],
  );

  const ingestFiles = useCallback(
    async (files: File[], forcedKind?: "audio", destination?: { trackId?: string; at: number }) => {
      for (const file of files) {
        const isImage = file.type.startsWith("image/");
        const isVideo = file.type.startsWith("video/");
        const isAudio = file.type.startsWith("audio/");
        if (!isImage && !isVideo && !isAudio) continue;
        const mediaKind: MediaKind = forcedKind ?? (isImage || isVideo ? "visual" : "audio");
        const mediaType: MediaItem["mediaType"] = isImage ? "image" : isVideo ? "video" : "audio";
        let duration = IMAGE_SCENE_SECONDS;
        if (mediaType !== "image") {
          duration = await new Promise<number>((resolve) => {
            // A file Chromium cannot decode never fires loadedmetadata or error, so the
            // queue needs a deadline or one unreadable file stalls every later import.
            const url = URL.createObjectURL(file);
            let timer = 0;
            let settled = false;
            const finish = (value: number) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              URL.revokeObjectURL(url);
              resolve(value);
            };
            timer = window.setTimeout(() => finish(0), 4000);
            const probe = document.createElement(mediaType === "video" ? "video" : "audio");
            probe.preload = "metadata";
            probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0);
            probe.onerror = () => finish(0);
            probe.src = url;
          });
        }
        if (duration <= 0) continue;
        const item: MediaItem = {
          id: makeId(),
          kind: mediaKind,
          mediaType,
          name: file.name,
          src: URL.createObjectURL(file),
          duration,
          sourceDuration: duration,
          sourceOffset: 0,
        };
        mediaUrls.current.push(item.src);
        setMedia((current) => [...current, item]);
        placeMedia(item, destination?.trackId, destination?.at);
      }
    },
    [placeMedia],
  );

  const importFiles = useCallback((event: ChangeEvent<HTMLInputElement>, forcedKind?: "audio") => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    ingestFiles(files, forcedKind).catch((error) => {
      console.error("Import failed", error);
    });
  }, [ingestFiles]);

  const handleDropFiles = useCallback((event: ReactDragEvent<HTMLElement>, destination?: { trackId?: string; at: number }) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    void ingestFiles(files, undefined, destination ?? { at: playhead });
  }, [ingestFiles, playhead]);

  const allowFileDrop = useCallback((target: DropTarget) => (event: ReactDragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(target);
  }, []);

  const clearFileDrop = useCallback((target: DropTarget) => (event: ReactDragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget((current) => (isSameDropTarget(current, target) ? null : current));
  }, []);

  const timelineDropTime = useCallback((clientX: number) => {
    const viewport = timelineRef.current;
    if (!viewport) return playhead;
    return timelineTimeAtPointer(clientX, viewport.getBoundingClientRect().left + railWidth(viewport), viewport.scrollLeft, zoom);
  }, [playhead, zoom]);

  const addTrack = useCallback((category: TrackCategory, belowTrackId?: string) => {
    const kind: MediaKind = category === "video" || category === "image" ? "visual" : category === "voice" ? "voice" : "audio";
    commitProject((current) => {
      const track = { id: makeId(), kind, category, name: nextTrackName(current.tracks, category) };
      const insertionIndex = trackInsertionIndex(current.tracks, category, belowTrackId);
      return { ...current, tracks: [...current.tracks.slice(0, insertionIndex), track, ...current.tracks.slice(insertionIndex)] };
    });
  }, [commitProject]);

  const removeTrack = useCallback((trackId: string) => {
    if (!canRemoveTrack(trackId, projectRef.current.tracks, projectRef.current.clips)) return;
    commitProject((current) => ({ ...current, tracks: current.tracks.filter((track) => track.id !== trackId) }));
  }, [commitProject]);

  const toggleTrack = useCallback((trackId: string, key: "muted" | "hidden") => {
    commitProject((current) => ({
      ...current,
      tracks: current.tracks.map((track) => track.id === trackId ? { ...track, [key]: !track[key] } : track),
    }));
  }, [commitProject]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commitProject((current) => ({
      ...current,
      clips: current.clips.filter((clip) => clip.id !== selectedId),
      transitions: current.transitions.filter((item) => item.leftId !== selectedId && item.rightId !== selectedId),
    }));
    setSelectedId(null);
  }, [commitProject, selectedId]);

  const duplicateSelected = useCallback(() => {
    if (!selectedClip) return;
    const duplicate = { ...selectedClip, id: makeId(), start: selectedClip.start + selectedClip.duration + 0.25 };
    commitProject((current) => ({ ...current, clips: [...current.clips, duplicate] }));
    setSelectedId(duplicate.id);
  }, [commitProject, selectedClip]);

  const splitSelected = useCallback(() => {
    if (!selectedClip) return;
    const offset = playhead - selectedClip.start;
    if (offset <= 0.02 || offset >= selectedClip.duration - 0.02) return;
    const left = { ...selectedClip, duration: offset };
    const right = {
      ...selectedClip,
      id: makeId(),
      start: playhead,
      duration: selectedClip.duration - offset,
      sourceOffset: selectedClip.sourceOffset + offset,
    };
    commitProject((current) => ({
      ...current,
      clips: current.clips.flatMap((clip) => (clip.id === selectedClip.id ? [left, right] : [clip])),
      transitions: current.transitions.filter((item) => item.leftId !== selectedClip.id && item.rightId !== selectedClip.id),
    }));
    setSelectedId(right.id);
  }, [commitProject, playhead, selectedClip]);

  const copySelected = useCallback(() => {
    if (selectedClip) setCopiedClip(selectedClip);
  }, [selectedClip]);

  const pasteClip = useCallback(() => {
    if (!copiedClip) return;
    const clip = { ...copiedClip, id: makeId(), start: snapStart(playhead, copiedClip.id, copiedClip.trackId) };
    commitProject((current) => ({ ...current, clips: [...current.clips, clip] }));
    setSelectedId(clip.id);
  }, [commitProject, copiedClip, playhead, snapStart]);

  const beginRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStream.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const duration = Math.max(0.1, (Date.now() - recordingStartedAt.current) / 1000);
        const item: MediaItem = {
          id: makeId(),
          kind: "voice",
          mediaType: "audio",
          name: `Voice recording ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          src: URL.createObjectURL(blob),
          duration,
          sourceOffset: 0,
          sourceDuration: duration,
        };
        mediaUrls.current.push(item.src);
        setMedia((current) => [...current, item]);
        const voiceTrack = projectRef.current.tracks.find((track) => track.kind === "voice");
        placeMedia(item, voiceTrack?.id, playhead);
        stream.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        setIsRecording(false);
        setRecordingSeconds(0);
      };
      recordingStartedAt.current = Date.now();
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setIsRecording(false);
    }
  }, [placeMedia, playhead]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => setRecordingSeconds((Date.now() - recordingStartedAt.current) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let last = performance.now();
    let currentTime = playhead;
    const tick = (now: number) => {
      const next = currentTime + (now - last) / 1000;
      last = now;
      currentTime = next;
      if (next >= totalDuration) {
        setPlayhead(totalDuration);
        setIsPlaying(false);
        return;
      }
      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, totalDuration]); // Playback starts at the current playhead; the animation owns its clock.

  useEffect(() => {
    const mutedTracks = new Set(project.tracks.filter((track) => track.muted).map((track) => track.id));
    const activeVisuals = project.clips.filter((clip) => clip.kind === "visual" && isTimelineRangeActive(clip, playhead));
    const hasAnyClip = project.clips.some((clip) => isTimelineRangeActive(clip, playhead));
    project.clips.filter((clip) => clip.mediaType === "video").forEach((clip) => {
      const element = videoRefs.current.get(clip.id);
      if (!element) return;
      const active = isPlaying && activeVisuals.some((item) => item.id === clip.id);
      const localTime = clip.sourceOffset + Math.min(clip.duration, Math.max(0, playhead - clip.start));
      if (Math.abs(element.currentTime - localTime) > 0.35) element.currentTime = localTime;
      element.muted = !active || mutedTracks.has(clip.trackId);
      if (active && element.paused) void element.play().catch(() => undefined);
      if (!active && !element.paused) element.pause();
    });
    project.clips.filter((clip) => clip.mediaType === "audio").forEach((clip) => {
      const element = audioRefs.current.get(clip.id);
      if (!element) return;
      const active = isPlaying && isTimelineRangeActive(clip, playhead);
      const localTime = clip.sourceOffset + Math.min(clip.duration, Math.max(0, playhead - clip.start));
      if (Math.abs(element.currentTime - localTime) > 0.35) element.currentTime = localTime;
      element.muted = !hasAnyClip || mutedTracks.has(clip.trackId);
      if (active && element.paused) void element.play().catch(() => undefined);
      if (!active && !element.paused) element.pause();
    });
  }, [isPlaying, playhead, project.clips, project.tracks]);

  useEffect(() => {
    if (!isPlaying || !timelineRef.current) return;
    const viewport = timelineRef.current;
    // Direct assignment: smooth scrolling rubber-bands behind the playhead at 60fps.
    viewport.scrollLeft = Math.max(0, playhead * zoom - viewport.clientWidth / 2);
  }, [isPlaying, playhead, zoom]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        setIsPlaying((value) => !value);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        copySelected();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        pasteClip();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelected, deleteSelected, pasteClip, redo, undo]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const clip = projectRef.current.clips.find((item) => item.id === drag.clipId);
      if (!clip) return;
      const raw = Math.max(0, drag.originalStart + (event.clientX - drag.startX) / zoom);
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-track-id]");
      const targetTrackId = target?.dataset["trackId"];
      const track = projectRef.current.tracks.find((item) => item.id === targetTrackId && isTrackCompatible(item, clip.mediaType));
      const nextTrackId = track?.id ?? drag.trackId;
      setDrag({ ...drag, nextStart: snapStart(raw, clip.id, nextTrackId), nextTrackId });
    };
    const onUp = () => {
      if (drag.nextStart !== drag.originalStart || drag.nextTrackId !== drag.trackId) {
        commitProject((current) => ({
          ...current,
          clips: current.clips.map((clip) => clip.id === drag.clipId ? { ...clip, start: drag.nextStart, trackId: drag.nextTrackId } : clip),
        }));
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [commitProject, drag, snapStart, zoom]);

  useEffect(() => {
    if (!trimDrag) return;
    const onMove = (event: PointerEvent) => {
      setTrimDrag({ ...trimDrag, delta: (event.clientX - trimDrag.startX) / zoom });
    };
    const onUp = () => {
      const trimmed = trimClip(trimDrag.original, trimDrag.edge, trimDrag.delta);
      if (trimmed.start !== trimDrag.original.start || trimmed.duration !== trimDrag.original.duration || trimmed.sourceOffset !== trimDrag.original.sourceOffset) {
        commitProject((current) => ({
          ...current,
          clips: current.clips.map((clip) => clip.id === trimDrag.clipId
            ? { ...clip, start: trimmed.start, duration: trimmed.duration, sourceOffset: trimmed.sourceOffset }
            : clip),
        }));
      }
      setTrimDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [commitProject, trimDrag, zoom]);

  useEffect(() => () => {
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    mediaUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const updateTransition = (transitionId: string, change: Partial<Transition>) => {
    commitProject((current) => ({
      ...current,
      transitions: current.transitions.map((item) => item.id === transitionId ? { ...item, ...change } : item),
    }));
  };

  const addOrSelectTransition = (left: Clip, right: Clip) => {
    const existing = project.transitions.find((item) => item.leftId === left.id && item.rightId === right.id);
    if (existing) {
      setSelectedTransition(existing.id);
      return;
    }
    const transition: Transition = { id: makeId(), leftId: left.id, rightId: right.id, effect: "crossfade", duration: 0.5 };
    commitProject((current) => ({ ...current, transitions: [...current.transitions, transition] }));
    setSelectedTransition(transition.id);
  };

  const transitionLayers = useMemo(
    () => transitionLayersAtTime(project.clips, project.transitions, playhead),
    [project.clips, project.transitions, playhead],
  );

  const previewLayers = useMemo(() => {
    const hiddenTracks = new Set(project.tracks.filter((track) => track.hidden).map((track) => track.id));
    return project.clips.filter(
      (clip) => clip.kind === "visual"
        && !hiddenTracks.has(clip.trackId)
        && (isTimelineRangeActive(clip, playhead) || transitionLayers.has(clip.id)),
    );
  }, [project.clips, project.tracks, playhead, transitionLayers]);

  const fadeOverlayOpacity = useMemo(() => {
    let opacity = 0;
    transitionLayers.forEach((layer) => {
      if (layer.effect === "fade-black") opacity = Math.max(opacity, fadeToBlackOverlayOpacity(layer.progress));
    });
    return opacity;
  }, [transitionLayers]);

  const clipWindow = (clip: Clip) => {
    if (trimDrag?.clipId === clip.id) {
      const trimmed = trimClip(trimDrag.original, trimDrag.edge, trimDrag.delta);
      return { start: trimmed.start, duration: trimmed.duration };
    }
    if (drag?.clipId === clip.id) return { start: drag.nextStart, duration: clip.duration };
    return { start: clip.start, duration: clip.duration };
  };

  const visibleTracks = [...project.tracks].reverse();
  const contentWidth = Math.max(1100, timelineWidth(totalDuration, zoom));
  const selectedTransitionData = project.transitions.find((item) => item.id === selectedTransition);

  const scrubTo = (clientX: number) => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    setPlayhead(Math.max(0, timelineTimeAtPointer(clientX, viewport.getBoundingClientRect().left + railWidth(viewport), viewport.scrollLeft, zoom)));
  };

  const beginTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(".clip-block, .transition-chip, .track-rail, button")) return;
    const now = performance.now();
    const last = lastTimelineTap.current;
    const isDoubleTap = !!last && now - last.time < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 32;
    lastTimelineTap.current = isDoubleTap ? null : { time: now, x: event.clientX, y: event.clientY };
    const viewport = event.currentTarget;
    timelineGesture.current = { mode: isDoubleTap ? "pan" : "scrub", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: viewport.scrollLeft, startTop: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    if (!isDoubleTap) {
      setIsPlaying(false);
      setSelectedId(null);
      scrubTo(event.clientX);
    }
  };

  const moveTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = timelineGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "pan") {
      event.currentTarget.scrollLeft = gesture.startLeft - (event.clientX - gesture.startX);
      event.currentTarget.scrollTop = gesture.startTop - (event.clientY - gesture.startY);
    } else {
      scrubTo(event.clientX);
    }
  };

  const endTimelineGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (timelineGesture.current?.pointerId !== event.pointerId) return;
    timelineGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setSelectedId(clip.id);
    setDrag({ clipId: clip.id, startX: event.clientX, originalStart: clip.start, trackId: clip.trackId, nextStart: clip.start, nextTrackId: clip.trackId });
  };

  const beginTrim = (event: ReactPointerEvent<HTMLSpanElement>, clip: Clip, edge: TrimEdge) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(clip.id);
    setSelectedTransition(null);
    setTrimDrag({ clipId: clip.id, edge, startX: event.clientX, original: clip, delta: 0 });
  };

  return (
    <main
      className="video-editor"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { if (event.dataTransfer.files.length > 0) event.preventDefault(); }}
    >
      <header className="editor-topbar">
        <div className="brand-lockup"><span className="brand-mark"><Film size={17} /></span><span>cutline</span><span className="topbar-divider" /><span className="project-name">Untitled project</span><ChevronDown size={14} /></div>
        <div className="topbar-center"><span className="save-dot" /> All changes saved</div>
        <div className="topbar-actions">
          <Button variant="ghost" size="sm" className="topbar-import" title="Import video and images" onClick={() => filePickerRef.current?.click()}><Upload size={14} /> Import media</Button>
          <Button variant="ghost" size="sm" className="topbar-import" title="Import audio" onClick={() => audioPickerRef.current?.click()}><AudioLines size={14} /> Import audio</Button>
          <Sheet open={libraryOpen} onOpenChange={setLibraryOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="media-drawer-trigger" title="Open media library" aria-label="Open media library"><LibraryBig /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="media-drawer">
              <SheetHeader className="media-drawer-header"><SheetTitle>Media</SheetTitle></SheetHeader>
              <div className="media-drawer-actions">
                <Button variant="outline" size="sm" onClick={() => filePickerRef.current?.click()}><Upload size={14} /> Import media</Button>
                <Button variant="outline" size="sm" onClick={() => audioPickerRef.current?.click()}><AudioLines size={14} /> Import audio</Button>
              </div>
              <div className="media-drawer-body">
                <MediaLibrary media={media} onPlace={(item) => { placeMedia(item, undefined, playhead); setLibraryOpen(false); }} />
              </div>
            </SheetContent>
          </Sheet>
          <span className="format-label">1080p · 30 fps</span>
          <Button size="sm" className="export-button" disabled={project.clips.length === 0}><Check size={15} /> Export</Button>
        </div>
      </header>

      <input ref={filePickerRef} className="file-input" type="file" accept="video/*,image/*" multiple onChange={(event) => void importFiles(event)} />
      <input ref={audioPickerRef} className="file-input" type="file" accept="audio/*" multiple onChange={(event) => void importFiles(event, "audio")} />

      <section className="editor-workspace">
        <aside className="media-panel">
          <div className="panel-heading"><div><span className="panel-eyebrow">PROJECT</span><h2>Media</h2></div><Button variant="ghost" size="icon" title="Import media" aria-label="Import media" onClick={() => filePickerRef.current?.click()}><Plus /></Button></div>
          <Button className="import-button" variant="outline" onClick={() => filePickerRef.current?.click()}><Upload size={15} /> Import media</Button>
          <Button className="import-audio-button" variant="ghost" onClick={() => audioPickerRef.current?.click()}><AudioLines size={14} /> Import audio</Button>
          <MediaLibrary media={media} onPlace={(item) => placeMedia(item, undefined, playhead)} />
          <div className="media-panel-bottom"><div className="storage-heading"><span>LOCAL STORAGE</span><span>{media.length} items</span></div><div className="storage-meter"><span style={{ width: `${Math.min(100, media.length * 12)}%` }} /></div><p>Files stay on this device</p></div>
        </aside>

        <section className="preview-panel">
          <div className="preview-heading"><div><span className="panel-eyebrow">PREVIEW</span><h2>Canvas</h2></div><span className="canvas-size">16:9 <span>·</span> 1920 × 1080</span></div>
          <div
            className={`preview-frame ${dropTarget?.type === "preview" ? "is-drop-target" : ""}`}
            onDragOver={allowFileDrop({ type: "preview", trackId: null })}
            onDragLeave={clearFileDrop({ type: "preview", trackId: null })}
            onDrop={(event) => handleDropFiles(event, { at: playhead })}
          >
            {previewLayers.map((clip, index) => {
              const layer = transitionLayers.get(clip.id);
              const style = { zIndex: index + 1, ...(layer ? transitionFrameStyle(layer.effect, layer.progress, layer.side) : {}) };
              return clip.mediaType === "image" ? <img key={clip.id} className="preview-media" style={style} src={clip.src} alt={clip.name} /> : <video key={clip.id} ref={(node) => { if (node) videoRefs.current.set(clip.id, node); else videoRefs.current.delete(clip.id); }} className="preview-media" style={style} src={clip.src} muted playsInline preload="auto" onLoadedMetadata={(event) => { const node = event.currentTarget; const local = clip.sourceOffset + Math.max(0, playhead - clip.start); if (Math.abs(node.currentTime - local) > 0.1) node.currentTime = local; if (isPlaying) void node.play().catch(() => undefined); }} />;
            })}
            {fadeOverlayOpacity > 0 && <div className="preview-fade-black" style={{ opacity: fadeOverlayOpacity }} />}
            {previewLayers.length === 0 && <div className="preview-empty"><span className="preview-empty-mark"><Film size={22} /></span><span>Nothing to preview</span><small>Move the playhead over a clip</small></div>}
            <div className="preview-timecode">{formatTime(playhead)}</div>
            <div className="preview-resolution">FULL HD</div>
          </div>
          <div className="transport-bar">
            <span className="transport-readout">{formatTime(playhead)} <span>/</span> {formatTime(totalDuration)}</span>
            <div className="transport-center"><Button variant="ghost" size="icon" title="Split at playhead" aria-label="Split at playhead" disabled={!selectedClip || playhead <= selectedClip.start || playhead >= selectedClip.start + selectedClip.duration} onClick={splitSelected}><Scissors /></Button><Button className="play-button" size="icon" title={isPlaying ? "Pause" : "Play"} aria-label={isPlaying ? "Pause" : "Play"} onClick={() => { if (playhead >= totalDuration) setPlayhead(0); setIsPlaying((value) => !value); }}>{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</Button><Button variant="ghost" size="icon" title={selectedMediaActive ? "Audio follows clips" : "Audio muted in empty gaps"} aria-label={selectedMediaActive ? "Audio follows clips" : "Audio muted in empty gaps"}>{selectedMediaActive ? <Volume2 /> : <VolumeX />}</Button></div>
            <span className="playback-speed">1.0×</span>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading inspector-title"><div><span className="panel-eyebrow">INSPECTOR</span><h2>{selectedTransitionData ? "Transition" : selectedClip ? "Clip details" : "Properties"}</h2></div></div>
          {selectedTransitionData ? <div className="inspector-content"><label className="field-label" htmlFor="transition-effect">Effect</label><select id="transition-effect" className="editor-select" value={selectedTransitionData.effect} onChange={(event) => updateTransition(selectedTransitionData.id, { effect: event.target.value })}><option value="crossfade">Crossfade</option><option value="wipe">Wipe</option><option value="slide">Slide</option><option value="fade-black">Fade to black</option></select><label className="field-label" htmlFor="transition-duration">Duration <span>{selectedTransitionData.duration.toFixed(1)} sec</span></label><input id="transition-duration" className="range-input" type="range" min="0.1" max="2" step="0.1" value={selectedTransitionData.duration} onChange={(event) => updateTransition(selectedTransitionData.id, { duration: Number(event.target.value) })} /><div className="transition-preview"><span className="transition-swatch" /><span>{selectedTransitionData.effect.replace("-", " ")} transition</span></div><Button variant="outline" size="sm" onClick={() => { commitProject((current) => ({ ...current, transitions: current.transitions.filter((item) => item.id !== selectedTransitionData.id) })); setSelectedTransition(null); }}><Trash2 size={14} /> Remove transition</Button></div> : selectedClip ? <div className="inspector-content"><div className="inspector-clip-icon">{selectedClip.mediaType === "video" ? <Video /> : selectedClip.mediaType === "image" ? <ImageIcon /> : <AudioLines />}</div><p className="inspector-clip-name">{selectedClip.name}</p><div className="property-row"><span>Start</span><span>{formatTime(selectedClip.start)}</span></div><div className="property-row"><span>Duration</span><span>{selectedClip.duration.toFixed(2)} sec</span></div><div className="property-row"><span>Layer</span><span>{project.tracks.find((track) => track.id === selectedClip.trackId)?.name}</span></div><div className="inspector-actions"><Button variant="outline" size="sm" onClick={duplicateSelected}><Copy size={14} /> Duplicate</Button><Button variant="ghost" size="icon" title="Delete clip" aria-label="Delete clip" onClick={deleteSelected}><Trash2 /></Button></div></div> : <div className="inspector-empty"><span className="inspector-empty-symbol">✳</span><p>Select a clip to see its properties</p><span>Clip position, duration and layer</span></div>}
          <div className="inspector-foot"><span>PROJECT SETTINGS</span><div><span>Aspect ratio</span><b>16:9</b></div><div><span>Frame rate</span><b>30 fps</b></div></div>
        </aside>
      </section>

      <section className="timeline-panel">
        <div className="timeline-toolbar"><div className="timeline-title"><span className="panel-eyebrow">EDIT</span><h2>Timeline</h2><span className="timeline-divider" /><span className="track-count">{project.tracks.length} tracks</span></div><div className="edit-actions"><Button variant="ghost" size="icon" title="Undo" aria-label="Undo" disabled={undoStack.current.length === 0} onClick={undo}><Undo2 /></Button><Button variant="ghost" size="icon" title="Redo" aria-label="Redo" disabled={redoStack.current.length === 0} onClick={redo}><Redo2 /></Button><span className="action-divider" /><Button variant="ghost" size="icon" title="Split at playhead" aria-label="Split at playhead" disabled={!selectedClip || playhead <= selectedClip.start || playhead >= selectedClip.start + selectedClip.duration} onClick={splitSelected}><Scissors /></Button><Button variant="ghost" size="icon" title="Copy clip" aria-label="Copy clip" disabled={!selectedClip} onClick={copySelected}><Copy /></Button><Button variant="ghost" size="icon" title="Paste clip" aria-label="Paste clip" disabled={!copiedClip} onClick={pasteClip}><ClipboardPaste /></Button><Button variant="ghost" size="icon" title="Duplicate clip" aria-label="Duplicate clip" disabled={!selectedClip} onClick={duplicateSelected}><Plus /></Button><Button variant="ghost" size="icon" title="Delete clip" aria-label="Delete clip" disabled={!selectedClip} onClick={deleteSelected}><Trash2 /></Button></div><div className="zoom-actions"><Button variant="ghost" size="icon" title="Zoom out" aria-label="Zoom out" disabled={zoom <= 32} onClick={() => setZoom((value) => Math.max(32, value - 12))}><ZoomOut /></Button><span>{Math.round(zoom / 72 * 100)}%</span><Button variant="ghost" size="icon" title="Zoom in" aria-label="Zoom in" disabled={zoom >= 144} onClick={() => setZoom((value) => Math.min(144, value + 12))}><ZoomIn /></Button></div></div>

        <div className="timeline-body">
          <div ref={timelineRef} className="timeline-scroll" onPointerDown={beginTimelineGesture} onPointerMove={moveTimelineGesture} onPointerUp={endTimelineGesture} onPointerCancel={endTimelineGesture}>
            <div className="timeline-grid">
          <div className="track-rail"><div className="rail-ruler">00:00:00</div><div className="track-rail-list">{visibleTracks.map((track) => <div className={`track-label ${track.kind} ${track.muted ? "muted" : ""} ${track.hidden ? "hidden" : ""}`} key={track.id}><span className="track-type-icon">{track.kind === "visual" ? <Film size={14} /> : track.kind === "voice" ? <Mic size={14} /> : <AudioLines size={14} />}</span><span className="track-name">{track.name}</span><span className="track-kind-label">{track.category.toUpperCase()}</span><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="track-menu" title={`${track.name} options`} aria-label={`${track.name} options`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="track-menu-content"><DropdownMenuLabel>{track.name}</DropdownMenuLabel><DropdownMenuItem onSelect={() => addTrack(track.category, track.id)}><Plus size={13} /> Add row</DropdownMenuItem>{!track.default && <DropdownMenuItem disabled={!canRemoveTrack(track.id, project.tracks, project.clips)} title={project.clips.some((clip) => clip.trackId === track.id) ? "Move or delete this track's clips first" : undefined} onSelect={() => removeTrack(track.id)}><Trash2 size={13} /> Remove row{project.clips.some((clip) => clip.trackId === track.id) ? " · clips exist" : ""}</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => toggleTrack(track.id, "muted")}>{track.muted ? <Volume2 size={13} /> : <VolumeX size={13} />}{track.muted ? " Unmute audio" : " Mute audio"}</DropdownMenuItem>{track.kind === "visual" && <DropdownMenuItem onSelect={() => toggleTrack(track.id, "hidden")}>{track.hidden ? <Eye size={13} /> : <EyeOff size={13} />}{track.hidden ? " Show in preview" : " Hide from preview"}</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div>)}</div></div>
            <div className="timeline-content" style={{ width: `${contentWidth}px` }}>
              <div className="timeline-ruler">
              {Array.from({ length: Math.ceil(contentWidth / (zoom * 5)) + 1 }, (_, index) => <span key={index} className="ruler-tick major" style={{ left: `${index * zoom * 5}px` }}><span>{formatTime(index * 5).slice(0, 5)}</span></span>)}
              </div>
              {visibleTracks.map((track) => {
                const trackClips = project.clips.filter((clip) => clip.trackId === track.id);
                const ordered = [...trackClips].sort((a, b) => a.start - b.start);
                const laneTarget: DropTarget = { type: "lane", trackId: track.id };
                const isLaneTarget = dropTarget?.type === "lane" && dropTarget.trackId === track.id;
                return <div className={`track-lane ${track.kind} ${isLaneTarget ? "is-drop-target" : ""}`} data-track-id={track.id} key={track.id} onDragOver={allowFileDrop(laneTarget)} onDragLeave={clearFileDrop(laneTarget)} onDrop={(event) => handleDropFiles(event, { trackId: track.id, at: timelineDropTime(event.clientX) })}>
                  {trackClips.map((clip) => {
                    const isDragged = drag?.clipId === clip.id;
                    if (isDragged && drag.nextTrackId !== track.id) return null;
                    const geometry = clipWindow(clip);
                    const isTrimming = trimDrag?.clipId === clip.id;
                    return <div key={clip.id} className={`clip-block ${clip.kind} ${clip.mediaType} ${selectedId === clip.id ? "selected" : ""} ${isDragged ? "dragging" : ""} ${isTrimming ? "trimming" : ""}`} style={{ left: `${geometry.start * zoom}px`, width: `${geometry.duration * zoom}px` }} onPointerDown={(event) => beginDrag(event, clip)} onClick={(event) => { event.stopPropagation(); setSelectedId(clip.id); setSelectedTransition(null); }} title={`${clip.name} · ${geometry.duration.toFixed(2)} sec`}><span className="clip-thumb">{clip.mediaType === "image" ? <ImageIcon size={13} /> : clip.mediaType === "video" ? <Video size={13} /> : <AudioLines size={13} />}</span><span className="clip-label">{clip.name}</span>{clip.mediaType !== "image" && <span className="clip-duration">{geometry.duration.toFixed(1)}s</span>}{clip.mediaType === "audio" && <span className="waveform" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ height: `${14 + ((index * 17 + clip.id.charCodeAt(0)) % 72)}%` }} />)}</span>}{selectedId === clip.id && <><span className={`trim-handle left ${isTrimming && trimDrag.edge === "left" ? "active" : ""}`} onPointerDown={(event) => beginTrim(event, clip, "left")} /><span className={`trim-handle right ${isTrimming && trimDrag.edge === "right" ? "active" : ""}`} onPointerDown={(event) => beginTrim(event, clip, "right")} /></>}</div>;
                  })}
                  {ordered.slice(0, -1).map((left) => {
                    const right = ordered.find((clip) => clip.start >= left.start + left.duration - 0.04 && clip.id !== left.id);
                    if (!right || Math.abs(left.start + left.duration - right.start) > 0.08) return null;
                    const transition = project.transitions.find((item) => item.leftId === left.id && item.rightId === right.id);
                    return <button key={`${left.id}-${right.id}`} className={`transition-chip ${transition ? "configured" : ""}`} style={{ left: `${right.start * zoom - 12}px` }} title={transition ? `Edit ${transition.effect} transition` : "Add transition"} aria-label={transition ? "Edit transition" : "Add transition"} onClick={(event) => { event.stopPropagation(); addOrSelectTransition(left, right); }}>{transition ? <Check size={11} /> : <Plus size={12} />}</button>;
                  })}
                </div>;
              })}
              <div className="timeline-playhead" style={{ left: `${playhead * zoom}px` }}><span className="playhead-head" /><span className="playhead-line" /></div>
            </div>
            </div>
          </div>
        </div>
        <div className="timeline-footer"><span><span className="status-dot" /> 00:00:00</span><span className="footer-separator" /><span>{project.clips.length} clips</span><div className="timeline-footer-right"><span>{isRecording ? <><span className="recording-dot" /> Recording · {recordingSeconds.toFixed(1)}s</> : "Magnetic snapping on"}</span>{isRecording ? <Button variant="outline" size="sm" className="stop-recording" onClick={stopRecording}><span className="record-stop-square" /> Stop recording</Button> : <Button variant="outline" size="sm" className="record-button" onClick={() => void beginRecording()}><Mic size={13} /> Record voice</Button>}</div></div>
      </section>

      {project.clips.filter((clip) => clip.mediaType === "audio").map((clip) => <audio className="hidden-audio" key={clip.id} ref={(node) => { if (node) audioRefs.current.set(clip.id, node); else audioRefs.current.delete(clip.id); }} src={clip.src} preload="auto" />)}
    </main>
  );
}

function MediaLibrary({ media, onPlace }: { media: MediaItem[]; onPlace: (item: MediaItem) => void }) {
  return (
    <>
      <div className="library-heading"><span>LIBRARY</span><span>{media.length.toString().padStart(2, "0")}</span></div>
      {media.length === 0 ? (
        <div className="empty-library"><div className="empty-icon"><Film size={19} /></div><p>Your media will appear here</p><span>Video, photos and audio</span></div>
      ) : (
        <div className="media-list">{media.map((item) => <button className="media-item" key={item.id} onClick={() => onPlace(item)} title={`Add ${item.name} to timeline`}><span className={`media-thumb ${item.mediaType}`}><MediaThumb item={item} /><span className="thumb-kind">{item.mediaType === "image" ? <ImageIcon size={12} /> : item.mediaType === "video" ? <Video size={12} /> : <AudioLines size={12} />}</span></span><span className="media-info"><span className="media-name">{item.name}</span><span className="media-meta">{item.mediaType === "image" ? "Still image" : formatTime(item.duration)}</span></span></button>)}</div>
      )}
    </>
  );
}

function MediaThumb({ item }: { item: MediaItem }) {
  if (item.mediaType === "image") return <img src={item.src} alt="" />;
  if (item.mediaType === "video") return <video src={item.src} muted preload="metadata" />;
  return <AudioLines size={20} />;
}
