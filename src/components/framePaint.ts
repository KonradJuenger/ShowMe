import type { Deck, Slide } from "../core/document";
import { localMatrix, walkElements, type Element } from "../core/element";

/** Display placement only. Document, hit-test and interaction coordinates stay logical. */
export interface CanvasPaintViewport {
  x: number;
  y: number;
  scale: number;
}

export interface FramePaintProjection {
  factor: number;
  offsetX: number;
  offsetY: number;
  pixelRatio: number;
}

interface FramePaintStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  transform: string;
  transformOrigin: string;
}

export function framePaintProjection(
  viewport: CanvasPaintViewport,
  pixelRatio: number,
): FramePaintProjection {
  return {
    factor: viewport.scale * pixelRatio,
    offsetX: viewport.x * pixelRatio - Math.round(viewport.x * pixelRatio),
    offsetY: viewport.y * pixelRatio - Math.round(viewport.y * pixelRatio),
    pixelRatio,
  };
}

function isPlainFill(element: Element) {
  return (
    element.geometry.type === "rect" &&
    !!element.appearance.fill &&
    element.appearance.radius === 0 &&
    element.appearance.strokeWidth === 0 &&
    !element.content &&
    element.children.length === 0 &&
    !element.effects?.some((effect) => effect.enabled) &&
    !element.cssClasses?.length
  );
}

export function supportsPixelFramePaint(slide: Slide, deck: Deck) {
  const elements = slide.nodes.flatMap((root) => root.children);
  return (
    !deck.stylesheet &&
    !slide.motion?.stages.length &&
    elements.some(isPlainFill) &&
    !walkElements(elements).some(
      (element) =>
        element.effects?.some((effect) => effect.enabled) ||
        element.cssClasses?.length,
    )
  );
}

/** Top-level paint boxes in device units; all other content keeps its logical box. */
export function framePaintStyle(
  element: Element,
  projection: FramePaintProjection,
): FramePaintStyle {
  const { frame } = element;
  const m = localMatrix(frame);
  const { factor, offsetX, offsetY } = projection;
  const x = m[4] * factor + offsetX;
  const y = m[5] * factor + offsetY;
  const axisAligned = Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12;
  const width = m[0] * frame.width * factor;
  const height = m[3] * frame.height * factor;
  // Thin boxes retain their subpixel coverage rather than disappearing or growing.
  if (
    isPlainFill(element) &&
    axisAligned &&
    Math.abs(width) >= 1 &&
    Math.abs(height) >= 1
  ) {
    const left = Math.round(Math.min(x, x + width));
    const right = Math.round(Math.max(x, x + width));
    const top = Math.round(Math.min(y, y + height));
    const bottom = Math.round(Math.max(y, y + height));
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
      transform: "none",
      transformOrigin: "0 0",
    };
  }
  // Applying the original affine map in the new paint space preserves text
  // wrapping, media rules, nested clips, rotation and signed frame scales.
  return {
    left: 0,
    top: 0,
    width: frame.width,
    height: frame.height,
    transform: `matrix(${m[0] * factor},${m[1] * factor},${m[2] * factor},${m[3] * factor},${x},${y})`,
    transformOrigin: "0 0",
  };
}
