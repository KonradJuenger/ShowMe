import { addParameterAnimation, resolveMotion } from "../../../src/core/motion";
import { validateMotionTargets } from "../../../src/core/motionModel";
import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement } from "../../../src/core/text";
import {
  insertElements,
  setElementEffectDefinition,
} from "../../../src/core/editorCommands";
import { dissolveEffect } from "../../../src/core/dissolveEffect";
import {
  effectTemplates,
  newEffectInstance,
  effectProperty,
  parseEffectProperty,
  effectTiming,
} from "../../../src/core/effects";

it("instances share a definition but retain independent parameters and Motion addresses", () => {
  const definition = effectTemplates[0];
  const first = newEffectInstance("glass", definition, "content");
  const second = newEffectInstance("glass", definition, "content");
  const key = definition.parameters[0].key;
  first.parameters[key] = 35;
  expect(second.parameters[key]).toBe(definition.parameters[0].default);
  expect(second.id).not.toBe(first.id);
  expect(parseEffectProperty(effectProperty(first.id, key))).toEqual({
    instanceId: first.id,
    key,
  });
});

it("applying built-in reveals creates two-second block-driven progress at Slide start", () => {
  const model = newPresentationDocument("Reveal defaults");
  const slide = model.slides[model.deck.slideIds[0]];
  const element = createTextElement("text");
  const snapshot = insertElements(
    { deck: model.deck, slide },
    [element],
    slide.nodes[0].id,
  );
  const reveals = [
    dissolveEffect,
    ...effectTemplates.filter(
      (definition) => definition.category === "entrance",
    ),
  ];
  expect(reveals.map((definition) => definition.name)).toEqual([
    "Dissolve",
    "CSS Reveal",
    "Text Scramble",
  ]);
  for (const definition of reveals) {
    const applied = setElementEffectDefinition(
      snapshot,
      element.id,
      definition,
      undefined,
      3,
    );
    const motion = applied.slide.motion!;
    expect(motion.stages).toHaveLength(1);
    const block = motion.stages[0].blocks![0];
    expect(block.effectSchedule).toEqual({
      version: 1,
      start: "slide",
      startOffsetMs: 0,
      stop: { mode: "after", durationMs: 2000 },
    });
    expect(
      effectTiming(
        motion,
        0,
        1000,
        element.id,
        block.binding?.kind === "effect" ? block.binding.effectInstanceId : "",
      ).progress,
    ).toBe(0.5);
    for (const [milliseconds, progress] of [
      [0, 0],
      [1000, 0.5],
      [2000, 1],
      [10000, 1],
    ]) {
      expect(
        effectTiming(
          motion,
          0,
          milliseconds,
          element.id,
          block.binding!.kind === "effect"
            ? block.binding!.effectInstanceId
            : "",
        ).progress,
      ).toBe(progress);
    }
    expect(motion.stages[0].tracks).toEqual([]);
  }
});

it("Dithered Patterns and Glass Distortion keep continuous t with p one", () => {
  for (const definition of effectTemplates.filter(
    (definition) => definition.timeControl.stop.mode === "none",
  )) {
    expect(definition.timeControl.start).toBe("slide");
    expect(
      effectTiming(
        undefined,
        0,
        5000,
        "element",
        "instance",
        undefined,
        definition.timeControl,
      ),
    ).toMatchObject({ time: 5, progress: 1 });
  }
});

it("Numeric Effect parameters retain ordinary Motion interpolation and hold their endpoint", () => {
  const model = newPresentationDocument("Parameter Motion"),
    slide = model.slides[model.deck.slideIds[0]];
  const definition = effectTemplates[0],
    element = createTextElement("element");
  const instance = newEffectInstance("glass", definition, "content");
  element.effects = [instance];
  slide.nodes[0].children = [element];
  slide.effectResources = { glass: definition };
  const property = effectProperty(instance.id, definition.parameters[0].key);
  slide.motion = addParameterAnimation(
    undefined,
    0,
    element.id,
    property,
    "Strength",
    0,
    12,
    800,
    true,
  );
  for (const track of slide.motion.stages[0].tracks)
    track.keyframes[0].easeToNext = "linear";
  expect(() =>
    validateMotionTargets(slide.motion!, [element], slide.effectResources),
  ).not.toThrow();
  expect(resolveMotion(slide, 0, 0)[element.id][property]).toBe(0);
  expect(resolveMotion(slide, 0, 400)[element.id][property]).toBe(6);
  expect(resolveMotion(slide, 0, 2000)[element.id][property]).toBe(12);
});
