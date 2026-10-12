import { compileEffectTiming } from "../../../src/core/effects";
import { templateTimingDocument } from "../../helpers/effectTimingFixture";
import { resolveSlide } from "../../../src/core/templates";
import { walkElements } from "../../../src/core/element";
import {
  withPreviewClock,
  previewTime,
} from "../../../src/core/motionPlayback";
import { expect, it } from "vitest";
import { effectTiming, type EffectClocks } from "../../../src/core/effects";
import { addEffectTrigger } from "../../../src/core/effectSequence";
import { blankEffect } from "../../../src/core/effectAuthoring";
import {
  slideMotionSchema,
  type SlideMotion,
  type EffectSchedule,
  effectScheduleSchema,
} from "../../../src/core/motionModel";
import {
  cloneMotion,
  filterMotion,
  editMotionBlock,
} from "../../../src/core/motion";
import {
  startSession,
  applyPresentationCommand,
} from "../../../src/core/presentationSession";
import {
  sampleEffectClocks,
  endEffectClocks,
  presenterEffectClockOrigins,
} from "../../../src/core/effectClocks";

function scheduled(schedule: EffectSchedule): SlideMotion {
  return {
    stages: [
      { id: "entry", tracks: [] },
      {
        id: "click-one",
        tracks: [],
        blocks: [
          {
            id: "fx-block",
            label: "Static",
            members: [],
            binding: {
              kind: "effect",
              elementId: "element",
              effectInstanceId: "instance",
            },
            effectSchedule: schedule,
          },
        ],
      },
      { id: "click-two", tracks: [] },
    ],
  };
}
const none: EffectSchedule = {
  version: 1,
  start: "click",
  startOffsetMs: 0,
  stop: { mode: "none" },
};
function sample(
  motion: SlideMotion,
  index: number,
  seconds: number,
  stageStarts = [0, 1, 10],
) {
  const clocks: EffectClocks = {
    slideTime: stageStarts[index] + seconds,
    presentationTime: 100 + stageStarts[index] + seconds,
    stepTime: seconds,
    stageStarts,
  };
  return effectTiming(
    motion,
    index,
    seconds * 1000,
    "element",
    "instance",
    clocks,
  );
}
it("Click 1 to Click 2 activates then completes discretely and freezes Effect time", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "click", stageId: "click-two" },
  });
  expect(sample(motion, 0, 0.5)).toMatchObject({
    started: false,
    running: false,
    time: 0,
    progress: 0,
  });
  expect(sample(motion, 1, 0)).toMatchObject({
    started: true,
    running: true,
    time: 0,
    progress: 0,
  });
  expect(sample(motion, 1, 7)).toMatchObject({
    started: true,
    running: true,
    time: 7,
    progress: 0,
  });
  expect(sample(motion, 2, 0)).toMatchObject({
    running: false,
    time: 9,
    progress: 1,
  });
  expect(motion.stages[1].tracks).toEqual([]);
});
it("None is explicitly unbounded across subsequent click events", () => {
  const motion = scheduled(none);
  expect(sample(motion, 2, 90)).toMatchObject({
    running: true,
    time: 99,
    progress: 1,
    duration: 0,
  });
  expect(effectTiming(undefined, 0, 0, "element", "instance")).toMatchObject({
    running: true,
    progress: 1,
  });
});
it("Start Offset delays actual activation even when another click occurs during the offset", () => {
  const motion = scheduled({ ...none, startOffsetMs: 400 });
  expect(sample(motion, 1, 0.3)).toMatchObject({
    running: false,
    time: 0,
  });
  expect(sample(motion, 1, 0.4)).toMatchObject({ running: true, time: 0 });
  expect(sample(motion, 1, 1).running).toBe(true);
  expect(sample(motion, 1, 1).time).toBeCloseTo(0.6);
  expect(sample(motion, 2, 0, [0, 1, 1.2])).toMatchObject({
    running: false,
    time: 0,
  });
});
it("Next click keeps p at zero until its endpoint", () => {
  const motion = scheduled({ ...none, stop: { mode: "next-click" } });
  expect(sample(motion, 0, 0).progress).toBe(0);
  expect(sample(motion, 1, 0.4)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
  });
  expect(sample(motion, 2, 0)).toMatchObject({ running: false, progress: 1 });
});
it("Timed Stop measures duration after Offset and freezes Effect time at its endpoint", () => {
  const motion = scheduled({
    ...none,
    startOffsetMs: 400,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 1, 2.399).running).toBe(true);
  expect(sample(motion, 1, 2.4)).toMatchObject({
    running: false,
    time: 2,
    progress: 1,
  });
  expect(sample(motion, 1, 20)).toMatchObject({ running: false, time: 2 });
});
it("Timed interval progress bypasses before the click, completes and samples backward with easing", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 0, 0.5)).toMatchObject({ time: 0, progress: 0 });
  expect(sample(motion, 1, 0).progress).toBe(0);
  expect(sample(motion, 1, 1)).toMatchObject({ time: 1, progress: 0.5 });
  expect(sample(motion, 1, 2)).toMatchObject({ running: false, progress: 1 });
  expect(sample(motion, 1, 20).progress).toBe(1);
  expect(sample(motion, 1, 1).progress).toBe(0.5);
  motion.stages[1].blocks![0].effectSchedule!.progressEasing = "hold";
  expect(sample(motion, 1, 1).progress).toBe(0);
  expect(sample(motion, 1, 2).progress).toBe(1);
});
it("Static scheduling has no fake progress track and survives filter, copy and retiming", () => {
  const definition = {
    ...blankEffect("shader"),
    timeControl: { start: "click" as const, stop: { mode: "none" as const } },
  };
  const motion = addEffectTrigger(
    undefined,
    1,
    "element",
    {
      id: "instance",
      resourceId: "resource",
      enabled: true,
      placement: "content",
      parameters: {},
    },
    definition,
  );
  expect(motion.stages[1].tracks).toEqual([]);
  expect(motion.stages[1].blocks![0].effectSchedule).not.toHaveProperty(
    "progress",
  );
  expect(
    filterMotion(motion, new Set(["element"]))!.stages[1].blocks,
  ).toHaveLength(1);
  const bounded = scheduled({
    ...none,
    stop: { mode: "click", stageId: "click-two" },
  });
  const copied = cloneMotion(bounded, new Map([["element", "copy"]]))!;
  expect(copied.stages[1].blocks![0].effectSchedule!.stop).toEqual({
    mode: "click",
    stageId: copied.stages[2].id,
  });
  expect(slideMotionSchema.safeParse(copied).success).toBe(true);
  expect(
    editMotionBlock(bounded, 1, "fx-block", 1, 400, 800).stages[1].tracks,
  ).toEqual([]);
});
it("Previous, Next, backward sampling and slide re-entry deterministically control time", () => {
  const motion = scheduled({ ...none, stop: { mode: "next-click" } });
  let state = startSession(
    { deckId: "deck", slideIds: [], index: null },
    {
      slideIds: ["slide", "other"],
      slideMeta: {
        slide: { templateId: null, name: "Slide", section: "", hidden: false },
        other: { templateId: null, name: "Other", section: "", hidden: false },
      },
    },
    1000,
    { slide: motion.stages.map((s) => ({ id: s.id, duration: 0 })), other: [] },
  );
  const evaluate = (now: number) => {
    const clocks = sampleEffectClocks(presenterEffectClockOrigins(state)!, now);
    return effectTiming(
      motion,
      state.motion?.stageIndex ?? 0,
      0,
      "element",
      "instance",
      {
        ...clocks,
        stageStarts: state.motionStageStartedOffsets?.map((t) => t / 1000),
      },
    );
  };
  expect(evaluate(1500)).toMatchObject({
    active: true,
    running: false,
    time: 0,
  });
  state = applyPresentationCommand(state, { type: "next" }, 2000);
  expect(evaluate(7000)).toMatchObject({
    active: true,
    running: true,
    time: 5,
  });
  state = applyPresentationCommand(state, { type: "next" }, 8000);
  expect(evaluate(8500)).toMatchObject({
    active: true,
    running: false,
    time: 6,
  });
  state = applyPresentationCommand(state, { type: "previous" }, 9000);
  expect(evaluate(9000)).toMatchObject({
    active: true,
    running: true,
    time: 0,
  });
  state = applyPresentationCommand(state, { type: "previous" }, 10000);
  expect(evaluate(10000)).toMatchObject({
    active: true,
    running: false,
    time: 0,
  });
  state = applyPresentationCommand(state, { type: "jump", index: 1 }, 11000);
  state = applyPresentationCommand(state, { type: "jump", index: 0 }, 12000);
  expect(evaluate(12000)).toMatchObject({
    active: true,
    running: false,
    time: 0,
  });
  state = applyPresentationCommand(state, { type: "next" }, 13000);
  expect(evaluate(13000)).toMatchObject({
    active: true,
    running: true,
    time: 0,
  });
});

