import type { CanvasDimensions } from "./presentationDimensions";
import type { Slide } from "./document";
import type { Element } from "./element";
import { maximumElementScale } from "./presentationImages";

/** Disposable output pixels, never document geometry or persistence state. */
export interface SlideRenderProfile extends CanvasDimensions {
  mode: "live" | "export";
}
export interface RenderDensity {
  x: number;
  y: number;
  mode: SlideRenderProfile["mode"];
}
export type RenderScale = number | { x: number; y: number };
export const PDF_RASTER_DPI = 300;
export const EXPORT_PAGE_HEIGHT_INCHES = 7.5;

/** Reuse media's conservative Motion envelope for the currently playing stage. */
export function shaderScaleEnvelopes(slide: Slide, stageIndex: number) {
  const values = new Map<string, number>();
  const visit = (elements: readonly Element[], parent: number) => {
    for (const element of elements) {
      const maximum = maximumElementScale(slide, element, stageIndex);
      const scale = parent * Math.max(maximum.x, maximum.y);
      values.set(element.id, scale);
      visit(element.children, scale);
    }
  };
  for (const layer of slide.nodes) visit(layer.children, 1);
  return values;
}

export function liveRenderProfile(
  size: CanvasDimensions,
  scale: RenderScale,
  pixelRatio: number,
): SlideRenderProfile | null {
  const x = typeof scale === "number" ? scale : scale.x;
  const y = typeof scale === "number" ? scale : scale.y;
  const width = size.width * x * pixelRatio;
  const height = size.height * y * pixelRatio;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    return null;
  return { width, height, mode: "live" };
}

export function renderDensity(
  size: CanvasDimensions,
  profile: SlideRenderProfile | null,
): RenderDensity {
  return profile
    ? {
        x: profile.width / size.width,
        y: profile.height / size.height,
        mode: profile.mode,
      }
    : { x: 0, y: 0, mode: "live" };
}

export function pdfRenderProfile(size: CanvasDimensions): SlideRenderProfile {
  return {
    width:
      ((EXPORT_PAGE_HEIGHT_INCHES * size.width) / size.height) * PDF_RASTER_DPI,
    height: EXPORT_PAGE_HEIGHT_INCHES * PDF_RASTER_DPI,
    mode: "export",
  };
}

export interface ShaderCapabilities {
  width: number;
  height: number;
}

/** Maximum affine stretch; translation and pure rotation do not change detail. */
export function affineSamplingDensity(
  density: RenderDensity,
  matrix: { a: number; b: number; c: number; d: number },
) {
  const a = matrix.a * density.x,
    b = matrix.b * density.y;
  const c = matrix.c * density.x,
    d = matrix.d * density.y;
  const first = a * a + b * b,
    second = c * c + d * d;
  const cross = a * c + b * d;
  return Math.sqrt(
    (first + second + Math.hypot(first - second, 2 * cross)) / 2,
  );
}

export function shaderSamplingSize(
  size: CanvasDimensions,
  density: number,
  capabilities: ShaderCapabilities,
) {
  if (
    ![
      size.width,
      size.height,
      density,
      capabilities.width,
      capabilities.height,
    ].every((value) => Number.isFinite(value) && value > 0)
  )
    throw new Error("Invalid shader sampling target");
  // Remove floating-point noise from a rotation without undersampling fractional sizes.
  const pixels = (value: number) => Math.max(1, Math.ceil(value - 1e-9));
  const requestedWidth = pixels(size.width * density);
  const requestedHeight = pixels(size.height * density);
  if (![requestedWidth, requestedHeight].every(Number.isSafeInteger))
    throw new Error("Shader sampling target exceeds numeric precision");
  const factor = Math.min(
    1,
    capabilities.width / requestedWidth,
    capabilities.height / requestedHeight,
  );
  return {
    requestedWidth,
    requestedHeight,
    width: Math.max(1, Math.floor(requestedWidth * factor)),
    height: Math.max(1, Math.floor(requestedHeight * factor)),
    reduced: factor < 1,
  };
}
