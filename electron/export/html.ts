import { promises as fs } from "node:fs";
import path from "node:path";
import type { SystemFontFamily } from "../../src/platform/api";
import type { ExportDocument, ExportWarning } from "../../src/export/shared";
import {
  HTML_EXPORT_FORMAT_VERSION,
  type HtmlEmbeddedAsset,
  type HtmlEmbeddedFontFamily,
  type HtmlExportPayload,
} from "../../src/export/html/types";
import {
  collectUsedFontUsages,
  nonPortableFontFamilies,
  type FontUsage,
} from "../../src/core/fonts";
import { resolveTextTypography } from "../../src/core/textTypography";
import { resolveMediaFrame, walkElements, type Element } from "../../src/core/element";
import { getPresentationSlideIds } from "../../src/core/presentationSequence";

export interface HtmlAssetSource {
  file: string;
  mime: string;
}

export interface HtmlExportInput {
  document: ExportDocument;
  runtimeVersion: string;
  runtimeDirectory: string;
  resolveAsset(id: string): Promise<HtmlAssetSource | null>;
  managedFonts(): Promise<SystemFontFamily[]>;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function directMediaShaderInput(deck: ExportDocument["deck"], element: Element) {
  const content = element.content;
  if (
    deck.stylesheet?.trim() ||
    !content ||
    (content.type !== "image" && content.type !== "video") ||
    element.children.length ||
    element.geometry.type !== "rect" ||
    element.appearance.radius !== 0 ||
    element.appearance.fill ||
    element.appearance.strokeWidth !== 0 ||
    content.opacity !== 1
  )
    return false;
  const media = resolveMediaFrame(element);
  return Boolean(
    media &&
      Math.abs(media.x) <= 1e-6 &&
      Math.abs(media.y) <= 1e-6 &&
      Math.abs(media.width - element.frame.width) <= 1e-6 &&
      Math.abs(media.height - element.frame.height) <= 1e-6 &&
      Math.abs(media.rotation) <= 1e-6 &&
      Math.abs(media.scaleX - 1) <= 1e-6 &&
      Math.abs(media.scaleY - 1) <= 1e-6 &&
      !media.flipX &&
      !media.flipY
  );
}

function sceneTextureWarnings(document: ExportDocument, slideIds: Set<string>) {
  const warnings: ExportWarning[] = [];
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    for (const element of walkElements(
      slide.nodes.flatMap((root) => root.children),
    )) {
      for (const instance of element.effects ?? []) {
        if (!instance.enabled) continue;
        const effect = slide.effectResources?.[instance.resourceId];
        if (effect?.kind !== "fragment-glsl") continue;
        const direct =
          effect.input === "content" &&
          directMediaShaderInput(document.deck, element);
        if (
          effect.input === "backdrop" ||
          (effect.input === "content" && !direct)
        )
          warnings.push({
            slideId: slide.id,
            elementId: element.id,
            code: "unsupported-browser-scene-texture",
            message:
              `Effect "${effect.name}" requires rendered Chromium DOM/backdrop pixels through SceneTexture. Standard browsers do not provide ShowMe's Electron native capture APIs, so this effect is not portable in the HTML prototype.`,
          });
      }
    }
  }
  return warnings;
}

function fontOccurrence(
  document: ExportDocument,
  slideIds: Set<string>,
  family: string,
) {
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    for (const element of walkElements(
      slide.nodes.flatMap((root) => root.children),
    )) {
      if (element.content?.type !== "text") continue;
      const typography = resolveTextTypography(document.deck, element.content);
      if (typography.fontFamily.localeCompare(family, undefined, {
        sensitivity: "base",
      }) === 0)
        return { slideId: slide.id, elementId: element.id };
    }
  }
  return { slideId: document.deck.slideIds[0] ?? "unknown" };
}

