import {
  stageDuration,
  transitionDuration,
  type SlideMotion,
} from "./motionModel";
import { z } from "zod";
export const motionPlaybackSchema = z
  .object({
    stageId: z.string(),
    stageIndex: z.number().int().min(-1),
    time: z.number().nonnegative(),
    startedAt: z.number().finite(),
    running: z.boolean(),
  })
  .strict();
export type MotionPlaybackState = z.infer<typeof motionPlaybackSchema>;
export type MotionStageTiming = { id: string; duration: number };
export function enterMotion(
  stages: readonly MotionStageTiming[],
  now: number,
  backward = false,
): MotionPlaybackState | undefined {
  if (!stages.length) return undefined;
  const stageIndex = backward ? stages.length - 1 : 0,
    stage = stages[stageIndex];
  return {
    stageId: stage.id,
    stageIndex,
    time: backward ? stage.duration : 0,
    startedAt: now,
    running: !backward && stage.duration > 0,
  };
}
export function motionTime(
  state: MotionPlaybackState,
  duration: number,
  now: number,
) {
  return Math.min(
    duration,
    state.time + (state.running ? Math.max(0, now - state.startedAt) : 0),
  );
}
export function navigateMotion(
  state: MotionPlaybackState,
  stages: readonly MotionStageTiming[],
  direction: "next" | "previous",
  now: number,
): MotionPlaybackState | null {
  const duration = stages[state.stageIndex]?.duration ?? 0,
    time = motionTime(state, duration, now);
  const running = state.running && time < duration;
  if (direction === "next") {
    const next = stages[state.stageIndex + 1];
    return next
      ? {
          stageId: next.id,
          stageIndex: state.stageIndex + 1,
          time: 0,
          startedAt: now,
          running: next.duration > 0,
        }
      : null;
  }
  if (state.stageIndex <= 0 && !running) return null;
  const index = state.stageIndex - 1,
    stage = stages[index];
  return {
    stageId: stage?.id ?? stages[0].id,
    stageIndex: index,
    time: stage?.duration ?? 0,
    startedAt: now,
    running: false,
  };
}

/** Renderer-local preview origins; never serialized as presenter or document state. */
export type MotionPreviewState = MotionPlaybackState & {
  effectClock?: { stageStart: number; stageStarts: number[] };
};
export function previewTime(state: MotionPlaybackState, now: number) {
  return state.time + (state.running ? Math.max(0, now - state.startedAt) : 0);
}
export function withPreviewClock(
  previous: MotionPreviewState | null,
  next: MotionPreviewState | null,
  stages: readonly MotionStageTiming[],
  now: number,
): MotionPreviewState | null {
  if (!next) return null;
  if (next.effectClock) return next;
  if (previous?.effectClock && previous.stageIndex === next.stageIndex)
    return { ...next, effectClock: previous.effectClock };
  const stageStarts = previous?.effectClock
    ? previous.effectClock.stageStarts.slice(0, next.stageIndex + 1)
    : stages
        .slice(0, Math.max(0, next.stageIndex + 1))
        .map((_, index) =>
          stages.slice(0, index).reduce((sum, s) => sum + s.duration, 0),
        );
  const start =
    previous?.effectClock && next.stageIndex > previous.stageIndex
      ? previous.effectClock.stageStart + previewTime(previous, now)
      : (stageStarts[next.stageIndex] ?? 0);
  stageStarts[next.stageIndex] = start;
  return { ...next, effectClock: { stageStart: start, stageStarts } };
}

/** Preview waits only on schedules whose End/Stop has not been reached.
 * Finite tails contribute a local deadline rather than an indefinite wait. */
export function previewInterval(
  motion: SlideMotion,
  state: MotionPreviewState,
  now: number,
) {
  const index = state.stageIndex;
  const time = previewTime(state, now);
  const origins = state.effectClock?.stageStarts ?? [];
  const origin = state.effectClock?.stageStart ?? 0;
  let duration = motion.stages[index] ? stageDuration(motion.stages[index]) : 0;
  let waits = false;
  const latest = new Map<string, { index: number; offset: number }>();
  motion.stages.forEach((stage, i) => {
    if (i > index) return;
    for (const b of stage.blocks ?? []) {
      if (b.binding?.kind !== "presence" || !b.presenceSchedule) continue;
      const offset = b.presenceSchedule.startOffsetMs;
      if (origin + time >= (origins[i] ?? origin) + offset) {
        const old = latest.get(b.binding.elementId);
        if (!old || i > old.index || offset > old.offset)
          latest.set(b.binding.elementId, { index: i, offset });
      }
    }
  });
  motion.stages.forEach((stage, i) => {
    if (i > index) return;
    for (const b of stage.blocks ?? []) {
      const schedule = b.presenceSchedule ?? b.effectSchedule;
      if (!schedule) continue;
      if (b.presenceSchedule && b.binding?.kind === "presence") {
        const owner = latest.get(b.binding.elementId);
        if (
          owner &&
          (i < owner.index ||
            (i === owner.index && schedule.startOffsetMs < owner.offset))
        )
          continue;
      }
      const end = b.presenceSchedule?.end ?? b.effectSchedule!.stop;
      const tail = b.presenceSchedule
        ? transitionDuration(b.presenceSchedule.exitTransition)
        : 0;
      if (end.mode === "none" || end.mode === "slide-end") waits = true;
      else if (end.mode === "after") {
        const start =
          b.effectSchedule?.start === "presentation" ||
          b.effectSchedule?.start === "slide"
            ? 0
            : (origins[i] ?? origin);
        duration = Math.max(
          duration,
          start + schedule.startOffsetMs + end.durationMs + tail - origin,
        );
      } else {
        const gate =
          end.mode === "next-click"
            ? (b.effectSchedule && b.effectSchedule.start !== "click" ? 0 : i) +
              1
            : motion.stages.findIndex((s) => s.id === end.stageId);
        if (gate > index) waits = true;
        else
          duration = Math.max(
            duration,
            (origins[gate] ?? origin) + tail - origin,
          );
      }
    }
  });
  return { waits, duration };
}
