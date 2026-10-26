import { expect, it } from "vitest";
import {
  compileCompositionPlan,
  compileVisualGroup,
  prefixElements,
  type Composition,
  type EffectRef,
} from "../../../src/components/compositionPlan";
import { newPresentationDocument } from "../../../src/core/document";
import { createBasicShape } from "../../../src/core/elementFactory";
import { blankEffect } from "../../../src/core/effectAuthoring";
import {
  newEffectInstance,
  type EffectDefinition,
} from "../../../src/core/effects";
import type { Element } from "../../../src/core/element";

const shape = (id: string) => createBasicShape(id, "rectangle", { x: 0, y: 0 });
function fixture(children: Element[]) {
  const document = newPresentationDocument("Composition");
  const slide = document.slides[document.deck.slideIds[0]];
  slide.nodes[0].children = children;
  const css = blankEffect("css-js");
  const shader = blankEffect("shader");
  slide.effectResources = {
    css,
    shader,
    js: {
      ...css,
      kind: "text-js",
      target: "text",
      source: "function render({text}) { return text; }",
    },
    backdrop: { ...shader, input: "backdrop", target: "background" },
    generated: { ...shader, input: "none", target: "background" },
  };
  const add = (
    element: Element,
    id: string,
    resource = "css",
    placement: "background" | "content" | "overlay" = "content",
  ) => {
    const instance = {
      ...newEffectInstance(
        resource,
        slide.effectResources![resource],
        placement,
      ),
      id,
    };
    (element.effects ??= []).push(instance);
    return instance;
  };
  const compile = () => compileCompositionPlan(slide, document.deck);
  return { ...document, slide, add, compile };
}
function describe(operation: Composition): unknown {
  switch (operation.kind) {
    case "sequence":
      return operation.items.map(describe);
    case "clip":
      return { clip: describe(operation.input) };
    case "effect":
      return {
        effect: operation.effect.id,
        input: operation.input ? describe(operation.input) : undefined,
      };
    default:
      return operation.kind;
  }
}
const ref = (elementId: string, effectId: string): EffectRef => ({
  elementId,
  effectId,
});

it("v1 content filtering includes children, overlay and stroke while text evaluation stays upstream", () => {
  const owner = shape("owner");
  owner.appearance.strokeWidth = 2;
  const f = fixture([owner]);
  f.add(owner, "overlay", "css", "overlay");
  f.add(owner, "filter", "shader");
  f.add(owner, "text", "js");
  f.add(owner, "css-after");
  f.add(owner, "background", "generated", "background");
  expect(describe(f.compile().groups.get(owner.id)!.visual)).toEqual({
    effect: "css-after",
    input: {
      effect: "filter",
      input: [
        {
          clip: [
            "fill",
            { effect: "background", input: undefined },
            { effect: "text", input: ["source", "children"] },
            { effect: "overlay", input: undefined },
          ],
        },
        "stroke",
      ],
    },
  });
});

it("CSS before a content shader wraps local content without hoisting its filter across the fill", () => {
  const owner = shape("owner");
  const f = fixture([owner]);
  f.add(owner, "css-before");
  f.add(owner, "filter", "shader");
  const plan = f.compile();
  expect(describe(plan.groups.get(owner.id)!.visual)).toEqual({
    effect: "filter",
    input: [
      {
        clip: ["fill", { effect: "css-before", input: ["source", "children"] }],
      },
    ],
  });
  expect(plan.dependencies(ref("owner", "filter"))).toEqual([
    ref("owner", "css-before"),
  ]);
});

it("background lenses retain element-entry inputs despite saved overlay placement", () => {
  const lower = shape("lower"),
    lens = shape("lens");
  const f = fixture([lower, lens]);
  f.add(lower, "generator", "generated", "background");
  f.add(lens, "own-background", "generated", "background");
  const instance = f.add(lens, "lens", "backdrop");
  instance.placement = "overlay";
  const plan = f.compile();
  expect(plan.groups.get("lens")!.inputs.get("lens")).toEqual({
    kind: "backdrop",
    elementId: "lens",
    backdrop: { kind: "element-entry", elementId: "lens" },
  });
  expect(plan.dependencies(ref("lens", "lens"))).toEqual([
    ref("lower", "generator"),
  ]);
  expect(plan.groups.get("lens")!.visual.kind).toBe("sequence");
});