function selectFonts(
  document: ExportDocument,
  slideIds: Set<string>,
  families: SystemFontFamily[],
) {
  const visibleSlides = document.slides.filter((slide) => slideIds.has(slide.id));
  const usages = collectUsedFontUsages(visibleSlides, document.deck);
  const selected: HtmlEmbeddedFontFamily[] = [];
  const bundled: FontUsage[] = [];
  for (const family of families) {
    const required = usages.filter(
      (usage) =>
        usage.family.localeCompare(family.family, undefined, {
          sensitivity: "base",
        }) === 0,
    );
    if (!required.length) continue;
    const sources = (family.sources ?? []).filter((source) =>
      required.some(
        (usage) =>
          usage.weight === source.weight && usage.italic === source.italic,
      ),
    );
    if (!sources.length) continue;
    selected.push({
      family: family.family,
      weights: [...new Set(sources.map((source) => source.weight))],
      sources: sources.map((source) => ({
        id: source.id,
        weight: source.weight,
        italic: source.italic,
        data: Buffer.from(source.data).toString("base64"),
      })),
    });
    bundled.push(
      ...sources.map((source) => ({
        family: family.family,
        weight: source.weight,
        italic: source.italic,
      })),
    );
  }
  const warnings = nonPortableFontFamilies(usages, bundled).map((family) => ({
    ...fontOccurrence(document, slideIds, family),
    code: "font-not-embedded",
    message:
      `Font "${family}" could not be embedded from ShowMe's managed font resources. The HTML export will rely on that font being installed on the viewing computer.`,
  }));
  return { fonts: selected, warnings };
}

async function runtimeAssets(runtimeDirectory: string) {
  const entries = await fs.readdir(runtimeDirectory);
  const javascript = entries.find((entry) => entry.endsWith(".js"));
  if (!javascript)
    throw new Error("Built HTML presentation runtime JavaScript is missing");
  const css = entries.find((entry) => entry.endsWith(".css"));
  return {
    javascript: await fs.readFile(
      path.join(runtimeDirectory, javascript),
      "utf8",
    ),
    css: css
      ? await fs.readFile(path.join(runtimeDirectory, css), "utf8")
      : "",
  };
}

function inlineScript(value: string) {
  return value.replace(/<\/script/gi, "<\\/script");
}
function inlineStyle(value: string) {
  return value.replace(/<\/style/gi, "<\\/style");
}
function embeddedJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export async function createHtmlExport({
  document,
  runtimeVersion,
  runtimeDirectory,
  resolveAsset,
  managedFonts,
}: HtmlExportInput) {
  const slideIds = new Set(getPresentationSlideIds(document.deck));
  if (!slideIds.size) throw new Error("There are no visible slides to export");

  const warnings: ExportWarning[] = sceneTextureWarnings(document, slideIds);
  const assetOccurrences = new Map<
    string,
    Array<{ slideId: string; elementId: string }>
  >();
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    for (const element of walkElements(
      slide.nodes.flatMap((root) => root.children),
    )) {
      const content = element.content;
      if (!content || content.type === "text") continue;
      const occurrences = assetOccurrences.get(content.assetId) ?? [];
      occurrences.push({ slideId: slide.id, elementId: element.id });
      assetOccurrences.set(content.assetId, occurrences);
    }
  }

  const assets: HtmlEmbeddedAsset[] = [];
  for (const [assetId, occurrences] of assetOccurrences) {
    const source = await resolveAsset(assetId).catch(() => null);
    if (!source) {
      for (const occurrence of occurrences)
        warnings.push({
          ...occurrence,
          code: "missing-media",
          message:
            "Media could not be resolved and is unavailable in the HTML export.",
        });
      continue;
    }
    assets.push({
      id: assetId,
      mime: source.mime,
      data: (await fs.readFile(source.file)).toString("base64"),
    });
  }

  const selectedFonts = selectFonts(
    document,
    slideIds,
    await managedFonts(),
  );
  warnings.push(...selectedFonts.warnings);
  const runtime = await runtimeAssets(runtimeDirectory);
  const payload: HtmlExportPayload = {
    kind: "showme-html-export",
    formatVersion: HTML_EXPORT_FORMAT_VERSION,
    runtimeVersion,
    exportedAt: new Date().toISOString(),
    document,
    assets,
    fonts: selectedFonts.fonts,
    warnings,
  };
  const encodedPayload = embeddedJson(payload);
  const title = escapeHtml(document.deck.name);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="showme-export-format" content="${HTML_EXPORT_FORMAT_VERSION}">
<meta name="showme-runtime-version" content="${escapeHtml(runtimeVersion)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; font-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>${title}</title>
<style>${inlineStyle(runtime.css)}</style>
</head>
<body>
<div id="root"></div>
<script id="showme-html-payload" type="application/json">${encodedPayload}</script>
<script>${inlineScript(runtime.javascript)}</script>
</body>
</html>`;
  return { html, warnings };
}