it("Timed clock intervals exclude paused wall time and reconnect uses transported click origins", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "after", durationMs: 2000 },
  });
  let state = startSession(
    { deckId: "deck", slideIds: [], index: null },
    {
      slideIds: ["slide"],
      slideMeta: {
        slide: { templateId: null, name: "Slide", section: "", hidden: false },
      },
    },
    1000,
    { slide: motion.stages.map((s) => ({ id: s.id, duration: 0 })) },
  );
  state = applyPresentationCommand(state, { type: "next" }, 2000);
  const evaluate = (now: number) => {
    const clocks = sampleEffectClocks(presenterEffectClockOrigins(state)!, now);
    return effectTiming(
      motion,
      state.motion!.stageIndex,
      0,
      "element",
      "instance",
      {
        ...clocks,
        stageStarts: state.motionStageStartedOffsets!.map((t) => t / 1000),
      },
    );
  };
  state = applyPresentationCommand(state, { type: "toggle-pause" }, 2500);
  expect(evaluate(10000)).toMatchObject({
    running: true,
    time: 0.5,
    progress: 0.25,
  });
  state = applyPresentationCommand(state, { type: "toggle-pause" }, 10000);
  expect(evaluate(10500)).toMatchObject({
    running: true,
    time: 1,
    progress: 0.5,
  });
  expect(evaluate(11500)).toMatchObject({
    running: false,
    time: 2,
    progress: 1,
  });
});
it("Editor preview origins retain actual click waits independently of finite phases", () => {
  const stages = [
    { id: "entry", duration: 0 },
    { id: "click-one", duration: 800 },
    { id: "click-two", duration: 0 },
  ];
  const first = withPreviewClock(
    null,
    {
      stageIndex: 1,
      stageId: "click-one",
      time: 0,
      startedAt: 1000,
      running: true,
    },
    stages,
    1000,
  )!;
  expect(previewTime(first, 6000)).toBe(5000);
  const paused = withPreviewClock(
    first,
    { ...first, time: 5000, startedAt: 6000, running: false },
    stages,
    6000,
  )!;
  expect(previewTime(paused, 20000)).toBe(5000);
  const next = withPreviewClock(
    paused,
    {
      stageIndex: 2,
      stageId: "click-two",
      time: 0,
      startedAt: 20000,
      running: true,
    },
    stages,
    20000,
  )!;
  expect(next.effectClock!.stageStarts).toEqual([0, 0, 5000]);
  const motion = scheduled({ ...none, stop: { mode: "next-click" } });
  expect(
    effectTiming(motion, 2, 0, "element", "instance", {
      slideTime: 5,
      presentationTime: 5,
      stageStarts: next.effectClock!.stageStarts.map((t) => t / 1000),
    }),
  ).toMatchObject({ running: false, time: 5, progress: 1 });
  const backward = withPreviewClock(
    next,
    {
      stageIndex: 1,
      stageId: "click-one",
      time: 800,
      startedAt: 21000,
      running: false,
    },
    stages,
    21000,
  )!;
  expect(backward.effectClock!.stageStarts).toEqual([0, 0]);
});

