import { expect, it } from "vitest";
import {
  addMotionPreset,
  addParameterAnimation,
  blockMotionEase,
  namedMotionEase,
  motionEaseFromName,
  motionEaseNames,
} from "../../../src/core/motion";

it("names standard easing and preserves unknown curves as Custom", () => {
  for (const name of motionEaseNames)
    expect(namedMotionEase(motionEaseFromName(name))).toBe(name);
  expect(namedMotionEase("linear")).toBe("Linear");
  expect(namedMotionEase("hold")).toBe("Hold");
  expect(namedMotionEase([0.42, 0, 1, 1])).toBe("Ease In");
  expect(namedMotionEase([0, 0, 0.58, 1])).toBe("Ease Out");
  expect(namedMotionEase([0.42, 0, 0.58, 1])).toBe("Ease In Out");
  expect(namedMotionEase()).toBe("Linear");
  expect(namedMotionEase([0.2, 0.3, 0.6, 0.9])).toBe("Custom");
});

it("reads all outgoing member segments without changing mixed or custom Motion easing", () => {
  const motion = addMotionPreset(undefined, 0, ["element"], "Move");
  const stage = motion.stages[0],
    block = stage.blocks![0];
  expect(block.members.length).toBeGreaterThan(1);
  for (const name of motionEaseNames) {
    for (const track of stage.tracks)
      track.keyframes[0].easeToNext = motionEaseFromName(name);
    expect(blockMotionEase(stage, block)).toBe(name);
  }
  stage.tracks[0].keyframes[0].easeToNext = "linear";
  const before = structuredClone(motion);
  expect(blockMotionEase(stage, block)).toBe("Custom");
  expect(motion).toEqual(before);
  for (const track of stage.tracks)
    track.keyframes[0].easeToNext = [0.2, 0.3, 0.6, 0.9];
  expect(blockMotionEase(stage, block)).toBe("Custom");
});

it("includes interior outgoing segments but excludes easing after the block endpoint", () => {
  const motion = addParameterAnimation(
    undefined,
    0,
    "element",
    "appearance.opacity",
    "Fade",
    0,
    1,
    1000,
    true,
  );
  const stage = motion.stages[0],
    track = stage.tracks[0],
    block = stage.blocks![0];
  track.keyframes[0].easeToNext = "linear";
  track.keyframes[1].easeToNext = "hold";
  expect(blockMotionEase(stage, block)).toBe("Linear");
  track.keyframes.splice(1, 0, {
    id: "interior",
    at: 500,
    value: { type: "absolute", value: 0.5 },
    easeToNext: "hold",
  });
  expect(blockMotionEase(stage, block)).toBe("Custom");
});

it("reads numeric Effect parameter easing from authoritative member ranges", () => {
  const motion = addParameterAnimation(
    undefined,
    0,
    "element",
    "effects.instance.parameters.strength",
    "Effect",
    0,
    1,
    800,
    true,
  );
  const stage = motion.stages[0],
    block = stage.blocks![0];
  expect(blockMotionEase(stage, block)).toBe("Linear");
  for (const name of motionEaseNames) {
    stage.tracks[0].keyframes[0].easeToNext = motionEaseFromName(name);
    expect(blockMotionEase(stage, block)).toBe(name);
  }
  stage.tracks[0].keyframes[0].easeToNext = [0.2, 0.3, 0.6, 0.9];
  const before = structuredClone(motion);
  expect(blockMotionEase(stage, block)).toBe("Custom");
  expect(motion).toEqual(before);
});
