import { createDomRasterSource } from "../../src/components/domRaster";
import type { Deck } from "../../src/core/document";
import type { Element } from "../../src/core/element";
import {
  configureNativeTextNode,
  nativeTextPixelKey,
  type GpuNativeRasterDiagnostics,
  type GpuNativeRasterResult,
  type GpuNativeRasterSource,
  type GpuNativeRasterSourceFactory,
} from "../../src/experiments/gpu-renderer/nativeRaster";

/**
 * Chromium implementation of the experiment's native-raster boundary. It lives
 * with the experiment harness so production renderer architecture remains
 * untouched and the GPU compositor only depends on the raster-source contract.
 */
class ChromiumNativeTextRasterSource implements GpuNativeRasterSource {
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
    this.key = nextKey;
    this.logicalWidth = element.frame.width;
    this.logicalHeight = element.frame.height;
    this.elementNode.className = element.cssClasses?.join(" ") ?? "";
    this.elementNode.style.width = `${this.logicalWidth}px`;
    this.elementNode.style.height = `${this.logicalHeight}px`;
    this.style.textContent = deck.stylesheet?.trim()
      ? `@scope (.slide-renderer) { ${deck.stylesheet} }`
      : "";
    configureNativeTextNode(this.textNode, element, deck);
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

export const createChromiumNativeTextRasterSource: GpuNativeRasterSourceFactory = (
  element,
  deck,
  onInvalidate,
) => new ChromiumNativeTextRasterSource(element, deck, onInvalidate);
