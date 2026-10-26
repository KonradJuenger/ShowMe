import { it, expect, vi, afterAll } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { storedDocument, storageAt } from "../../helpers/storage";
import { saveResolvedFontToLibrary } from "../../../electron/fontLibrary";
import {
  fontStorageService,
  fontFamiliesFromFaces,
} from "../../../electron/fontIntegration";
import {
  createHtmlExport,
  htmlFontUsages,
} from "../../../electron/export/html";
import { createTextElement } from "../../../src/core/text";
import {
  insertElements,
  setDeckProperties,
  setSlideEffects,
} from "../../../src/core/editorCommands";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";
import {
  readStoredZipFile,
  readArchiveEntry,
} from "../../../electron/packageArchive";
import type { HtmlExportPayload } from "../../../src/export/html/types";

// This integration includes the host's native installed-font enumeration.
vi.setConfig({ testTimeout: 15000 });
afterAll(() => vi.resetConfig());

const css =
  ':scope { font-family: "Asap Condensed"; font-weight: 700; font-style: italic; }';
async function fixture() {
  const setup = await storedDocument();
  setup.storage.fonts = fontStorageService;
  for (const [family, filename, weight, italic] of [
    ["Asap Condensed", "AsapCondensed-Regular.ttf", 400, false],
    ["Asap Condensed", "AsapCondensed-BoldItalic.ttf", 700, true],
    ["Abel", "Abel-Regular.ttf", 400, false],
  ] as const)
    await saveResolvedFontToLibrary(setup.storage.assetRoot, {
      family,
      weight,
      italic,
      filePath: path.resolve("tests/fixtures/fonts", filename),
    });
  return setup;
}

it("resolves real CSS-only family files through the complete HTML font-file production pipeline", async () => {
  const { storage, root, id, runtime } = await fixture();
  await writeFile(path.join(root, "runtime.js"), "void 0;");
  const model = structuredClone(runtime.authority.document);
  const text = createTextElement("css-text");
  if (text.content?.type !== "text" || text.content.format.kind !== "local")
    throw Error("Text required");
  text.content.format.typography.fontFamily = "Abel";
  const slide = Object.values(model.slides)[0];
  slide.nodes[0].children = [text];
  model.deck.stylesheet = css;
  const document = { deck: model.deck, slides: [slide] };
  expect(htmlFontUsages(document)).toContainEqual({
    family: "Asap Condensed",
    allVariants: true,
  });
  const { html } = await createHtmlExport({
    document,
    runtimeDirectory: root,
    runtimeVersion: "test",
    resolveAsset: async () => null,
    managedFonts: async () =>
      fontFamiliesFromFaces(
        (await storage.exportFontFaces(id, htmlFontUsages(document))).resolved,
      ),
  });
  const payload = JSON.parse(
    html.match(
      /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
    )![1],
  ) as HtmlExportPayload;
  const family = payload.fonts.find(
    (font) => font.family === "Asap Condensed",
  )!;
  expect(family.sources.map((face) => [face.weight, face.italic])).toEqual(
    expect.arrayContaining([
      [400, false],
      [700, true],
    ]),
  );
  const boldItalic = family.sources.find(
    (face) => face.weight === 700 && face.italic,
  )!;
  expect(Buffer.from(boldItalic.data, "base64")).toEqual(
    await readFile("tests/fixtures/fonts/AsapCondensed-BoldItalic.ttf"),
  );
  expect(
    payload.warnings.some(
      (warning) => warning.code === "stylesheet-font-not-embedded",
    ),
  ).toBe(false);
});

async function expectCssFace(file: string) {
  const archive = await readStoredZipFile(file);
  try {
    const manifest = JSON.parse(
      (
        await readArchiveEntry(archive.entries.get("manifest.json")!)
      ).toString(),
    );
    const family = manifest.fonts.filter(
      (face: { family: string }) => face.family === "Asap Condensed",
    );
    expect(
      family.map((face: { weight: number; italic: boolean }) => [
        face.weight,
        face.italic,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [400, false],
        [700, true],
      ]),
    );
    const italic = family.find(
      (face: { weight: number; italic: boolean }) =>
        face.weight === 700 && face.italic,
    );
    expect(
      await readArchiveEntry(archive.entries.get(italic.originalPath)!),
    ).toEqual(
      await readFile("tests/fixtures/fonts/AsapCondensed-BoldItalic.ttf"),
    );
  } finally {
    await archive.dispose();
  }
}

it("packages fonts referenced only by deck CSS, template Effect CSS or text-JS styles and retains their owned variants when repackaging", async () => {
  const { storage, root, id, session, runtime } = await fixture();
  session.apply(setDeckProperties(session.snapshot!, { stylesheet: css }));
  await session.flush();
  await expectCssFace(
    await storage.packageDocument(
      id,
      path.join(root, "deck-css.smp"),
      false,
      false,
      undefined,
      { fontEmbedding: "file" },
    ),
  );
  session.apply(setDeckProperties(session.snapshot!, { stylesheet: "" }));
  await session.flush();
  await session.loadProjection(
    runtime.authority.document.deck.defaultTemplateId,
  );
  const effect = { ...blankEffect("css-js"), source: css };
  session.apply(
    setSlideEffects(session.snapshot!, { resources: { css: effect } }),
  );
  await session.flush();
  const text = createTextElement("template-css-text");
  if (text.content?.type !== "text" || text.content.format.kind !== "local")
    throw Error("Text required");
  text.content.format.typography.fontFamily = "Abel";
  text.effects = [newEffectInstance("css", effect, "content")];
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  await expectCssFace(
    await storage.packageDocument(
      id,
      path.join(root, "effect-css.smp"),
      false,
      false,
      undefined,
      { fontEmbedding: "file" },
    ),
  );
  const textJs = {
    ...blankEffect("css-js"),
    kind: "text-js" as const,
    target: "text" as const,
    source: "function render({text}) { return text; }",
    styleSource: css,
  };
  session.apply(
    setSlideEffects(session.snapshot!, {
      resources: { js: textJs },
      changes: [
        {
          elementId: text.id,
          value: [newEffectInstance("js", textJs, "content")],
        },
      ],
    }),
  );
  await session.flush();
  const before = structuredClone(runtime.authority.document);
  const jsFile = await storage.packageDocument(
    id,
    path.join(root, "text-js.smp"),
    false,
    false,
    undefined,
    { fontEmbedding: "file" },
  );
  await expectCssFace(jsFile);
  expect(runtime.authority.document).toEqual(before);
  const recipient = await storageAt(root, "recipient");
  recipient.fonts = fontStorageService;
  const opened = await recipient.openPackage(jsFile);
  await expectCssFace(
    await recipient.packageDocument(
      opened.id,
      path.join(root, "repackaged.smp"),
      false,
      false,
      undefined,
      { fontEmbedding: "file" },
    ),
  );
});