it("Click Start uses its configured gate and holds time at Stop while staying applied", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "click", stageId: "click-two" },
  });
  const evaluate = (index: number, seconds: number) =>
    effectTiming(motion, index, seconds * 1000, "element", "instance", {
      slideTime: [0, 1, 10][index] + seconds,
      presentationTime: 100 + [0, 1, 10][index] + seconds,
      stepTime: seconds,
      stageStarts: [0, 1, 10],
    });
  expect(evaluate(0, 0.5)).toMatchObject({
    active: true,
    running: false,
    time: 0,
  });
  expect(evaluate(1, 0)).toMatchObject({
    active: true,
    running: true,
    time: 0,
  });
  expect(evaluate(1, 7)).toMatchObject({
    active: true,
    running: true,
    time: 7,
    presentationTime: 108,
  });
  expect(evaluate(2, 0)).toMatchObject({
    active: true,
    running: false,
    time: 9,
  });
  expect(evaluate(2, 80)).toMatchObject({
    active: true,
    running: false,
    time: 9,
    presentationTime: 190,
  });
});
it("Timed Stop freezes t and completes p at the same endpoint", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "after", durationMs: 100 },
  });
  expect(sample(motion, 1, 0.4)).toMatchObject({
    time: 0.1,
    progress: 1,
    running: false,
  });
});
it("Click time stays relative to its configured origin at subsequent clicks", () => {
  const motion = scheduled({
    version: 1,
    start: "click",
    startOffsetMs: 400,
    stop: { mode: "click", stageId: "click-two" },
  });
  const evaluate = (index: number, seconds: number) =>
    effectTiming(motion, index, seconds * 1000, "element", "instance", {
      slideTime: [0, 1, 10][index] + seconds,
      presentationTime: 100 + [0, 1, 10][index] + seconds,
      stepTime: seconds,
      stageStarts: [0, 1, 10],
    });
  expect(evaluate(1, 0.3).time).toBe(0);
  expect(evaluate(1, 0.4).time).toBe(0);
  expect(evaluate(2, 0).time).toBeCloseTo(8.6);
  expect(evaluate(2, 80).time).toBeCloseTo(8.6);
});

