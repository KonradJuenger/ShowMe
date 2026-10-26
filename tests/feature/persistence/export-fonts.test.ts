import { it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { storedDocument } from "../../helpers/storage";
import { createTextElement } from "../../../src/core/text";
import {
  insertElements,
  setSlideNotes,
} from "../../../src/core/editorCommands";
import {
  fontStorageService,
  fontFamiliesFromFaces,
} from "../../../electron/fontIntegration";
import { saveResolvedFontToLibrary } from "../../../electron/fontLibrary";
import { preparePackageText } from "../../../electron/export/prepareText";
import {
  readStoredZipFile,
  readArchiveEntry,
} from "../../../electron/packageArchive";
import { readSettings, writeSettings } from "../../../electron/settings";
import { hashFile } from "../../../electron/storage/io";

it("font-file packages retain live text and full font bytes regardless of embedding flags; none omits owned fonts", async () => {
  const { storage, root, session, id, runtime } = await storedDocument();
  const bytes = await readFile("tests/fixtures/fonts/Abel-Regular.ttf");
  for (let index = 0; index < bytes.readUInt16BE(4); index++) {
    const record = 12 + index * 16;
    if (bytes.toString("ascii", record, record + 4) === "OS/2")
      bytes.writeUInt16BE(0x0102, bytes.readUInt32BE(record + 8) + 8);
  }
  const font = path.join(root, "restricted.ttf");
  await writeFile(font, bytes);
  await saveResolvedFontToLibrary(storage.assetRoot, {
    filePath: font,
    family: "Export Face",
    weight: 400,
    italic: false,
  });
  storage.fonts = fontStorageService;
  const text = createTextElement("live-text");
  if (text.content?.type !== "text" || text.content.format.kind !== "local")
    throw Error("Text required");
  text.content.text = "Live text";
  text.content.format.typography.fontFamily = "Export Face";
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  const before = structuredClone(runtime.authority.document);
  const faces = await storage.exportFontFaces(id, [
    { family: "Export Face", weight: 400, italic: false },
  ]);
  expect(
    (await fontFamiliesFromFaces(faces.resolved))[0].sources![0].data,
  ).toEqual(bytes);
  const file = await storage.packageDocument(
    id,
    path.join(root, "file.smp"),
    false,
    false,
    undefined,
    { fontEmbedding: "file" },
  );
  const opened = await storage.openPackage(file);
  expect((await storage.managedFonts(opened.id))[0].sources![0].data).toEqual(
    new Uint8Array(bytes),
  );
  expect(
    Object.values(
      storage.documentRuntime(opened.id).authority.document.slides,
    )[0].nodes[0].children[0].content,
  ).toEqual(text.content);
  const none = await storage.packageDocument(
    opened.id,
    path.join(root, "none.smp"),
    false,
    false,
    undefined,
    { fontEmbedding: "none" },
  );
  const archive = await readStoredZipFile(none);
  try {
    expect(
      [...archive.entries.keys()].some((name) => name.startsWith("fonts/")),
    ).toBe(false);
    expect(
      JSON.parse(
        (
          await readArchiveEntry(archive.entries.get("manifest.json")!)
        ).toString(),
      ).fonts,
    ).toEqual([]);
  } finally {
    await archive.dispose();
  }
  expect((await storage.managedFonts(opened.id))[0].sources).toHaveLength(1);
  expect(runtime.authority.document).toEqual(before);
});

it("SVG packages convert slides and templates only in the packaged copy and preserve accepted content when notes are removed", async () => {
  const { storage, root, session, id, runtime } = await storedDocument();
  storage.fonts = fontStorageService;
  session.apply(
    insertElements(
      session.snapshot!,
      [createTextElement("slide-text")],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(setSlideNotes(session.snapshot!, "Private notes"));
  await session.flush();
  await session.loadProjection(
    runtime.authority.document.deck.defaultTemplateId,
  );
  session.apply(
    insertElements(
      session.snapshot!,
      [createTextElement("template-text")],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  const before = structuredClone(runtime.authority.document);
  const svg = path.join(root, "text.svg");
  await writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="180"><path d="M1 1L20 20"/></svg>',
  );
  const assetId = await hashFile(svg);
  const file = await storage.packageDocument(
    id,
    path.join(root, "svg.smp"),
    false,
    true,
    undefined,
    {
      fontEmbedding: "svg",
      prepareDocument: async (document) =>
        (
          await preparePackageText(document, async (element) => ({
            file: svg,
            mime: "image/svg+xml",
            id: assetId,
            local: { ...element.frame, x: 0, y: 0 },
          }))
        ).assets,
    },
  );
  expect(runtime.authority.document).toEqual(before);
  const opened = await storage.openPackage(file),
    result = storage.documentRuntime(opened.id).authority.document;
  expect(
    Object.values(result.slides)[0].nodes[0].children[0].content,
  ).toMatchObject({ type: "svg", assetId });
  expect(
    Object.values(result.templates)[0].nodes[0].children[0].content,
  ).toMatchObject({ type: "svg", assetId });
  expect(Object.values(result.slides)[0].notes).toBe("");
  expect(await storage.managedFonts(opened.id)).toEqual([]);
  expect(
    await readFile(storage.assetPathForDocument(opened.id, assetId)),
  ).toEqual(await readFile(svg));
});

it("migrates the current HTML-only font preference to the shared export preference without overriding an explicit new choice", async () => {
  const { root } = await storedDocument();
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ htmlFontEmbedding: "none", htmlExportJpegQuality: 75 }),
  );
  const migrated = await readSettings(root);
  expect(migrated.exportFontEmbedding).toBe("none");
  await writeSettings(root, migrated);
  expect(
    JSON.parse(await readFile(path.join(root, "settings.json"), "utf8")),
  ).toEqual({ exportFontEmbedding: "none", htmlExportJpegQuality: 75 });
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({ htmlFontEmbedding: "svg", exportFontEmbedding: "file" }),
  );
  expect((await readSettings(root)).exportFontEmbedding).toBe("file");
});
