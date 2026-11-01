import { expect, it, vi } from "vitest";
import path from "node:path";
import { open, stat, writeFile, readFile } from "node:fs/promises";
import {
  PACKAGE_LIMITS,
  readStoredZipFile,
  writeStoredZipFile,
} from "../../../electron/packageArchive";
import { hashFile } from "../../../electron/storage/io";
import { storedDocument, storageAt } from "../../helpers/storage";
import { openPowerPointArchive } from "../../../electron/powerpointArchive";
import { insertElements } from "../../../src/core/editorCommands";
import { createMediaElement } from "../../../src/core/media";

// Archive I/O shares the host disk with the rest of the full suite. This is an
// integrity and bounded-memory contract, not a five-second disk benchmark.
vi.setConfig({ testTimeout: 30000 });

it("streams PowerPoint media and rejects corrupt entries", async () => {
  const { root } = await storedDocument();
  const file = path.join(root, "import.pptx");
  await writeStoredZipFile(file, [
    { name: "ppt/presentation.xml", data: "<presentation/>" },
    { name: "ppt/media/image.png", data: "image-data" },
  ]);
  const archive = await openPowerPointArchive(file);
  try {
    expect(await archive.readXml("ppt/presentation.xml")).toBe("<presentation/>");
    const media = await archive.extractMedia("ppt/media/image.png");
    expect(await readFile(media, "utf8")).toBe("image-data");
  } finally {
    await archive.dispose();
  }
  const handle = await open(file, "r+");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, 0);
    await handle.write(Buffer.from("X"), 0, 1, 30 + header.readUInt16LE(26) + header.readUInt16LE(28));
  } finally { await handle.close(); }
  const corrupt = await openPowerPointArchive(file);
  try {
    await expect(corrupt.readXml("ppt/presentation.xml")).rejects.toThrow("integrity");
  } finally { await corrupt.dispose(); }
});

it("keeps imported media local through recovery and promotes it on save", async () => {
  const { root, storage, session, id } = await storedDocument();
  const source = path.join(root, "source.png");
  await writeFile(source, "image-data");
  const asset = await storage.stageDocumentMedia(id, "source.png", source);
  expect((await storage.listAssets("", 0, 100)).total).toBe(0);
  session.apply(insertElements(session.snapshot!, [createMediaElement("image", { ...asset, width: 1, height: 1 })], session.snapshot!.slide.nodes[0].id));
  await session.flush();
  expect(await storage.assetForDocument(id, asset.id)).toMatchObject({ id: asset.id });
  const restarted = await storageAt(root);
  await restarted.recoverUntitled(id);
  expect(await restarted.assetForDocument(id, asset.id)).toMatchObject({ id: asset.id });
  await storage.saveDocument(id, path.join(root, "imported.sme"));
  expect((await storage.listAssets("", 0, 100)).items.map((item) => item.id)).toContain(asset.id);
});

it("does not publish staged media when the saved presentation changed externally", async () => {
  const { root, storage, session, id } = await storedDocument();
  const destination = path.join(root, "existing.sme");
  await storage.saveDocument(id, destination);
  const source = path.join(root, "source.png");
  await writeFile(source, "image-data");
  const asset = await storage.stageDocumentMedia(id, "source.png", source);
  session.apply(insertElements(session.snapshot!, [createMediaElement("image", { ...asset, width: 1, height: 1 })], session.snapshot!.slide.nodes[0].id));
  await session.flush();
  await writeFile(destination, "externally changed");
  await expect(storage.saveDocument(id)).rejects.toThrow("changed on disk");
  expect((await storage.listAssets("", 0, 100)).total).toBe(0);
  expect(await storage.assetForDocument(id, asset.id)).toMatchObject({ id: asset.id });
});

it("streams a generated 128 MiB media archive with verified cold extraction", async () => {
  const { root } = await storedDocument();
  const media = path.join(root, "large-video.mp4");
  const handle = await open(media, "wx");
  const chunk = Buffer.alloc(1024 ** 2, 0x5a);
  try {
    for (let index = 0; index < 128; index++) await handle.writeFile(chunk);
  } finally {
    await handle.close();
  }
  const file = path.join(root, "large.smp");
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  try {
    await writeStoredZipFile(file, [
      { name: "video/large.mp4", file: media },
      { name: "manifest.json", data: "{}" },
    ]);
    const archive = await readStoredZipFile(file);
    try {
      expect((await stat(file)).size).toBeGreaterThan(128 * 1024 ** 2);
      expect(await hashFile(archive.entries.get("video/large.mp4")!.file)).toBe(
        await hashFile(media),
      );
    } finally {
      await archive.dispose();
    }
  } finally {
    clearInterval(sample);
  }
  console.info(
    `128 MiB streaming package RSS: baseline=${baseline}, peak=${peak}, delta=${peak - baseline}`,
  );
});

it("rejects excessive archive entries and unsafe paths before writing", async () => {
  const { root } = await storedDocument();
  const file = path.join(root, "bounded.smp");
  await expect(
    writeStoredZipFile(
      file,
      Array.from({ length: PACKAGE_LIMITS.entries + 1 }, (_, index) => ({
        name: String(index),
        data: "",
      })),
    ),
  ).rejects.toThrow("count");
  await expect(
    writeStoredZipFile(file, [{ name: "../escape", data: "" }]),
  ).rejects.toThrow("entry name");
});

it("cold extraction rejects corrupted entry bytes", async () => {
  const { root } = await storedDocument();
  const file = path.join(root, "corrupt.smp");
  await writeStoredZipFile(file, [{ name: "media/data", data: "original" }]);
  const handle = await open(file, "r+");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, header.length, 0);
    await handle.write(
      Buffer.from("X"),
      0,
      1,
      30 + header.readUInt16LE(26) + header.readUInt16LE(28),
    );
  } finally {
    await handle.close();
  }
  await expect(readStoredZipFile(file)).rejects.toThrow(
    "integrity verification",
  );
});
