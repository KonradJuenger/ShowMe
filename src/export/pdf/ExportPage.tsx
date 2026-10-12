import { resolveVisualSlide } from "../../core/templates";
import { useEffect, useState } from "react";
import { SlideRenderer } from "../../components/SlideRenderer";
import { walkElements } from "../../core/element";
import { platform } from "../../platform";
import { pdfSlides, type ExportDocument } from "../shared";
import { videoPoster } from "../../core/videoPoster";
import { flushEffectSurfaces } from "../../components/effectRuntime";
import {
  pdfRenderProfile,
  EXPORT_PAGE_HEIGHT_INCHES,
} from "../../core/renderProfile";

export function ExportPage() {
  const [document, setDocument] = useState<ExportDocument | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const deckId = new URLSearchParams(location.search).get("exportPdf");
      if (!deckId) throw new Error("Missing export document");
      if (!platform.documentProjection)
        throw new Error("PDF projection is unavailable");
      const first = await platform.documentProjection(deckId);
      const deck = first.deck;
      const slides = await Promise.all(
        deck.slideIds.map(async (slideId) => {
          const projection =
            slideId === first.slide.id
              ? first
              : await platform.documentProjection!(deckId, slideId);
          return resolveVisualSlide(
            deck,
            projection.slide,
            projection.templates ?? {},
          ).slide;
        }),
      );
      if (live) setDocument({ deck, slides });
    })().catch((error) => platform.exportReady?.(String(error)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!document) return;
    let live = true;
    void (async () => {
      const media = new Map<
        string,
        { id: string; video: boolean; start: number }
      >();
      const addMedia = (id: string, video: boolean, start: number) => {
        media.set(video ? `${id}:${start}` : id, { id, video, start });
      };
      pdfSlides(document).forEach((slide) => {
        const layers = new Map(
          document.deck.layers.map((layer) => [layer.id, layer]),
        );
        for (const root of slide.nodes) {
          if (layers.get(root.id)?.hidden) continue;
          for (const element of walkElements(root.children)) {
            const content = element.content;
            if (!content || content.type === "text") continue;
            addMedia(
              content.assetId,
              content.type === "video",
              content.type === "video" ? content.startTime : 0,
            );
          }
        }
      });
      await Promise.all(
        Array.from(media.values(), async (item) => {
          const preview = await platform
            .assetUrl(item.id, true)
            .catch(() => null);
          if (item.video && !preview) await videoPoster(item.id, item.start);
        }),
      );
      await platform.managedFonts?.(document.deck.id);
      await window.document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await Promise.all(
        Array.from(window.document.images).map((image) =>
          image.decode().catch(() => {}),
        ),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (live) {
        if (!(await flushEffectSurfaces(window.document.body)))
          throw new Error("Effect output is not ready for export");
        const failed = window.document.querySelector<HTMLElement>(
          "[data-effect-error]",
        );
        if (failed)
          throw new Error(
            `Effect could not render for PDF: ${failed.dataset.effectError}`,
          );
        await platform.exportReady?.(null);
      }
    })().catch((error) => platform.exportReady?.(String(error)));
    return () => {
      live = false;
    };
  }, [document]);
  if (!document) return null;
  const pageHeight = EXPORT_PAGE_HEIGHT_INCHES;
  const pageWidth = (pageHeight * document.deck.width) / document.deck.height;
  const scale = (pageHeight * 96) / document.deck.height;
  return (
    <main className="pdf-export">
      <style>{`@page { size: ${pageWidth}in ${pageHeight}in; margin: 0; } .pdf-export-page { width: ${pageWidth}in; height: ${pageHeight}in; } .pdf-export-page .slide-renderer { transform: scale(${scale}); transform-origin: top left; }`}</style>
      {pdfSlides(document).map((slide) => (
        <section className="pdf-export-page" key={slide.id}>
          <SlideRenderer
            slide={slide}
            deck={document.deck}
            staticVideo
            renderProfile={pdfRenderProfile(document.deck)}
          />
        </section>
      ))}
    </main>
  );
}
