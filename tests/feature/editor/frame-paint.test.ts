import { expect, it } from "vitest";
import { createEmptyFrame } from "../../../src/core/elementFactory";
import { newPresentationDocument } from "../../../src/core/document";
import { localMatrix } from "../../../src/core/element";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";
import {
  framePaintProjection,
  framePaintStyle,
  supportsPixelFramePaint,
} from "../../../src/components/framePaint";

function rectangle(x: number, width = 130) {
  const element = createEmptyFrame("frame", { x, y: 80 });
  Object.assign(element.frame, { width, height: 80 });
  Object.assign(element.appearance, { fill: "#336699", opacity: 0.5 });
  return element;
}

it("paint rounding gives adjacent translucent rectangles one shared device edge without changing document geometry", () => {
  const left = rectangle(80),
    right = rectangle(210);
  const original = JSON.stringify([left, right]);
  for (const scale of [0.25, 0.33, 0.67, 1.25])
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const view = { x: 193.375, y: 78.625, scale };
      const projection = framePaintProjection(view, dpr);
      const a = framePaintStyle(left, projection),
        b = framePaintStyle(right, projection);
      expect(Number(a.left) + Number(a.width)).toBe(b.left);
      expect(Number(a.width)).toBeGreaterThan(0);
      expect(
        Math.abs(
          Number(a.left) -
            (left.frame.x * projection.factor + projection.offsetX),
        ),
      ).toBeLessThanOrEqual(0.5);
    }
  expect(JSON.stringify([left, right])).toBe(original);
});

it("subpixel and rotated boxes keep their affine logical geometry", () => {
  const thin = rectangle(10, 0.2),
    rotated = rectangle(20);
  rotated.frame.rotation = 17;
  const projection = framePaintProjection(
    { x: 14.125, y: 20.375, scale: 0.25 },
    1.5,
  );
  expect(framePaintStyle(thin, projection).width).toBe(0.2);
  expect(framePaintStyle(rotated, projection).width).toBe(130);
  const m = localMatrix(rotated.frame),
    f = projection.factor;
  expect(framePaintStyle(rotated, projection).transform).toBe(
    `matrix(${m[0] * f},${m[1] * f},${m[2] * f},${m[3] * f},${m[4] * f + projection.offsetX},${m[5] * f + projection.offsetY})`,
  );
});

it("mirrored axis-aligned fills snap their visual extents without altering signed document scales", () => {
  const element = rectangle(10);
  element.frame.flipX = true;
  element.frame.scaleY = 2;
  const original = structuredClone(element.frame);
  const paint = framePaintStyle(
    element,
    framePaintProjection({ x: 0, y: 0, scale: 0.25 }, 2),
  );
  expect(paint).toMatchObject({
    left: 5,
    width: 65,
    height: 80,
    transform: "none",
  });
  expect(element.frame).toEqual(original);
});

it("motion and user CSS or effects retain the established rendering path", () => {
  const model = newPresentationDocument("Eligibility"),
    slide = model.slides[model.deck.slideIds[0]];
  slide.nodes[0].children = [rectangle(10)];
  expect(supportsPixelFramePaint(slide, model.deck)).toBe(true);
  expect(
    supportsPixelFramePaint(slide, {
      ...model.deck,
      stylesheet: ".custom { color:red }",
    }),
  ).toBe(false);
  const custom = structuredClone(slide);
  custom.nodes[0].children[0].cssClasses = ["custom"];
  expect(supportsPixelFramePaint(custom, model.deck)).toBe(false);
  const effected = structuredClone(slide);
  effected.nodes[0].children[0].effects = [
    newEffectInstance("shader", blankEffect("shader"), "background"),
  ];
  expect(supportsPixelFramePaint(effected, model.deck)).toBe(false);
  const moving = {
    ...slide,
    motion: { stages: [{ id: "stage", tracks: [] }] },
  };
  expect(supportsPixelFramePaint(moving, model.deck)).toBe(false);
});
