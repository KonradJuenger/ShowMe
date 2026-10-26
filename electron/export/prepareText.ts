import type { Deck, VisualPage } from "../../src/core/document";
import type { Element } from "../../src/core/element";
import type { TextElement } from "../../src/core/text";
import { resolveTextTypography } from "../../src/core/textTypography";
import type { ExportWarning } from "../../src/export/shared";
import type { PresentationDocument } from "../../src/core/document";
import type { PackageExportAsset } from "../storage";
import { assetSchema } from "../../src/core/assets";
import { promises as fs } from "node:fs";

export interface OutlineAsset {
  file: string;
  mime: string;
  id: string;
  local: Element["frame"];
}
export type PrepareText = (element: TextElement) => Promise<OutlineAsset>;

/** Mutates only the caller's export-owned snapshot, shared by HTML and SMP. */
export async function preparePageText(
  deck: Deck,
  pages: VisualPage[],
  prepare: PrepareText,
  progress: (completed: number, total: number) => void = () => {},
) {
  const texts: Array<{ slideId: string; element: Element; blocked: boolean }> =
    [];
  const visit = (slideId: string, elements: Element[], blocked: boolean) => {
    for (const element of elements) {
      const unsafe =
        blocked || !!element.effects?.some((effect) => effect.enabled);
      if (element.content?.type === "text")
        texts.push({ slideId, element, blocked: unsafe });
      visit(slideId, element.children, unsafe);
    }
  };
  for (const page of pages)
    visit(
      page.id,
      page.nodes.flatMap((root) => root.children),
      !!deck.stylesheet?.trim(),
    );
  const warnings: ExportWarning[] = [],
    assets = new Map<string, OutlineAsset>();
  progress(0, texts.length);
  for (const [index, { slideId, element, blocked }] of texts.entries()) {
    if (element.content?.type !== "text") continue;
    try {
      if (blocked)
        throw Error("Text with Effects or deck CSS stays live in SVG mode");
      const typography = resolveTextTypography(deck, element.content);
      const prepared = await prepare({
        ...element,
        content: { ...element.content, format: { kind: "local", typography } },
      });
      assets.set(prepared.id, prepared);
      element.content = {
        type: "svg",
        assetId: prepared.id,
        filename: "outlined-text.svg",
        mediaType: "image",
        opacity: 1,
        lockAspect: false,
        transform: { rule: "free", local: prepared.local },
      };
    } catch (cause) {
      warnings.push({
        slideId,
        elementId: element.id,
        code: "text-svg-unavailable",
        message: `Text stayed live and needs its font on the viewing computer: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    progress(index + 1, texts.length);
  }
  return { warnings, assets };
}

export async function preparePackageText(
  document: PresentationDocument,
  prepare: PrepareText,
) {
  const result = await preparePageText(
    document.deck,
    [...Object.values(document.slides), ...Object.values(document.templates)],
    prepare,
  );
  const assets = new Map<string, PackageExportAsset>();
  for (const [id, outlined] of result.assets)
    assets.set(id, {
      file: outlined.file,
      asset: assetSchema.parse({
        version: 1,
        id,
        filename: `outlined-text__${id}.svg`,
        type: "svg",
        mediaType: "image",
        mime: "image/svg+xml",
        names: ["Outlined text"],
        bytes: (await fs.stat(outlined.file)).size,
        width: outlined.local.width,
        height: outlined.local.height,
        createdAt: new Date().toISOString(),
      }),
    });
  return { assets, warnings: result.warnings };
}
