import { resolveVisualSlide } from "../../../src/core/templates";
import { createContainerElement } from "../../../src/core/elementFactory";
import { createBasicShape } from "../../../src/core/elementFactory";
import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createMediaElement } from "../../../src/core/media";
import {
  canvasImagePixels,
  maximumElementScale,
  planPresentationImages,
} from "../../../src/core/presentationImages";

function imageSlide() {
  const document = newPresentationDocument("Image sampling");
  const slide = document.slides[document.deck.slideIds[0]];
  const element = createMediaElement("image", {
    version: 1,
    id: "a".repeat(64),
    filename: "image.png",
    names: ["image.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: 1,
    width: 4096,
    height: 4096,
    createdAt: "2026-10-10T00:00:00Z",
  });
  element.frame.width = 600;
  element.frame.height = 600;
  slide.nodes[0].children = [element];
  return { deck: document.deck, slide, element };
}

it("canvas tiers ceil each dimension and preserve exact tier boundaries", () => {
  expect(canvasImagePixels(1)).toBe(256);
  expect(canvasImagePixels(255.1)).toBe(256);
  expect(canvasImagePixels(256)).toBe(256);
  expect(canvasImagePixels(256.01)).toBe(512);
  expect(canvasImagePixels(768)).toBe(768);
});

it("small canvas resizes reuse a tier while presentation retains exact requirements", () => {
  const { deck, slide, element } = imageSlide();
  const output = { width: deck.width, height: deck.height };
  const canvas = { ...output, sampling: "canvas" as const };
  expect(planPresentationImages(deck, [slide], canvas)[0]).toMatchObject({
    width: 768,
    height: 768,
  });
  expect(planPresentationImages(deck, [slide], output)[0]).toMatchObject({
    width: 600,
    height: 600,
  });
  element.frame.width = element.frame.height = 650;
  expect(planPresentationImages(deck, [slide], canvas)[0]).toMatchObject({
    width: 768,
    height: 768,
  });
  expect(planPresentationImages(deck, [slide], output)[0]).toMatchObject({
    width: 650,
    height: 650,
  });
  element.frame.width = element.frame.height = 769;
  expect(planPresentationImages(deck, [slide], canvas)[0]).toMatchObject({
    width: 1024,
    height: 1024,
  });
});

it("exact presentation sampling follows the output display resolution", () => {
  const { deck, slide } = imageSlide();
  expect(
    planPresentationImages(deck, [slide], { width: 1920, height: 1080 })[0],
  ).toMatchObject({ width: 600, height: 600 });
  expect(
    planPresentationImages(deck, [slide], { width: 3840, height: 2160 })[0],
  ).toMatchObject({ width: 1200, height: 1200 });
});

it("scale planning visits tracks once for all elements and preserves easing overshoot", () => {
  const { deck, slide, element } = imageSlide();
  let visits = 0;
  const tracks = Array.from({ length: 100 }, (_, i) => ({
    id: "track" + i,
    elementId: i === 0 ? element.id : "shape" + i,
    property: "transform.scaleX" as const,
    initial: { type: "absolute" as const, value: 1 },
    keyframes: [
      {
        id: "key0",
        at: 0,
        value: { type: "absolute" as const, value: 1 },
        easeToNext: [0.2, 3, 0.8, 3] as [number, number, number, number],
      },
      { id: "key1", at: 1000, value: { type: "absolute" as const, value: 2 } },
    ],
  }));
  slide.motion = {
    stages: [
      {
        id: "stage",
        get tracks() {
          visits++;
          return tracks;
        },
      },
    ],
  };
  slide.nodes[0].children.push(
    ...Array.from({ length: 100 }, (_, i) =>
      createBasicShape("shape" + i, "rectangle"),
    ),
  );
  expect(
    planPresentationImages(deck, [slide], {
      width: deck.width,
      height: deck.height,
    })[0],
  ).toMatchObject({ width: 2400, height: 600 });
  expect(visits).toBe(1);
});

function scaleTrack(
  elementId: string,
  property: "transform.scaleX" | "transform.scaleY",
  value: number,
) {
  return {
    id: property,
    elementId,
    property,
    initial: { type: "absolute" as const, value },
    keyframes: [
      { id: "key", at: 0, value: { type: "absolute" as const, value } },
    ],
  };
}

it("horizontal Motion demand leaves vertical sampling exact", () => {
  const { deck, slide, element } = imageSlide();
  slide.motion = {
    stages: [
      { id: "stage", tracks: [scaleTrack(element.id, "transform.scaleX", 2)] },
    ],
  };
  expect(planPresentationImages(deck, [slide], deck)[0]).toMatchObject({
    width: 1200,
    height: 600,
  });
});

it("vertical Motion demand leaves horizontal sampling exact", () => {
  const { deck, slide, element } = imageSlide();
  slide.motion = {
    stages: [
      { id: "stage", tracks: [scaleTrack(element.id, "transform.scaleY", 2)] },
    ],
  };
  expect(planPresentationImages(deck, [slide], deck)[0]).toMatchObject({
    width: 600,
    height: 1200,
  });
});

it("nested Frames compose authored and Motion magnitudes independently", () => {
  const { deck, slide, element } = imageSlide();
  const parent = createContainerElement("parent", []);
  const outer = createContainerElement("outer", []);
  parent.frame.scaleX = -2;
  parent.frame.scaleY = 3;
  outer.frame.scaleX = 1;
  outer.frame.scaleY = -2;
  parent.children = [element];
  outer.children = [parent];
  slide.nodes[0].children = [outer];
  slide.motion = {
    stages: [
      { id: "stage", tracks: [scaleTrack(element.id, "transform.scaleX", -3)] },
    ],
  };
  expect(planPresentationImages(deck, [slide], deck)[0]).toMatchObject({
    width: 3600,
    height: 3600,
  });
});

it("stage envelopes retain entering axis values and later stages remain separate", () => {
  const { slide, element } = imageSlide();
  slide.motion = {
    stages: [
      { id: "first", tracks: [scaleTrack(element.id, "transform.scaleX", -2)] },
      { id: "second", tracks: [scaleTrack(element.id, "transform.scaleY", 3)] },
      { id: "third", tracks: [scaleTrack(element.id, "transform.scaleX", 4)] },
    ],
  };
  expect(maximumElementScale(slide, element, 1)).toEqual({ x: 2, y: 3 });
  expect(maximumElementScale(slide, element)).toEqual({ x: 4, y: 3 });
});

it("rotated branches conservatively include cross-axis stretch", () => {
  const { deck, slide, element } = imageSlide();
  const parent = createBasicShape("parent", "rectangle");
  parent.frame.scaleX = 2;
  parent.frame.rotation = 90;
  element.frame.scaleY = 3;
  parent.children = [element];
  slide.nodes[0].children = [parent];
  expect(planPresentationImages(deck, [slide], deck)[0]).toMatchObject({
    width: 1200,
    height: 3600,
  });
});

it("Motion rotation retains cross-axis safety while pure scaling stays exact", () => {
  const { deck, slide, element } = imageSlide();
  element.frame.scaleX = 2;
  slide.motion = {
    stages: [
      {
        id: "stage",
        tracks: [
          {
            ...scaleTrack(element.id, "transform.scaleX", 90),
            property: "transform.rotation",
          },
        ],
      },
    ],
  };
  expect(planPresentationImages(deck, [slide], deck)[0]).toMatchObject({
    width: 1200,
    height: 1200,
  });
});

it("template-resolved images preserve inherited asymmetric geometry and slide Motion", () => {
  const { deck, slide, element } = imageSlide();
  const parent = createContainerElement("template-frame", [element]);
  parent.frame.scaleX = 2;
  const templateId = "template";
  const template = {
    ...slide,
    id: templateId,
    nodes: slide.nodes.map((root) => ({ ...root, children: [parent] })),
  };
  slide.nodes = slide.nodes.map((root) => ({ ...root, children: [] }));
  deck.slideMeta[slide.id].templateId = templateId;
  slide.motion = {
    stages: [
      { id: "stage", tracks: [scaleTrack(element.id, "transform.scaleY", 3)] },
    ],
  };
  const resolved = resolveVisualSlide(deck, slide, {
    [templateId]: template,
  }).slide;
  expect(planPresentationImages(deck, [resolved], deck)[0]).toMatchObject({
    width: 1200,
    height: 1800,
  });
});
