import {
  enterMotion,
  motionTime,
  navigateMotion,
  type MotionStageTiming,
} from "./motionPlayback";
import type { PresentationDeckSequence } from "./presentationSequence";
import type { PresenterState } from "../platform/api";
import { resolveSlideTransition } from "./slideTransitions";
import {
  getPresentationSlideIds,
  reconcilePresentationSequence,
} from "./presentationSequence";

function logicalSlideTime(state: PresenterState, now: number) {
  const sample = state.pausedAt ?? now;
  const start = state.slideStartedAt ?? state.startedAt ?? sample;
  return Math.max(0, sample - start);
}

export type PresentationCommand =
  | {
      type:
        | "next"
        | "previous"
        | "first"
        | "last"
        | "toggle-black"
        | "toggle-pause"
        | "restart-media";
    }
  | { type: "jump"; index: number }
  | {
      type: "audience-ready";
      sessionStartedAt: number;
      motionStartedAt: number;
      slideId: string;
    }
  | { type: "black"; value: boolean };

export function reconcileSession(
  state: PresenterState,
  deck: PresentationDeckSequence,
  now = Date.now(),
): PresenterState {
  const current =
    state.index === null ? null : (state.slideIds[state.index] ?? null);
  let sequence = reconcilePresentationSequence(deck, current);

  // If the presenting slide was deleted, preserve continuity from the prior
  // visible sequence instead of jumping to slide 1. Prefer the next surviving
  // slide, then walk backward.
  if (current && state.index !== null && !deck.slideIds.includes(current)) {
    const visible = new Set(getPresentationSlideIds(deck));
    const fallback = [
      ...state.slideIds.slice(state.index + 1),
      ...state.slideIds.slice(0, state.index).reverse(),
    ].find((id) => visible.has(id));
    if (fallback) sequence = reconcilePresentationSequence(deck, fallback);
  }

  const nextId =
    sequence.index === null ? null : sequence.slideIds[sequence.index];
  const stages = nextId ? (state.motionSlides?.[nextId] ?? []) : [];
  let motion = state.motion;
  if (nextId !== current) motion = enterMotion(stages, now);
  else if (motion && stages.length) {
    const index = stages.findIndex((s) => s.id === motion!.stageId);
    if (index >= 0)
      motion = { ...motion, stageIndex: motion.stageIndex < 0 ? -1 : index };
    else {
      const fallback = Math.min(
        Math.max(0, motion.stageIndex),
        stages.length - 1,
      );
      motion = {
        stageId: stages[fallback].id,
        stageIndex: fallback,
        time: stages[fallback].duration,
        startedAt: now,
        running: false,
      };
    }
  } else if (!stages.length) motion = undefined;
  const awaitingAudience =
    nextId !== current
      ? Boolean(state.prepareAudience && nextId)
      : Boolean(
          state.awaitingAudience &&
          (!state.motion ||
            (motion &&
              motion.time === 0 &&
              stages[motion.stageIndex]?.id === state.motion.stageId &&
              stages[motion.stageIndex]?.duration > 0)),
        );
  if (awaitingAudience && motion) motion = { ...motion, running: false };
  const next: PresenterState = {
    ...state,
    transition: nextId !== current ? undefined : state.transition,
    transitionSlides: Object.fromEntries(
      deck.slideIds.map((id) => [
        id,
        resolveSlideTransition(
          deck.slideMeta[id]?.transition,
          deck.transitionDefaults,
        ),
      ]),
    ),
    previousSlideId:
      nextId !== current
        ? (current ?? nextId ?? state.previousSlideId)
        : state.previousSlideId,
    previousSlideIndex:
      nextId !== current
        ? current
          ? (state.index ?? sequence.index ?? 0)
          : (sequence.index ?? state.previousSlideIndex ?? 0)
        : state.previousSlideIndex,
    slideStartedAt:
      nextId !== current ? (state.pausedAt ?? now) : state.slideStartedAt,
    stepStartedAt:
      nextId !== current ? (state.pausedAt ?? now) : state.stepStartedAt,
    motionStageStartedOffsets:
      nextId !== current
        ? motion
          ? [0]
          : undefined
        : state.motionStageStartedOffsets,
    awaitingAudience,
    slideIds: sequence.slideIds,
    index: sequence.index,
    ...(motion ? { motion } : state.motion ? { motion: undefined } : {}),
  };
  // A replacement stage can cancel readiness. Settle the excluded preparation
  // time as well, so future slides don't remain in initial-start clock policy.
  return state.awaitingAudience && !awaitingAudience
    ? releaseAudience(next, now)
    : next;
}

