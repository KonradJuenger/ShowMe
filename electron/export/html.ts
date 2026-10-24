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
import { walkElements } from "../../src/core/element";
import {
  compileCompositionPlan,
  compositionIsOwnedMediaOnly,
} from "../../src/components/compositionPlan";
import { nativeOpacityPlan } from "../../src/components/nativeOpacity";
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

function visibleLayerNodes(
  document: ExportDocument,
  slide: ExportDocument["slides"][number],
) {
  const visible = new Set(
    document.deck.layers.filter((layer) => !layer.hidden).map((layer) => layer.id),
  );
  return slide.nodes.filter((root) => visible.has(root.id));
}

function visibleElements(
  document: ExportDocument,
  slide: ExportDocument["slides"][number],
) {
  return walkElements(visibleLayerNodes(document, slide).flatMap((root) => root.children));
}

function externalCssUrl(source: string | undefined) {
  if (!source) return null;
  const match = source.match(
    /(?:https?:\/\/|file:|url\(\s*["']?\/\/)[^)"'\s]*/i,
  );
  return match?.[0]?.trim() ?? null;
}

function externalCssWarnings(document: ExportDocument, slideIds: Set<string>) {
  const warnings: ExportWarning[] = [];
  const deckReference = externalCssUrl(document.deck.stylesheet);
  if (deckReference)
    warnings.push({
      slideId:
        document.deck.slideIds.find((id) => slideIds.has(id)) ?? "unknown",
      code: "external-css-resource-blocked",
      message:
        `The deck stylesheet references an external resource (${deckReference}). Portable HTML exports block network and file URL access.`,
    });
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    const resources = slide.effectResources ?? {};
    for (const element of visibleElements(document, slide)) {
      for (const instance of element.effects ?? []) {
        if (!instance.enabled) continue;
        const effect = resources[instance.resourceId];
        if (!effect) continue;
        const reference = externalCssUrl(
          effect.kind === "css"
            ? effect.source
            : effect.kind === "text-js"
              ? effect.styleSource
              : undefined,
        );
        if (!reference) continue;
        warnings.push({
          slideId: slide.id,
          elementId: element.id,
          code: "external-effect-resource-blocked",
          message:
            `Effect "${effect.name}" references an external CSS resource (${reference}). Portable HTML exports block network and file URL access.`,
        });
      }
    }
  }
  return warnings;
}

type CssFontReference = {
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

function cssFontReferences(
  document: ExportDocument,
  slideIds: Set<string>,
): CssFontReference[] {
  const references: CssFontReference[] = [];
  const firstSlide =
    document.deck.slideIds.find((id) => slideIds.has(id)) ?? "unknown";
  for (const family of fontFamiliesFromCss(document.deck.stylesheet))
    references.push({ family, slideId: firstSlide });
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    const resources = slide.effectResources ?? {};
    for (const element of visibleElements(document, slide)) {
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

function sceneTextureWarnings(document: ExportDocument, slideIds: Set<string>) {
  const warnings: ExportWarning[] = [];
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    const resources = slide.effectResources ?? {};
    const composition = compileCompositionPlan(
      slide,
      document.deck,
      undefined,
      resources,
    );
    const opacity = nativeOpacityPlan(
      visibleLayerNodes(document, slide).flatMap((root) => root.children),
      resources,
      document.deck.stylesheet,
    );
    for (const element of visibleElements(document, slide)) {
      for (const instance of element.effects ?? []) {
        if (!instance.enabled) continue;
        const effect = resources[instance.resourceId];
        if (!effect) {
          warnings.push({
            slideId: slide.id,
            elementId: element.id,
            code: "missing-effect-resource",
            message:
              `Effect resource "${instance.resourceId}" is missing and cannot be reproduced in the HTML export.`,
          });
          continue;
        }
        if (effect.kind !== "fragment-glsl") continue;
        const input = composition.groups.get(element.id)?.inputs.get(instance.id);
        const browserContentInput =
          effect.input === "content" &&
          !document.deck.stylesheet?.trim() &&
          !opacity.get(element.id)?.distribute &&
          input?.kind === "content" &&
          ((input.operation.kind === "effect" &&
            resources[input.operation.effect.resourceId]?.kind ===
              "fragment-glsl") ||
            compositionIsOwnedMediaOnly(input.operation, element));
        if (
          effect.input === "backdrop" ||
          (effect.input === "content" && !browserContentInput)
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
    for (const element of visibleElements(document, slide)) {
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
  const visibleSlides = document.slides
    .filter((slide) => slideIds.has(slide.id))
    .map((slide) => ({
      ...slide,
      nodes: visibleLayerNodes(document, slide),
    }));
  const usages = collectUsedFontUsages(visibleSlides, document.deck);
  const cssReferences = cssFontReferences(document, slideIds);
  const selected: HtmlEmbeddedFontFamily[] = [];
  const bundled: FontUsage[] = [];
  for (const family of families) {
    const required = usages.filter(
      (usage) =>
        usage.family.localeCompare(family.family, undefined, {
          sensitivity: "base",
        }) === 0,
    );
    const cssRequired = cssReferences.some(
      (reference) =>
        reference.family.localeCompare(family.family, undefined, {
          sensitivity: "base",
        }) === 0,
    );
    if (!required.length && !cssRequired) continue;
    const sources = cssRequired
      ? (family.sources ?? [])
      : (family.sources ?? []).filter((source) =>
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
  const warnings: ExportWarning[] = nonPortableFontFamilies(
    usages,
    bundled,
  ).map((family) => ({
    ...fontOccurrence(document, slideIds, family),
    code: "font-not-embedded",
    message:
      `Font "${family}" could not be embedded from ShowMe's managed font resources. The HTML export will rely on that font being installed on the viewing computer.`,
  }));
  for (const reference of cssReferences) {
    const embedded = bundled.some(
      (face) =>
        face.family.localeCompare(reference.family, undefined, {
          sensitivity: "base",
        }) === 0,
    );
    if (embedded) continue;
    if (
      ["arial", "times new roman", "courier new"].includes(
        reference.family.toLowerCase(),
      )
    )
      continue;
    if (
      warnings.some(
        (warning) =>
          warning.code === "font-not-embedded" &&
          warning.message.includes(`"${reference.family}"`),
      )
    )
      continue;
    warnings.push({
      slideId: reference.slideId,
      elementId: reference.elementId,
      code: "stylesheet-font-not-embedded",
      message:
        `CSS references font "${reference.family}", but ShowMe has no embeddable managed font data for it. The HTML export will rely on that font being installed on the viewing computer.`,
    });
  }
  return { fonts: selected, warnings };
}

async function runtimeAssets(runtimeDirectory: string) {
  const entries = await fs.readdir(runtimeDirectory);
  const javascript = entries.filter((entry) => entry.endsWith(".js"));
  if (javascript.length !== 1)
    throw new Error(
      `HTML presentation runtime must contain exactly one JavaScript bundle; found ${javascript.length}`,
    );
  const css = entries.filter((entry) => entry.endsWith(".css"));
  if (css.length > 1)
    throw new Error(
      `HTML presentation runtime must contain at most one CSS bundle; found ${css.length}`,
    );
  return {
    javascript: await fs.readFile(
      path.join(runtimeDirectory, javascript[0]),
      "utf8",
    ),
    css: css[0]
      ? await fs.readFile(path.join(runtimeDirectory, css[0]), "utf8")
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

  const warnings: ExportWarning[] = [
    ...sceneTextureWarnings(document, slideIds),
    ...externalCssWarnings(document, slideIds),
  ];
  const assetOccurrences = new Map<
    string,
    Array<{ slideId: string; elementId: string }>
  >();
  for (const slide of document.slides) {
    if (!slideIds.has(slide.id)) continue;
    for (const element of visibleElements(document, slide)) {
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

  let managedFontFamilies: SystemFontFamily[] = [];
  try {
    managedFontFamilies = await managedFonts();
  } catch (cause) {
    warnings.push({
      slideId: document.deck.slideIds[0] ?? "unknown",
      code: "managed-fonts-unavailable",
      message:
        "ShowMe could not read its managed font resources for this export: " +
        String(cause),
    });
  }
  const selectedFonts = selectFonts(
    document,
    slideIds,
    managedFontFamilies,
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
