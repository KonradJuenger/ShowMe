import { expect, it } from "vitest";
import { nativeOpacityPlan } from "../../../src/components/nativeOpacity";
import { createBasicShape } from "../../../src/core/elementFactory";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";

function fixture() {
  const group = createBasicShape("group", "rectangle");
  const card = createBasicShape("card", "rectangle");
  const text = createBasicShape("text", "rectangle");
  const glass = {
    ...blankEffect("css-js"),
    source:
      ":scope { backdrop-filter: blur(12px); background: #ffffff44; border-radius: 16px; overflow: hidden; }",
  };
  card.effects = [newEffectInstance("glass", glass, "content")];
  card.children = [text];
  group.children = [card];
  return { group, card, text, resources: { glass } };
}

it("retains native group opacity for ordinary and disabled-effect content", () => {
  const { group, card, resources } = fixture();
  card.effects![0].enabled = false;
  expect(nativeOpacityPlan([group], resources).size).toBe(0);
  card.effects![0].enabled = true;
  resources.glass.source = ":scope { backdrop-filter: none; }";
  expect(nativeOpacityPlan([group], resources).size).toBe(0);
});

it("carries ancestor alpha to each material once without fading a backdrop ancestor", () => {
  const { group, card, text, resources } = fixture();
  const second = structuredClone(card);
  second.id = "second";
  second.children = [];
  group.children.push(second);
  const plan = nativeOpacityPlan([group], resources);
  expect(plan.get(group.id)?.distribute).toBe(true);
  expect(plan.get(card.id)?.distribute).toBe(true);
  expect(plan.get(card.id)?.value).toContain(
    `var(${plan.get(group.id)!.property})`,
  );
  expect(plan.get(second.id)?.value).toContain(
    `var(${plan.get(group.id)!.property})`,
  );
  expect(plan.has(text.id)).toBe(false); // already inside the material's alpha
});

it("keeps authored CSS boundaries and arbitrary stylesheets native", () => {
  const { group, resources } = fixture();
  resources.glass.source =
    ":scope { backdrop-filter: blur(12px); opacity: .8; }";
  expect(nativeOpacityPlan([group], resources).size).toBe(0);
  resources.glass.source = ":scope::before { backdrop-filter: blur(12px); }";
  expect(nativeOpacityPlan([group], resources).size).toBe(0);
  expect(
    nativeOpacityPlan([group], resources, ".custom { opacity: .5; }").size,
  ).toBe(0);
});

it("does not distribute alpha through a shader or nested material boundary", () => {
  const { group, card, resources } = fixture();
  const child = structuredClone(card);
  child.id = "child";
  child.children = [];
  card.children = [child];
  const plan = nativeOpacityPlan([group], resources);
  expect(plan.has(group.id)).toBe(false);
  expect(plan.has(card.id)).toBe(false);
  expect(plan.get(child.id)?.distribute).toBe(true);
  const shader = blankEffect("shader");
  group.effects = [newEffectInstance("shader", shader, "content")];
  expect(
    nativeOpacityPlan([group], { ...resources, shader }).has(group.id),
  ).toBe(false);
});
