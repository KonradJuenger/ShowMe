import type { Deck } from "../../core/document";
import type { Element } from "../../core/element";
import { resolveTextTypography } from "../../core/textTypography";

export type GpuNativeRasterResult = {
  canvas: HTMLCanvasElement;
  revision: number;
  rasterized: boolean;
};

export type GpuNativeRasterDiagnostics = {
  rasterizations: number;
  cacheHits: number;
  invalidations: number;
  live: boolean;
  revision: number;
  logicalWidth: number;
  logicalHeight: number;
};

export interface GpuNativeRasterSource {
  sync(element: Element, deck: Deck): boolean;
  rasterize(scale?: number): Promise<GpuNativeRasterResult>;
  diagnostics(): GpuNativeRasterDiagnostics;
  dispose(): void;
}

export type GpuNativeRasterSourceFactory = (
  element: Element,
  deck: Deck,
  onInvalidate?: () => void,
) => GpuNativeRasterSource;

function textContent(element: Element) {
  if (element.content?.type !== "text")
    throw new Error("GPU native raster source requires text content");
  return element.content;
}

/**
 * Pixel identity deliberately excludes x/y, rotation, scale, flips, parent
 * transforms and group opacity. Those values belong to GPU composition.
 */
export function nativeTextPixelKey(element: Element, deck: Deck) {
  const content = textContent(element);
  return JSON.stringify({
    text: content.text,
    placeholder: content.placeholder,
    autoSize: content.autoSize,
    typography: resolveTextTypography(deck, content),
    width: element.frame.width,
    height: element.frame.height,
    cssClasses: element.cssClasses ?? [],
    stylesheet: deck.stylesheet ?? "",
  });
}

/** Configure the Chromium source DOM with the same native typography/layout as TextView. */
export function configureNativeTextNode(
  node: HTMLElement,
  element: Element,
  deck: Deck,
) {
  const content = textContent(element);
  const typography = resolveTextTypography(deck, content);
  const justifyContent =
    typography.verticalAlign === "middle"
      ? "center"
      : typography.verticalAlign === "bottom"
        ? "flex-end"
        : "flex-start";
  Object.assign(node.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent,
    fontFamily: typography.fontFamily,
    fontWeight: String(
      typography.bold ? Math.max(700, typography.fontWeight) : typography.fontWeight,
    ),
    fontStyle: typography.italic ? "italic" : "normal",
    fontSize: `${typography.fontSize}px`,
    color: typography.color,
    textAlign: typography.align,
    lineHeight: String(typography.lineHeight),
    letterSpacing: `${typography.letterSpacing}px`,
    whiteSpace: content.autoSize === "both" ? "pre" : "pre-wrap",
    overflowWrap: content.autoSize === "both" ? "normal" : "anywhere",
  });
  node.textContent = content.text;
  node.dataset.textPlaceholder = content.placeholder ? "true" : "false";
}