it("Presentation Start supplies deck-global Effect time when first rendered on a later slide", () => {
  const motion = scheduled({ ...none, start: "presentation" });
  expect(sample(motion, 0, 0.5)).toMatchObject({
    time: 100.5,
    active: true,
    running: true,
    progress: 1,
  });
  expect(sample(motion, 2, 7)).toMatchObject({
    time: 117,
    presentationTime: 117,
    slideTime: 17,
    stepTime: 7,
  });
  expect(
    effectTiming(
      undefined,
      0,
      0,
      "later",
      "instance",
      { slideTime: 0, presentationTime: 40 },
      { start: "presentation", stop: { mode: "none" } },
    ),
  ).toMatchObject({ time: 40, running: true });
});
it("Slide Start resets at activation and re-entry without waiting for its progress click", () => {
  const motion = scheduled({ ...none, start: "slide" });
  expect(sample(motion, 0, 0.5)).toMatchObject({ time: 0.5, progress: 1 });
  expect(sample(motion, 2, 7).time).toBe(17);
  expect(sample(motion, 0, 0).time).toBe(0);
});
it("Click origins honor offsets and known duration Stops", () => {
  const motion = scheduled({
    ...none,
    start: "click",
    startOffsetMs: 400,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 1, 0.3)).toMatchObject({ time: 0, running: false });
  expect(sample(motion, 1, 0.4)).toMatchObject({ time: 0, running: true });
  expect(sample(motion, 2, 80)).toMatchObject({ time: 2, running: false });
});
it("Slide end completes discretely and freezes local and presentation origins", () => {
  const clocks = {
    slideTime: 12,
    presentationTime: 112,
    stageStarts: [0, 1, 10],
    slideEnd: { slideTime: 8, presentationTime: 108 },
  };
  const slideEnd = scheduled({
    ...none,
    start: "slide",
    stop: { mode: "slide-end" },
  });
  expect(
    effectTiming(slideEnd, 2, 0, "element", "instance", clocks),
  ).toMatchObject({ time: 8, running: false, progress: 1, duration: 0 });
  const deckEnd = scheduled({
    ...none,
    start: "presentation",
    stop: { mode: "slide-end" },
  });
  expect(
    effectTiming(deckEnd, 2, 0, "element", "instance", clocks),
  ).toMatchObject({ time: 108, running: false, progress: 1, duration: 0 });
  expect(
    effectTiming(deckEnd, 2, 0, "element", "instance", {
      ...clocks,
      slideEnd: undefined,
    }).time,
  ).toBe(112);
});
it("Presentation Start completes a finite interval before a later mount", () => {
  const motion = scheduled({
    ...none,
    start: "presentation",
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 0, 0.5)).toMatchObject({ time: 2, progress: 1 });
});
it("Advanced clocks remain explicit inputs independent of generic Effect time", () => {
  const clocks = { slideTime: 12, presentationTime: 112, stepTime: 2 };
  expect(
    effectTiming(undefined, 2, 2000, "element", "instance", clocks, {
      start: "presentation",
      stop: { mode: "none" },
    }),
  ).toMatchObject({ time: 112, ...clocks });
  expect(
    effectTiming(undefined, 2, 2000, "element", "instance", clocks),
  ).toMatchObject({ time: 12, ...clocks });
});

