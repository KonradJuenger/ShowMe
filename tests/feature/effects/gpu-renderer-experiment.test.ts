import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createBasicShape, createContainerElement } from "../../../src/core/elementFactory";
import { createTextElement } from "../../../src/core/text";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";
import {
  compileGpuRenderGraph,
  walkGpuOperation,
  type GpuRenderOperation,
} from "../../../src/experiments/gpu-renderer/graph";
import { nativeTextPixelKey } from "../../../src/experiments/gpu-renderer/nativeRaster";

function fixture() {
  const document = newPresentationDocument("GPU graph");
  const slide = document.slides[document.deck.slideIds[0]];
  const generated = {
    ...blankEffect("shader"),
    name: "Generated",
    target: "background" as const,
    input: "none" as const,
  };
  const backdrop = {
    ...blankEffect("shader"),
    name: "Backdrop",
    target: "background" as const,
    input: "backdrop" as const,
  };
  slide.effectResources = { generated, backdrop };

  const background = createBasicShape("background", "rectangle", { x: 0, y: 0 });
  background.frame.width = document.deck.width;
  background.frame.height = document.deck.height;
  background.appearance.fill = null;
  background.effects = [newEffectInstance("generated", generated, "background")];

  const text = createTextElement("text", { x: 80, y: 60 });
  const child = createBasicShape("child", "rectangle", { x: -30, y: 20 });
  child.frame.width = 160;
  child.frame.height = 80;
  const group = createContainerElement("group", [child], { x: 180, y: 140 });
  group.frame.width = 120;
  group.frame.height = 90;
  group.clipChildren = true;
  group.appearance.opacity = 0.45;

  const glass = createBasicShape("glass", "rectangle", { x: 120, y: 100 });
  glass.frame.width = 260;
  glass.frame.height = 180;
  glass.appearance.fill = null;
  glass.effects = [newEffectInstance("backdrop", backdrop, "background")];

  slide.nodes[0].children = [background, text, group, glass];
  return { document, slide, text };
}

it("derives a general GPU graph from the existing composition plan", () => {
  const { document, slide } = fixture();
  const graph = compileGpuRenderGraph(slide, document.deck);
  expect(graph.roots).toEqual(["background", "text", "group", "glass"]);
  expect(graph.groups.get("group")).toMatchObject({
    opacity: 0.45,
    clipChildren: true,
    children: ["child"],
  });
  const kinds: string[] = [];
  walkGpuOperation(graph.groups.get("group")!.visual, (operation) => kinds.push(operation.kind));
  expect(kinds).toContain("children");
  expect(kinds).toContain("clip");

  let backdrop: Extract<GpuRenderOperation, { kind: "effect" }> | undefined;
  walkGpuOperation(graph.groups.get("glass")!.visual, (operation) => {
    if (operation.kind === "effect") backdrop = operation;
  });
  expect(backdrop).toMatchObject({
    inputKind: "backdrop",
    backdrop: { kind: "element-entry", elementId: "glass" },
  });
  expect(graph.plan.dependencies({ elementId: "glass", effectId: glassEffectId(slide) })).toEqual([
    { elementId: "background", effectId: backgroundEffectId(slide) },
  ]);
});

function backgroundEffectId(slide: ReturnType<typeof fixture>["slide"]) {
  return slide.nodes[0].children[0].effects![0].id;
}
function glassEffectId(slide: ReturnType<typeof fixture>["slide"]) {
  return slide.nodes[0].children[3].effects![0].id;
}

it("keeps transform-only text changes out of native pixel identity", () => {
  const { document, text } = fixture();
  const original = nativeTextPixelKey(text, document.deck);
  const moved = structuredClone(text);
  moved.frame.x += 100;
  moved.frame.y -= 30;
  moved.frame.rotation = 27;
  moved.frame.scaleX = 1.4;
  moved.frame.scaleY = 0.7;
  moved.appearance.opacity = 0.25;
  expect(nativeTextPixelKey(moved, document.deck)).toBe(original);

  const edited = structuredClone(text);
  if (edited.content?.type !== "text") throw new Error("fixture text missing");
  edited.content.text = "different pixels";
  expect(nativeTextPixelKey(edited, document.deck)).not.toBe(original);

  const resized = structuredClone(text);
  resized.frame.width += 1;
  expect(nativeTextPixelKey(resized, document.deck)).not.toBe(original);

  const styledDeck = structuredClone(document.deck);
  styledDeck.stylesheet = "[data-text-content] { text-shadow: 1px 1px red; }";
  expect(nativeTextPixelKey(text, styledDeck)).not.toBe(original);
});


it("keeps the experiment isolated from SceneTexture and the production renderer", () => {
  const source = readFileSync(
    new URL(
      "../../../src/experiments/gpu-renderer/renderer.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).not.toContain("sceneTexture");
  expect(source).not.toContain("sceneTextureGpu");
  expect(source).not.toContain("elementRaster");
  expect(source).not.toContain("SlideRenderer");

  const nativeBoundary = readFileSync(
    new URL(
      "../../../src/experiments/gpu-renderer/nativeRaster.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(nativeBoundary).not.toContain("components/domRaster");
});
