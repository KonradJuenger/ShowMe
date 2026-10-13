import { motionTime, type MotionStageTiming } from "../core/motionPlayback";
import type { PresenterState } from "../platform/api";

export type PresenterReadiness =
  | "ready"
  | "animating"
  | "paused"
  | "black"
  | "preparing"
  | "empty";

export interface PresenterViewModel {
  slidePosition: number;
  slideCount: number;
  nextSlidePosition: number | null;
  readiness: PresenterReadiness;
  readinessLabel: string;
  advanceDetail: string;
  canAdvance: boolean;
  canPrevious: boolean;
  hasRemainingMotionStage: boolean;
  motionActive: boolean;
  transitionActive: boolean;
}

function activeMotion(
  state: PresenterState,
  stages: readonly MotionStageTiming[],
  now: number,
) {
  if (!state.motion?.running) return false;
  const duration = stages[state.motion.stageIndex]?.duration ?? 0;
  return motionTime(state.motion, duration, now) < duration;
}

function activeTransition(state: PresenterState, now: number) {
  const transition = state.transition;
  if (
    !transition ||
    transition.kind === "none" ||
    transition.durationMs <= 0 ||
    transition.startedAt === undefined
  )
    return false;
  return now < transition.startedAt + transition.durationMs;
}

export function derivePresenterView(
  state: PresenterState,
  now: number,
): PresenterViewModel {
  const slideCount = state.slideIds.length;
  const index = state.index;
  const currentSlideId = index === null ? undefined : state.slideIds[index];
  const stages = currentSlideId
    ? (state.motionSlides?.[currentSlideId] ?? [])
    : [];
  const motionActive = activeMotion(state, stages, now);
  const transitionActive = activeTransition(state, now);
  const nextStageIndex =
    state.motion && state.motion.stageIndex + 1 < stages.length
      ? state.motion.stageIndex + 1
      : null;
  const hasRemainingMotionStage = nextStageIndex !== null;
  const nextSlidePosition =
    index !== null && index + 1 < slideCount ? index + 2 : null;

  let advanceDetail = "No slide";
  let canAdvance = false;
  if (index !== null) {
    if (nextStageIndex !== null) {
      advanceDetail =
        "Animation " + (nextStageIndex + 1) + " / " + stages.length;
      canAdvance = true;
    } else if (nextSlidePosition !== null) {
      advanceDetail = "Slide " + nextSlidePosition + " / " + slideCount;
      canAdvance = true;
    } else if (motionActive && state.motion && stages.length) {
      advanceDetail =
        "Finish animation " +
        Math.max(1, state.motion.stageIndex + 1) +
        " / " +
        stages.length;
      canAdvance = true;
    } else {
      advanceDetail = "End";
    }
  }

  const canPrevious =
    index !== null &&
    (index > 0 ||
      !!(
        state.motion &&
        (state.motion.stageIndex > 0 ||
          (state.motion.stageIndex === 0 && motionActive))
      ));

  let readiness: PresenterReadiness;
  let readinessLabel: string;
  if (index === null) {
    readiness = "empty";
    readinessLabel = "No slide";
  } else if (state.black) {
    readiness = "black";
    readinessLabel = "Audience black";
  } else if (state.pausedAt !== undefined) {
    readiness = "paused";
    readinessLabel = "Paused";
  } else if (state.awaitingAudience || state.presentationReady === false) {
    readiness = "preparing";
    readinessLabel = "Preparing audience";
  } else if (motionActive || transitionActive) {
    readiness = "animating";
    readinessLabel = "Animating";
  } else {
    readiness = "ready";
    readinessLabel = "Ready";
  }

  return {
    slidePosition: index === null ? 0 : index + 1,
    slideCount,
    nextSlidePosition,
    readiness,
    readinessLabel,
    advanceDetail,
    canAdvance,
    canPrevious,
    hasRemainingMotionStage,
    motionActive,
    transitionActive,
  };
}
