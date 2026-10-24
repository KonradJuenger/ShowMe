import type { Deck } from "../../core/document";
import type { Element } from "../../core/element";
import { resolveTextTypography } from "../../core/textTypography";
import { createDomRasterSource } from "../../components/domRaster";

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

function setTextStyle(node: HTMLElement, element: Element, deck: Deck) {
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

/**
 * A renderer-local Chromium raster service. The hidden DOM owns only the native
 * pixels. It never receives ShowMe transport Motion or group opacity.
 */
export class GpuNativeTextRasterSource {
  private readonly host = document.createElement("div");
  private readonly style = document.createElement("style");
  private readonly elementNode = document.createElement("div");
  private readonly textNode = document.createElement("div");
  private readonly raster;
  private key = "";
  private logicalWidth = 1;
  private logicalHeight = 1;
  private rasterizations = 0;
  private cacheHits = 0;
  private invalidations = 0;
  private disposed = false;

  constructor(
    element: Element,
    deck: Deck,
    private readonly onInvalidate: () => void = () => {},
  ) {
    this.host.className = "slide-renderer gpu-renderer-native-raster";
    this.host.setAttribute("aria-hidden", "true");
    this.host.setAttribute("inert", "");
    Object.assign(this.host.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      zIndex: "-2147483648",
      pointerEvents: "none",
      contain: "layout style paint",
    });
    this.elementNode.dataset.elementId = element.id;
    this.elementNode.dataset.showmeId = `showme-${element.id}`;
    this.elementNode.dataset.showmePart = "self";
    Object.assign(this.elementNode.style, {
      position: "relative",
      left: "0",
      top: "0",
      transform: "none",
      transformOrigin: "0 0",
      opacity: "1",
    });
    this.textNode.dataset.showmePart = "content";
    this.textNode.dataset.textContent = "true";
    this.elementNode.append(this.textNode);
    this.host.append(this.style, this.elementNode);
    document.body.append(this.host);
    this.raster = createDomRasterSource(
      () => this.elementNode,
      () => true,
      () => {},
      () => {
        this.invalidations++;
        this.onInvalidate();
      },
      async () => {
        await document.fonts.ready;
      },
      () => new DOMMatrix(),
      true,
      () => this.key,
    );
    this.sync(element, deck);
  }

  sync(element: Element, deck: Deck) {
    if (this.disposed) throw new Error("Native raster source is disposed");
    const nextKey = nativeTextPixelKey(element, deck);
    if (nextKey === this.key) return false;
    const content = textContent(element);
    this.key = nextKey;
    this.logicalWidth = element.frame.width;
    this.logicalHeight = element.frame.height;
    this.elementNode.className = element.cssClasses?.join(" ") ?? "";
    this.elementNode.style.width = `${this.logicalWidth}px`;
    this.elementNode.style.height = `${this.logicalHeight}px`;
    this.style.textContent = deck.stylesheet?.trim()
      ? `@scope (.slide-renderer) { ${deck.stylesheet} }`
      : "";
    setTextStyle(this.textNode, element, deck);
    this.textNode.dataset.textPlaceholder = content.placeholder ? "true" : "false";
    this.raster.markDirty();
    return true;
  }

  async rasterize(scale = devicePixelRatio || 1): Promise<GpuNativeRasterResult> {
    if (this.disposed) throw new Error("Native raster source is disposed");
    const before = this.raster.revision;
    const width = Math.max(1, Math.round(this.logicalWidth * scale));
    const height = Math.max(1, Math.round(this.logicalHeight * scale));
    await this.raster.update(
      width,
      height,
      this.logicalWidth,
      this.logicalHeight,
    );
    const rasterized = this.raster.revision !== before;
    if (rasterized) this.rasterizations++;
    else this.cacheHits++;
    return {
      canvas: this.raster.canvas,
      revision: this.raster.revision,
      rasterized,
    };
  }

  diagnostics(): GpuNativeRasterDiagnostics {
    return {
      rasterizations: this.rasterizations,
      cacheHits: this.cacheHits,
      invalidations: this.invalidations,
      live: !this.disposed,
      revision: this.raster.revision,
      logicalWidth: this.logicalWidth,
      logicalHeight: this.logicalHeight,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.raster.dispose();
    this.host.remove();
  }
}