export function startSession(
  input: PresenterState,
  deck: PresentationDeckSequence,
  now = Date.now(),
  motionSlides?: Record<string, MotionStageTiming[]>,
  waitForAudience = false,
): PresenterState {
  const state = reconcileSession(
    {
      ...input,
      startedAt: now,
      slideStartedAt: now,
      stepStartedAt: now,
      pausedAt: undefined,
      pausedDuration: 0,
      resumeMotion: false,
      black: false,
      restartToken: 0,
      contentRevision: 0,
      motionSlides,
      transition: undefined,
    },
    deck,
    now,
  );
  const motion = enterMotion(
    motionSlides?.[state.slideIds[state.index ?? 0]] ?? [],
    now,
  );
  const awaitingAudience = waitForAudience && state.index !== null;
  const initialIndex = state.index ?? 0;
  const initialSlideId =
    state.index === null ? undefined : state.slideIds[initialIndex];
  return {
    ...state,
    previousSlideId: initialSlideId,
    previousSlideIndex: state.index ?? undefined,
    prepareAudience: waitForAudience,
    presentationReady: !awaitingAudience,
    awaitingAudience,
    motionStageStartedOffsets: motion ? [0] : undefined,
    motion: motion && awaitingAudience ? { ...motion, running: false } : motion,
  };
}

export function applyPresentationCommand(
  state: PresenterState,
  command: PresentationCommand,
  now = Date.now(),
): PresenterState {
  if (command.type === "toggle-pause") {
    if (state.pausedAt !== undefined) {
      const paused = Math.max(0, now - state.pausedAt);
      return {
        ...state,
        pausedAt: undefined,
        pausedDuration: (state.pausedDuration ?? 0) + paused,
        transition: state.transition && {
          ...state.transition,
          startedAt:
            state.transition.startedAt === undefined
              ? undefined
              : state.transition.startedAt + paused,
        },
        slideStartedAt:
          (state.slideStartedAt ?? state.startedAt ?? now) + paused,
        stepStartedAt:
          (state.stepStartedAt ??
            state.slideStartedAt ??
            state.startedAt ??
            now) + paused,
        motion: state.motion && {
          ...state.motion,
          startedAt: now,
          running: !!state.resumeMotion,
        },
        resumeMotion: false,
      };
    }
    const duration =
      state.motionSlides?.[state.slideIds[state.index ?? 0]]?.[
        state.motion?.stageIndex ?? 0
      ]?.duration ?? 0;
    return {
      ...state,
      pausedAt: now,
      resumeMotion:
        !!state.motion?.running &&
        motionTime(state.motion, duration, now) < duration,
      motion: state.motion && {
        ...state.motion,
        time: motionTime(state.motion, duration, now),
        startedAt: now,
        running: false,
      },
    };
  }
  // Navigation while paused deterministically seeks, and remains paused.
  const wasPaused = state.pausedAt !== undefined;
  if (
    wasPaused &&
    ["next", "previous", "first", "last", "jump"].includes(command.type)
  ) {
    const next = applyPresentationCommand(
      { ...state, pausedAt: undefined },
      command,
      state.pausedAt,
    );
    return {
      ...next,
      pausedAt: state.pausedAt,
      resumeMotion: !!next.motion?.running,
      motion: next.motion && { ...next.motion, running: false },
    };
  }
  if (command.type === "audience-ready") {
    if (
      !state.awaitingAudience ||
      state.startedAt !== command.sessionStartedAt ||
      (state.motion?.startedAt ?? state.slideStartedAt ?? state.startedAt) !==
        command.motionStartedAt ||
      state.slideIds[state.index ?? 0] !== command.slideId
    )
      return state;
    return releaseAudience(state, now);
  }
  if (command.type === "black") return { ...state, black: command.value };
  if (command.type === "toggle-black") return { ...state, black: !state.black };
  if (command.type === "restart-media")
    return { ...state, restartToken: (state.restartToken ?? 0) + 1 };
  if (state.awaitingAudience) state = releaseAudience(state, now);
  if (
    (command.type === "next" || command.type === "previous") &&
    state.motion
  ) {
    const stages = state.motionSlides?.[state.slideIds[state.index ?? 0]] ?? [];
    const motion = navigateMotion(state.motion, stages, command.type, now);
    if (motion) {
      const offsets = [...(state.motionStageStartedOffsets ?? [])];
      const elapsed = logicalSlideTime(state, now);
      const enteredDuration = stages[motion.stageIndex]?.duration ?? 0;
      offsets.length = motion.stageIndex + 1;
      offsets[motion.stageIndex] =
        command.type === "previous"
          ? Math.max(0, elapsed - enteredDuration)
          : elapsed;
      return {
        ...state,
        motion,
        stepStartedAt: now,
        motionStageStartedOffsets: offsets,
      };
    }
  }
  let index = state.index ?? 0;
  if (command.type === "next") index++;
  if (command.type === "previous") index--;
  if (command.type === "first") index = 0;
  if (command.type === "last") index = state.slideIds.length - 1;
  if (command.type === "jump") index = command.index;
  const nextIndex = state.slideIds.length
    ? Math.max(0, Math.min(state.slideIds.length - 1, index))
    : null;
  if (
    nextIndex === state.index &&
    (command.type === "next" || command.type === "previous")
  ) {
    // At the end of the deck there is nowhere to advance; settle the final stage.
    if (command.type === "next" && state.motion) {
      const stages =
        state.motionSlides?.[state.slideIds[state.index ?? 0]] ?? [];
      const duration = stages[state.motion.stageIndex]?.duration ?? 0;
      return {
        ...state,
        motion: {
          ...state.motion,
          time: duration,
          running: false,
          startedAt: now,
        },
      };
    }
    return state;
  }
  const motion = enterMotion(
    state.motionSlides?.[state.slideIds[nextIndex ?? 0]] ?? [],
    now,
    command.type === "previous",
  );
  const awaitingAudience = Boolean(state.prepareAudience && nextIndex !== null);
  const incomingId = nextIndex === null ? undefined : state.slideIds[nextIndex];
  const incomingTransition = incomingId
    ? state.transitionSlides?.[incomingId]
    : undefined;
  const transition =
    command.type === "next" &&
    state.index !== null &&
    nextIndex === state.index + 1 &&
    incomingId &&
    incomingTransition &&
    incomingTransition.kind !== "none" &&
    incomingTransition.durationMs > 0
      ? {
          ...incomingTransition,
          fromSlideId: state.slideIds[state.index],
          toSlideId: incomingId,
          startedAt: awaitingAudience ? undefined : now,
        }
      : undefined;
  return {
    ...state,
    transition,
    slideStartedAt: now,
    stepStartedAt: now,
    previousSlideId:
      state.index === null
        ? (incomingId ?? state.previousSlideId)
        : state.slideIds[state.index],
    previousSlideIndex:
      state.index ?? nextIndex ?? state.previousSlideIndex ?? 0,
    index: nextIndex,
    awaitingAudience,
    motionStageStartedOffsets: motion ? [0] : undefined,
    motion: awaitingAudience && motion ? { ...motion, running: false } : motion,
  };
}

