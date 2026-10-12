import { expect, it } from "vitest";
import {
  affineSamplingDensity,
  liveRenderProfile,
  pdfRenderProfile,
  renderDensity,
  shaderSamplingSize,
  shaderScaleEnvelopes,
} from "../../../src/core/renderProfile";
import { newPresentationDocument } from "../../../src/core/document";
import {
  createBasicShape,
  createContainerElement,
} from "../../../src/core/elementFactory";

const deck = { width: 1920, height: 1080 };
const capabilities = { width: 16384, height: 16384 };
const identity = { a: 1, b: 0, c: 0, d: 1 };

it("live profiles follow view scale and density without altering logical geometry", () => {
  expect(liveRenderProfile(deck, 1, 1)).toEqual({
    width: 1920,
    height: 1080,
    mode: "live",
  });
  const highDensity = liveRenderProfile(deck, 1, 2)!;
  expect(highDensity).toEqual(liveRenderProfile(deck, 2, 1));
  expect(renderDensity(deck, highDensity)).toEqual({
    x: 2,
    y: 2,
    mode: "live",
  });
  expect(liveRenderProfile(deck, { x: 0.5, y: 0.25 }, 2)).toMatchObject({
    width: 1920,
    height: 540,
  });
  expect(deck).toEqual({ width: 1920, height: 1080 });
  expect(liveRenderProfile(deck, 0, 2)).toBeNull();
  expect(liveRenderProfile(deck, Infinity, 1)).toBeNull();
});

it("shader sampling retains 4K and 8K detail when hardware supports it", () => {
  expect(shaderSamplingSize(deck, 2, capabilities)).toMatchObject({
    width: 3840,
    height: 2160,
    reduced: false,
  });
  expect(shaderSamplingSize(deck, 4, capabilities)).toMatchObject({
    width: 7680,
    height: 4320,
    reduced: false,
  });
  expect(
    shaderSamplingSize({ width: 600, height: 400 }, 0.5, capabilities),
  ).toMatchObject({ width: 300, height: 200 });
});

it("actual asymmetric hardware limits uniformly reduce the sampling rectangle", () => {
  expect(shaderSamplingSize(deck, 4, { width: 8192, height: 2160 })).toEqual({
    requestedWidth: 7680,
    requestedHeight: 4320,
    width: 3840,
    height: 2160,
    reduced: true,
  });
  expect(
    shaderSamplingSize(deck, 4, { width: 3840, height: 8192 }),
  ).toMatchObject({ width: 3840, height: 2160, reduced: true });
  expect(() => shaderSamplingSize(deck, 0, capabilities)).toThrow();
  expect(() =>
    shaderSamplingSize(deck, 1, { width: NaN, height: 8192 }),
  ).toThrow();
});

it("sampling follows nested affine stretch without rotation bounding-box inflation", () => {
  const density = { x: 2, y: 2, mode: "live" as const };
  expect(affineSamplingDensity(density, identity)).toBe(2);
  const angle = Math.PI / 4;
  const rotation = {
    a: Math.cos(angle),
    b: Math.sin(angle),
    c: -Math.sin(angle),
    d: Math.cos(angle),
  };
  expect(affineSamplingDensity(density, rotation)).toBeCloseTo(2);
  expect(
    shaderSamplingSize(
      deck,
      affineSamplingDensity(density, rotation),
      capabilities,
    ),
  ).toMatchObject({ width: 3840, height: 2160 });
  expect(affineSamplingDensity(density, { a: 3, b: 0, c: 0, d: 1 })).toBe(6);
  expect(
    affineSamplingDensity(density, { a: 1, b: 0, c: 1, d: 1 }),
  ).toBeGreaterThan(2);
  expect(
    affineSamplingDensity({ ...density, x: 1, y: 2 }, rotation),
  ).toBeCloseTo(2);
});

it("PDF shader detail is explicit physical-page sampling independent of display DPR", () => {
  const profile = pdfRenderProfile(deck);
  expect(profile).toEqual({ width: 4000, height: 2250, mode: "export" });
  const density = affineSamplingDensity(renderDensity(deck, profile), identity);
  expect(shaderSamplingSize(deck, density, capabilities)).toMatchObject({
    width: 4000,
    height: 2250,
  });
  expect(pdfRenderProfile({ width: 1080, height: 1920 })).toMatchObject({
    width: 1265.625,
    height: 2250,
  });
});

it("playing-stage scale envelopes reserve nested Motion detail including easing overshoot", () => {
  const model = newPresentationDocument("Envelope");
  const slide = model.slides[model.deck.slideIds[0]];
  const child = createBasicShape("child", "rectangle");
  child.frame.scaleX = 2;
  const parent = createContainerElement("parent", [child]);
  slide.nodes[0].children = [parent];
  slide.motion = {
    stages: [
      {
        id: "grow",
        tracks: [
          {
            id: "scale",
            elementId: "parent",
            property: "transform.scaleX",
            keyframes: [
              {
                id: "one",
                at: 0,
                value: { type: "absolute", value: 1 },
                easeToNext: [0.3, 0, 0.7, 1.5],
              },
              { id: "two", at: 1000, value: { type: "absolute", value: 2 } },
            ],
          },
        ],
      },
    ],
  };
  const envelopes = shaderScaleEnvelopes(slide, 0);
  expect(envelopes.get("parent")).toBe(2.5);
  expect(envelopes.get("child")).toBe(5);
});