it("Transport termination captures paused logical endpoints and leaves named reference clocks intact", () => {
  const clocks = sampleEffectClocks(
    {
      presentationStartedAt: 1000,
      slideStartedAt: 4000,
      stepStartedAt: 6000,
      pausedAt: 8000,
    },
    20000,
  );
  expect(endEffectClocks(clocks)).toEqual({
    ...clocks,
    slideEnd: { slideTime: 4, presentationTime: 7 },
  });
  const ended = endEffectClocks(clocks);
  expect(ended).toEqual({
    ...clocks,
    slideEnd: { slideTime: 4, presentationTime: 7 },
  });
  const motion = scheduled({
    ...none,
    start: "presentation",
    stop: { mode: "slide-end" },
  });
  expect(
    effectTiming(motion, 0, 0, "element", "instance", ended),
  ).toMatchObject({
    time: 7,
    running: false,
    slideTime: 4,
    presentationTime: 7,
    stepTime: 2,
  });
});
it("Slide Start follows real slide jumps and re-entry while Presentation Start stays deck-global", () => {
  const deck = {
    slideIds: ["slide", "other"],
    slideMeta: {
      slide: { templateId: null, name: "Slide", section: "", hidden: false },
      other: { templateId: null, name: "Other", section: "", hidden: false },
    },
  };
  let state = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
  );
  const sampleStart = (start: "slide" | "presentation", now: number) =>
    effectTiming(
      undefined,
      0,
      0,
      "element",
      "instance",
      sampleEffectClocks(presenterEffectClockOrigins(state)!, now),
      { start, stop: { mode: "none" } },
    ).time;
  expect(sampleStart("slide", 6000)).toBe(5);
  state = applyPresentationCommand(state, { type: "jump", index: 1 }, 7000);
  expect(sampleStart("slide", 7000)).toBe(0);
  expect(sampleStart("presentation", 7000)).toBe(6);
  state = applyPresentationCommand(state, { type: "jump", index: 0 }, 10000);
  expect(sampleStart("slide", 10000)).toBe(0);
  expect(sampleStart("presentation", 10000)).toBe(9);
});

it("A captured Stop freezes Presentation-origin t even while the local reference clock is paused", () => {
  const motion = scheduled({
    ...none,
    start: "presentation",
    stop: { mode: "slide-end" },
  });
  const ended = endEffectClocks({ slideTime: 8, presentationTime: 108 });
  expect(
    effectTiming(motion, 0, 0, "element", "instance", {
      ...ended,
      presentationTime: 150,
    }).time,
  ).toBe(108);
});

