export interface VideoContent {
  type: "video";
  assetId: string;
  startTime: number;
  endTime: number | null;
  autoplay?: boolean;
  loop?: boolean;
  mute?: boolean;
  volume?: number;
}

export function videoBounds(video: VideoContent, duration: number) {
  const usableDuration = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const start = Math.min(video.startTime ?? 0, Math.max(0, usableDuration - 0.05));
  const end = Math.min(video.endTime ?? usableDuration, usableDuration);
  return { start, end: Math.max(start + 0.05, end) };
}

export function clampVideoTrim(start: number, end: number | null, duration: number) {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const safeStart = Math.max(0, Math.min(start, Math.max(0, limit - 0.05)));
  const safeEnd = end === null ? null : Math.max(safeStart + 0.05, Math.min(end, limit));
  return { startTime: safeStart, endTime: safeEnd };
}

export function formatVideoTime(value: number) {
  if (!Number.isFinite(value)) return "--:--";
  const totalHundredths = Math.round(value * 100);
  const minutes = Math.floor(totalHundredths / 6000);
  const seconds = Math.floor(totalHundredths / 100) % 60;
  const hundredths = totalHundredths % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}
