import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createBasicShape } from "../../../src/core/elementFactory";
import { addParameterAnimation, resolveMotion } from "../../../src/core/motion";

it("Motion samples a deterministic overlay and leaves canonical element state intact", () => {
  const document = newPresentationDocument("Motion");
  const slide = document.slides[document.deck.slideIds[0]];
  const element = createBasicShape("shape", "rectangle");
  slide.nodes[0].children.push(element);
  slide.motion = addParameterAnimation(
    undefined,
    0,
    element.id,
    "appearance.opacity",
    "Fade",
    0,
    1,
    1000,
    true,
  );
  const before = structuredClone(slide);
  expect(resolveMotion(slide, 0, 0)[element.id]["appearance.opacity"]).toBe(0);
  expect(
    resolveMotion(slide, 0, 500)[element.id]["appearance.opacity"],
  ).toBeCloseTo(0.5);
  expect(resolveMotion(slide, 0, 1000)[element.id]["appearance.opacity"]).toBe(
    1,
  );
  expect(slide).toEqual(before);
});