it("Template A Presentation time survives inherited shader remounts, jumps and audience reconnect", () => {
  const document = templateTimingDocument();
  let state = startSession(
    { deckId: document.deck.id, slideIds: [], index: null },
    document.deck,
    1000,
  );
  const sample = (now: number) => {
    const resolved = resolveSlide(document, state.slideIds[state.index!]);
    const element = walkElements(
      resolved.slide.nodes.flatMap((root) => root.children),
    )[0];
    expect(resolved.sources.get(element.id)).toBe("template");
    const instance = element.effects![0],
      definition = resolved.slide.effectResources![instance.resourceId];
    expect(instance).not.toHaveProperty("timeSource");
    expect(definition).not.toHaveProperty("timeSource");
    return effectTiming(
      resolved.slide.motion,
      0,
      0,
      element.id,
      instance.id,
      sampleEffectClocks(
        presenterEffectClockOrigins(structuredClone(state))!,
        now,
      ),
      definition.timeControl,
    ).time;
  };
  expect(sample(1000)).toBe(0);
  state = applyPresentationCommand(state, { type: "jump", index: 1 }, 9000);
  expect(sample(9000)).toBe(8);
  state = applyPresentationCommand(state, { type: "jump", index: 2 }, 16000);
  expect(sample(16000)).toBe(15);
  state = applyPresentationCommand(state, { type: "jump", index: 0 }, 18000);
  expect(sample(18000)).toBe(17);
  expect(state.startedAt).toBe(1000);
});

it("Effect schedules require version 1 and current Stop choices", () => {
  expect(effectScheduleSchema.parse(none)).toEqual(none);
  expect(
    effectScheduleSchema.safeParse({ ...none, version: undefined }).success,
  ).toBe(false);
  expect(
    effectScheduleSchema.safeParse({
      ...none,
      stop: { mode: "presentation-end" },
    }).success,
  ).toBe(false);
});

