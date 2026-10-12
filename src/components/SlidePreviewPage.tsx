import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { DocumentProjection } from "../core/documentProjection";
import { platform } from "../platform";
import { SlideRenderer } from "./SlideRenderer";
import { waitForSlideImages } from "./audienceImagePreparation";
import { flushEffectSurfaces } from "./effectRuntime";

declare global { interface Window { clearSlidePreview?: () => void; composeSlidePreview?: (projection: DocumentProjection, width: number, height: number) => Promise<boolean>; } }
/** Isolated native capture surface; all visual semantics belong to SlideRenderer. */
export function installSlidePreviewPage() {
  const host = document.getElementById("root")!;
  document.body.style.margin = "0";
  const root = createRoot(host);
  window.clearSlidePreview = () => flushSync(() => root.render(null));
  window.composeSlidePreview = async (projection, width, height) => {
    const profile = { width, height, mode: "live" as const };
    await platform.managedFonts?.(projection.documentId);
    flushSync(() => root.render(<div style={{ width: projection.deck.width, height: projection.deck.height, transform: `scale(${width / projection.deck.width}, ${height / projection.deck.height})`, transformOrigin: "top left" }}><SlideRenderer slide={projection.slide} deck={projection.deck} templates={projection.templates} staticVideo preparedImages renderProfile={profile} imageProfile={profile} /></div>));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      await waitForSlideImages(host, abort.signal);
      await document.fonts.ready;
      await Promise.all([...host.querySelectorAll("img")].map(image => image.decode().catch(() => {})));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return !abort.signal.aborted && await flushEffectSurfaces(host);
    } finally { clearTimeout(timer); }
  };
}
