import { expect, it } from "vitest";
import path from "node:path";
import { rename } from "node:fs/promises";
import {
  writeStoredZipFile,
  readStoredZipFile,
  readArchiveEntry,
  type ZipEntryInput,
} from "../../../electron/packageArchive";
import { fontStorageService } from "../../../electron/fontIntegration";
import { digest } from "../../../electron/storage/io";
import { storedDocument } from "../../helpers/storage";

async function packageFont(
  storage: Awaited<ReturnType<typeof storedDocument>>["storage"],
  id: string,
  file: string,
  family: string,
  invalidDocument = false,
) {
  await storage.packageDocument(id, file);
  const archive = await readStoredZipFile(file);
  const entries = new Map<string, ZipEntryInput>(
    [...archive.entries].map(([name, entry]) => [
      name,
      { name, file: entry.file },
    ]),
  );
  const bytes = Buffer.from(family);
  const fontId = digest(bytes);
  const originalPath = `fonts/${fontId}.ttf`;
  const manifest = JSON.parse(
    (await readArchiveEntry(archive.entries.get("manifest.json")!)).toString(),
  );
  manifest.fonts = [
    {
      id: fontId,
      family,
      weight: 400,
      italic: false,
      bytes: bytes.length,
      originalName: "fixture.ttf",
      originalPath,
    },
  ];
  entries.set("manifest.json", {
    name: "manifest.json",
    data: JSON.stringify(manifest),
  });
  entries.set(originalPath, { name: originalPath, data: bytes });
  if (invalidDocument)
    entries.set(manifest.documentPath, {
      name: manifest.documentPath,
      data: "{}",
    });
  try {
    await writeStoredZipFile(file + ".fonts", [...entries.values()]);
    await rename(file + ".fonts", file);
  } finally {
    await archive.dispose();
  }
}

it("failed package validation preserves the open document's font resources", async () => {
  const { root, storage, id } = await storedDocument();
  const valid = path.join(root, "valid.smp");
  const invalid = path.join(root, "invalid.smp");
  await packageFont(storage, id, valid, "First");
  await packageFont(storage, id, invalid, "Rejected", true);
  storage.fonts = fontStorageService;
  const opened = await storage.openPackage(valid);
  const before = await storage.managedFonts(opened.id);
  await expect(storage.openPackage(invalid)).rejects.toThrow();
  expect(await storage.managedFonts(opened.id)).toEqual(before);
  expect(before.map(({ family }) => family)).toContain("First");
});

it("two open packages retain independent fonts and closing one preserves the other", async () => {
  const { root, storage, id } = await storedDocument();
  const first = path.join(root, "first.smp");
  const second = path.join(root, "second.smp");
  await packageFont(storage, id, first, "First");
  await packageFont(storage, id, second, "Second");
  storage.fonts = fontStorageService;
  const a = await storage.openPackage(first);
  const b = await storage.openPackage(second);
  expect(
    (await storage.managedFonts(a.id)).map(({ family }) => family),
  ).toEqual(["First"]);
  expect(
    (await storage.managedFonts(b.id)).map(({ family }) => family),
  ).toEqual(["Second"]);
  storage.closeDocument(a.id);
  expect(
    (await storage.managedFonts(b.id)).map(({ family }) => family),
  ).toEqual(["Second"]);
});