it("Changing Stop changes p without another authored field", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 1, 1).progress).toBe(0.5);
  motion.stages[1].blocks![0].effectSchedule!.stop = { mode: "none" };
  expect(sample(motion, 0, 0).progress).toBe(0);
  expect(sample(motion, 1, 0).progress).toBe(1);
  motion.stages[1].blocks![0].effectSchedule!.stop = {
    mode: "after",
    durationMs: 2000,
  };
  expect(sample(motion, 1, 1).progress).toBe(0.5);
  expect(motion.stages[1].blocks![0].effectSchedule).not.toHaveProperty(
    "progress",
  );
});
it("Consuming p never forces a timed Stop or creates a Motion track", () => {
  const definition = {
    ...blankEffect("css-js"),
    source: ":scope { opacity: var(--p); }",
  };
  const motion = addEffectTrigger(
    undefined,
    0,
    "element",
    {
      id: "instance",
      resourceId: "resource",
      enabled: true,
      placement: "content",
      parameters: {},
    },
    definition,
  );
  expect(motion.stages[0].blocks![0].effectSchedule!.stop).toEqual({
    mode: "none",
  });
  expect(motion.stages[0].tracks).toEqual([]);
});
it("Current schedules reject progress modes and progress pseudo-property Motion", () => {
  expect(
    effectScheduleSchema.safeParse({ ...none, progress: { mode: "none" } })
      .success,
  ).toBe(false);
  expect(effectScheduleSchema.safeParse({ ...none, version: 2 }).success).toBe(
    false,
  );
  const motion = scheduled(none);
  motion.stages[0].tracks.push({
    id: "progress",
    elementId: "element",
    property: "effects.instance.parameters.progress",
    keyframes: [{ id: "key", at: 0, value: { type: "absolute", value: 0 } }],
  });
  expect(slideMotionSchema.safeParse(motion).success).toBe(false);
});
it("Started is reconstructed across event completion and backward scrubbing", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "next-click" },
    progressEasing: "hold",
  });
  const before = {
    started: false,
    running: false,
    time: 0,
    progress: 0,
    active: true,
  };
  const waiting = {
    started: true,
    running: true,
    time: 2,
    progress: 0,
    active: true,
  };
  const final = {
    started: true,
    running: false,
    time: 9,
    progress: 1,
    active: true,
  };
  expect(sample(motion, 0, 0.5)).toMatchObject(before);
  expect(sample(motion, 1, 2)).toMatchObject(waiting);
  expect(sample(motion, 2, 20)).toMatchObject(final);
  expect(sample(motion, 1, 2)).toMatchObject(waiting);
  expect(sample(motion, 0, 0.5)).toMatchObject(before);
});
it("Slide Start waits for Next click and a missing later gate remains unbounded", () => {
  const motion = scheduled({
    ...none,
    start: "slide",
    stop: { mode: "next-click" },
  });
  expect(sample(motion, 0, 0)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
    time: 0,
  });
  expect(sample(motion, 1, 0)).toMatchObject({
    started: true,
    running: false,
    progress: 1,
    time: 1,
  });
  motion.stages[0].blocks = motion.stages[1].blocks;
  motion.stages = [motion.stages[0]];
  expect(sample(motion, 0, 50)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
    time: 50,
  });
});
it("None activates at Start and offsets bypass until the actual origin", () => {
  const motion = scheduled({ ...none, startOffsetMs: 500 });
  expect(sample(motion, 0, 0.3)).toMatchObject({
    started: false,
    running: false,
    progress: 0,
    time: 0,
  });
  expect(sample(motion, 1, 0.3)).toMatchObject({
    started: false,
    running: false,
    progress: 0,
    time: 0,
  });
  expect(sample(motion, 1, 0.5)).toMatchObject({
    started: true,
    running: true,
    progress: 1,
    time: 0,
  });
  expect(sample(motion, 1, 1.5)).toMatchObject({
    started: true,
    running: true,
    progress: 1,
    time: 1,
  });
  motion.stages[1].blocks![0].effectSchedule!.start = "slide";
  expect(sample(motion, 0, 0.3).started).toBe(false);
  expect(sample(motion, 0, 0.5).started).toBe(true);
});
it("After duration uses the unscaled interval and late Presentation mounts are completed", () => {
  const motion = scheduled({
    ...none,
    startOffsetMs: 500,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(sample(motion, 1, 0.3)).toMatchObject({
    started: false,
    running: false,
    progress: 0,
    time: 0,
  });
  expect(sample(motion, 1, 0.5)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
    time: 0,
  });
  expect(sample(motion, 1, 1.5)).toMatchObject({
    started: true,
    running: true,
    progress: 0.5,
    time: 1,
  });
  expect(sample(motion, 1, 2.5)).toMatchObject({
    started: true,
    running: false,
    progress: 1,
    time: 2,
  });
  expect(
    effectTiming(
      undefined,
      0,
      0,
      "element",
      "instance",
      { slideTime: 0, presentationTime: 40 },
      { start: "presentation", stop: { mode: "after", durationMs: 2000 } },
    ),
  ).toMatchObject({ started: true, running: false, progress: 1, time: 2 });
});
it("Slide end supplies discrete completion only in the captured terminal sample", () => {
  const motion = scheduled({
    ...none,
    start: "slide",
    stop: { mode: "slide-end" },
    progressEasing: "hold",
  });
  expect(sample(motion, 1, 4)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
    time: 5,
  });
  expect(
    effectTiming(
      motion,
      1,
      0,
      "element",
      "instance",
      endEffectClocks({ slideTime: 5, presentationTime: 105 }),
    ),
  ).toMatchObject({ started: true, running: false, progress: 1, time: 5 });
  expect(sample(motion, 0, 0)).toMatchObject({
    started: true,
    running: true,
    progress: 0,
    time: 0,
  });
});

it("compiled effect timing samples 600 frames without searching the immutable schedule", () => {
  const motion = scheduled({
    ...none,
    stop: { mode: "click", stageId: "click-two" },
  });
  const control = structuredClone(motion);
  const compiled = compileEffectTiming(motion, "element", "instance");
  Object.defineProperty(motion.stages, "findIndex", {
    value: () => {
      throw new Error("Per-frame schedule search");
    },
  });
  for (const stage of motion.stages)
    Object.defineProperty(stage, "blocks", {
      get() {
        throw new Error("Per-frame binding search");
      },
    });
  for (let frame = 0; frame < 600; frame++) {
    const index = frame < 300 ? 1 : 2,
      time = frame / 60,
      clocks = {
        slideTime: time,
        presentationTime: 100 + time,
        stepTime: time,
        stageStarts: [0, 0, 5],
      };
    expect(compiled.sample(index, time * 1000, clocks)).toEqual(
      effectTiming(control, index, time * 1000, "element", "instance", clocks),
    );
  }
});