it("CSS backdrop dependencies name their effect-entry paint point and completed ancestor paint", () => {
  const lower = shape("lower"),
    parent = shape("parent"),
    card = shape("card");
  parent.children = [card];
  const f = fixture([lower, parent]);
  f.slide.effectResources!.css.source =
    ":scope { backdrop-filter: blur(10px); }";
  f.add(lower, "lower-bg", "generated", "background");
  f.add(parent, "parent-bg", "generated", "background");
  f.add(parent, "unfinished", "shader");
  f.add(card, "card-bg", "generated", "background");
  f.add(card, "material", "css");
  const plan = f.compile();
  expect(plan.groups.get("card")!.inputs.get("material")).toMatchObject({
    kind: "styled",
    backdrop: { kind: "effect-entry", elementId: "card", effectId: "material" },
  });
  expect(plan.dependencies(ref("card", "material"))).toEqual([
    ref("lower", "lower-bg"),
    ref("parent", "parent-bg"),
    ref("card", "card-bg"),
  ]);
  expect(plan.dependencies(ref("parent", "unfinished"))).toContainEqual(
    ref("card", "material"),
  );
});

it("effect-entry surfaces retain exact paint identity inside one Element", () => {
  const owner = shape("owner");
  const f = fixture([owner]);
  f.slide.effectResources!.css.source =
    ":scope { backdrop-filter: blur(10px); }";
  f.add(owner, "generated", "generated", "background");
  f.add(owner, "glass-a", "css", "background");
  f.add(owner, "glass-b", "css", "background");

  const plan = f.compile();
  const pointA = {
    kind: "effect-entry" as const,
    elementId: "owner",
    effectId: "glass-a",
  };
  const pointB = {
    kind: "effect-entry" as const,
    elementId: "owner",
    effectId: "glass-b",
  };
  const surfaceA = plan.surface(pointA)!;
  const surfaceB = plan.surface(pointB)!;

  expect(plan.dependencies(ref("owner", "glass-a"))).toEqual([
    ref("owner", "generated"),
  ]);
  expect(plan.dependencies(ref("owner", "glass-b"))).toEqual([
    ref("owner", "generated"),
    ref("owner", "glass-a"),
  ]);
  expect(surfaceA.paintEffects).toEqual([ref("owner", "generated")]);
  expect(surfaceB.paintEffects).toEqual([
    ref("owner", "generated"),
    ref("owner", "glass-a"),
  ]);
  expect(surfaceA.id).not.toBe(surfaceB.id);
  expect(plan.surface(pointA)).toBe(surfaceA);
});

it("local CSS without a backdrop read does not depend on unrelated earlier paint", () => {
  const lower = shape("lower"),
    owner = shape("owner");
  const f = fixture([lower, owner]);
  f.slide.effectResources!.css.source = ":scope { color: red; }";
  f.add(lower, "generated", "generated", "background");
  f.add(owner, "style");
  expect(f.compile().dependencies(ref("owner", "style"))).toEqual([]);
  f.slide.effectResources!.css.source = String.raw`:scope { \62 ackdrop-filter: blur(5px); }`;
  expect(f.compile().dependencies(ref("owner", "style"))).toEqual([
    ref("lower", "generated"),
  ]);
  f.slide.effectResources!.css.source = ":scope { color: red; }";
  f.deck.stylesheet = "[data-effect-id] { backdrop-filter: blur(5px); }";
  expect(f.compile().dependencies(ref("owner", "style"))).toEqual([
    ref("lower", "generated"),
  ]);
});

it("nested prefixes include earlier siblings and unfinished ancestors without later paint or document mutation", () => {
  const lower = shape("lower"),
    outer = shape("outer"),
    first = shape("first"),
    inner = shape("inner"),
    lens = shape("lens"),
    later = shape("later");
  outer.children = [first, inner, later];
  inner.children = [lens];
  const f = fixture([lower, outer, shape("top")]);
  f.add(lower, "lower-fx", "generated", "background");
  f.add(first, "first-fx");
  f.add(outer, "outer-fx", "shader");
  f.add(inner, "inner-fx", "shader");
  f.add(lens, "lens-fx", "backdrop");
  const before = JSON.stringify(f.slide),
    plan = f.compile();
  const prefix = prefixElements(plan, "lens");
  expect(prefix.elements.map((e) => e.id)).toEqual(["lower", "outer"]);
  expect(prefix.elements[1].children.map((e) => e.id)).toEqual([
    "first",
    "inner",
  ]);
  expect(prefix.elements[1].children[1].children).toEqual([]);
  expect([...prefix.partial]).toEqual(["outer", "inner"]);
  expect(plan.dependencies(ref("lens", "lens-fx"))).toEqual([
    ref("lower", "lower-fx"),
    ref("first", "first-fx"),
  ]);
  expect(JSON.stringify(f.slide)).toBe(before);
});

