import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useMediaAsset } from "./MediaFileControls";
import { clampVideoTrim, formatVideoTime, type VideoContent } from "../core/video";

type Trim = { startTime: number; endTime: number | null };

export function VideoTrimOverlay({ video, elementId, style, onPatch, onDone, onSeek, onControl }: {
  video: VideoContent;
  elementId: string;
  style: CSSProperties;
  onPatch: (patch: Trim) => void;
  onDone: () => void;
  onSeek: (time: number, final?: boolean) => void;
  onControl: (command: "previous" | "play" | "next") => void;
}) {
  const asset = useMediaAsset(video.assetId);
  const duration = asset?.duration ?? 0;
  const [draft, setDraft] = useState<Trim>(() => ({ startTime: video.startTime, endTime: video.endTime }));
  const [currentTime, setCurrentTime] = useState(video.startTime);
  const draftRef = useRef(draft);
  const dragging = useRef(false);
  const lastHandle = useRef<"start" | "end">("start");
  const requestedTime = useRef<number | null>(null);
  const finishRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (dragging.current) return;
    const next = { startTime: video.startTime, endTime: video.endTime };
    draftRef.current = next;
    setDraft(next);
  }, [video.startTime, video.endTime]);

  function update(next: Trim, handle: "start" | "end") {
    draftRef.current = next;
    lastHandle.current = handle;
    setDraft(next);
    const time = handle === "start" ? next.startTime : (next.endTime ?? duration);
    requestedTime.current = time;
    setCurrentTime(time);
    onSeek(time);
  }

  function finish() {
    if (!dragging.current) return;
    dragging.current = false;
    const next = draftRef.current;
    if (next.startTime !== video.startTime || next.endTime !== video.endTime)
      onPatch(next);
    const time = lastHandle.current === "start" ? next.startTime : (next.endTime ?? duration);
    requestedTime.current = time;
    setCurrentTime(time);
    onSeek(time, true);
  }

  useLayoutEffect(() => { finishRef.current = finish; });
  useEffect(() => {
    const release = () => finishRef.current();
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  useEffect(() => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-editor-stage] .slide-renderer [data-element-id]",))
      .find((node) => node.dataset.elementId === elementId);
    const player = element?.querySelector("video");
    if (!player) return;
    const updateTime = () => {
      if (requestedTime.current !== null && Math.abs(player.currentTime - requestedTime.current) > 0.05) return;
      requestedTime.current = null;
      setCurrentTime(player.currentTime);
    };
    player.addEventListener("timeupdate", updateTime);
    player.addEventListener("seeked", updateTime);
    return () => {
      player.removeEventListener("timeupdate", updateTime);
      player.removeEventListener("seeked", updateTime);
    };
  }, [elementId]);

  function setAtPlayhead(handle: "start" | "end") {
    const next = handle === "start"
      ? clampVideoTrim(currentTime, draftRef.current.endTime, duration)
      : clampVideoTrim(draftRef.current.startTime, currentTime, duration);
    draftRef.current = next;
    setDraft(next);
    onPatch(next);
    const time = handle === "start" ? next.startTime : (next.endTime ?? duration);
    requestedTime.current = time;
    setCurrentTime(time);
    onSeek(time, true);
  }

  return (
    <div className="mode-bar movie-trim-overlay" role="toolbar" aria-label="Trim Video controls" style={style}
    onPointerDown={(event) => event.stopPropagation()}>
    <div className="movie-trim-heading"><strong>Trim Video</strong><span aria-label="Current video time">{formatVideoTime(currentTime)}</span></div>
    <div className="movie-trim-track">
      <div className="movie-trim-row"><span>Start</span><input aria-label="Trim start" type="range" min="0" max={duration || 1} step="0.01"
        disabled={!duration} value={draft.startTime}
        onPointerDown={() => { dragging.current = true; lastHandle.current = "start"; }}
        onKeyUp={finish} onBlur={finish}
        onChange={(event) => {
          const next = clampVideoTrim(Number(event.target.value), draftRef.current.endTime, duration);
          if (!dragging.current) dragging.current = true;
          update(next, "start");
        }} />{formatVideoTime(draft.startTime)}
        <button type="button" aria-label="Set start to current time" onClick={() => setAtPlayhead("start")}>Set</button>
      </div>
      <div className="movie-trim-row"><span>End</span><input aria-label="Trim end" type="range" min="0" max={duration || 1} step="0.01"
        disabled={!duration} value={draft.endTime ?? duration}
        onPointerDown={() => { dragging.current = true; lastHandle.current = "end"; }}
        onKeyUp={finish} onBlur={finish}
        onChange={(event) => {
          const next = clampVideoTrim(draftRef.current.startTime, Number(event.target.value), duration);
          if (!dragging.current) dragging.current = true;
          update(next, "end");
        }} />{formatVideoTime(draft.endTime ?? duration)}
        <button type="button" aria-label="Set end to current time" onClick={() => setAtPlayhead("end")}>Set</button>
      </div>
    </div>
    <div className="movie-trim-footer">
      <div className="movie-trim-preview-controls" aria-label="Preview controls">
        <button type="button" aria-label="Back one second" onClick={() => onControl("previous")}>◀◀</button>
        <button type="button" aria-label="Play or pause trim preview" onClick={() => onControl("play")}>▶</button>
        <button type="button" aria-label="Forward one second" onClick={() => onControl("next")}>▶▶</button>
      </div>
      <div className="movie-trim-actions">
        <button type="button" onClick={() => { const next = { startTime: 0, endTime: null }; draftRef.current = next; setDraft(next); onPatch(next); requestedTime.current = 0; setCurrentTime(0); onSeek(0, true); }}>Reset</button>
        <button type="button" className="primary" onClick={() => { finish(); onDone(); }}>Done</button>
      </div>
    </div>
  </div>);
}
