import type { Deck, VisualPage } from "../core/document";
import { walkElements } from "../core/element";
import { collectUsedFontUsages, type FontUsage } from "../core/fonts";

export type ExportFontRequest =
  FontUsage | { family: string; allVariants: true };

export type CssFontReference = {
  family: string;
  slideId: string;
  elementId?: string;
};

const genericCssFonts = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

function fontFamiliesFromCss(source: string | undefined) {
  if (!source) return [];
  const families: string[] = [];
  for (const match of source.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
    for (const raw of match[1].split(",")) {
      const family = raw
        .replace(/!important\s*$/i, "")
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
      if (
        family &&
        !family.includes("var(") &&
        !genericCssFonts.has(family.toLowerCase())
      )
        families.push(family);
    }
  }
  return families;
}

export function cssFontReferences(
  deck: Pick<Deck, "stylesheet">,
  pages: VisualPage[],
): CssFontReference[] {
  const references: CssFontReference[] = [];
  const firstSlide = pages[0]?.id ?? "unknown";
  for (const family of fontFamiliesFromCss(deck.stylesheet))
    references.push({ family, slideId: firstSlide });
  for (const slide of pages) {
    const resources = slide.effectResources ?? {};
    for (const element of walkElements(
      slide.nodes.flatMap((root) => root.children),
    )) {
      for (const instance of element.effects ?? []) {
        if (!instance.enabled) continue;
        const effect = resources[instance.resourceId];
        if (!effect) continue;
        const source =
          effect.kind === "css"
            ? effect.source
            : effect.kind === "text-js"
              ? effect.styleSource
              : undefined;
        for (const family of fontFamiliesFromCss(source))
          references.push({
            family,
            slideId: slide.id,
            elementId: element.id,
          });
      }
    }
  }
  return references;
}

/** CSS selectors, inheritance and keyframes can choose any face within a named family. */
export function collectExportFontRequests(
  deck: Deck,
  pages: VisualPage[],
): ExportFontRequest[] {
  const requests: ExportFontRequest[] = collectUsedFontUsages(
    pages.map((page) => ({ ...page, notes: "" })),
    deck,
  );
  const families = new Set<string>();
  for (const reference of cssFontReferences(deck, pages)) {
    const key = reference.family.toLocaleLowerCase();
    if (!families.has(key))
      requests.push({ family: reference.family, allVariants: true });
    families.add(key);
  }
  return requests;
}