it("outer content effects consume child results without introducing a dependency on their own completed group", () => {
  const parent = shape("parent"),
    first = shape("first"),
    lens = shape("lens");
  parent.children = [first, lens];
  const f = fixture([parent]);
  f.add(parent, "filter", "shader");
  f.add(first, "first", "generated", "background");
  f.add(lens, "lens", "backdrop");
  const plan = f.compile();
  expect(plan.dependencies(ref("parent", "filter"))).toEqual([
    ref("first", "first"), ref("lens", "lens"),
  ]);
  expect(plan.dependencies(ref("lens", "lens"))).toEqual([ref("first", "first")]);
  expect(plan.dependencies(ref("first", "first"))).toEqual([]);
});

it("editing bypasses only the edited element's content pipeline and keeps descendant effects", () => {
  const parent = shape("parent"),
    child = shape("child");
  parent.children = [child];
  const f = fixture([parent]);
  f.add(parent, "filter", "shader");
  f.add(parent, "text", "js");
  f.add(parent, "background", "generated", "background");
  f.add(child, "child");
  const plan = compileCompositionPlan(f.slide, f.deck, "parent");
  expect([...plan.groups.get("parent")!.inputs.keys()]).toEqual(["background"]);
  expect([...plan.groups.get("child")!.inputs.keys()]).toEqual(["child"]);
});

it("hidden layers, disabled and missing effects never contribute to a visible prefix", () => {
  const first = shape("first"),
    second = shape("second");
  const f = fixture([first, second]);
  f.add(first, "disabled").enabled = false;
  f.add(first, "missing").resourceId = "missing";
  f.add(second, "lens", "backdrop");
  expect(f.compile().dependencies(ref("second", "lens"))).toEqual([]);
  f.deck.layers.find((layer) => layer.id === f.slide.nodes[0].id)!.hidden =
    true;
  const plan = f.compile();
  expect(plan.roots).toEqual([]);
  expect(() => prefixElements(plan, "second")).toThrow(
    "not in the visible scene",
  );
});

it("effect identities remain scoped to their owning element across duplicated instances", () => {
  const first = shape("first"),
    second = shape("second"),
    third = shape("third");
  const f = fixture([first, second, third]);
  f.add(first, "same");
  f.add(second, "same");
  f.add(third, "lens", "backdrop");
  expect(f.compile().dependencies(ref("third", "lens"))).toEqual([
    ref("first", "same"),
    ref("second", "same"),
  ]);
});

it("prefix indexing retains linear structural state instead of copying each preceding subtree", () => {
  const children = Array.from({ length: 1000 }, (_, i) => shape("e" + i));
  const f = fixture(children),
    plan = f.compile();
  const seen = new Set(),
    visit = (prefix: ReturnType<typeof plan.prefixes.get>) => {
      if (!prefix || seen.has(prefix)) return;
      seen.add(prefix);
      expect(prefix.earlier.length).toBeLessThanOrEqual(1);
      visit(prefix.parent);
    };
  for (const prefix of plan.prefixes.values()) visit(prefix);
  expect(seen.size).toBe(1000);
  expect(prefixElements(plan, "e999").elements).toHaveLength(999);
});

it("group alpha and media transforms remain distinct from effect scope and are not propagated to children", () => {
  const parent = shape("parent"),
    child = shape("child");
  parent.children = [child];
  parent.appearance.opacity = 0.4;
  child.appearance.opacity = 0.6;
  parent.frame.rotation = 17;
  const resources: Record<string, EffectDefinition> = {};
  const group = compileVisualGroup(parent, resources);
  expect(group.opacity).toBe(0.4);
  expect(group.children[0].opacity).toBe(0.6);
  expect(group.transport).toBe(parent.frame);
  expect(group.children[0].element).toBe(child);
});