export function presentationShortcut(
  key: string,
): PresentationCommand | "end" | "fullscreen" | null {
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key))
    return { type: "next" };
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(key))
    return { type: "previous" };
  if (key === "Home") return { type: "first" };
  if (key === "End") return { type: "last" };
  if (key.toLowerCase() === "p") return { type: "toggle-pause" };
  if (key.toLowerCase() === "b") return { type: "toggle-black" };
  if (key.toLowerCase() === "r") return { type: "restart-media" };
  if (key.toLowerCase() === "f") return "fullscreen";
  if (key === "Escape") return "end";
  return null;
}

function releaseAudience(state: PresenterState, now: number): PresenterState {
  const logicalNow = state.pausedAt ?? now;
  const wait = Math.max(
    0,
    logicalNow - (state.slideStartedAt ?? state.startedAt ?? logicalNow),
  );
  const initial = state.presentationReady === false;
  return {
    ...state,
    awaitingAudience: false,
    presentationReady: true,
    transition: state.transition && {
      ...state.transition,
      startedAt: state.transition.startedAt ?? logicalNow,
    },
    pausedDuration: (state.pausedDuration ?? 0) + (initial ? wait : 0),
    slideStartedAt: logicalNow,
    stepStartedAt: logicalNow,
    resumeMotion: state.pausedAt !== undefined && !!state.motion,
    motion: state.motion && {
      ...state.motion,
      running:
        state.pausedAt === undefined &&
        (state.motionSlides?.[state.slideIds[state.index ?? 0]]?.[
          state.motion.stageIndex
        ]?.duration ?? 0) > state.motion.time,
      startedAt: logicalNow,
    },
  };
}
