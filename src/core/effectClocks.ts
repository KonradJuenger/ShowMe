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
  pausedAt?: number;
  localPausedAt?: number;
};

export function sampleEffectClocks(origins: EffectClockOrigins, now: number) {
  const at = origins.pausedAt ?? now;
  const elapsed = (start: number, sample = at) =>
    Math.max(0, sample - start) / 1000;
  const localAt = origins.localPausedAt ?? at;
  return {
    presentationTime: elapsed(origins.presentationStartedAt),
    slideTime: elapsed(origins.slideStartedAt, localAt),
    stepIndex: Math.max(0, Math.trunc(origins.stepIndex ?? 0)),
    stepTime: elapsed(origins.stepStartedAt ?? origins.slideStartedAt, localAt),
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
  return {
    presentationStartedAt: state.startedAt + (state.pausedDuration ?? 0),
    slideStartedAt: state.slideStartedAt ?? state.startedAt,
    stepStartedAt:
      state.stepStartedAt ?? state.slideStartedAt ?? state.startedAt,
    stageStartedOffsets: state.motionStageStartedOffsets,
    stepIndex: Math.max(0, state.motion?.stageIndex ?? 0),
    pausedAt:
      state.presentationReady === false && waitingAt !== undefined
        ? waitingAt
        : state.pausedAt,
    localPausedAt: waitingAt,
  };
}
