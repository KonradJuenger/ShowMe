import { resolveTextTypography } from "./textTypography";
import type { Slide } from "./document";
import { walkElements } from "./element";

export interface FontUsage {
  family: string;
  weight: number;
  italic: boolean;
}

export function collectUsedFontUsages(
  slides: Slide[],
  deck?: import("./document").Deck,
): FontUsage[] {
  const usages = new Map<string, FontUsage>();
  for (const slide of slides) {
    for (const element of walkElements(
      slide.nodes.flatMap((root) => root.children),
    )) {
      if (element.content?.type !== "text") continue;
      const content = resolveTextTypography(deck, element.content);
      const usage: FontUsage = {
        family: content.fontFamily.trim(),
        weight: content.bold
          ? Math.max(700, content.fontWeight)
          : content.fontWeight,
        italic: content.italic,
      };
      const key = `${usage.family.toLocaleLowerCase()}\u0000${usage.weight}\u0000${usage.italic ? 1 : 0}`;
      if (!usages.has(key)) usages.set(key, usage);
    }
  }
  return Array.from(usages.values()).sort(
    (a, b) =>
      a.family.localeCompare(b.family, undefined, { sensitivity: "base" }) ||
      a.weight - b.weight ||
      Number(a.italic) - Number(b.italic),
  );
}

export function fontUsageLabel(usage: FontUsage) {
  return `${usage.family} ${usage.weight}${usage.italic ? " Italic" : ""}`;
}

export function nonPortableFontFamilies(
  usages: FontUsage[],
  bundled: FontUsage[] = [],
) {
  const safe = new Set(["arial", "times new roman", "courier new"]);
  return [
    ...new Set(
      usages
        .filter(
          (usage) =>
            !safe.has(usage.family.toLowerCase()) &&
            !bundled.some(
              (face) =>
                face.family.toLowerCase() === usage.family.toLowerCase() &&
                face.weight === usage.weight &&
                face.italic === usage.italic,
            ),
        )
        .map((usage) => usage.family),
    ),
  ].sort();
}
