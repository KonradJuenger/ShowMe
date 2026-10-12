import { expect, it } from "vitest";
import {
  motionTimelineLayout,
  motionTimelineSpans,
  resizeTimelineIntervalStart,
} from "../../../src/components/motionTimelineLayout";
import {
  resizeEffectTime,
  editEffectSchedule,
} from "../../../src/core/effectSequence";
import { editMotionBlock } from "../../../src/core/motion";
import { effectTiming } from "../../../src/core/effects";
import {
  slideMotionSchema,
  type SlideMotion,
  type EffectSchedule,
} from "../../../src/core/motionModel";
function fixture(stop: EffectSchedule["stop"]): SlideMotion {
  return slideMotionSchema.parse({
    stages: [
      {
        id: "start",
        tracks: [],
        blocks: [
          {
            id: "effect",
            label: "Effect",
            members: [],
            binding: {
              kind: "effect",
              elementId: "element",
              effectInstanceId: "instance",
            },
            effectSchedule: {
              version: 1,
              start: "click",
              startOffsetMs: 200,
              stop,
            },
          },
        ],
      },
      { id: "next", tracks: [] },
      { id: "later", tracks: [] },
    ],
  });
}
it("Slide start moves the bound Effect to stage zero and removes its delay", () => {
  const original = fixture({ mode: "after", durationMs: 2000 });
  const delayed = editMotionBlock(original, 0, "effect", 2, 700, 2000);
  const reset = editEffectSchedule(delayed, 2, "effect", (schedule) => {
    schedule.start = "slide";
  });
  expect(reset.stages[2].blocks).toEqual([]);
  expect(reset.stages[0].blocks![0].effectSchedule).toEqual({
    version: 1,
    start: "slide",
    startOffsetMs: 0,
    stop: { mode: "after", durationMs: 2000 },
  });
  expect(effectTiming(reset, 0, 1000, "element", "instance")).toMatchObject({
    time: 1,
    progress: 0.5,
    duration: 2,
  });
  const shortened = resizeEffectTime(reset, 0, "effect", 0, {
    mode: "after",
    durationMs: 1000,
  });
  expect(effectTiming(shortened, 0, 500, "element", "instance")).toMatchObject({
    time: 0.5,
    progress: 0.5,
    duration: 1,
  });
  expect(delayed.stages[2].blocks![0].effectSchedule!.startOffsetMs).toBe(700);
});
it("Effect start resizing snaps to another click, keeps the Stop gate", () => {
  const motion = fixture({ mode: "click", stageId: "later" });
  const resized = resizeTimelineIntervalStart(
    motion,
    0,
    "effect",
    150,
    [100, 100, 100],
    [1000, 1000, 1000],
    true,
  );
  expect(resized.stages[0].blocks).toEqual([]);
  expect(resized.stages[1].blocks![0].effectSchedule).toMatchObject({
    startOffsetMs: 0,
    stop: { mode: "click", stageId: "later" },
  });
});
it("Timed Effect resizing drives progress with its Stop duration", () => {
  const motion = fixture({ mode: "after", durationMs: 2000 });
  expect(
    motionTimelineLayout(motion, [220, 100, 80], [2200, 1000, 1000]).get(
      "effect",
    ),
  ).toEqual({ left: 20, width: 200, lane: 0, end: "timed" });
  const resized = resizeEffectTime(motion, 0, "effect", 300, {
    mode: "after",
    durationMs: 1000,
  });
  expect(resized.stages[0].blocks![0].effectSchedule).toMatchObject({
    startOffsetMs: 300,
    stop: { mode: "after", durationMs: 1000 },
  });
  expect(motion.stages[0].blocks![0].effectSchedule!.stop).toEqual({
    mode: "after",
    durationMs: 2000,
  });
});
it("Click-linked Effect bodies fill the interval to their actual stop gate and reserve lanes", () => {
  const motion = fixture({ mode: "click", stageId: "later" });
  motion.stages[1].blocks = [
    {
      ...structuredClone(motion.stages[0].blocks![0]),
      id: "other",
      binding: {
        kind: "effect",
        elementId: "element",
        effectInstanceId: "other-instance",
      },
    },
  ];
  motion.stages[1].blocks[0].effectSchedule!.stop = { mode: "none" };
  const layout = motionTimelineLayout(
    motion,
    [200, 100, 80],
    [1000, 1000, 1000],
  );
  expect(layout.get("effect")).toEqual({
    left: 40,
    width: 260,
    lane: 0,
    end: "click",
  });
  expect(layout.get("other")!.lane).toBe(1);
  const next = fixture({ mode: "next-click" });
  expect(
    motionTimelineLayout(next, [200, 100, 80], [1000, 1000, 1000]).get(
      "effect",
    )!.width,
  ).toBe(160);
});
it("Unbounded Effects fill the remaining authored timeline with a continuous end instead of a fake timed length", () => {
  const motion = fixture({ mode: "none" });
  expect(motionTimelineSpans(motion)[0]).toBe(1200);
  expect(
    motionTimelineLayout(motion, [200, 100, 80], [1000, 1000, 1000]).get(
      "effect",
    ),
  ).toEqual({ left: 40, width: 340, lane: 0, end: "continuous" });
});

it("Stop None at Click 1 grows through later clicks without changing persistence", () => {
  const motion = fixture({ mode: "none" });
  motion.stages[1].blocks = motion.stages[0].blocks;
  motion.stages[0].blocks = [];
  motion.stages.push({ id: "third", tracks: [] });
  expect(
    motionTimelineLayout(
      motion,
      [100, 100, 100, 100],
      [1000, 1000, 1000, 1000],
    ).get("effect")!.width,
  ).toBe(280);
  motion.stages.push({ id: "fourth", tracks: [] });
  expect(
    motionTimelineLayout(
      motion,
      [100, 100, 100, 100, 100],
      [1000, 1000, 1000, 1000, 1000],
    ).get("effect")!.width,
  ).toBe(380);
  expect(
    slideMotionSchema.parse(motion).stages[1].blocks![0].effectSchedule!.stop,
  ).toEqual({ mode: "none" });
});
