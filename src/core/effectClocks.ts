import type { PresenterState } from "../platform/api";
/** Shared logical clocks, in seconds. Origins travel with presenter state so
 * reconnecting renderers sample the same values without starting new timers. */
export type EffectClockOrigins = {
  presentationStartedAt: number;
  slideStartedAt: number;
  stepStartedAt?: number;
  /** Current logical slide stage, shared with Motion. */
  stepIndex?: number;
  stageStartedOffsets?: readonly number[];
  slideIndex?: number;
  slideCount?: number;
  slideSeed?: number;
  previousSlideIndex?: number;
  previousSlideSeed?: number;
  pausedAt?: number;
  localPausedAt?: number;
};

export function effectSlideSeed(slideId: string | undefined) {
  if (!slideId) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < slideId.length; i++) {
    hash ^= slideId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Keep 24 bits so the value survives an exact round-trip through highp float.
  return ((hash >>> 8) & 0xffffff) / 0x1000000;
}

export function sampleEffectClocks(origins: EffectClockOrigins, now: number) {
  const at = origins.pausedAt ?? now;
  const elapsed = (start: number, sample = at) =>
    Math.max(0, sample - start) / 1000;
  const localAt = origins.localPausedAt ?? at;
  const slideIndex = Math.max(0, Math.trunc(origins.slideIndex ?? 0));
  const slideCount = Math.max(1, Math.trunc(origins.slideCount ?? 1));
  const slideSeed = origins.slideSeed ?? 0;
  return {
    presentationTime: elapsed(origins.presentationStartedAt),
    slideTime: elapsed(origins.slideStartedAt, localAt),
    stepIndex: Math.max(0, Math.trunc(origins.stepIndex ?? 0)),
    stepTime: elapsed(origins.stepStartedAt ?? origins.slideStartedAt, localAt),
    slideIndex,
    slideCount,
    slideSeed,
    previousSlideIndex: Math.max(
      0,
      Math.trunc(origins.previousSlideIndex ?? slideIndex),
    ),
    previousSlideSeed: origins.previousSlideSeed ?? slideSeed,
  };
}

/** Capture an outgoing activation's endpoint in logical seconds. */
export function endEffectClocks(
  clocks: import("./effects").EffectClocks,
): import("./effects").EffectClocks {
  return {
    ...clocks,
    slideEnd: clocks.slideEnd ?? {
      slideTime: clocks.slideTime,
      presentationTime: clocks.presentationTime,
    },
  };
}

/** Preparation freezes local clocks; the initial preparation also freezes presentation time. */
export function presenterEffectClockOrigins(
  state: PresenterState | null,
): EffectClockOrigins | undefined {
  if (state?.startedAt === undefined) return undefined;
  const waitingAt = state.awaitingAudience
    ? (state.slideStartedAt ?? state.startedAt)
    : undefined;
  const slideIndex = Math.max(0, state.index ?? 0);
  const slideId = state.index === null ? undefined : state.slideIds[slideIndex];
  const previousSlideId = state.previousSlideId ?? slideId;
  return {
    presentationStartedAt: state.startedAt + (state.pausedDuration ?? 0),
    slideStartedAt: state.slideStartedAt ?? state.startedAt,
    stepStartedAt:
      state.stepStartedAt ?? state.slideStartedAt ?? state.startedAt,
    stageStartedOffsets: state.motionStageStartedOffsets,
    stepIndex: Math.max(0, state.motion?.stageIndex ?? 0),
    slideIndex,
    slideCount: Math.max(1, state.slideIds.length),
    slideSeed: effectSlideSeed(slideId),
    previousSlideIndex: Math.max(
      0,
      Math.trunc(state.previousSlideIndex ?? slideIndex),
    ),
    previousSlideSeed: effectSlideSeed(previousSlideId),
    pausedAt:
      state.presentationReady === false && waitingAt !== undefined
        ? waitingAt
        : state.pausedAt,
    localPausedAt: waitingAt,
  };
}
