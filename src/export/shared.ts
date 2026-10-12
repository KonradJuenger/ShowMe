import type { Deck, Slide } from "../core/document";

export interface ExportWarning {
  slideId: string;
  elementId?: string;
  code: string;
  message: string;
}

export interface ExportResult {
  warnings: ExportWarning[];
}

export function formatExportWarnings(warnings: ExportWarning[]) {
  return (
    `Export completed with ${warnings.length} compatibility warnings:\n\n` +
    warnings
      .map(
        (warning) =>
          `Slide ${warning.slideId}${warning.elementId ? ` / Object ${warning.elementId}` : ""}: ${warning.message}`,
      )
      .join("\n\n")
  );
}

export interface ExportDocument {
  deck: Deck;
  slides: Slide[];
}

export function pdfSlides(document: ExportDocument): Slide[] {
  const byId = new Map(document.slides.map((slide) => [slide.id, slide]));
  return document.deck.slideIds
    .map((id) => byId.get(id))
    .filter((slide): slide is Slide => Boolean(slide));
}
