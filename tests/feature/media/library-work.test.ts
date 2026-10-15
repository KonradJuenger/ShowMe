vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
import * as nodeFs from "node:fs";
import { readFile } from "node:fs/promises";
import {
  LibraryIndex,
  importManagedFile,
} from "../../../electron/mediaLibrary";
import { restoreLibraryAsset } from "../../../electron/libraryLifecycle";
import { expect, it, vi } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { storedDocument } from "../../helpers/storage";
import { libraryIndex, managedFilename } from "../../../electron/mediaLibrary";
import { createMediaElement } from "../../../src/core/media";
import { insertElements } from "../../../src/core/editorCommands";
import { StorageMedia } from "../../../electron/storage/media";
import type { Asset } from "../../../src/core/assets";
import { NativeLibraryBrowser } from "../../../electron/libraryBrowser";
import { EffectLibraryStorage } from "../../../electron/effectLibrary";
import { blankEffect } from "../../../src/core/effectAuthoring";

it("warm asset lookup and listing reuse inventory without directory enumeration", async () => {
  const { storage } = await storedDocument();
  const asset = await storage.importAssetData(
    "sample.png",
    new Uint8Array([1, 2, 3]),
  );
  const index = libraryIndex(storage.assetRoot)!;
  const before = index.diagnostics().scans;
  for (let count = 0; count < 100; count++)
    expect(storage.assetPath(asset.id)).toContain(asset.id);
  const listed = await storage.listAssets("", 0, 100);
  expect(listed.items.map((item) => item.id)).toEqual([asset.id]);
  expect(index.diagnostics().scans).toBe(before);
});

it("external arrivals are hash validated and notify at unchanged document revision", async () => {
  const { storage, runtime } = await storedDocument();
  const bytes = new Uint8Array([4, 5, 6]);
  const id = createHash("sha256").update(bytes).digest("hex");
  const index = libraryIndex(storage.assetRoot)!;
  let notifications = 0;
  const unsubscribe = index.subscribe(() => {
    notifications++;
  });
  try {
    const file = path.join(
      storage.assetRoot,
      "images",
      managedFilename("external.png", id),
    );
    await writeFile(file, bytes);
    await index.refresh();
    expect(index.diagnostics().hashedBytes).toBe(0);
    expect(await storage.verifiedAssetPath(id)).toBe(file);
    expect(notifications).toBeGreaterThan(0);
    expect(runtime.authority.revision).toBe(0);
    await writeFile(file, new Uint8Array([7, 8, 9]));
    await index.refresh();
    await expect(storage.verifiedAssetPath(id)).rejects.toThrow(
      "Asset not found",
    );
  } finally {
    unsubscribe();
  }
});

it("indexed Trash restoration validates external bytes and rechecks changes before restoring", async () => {
  const { storage } = await storedDocument(),
    bytes = new Uint8Array([11, 12, 13]);
  const id = createHash("sha256").update(bytes).digest("hex"),
    name = managedFilename("external.png", id),
    dir = path.join(storage.assetRoot, "Trash", "assets", "external");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, name);
  await writeFile(
    path.join(dir, "item.json"),
    JSON.stringify({
      hash: id,
      trashedAt: "2026-10-12T00:00:00Z",
      originalRelativePath: "images/" + name,
      bytes: 3,
    }),
  );
  const index = libraryIndex(storage.assetRoot)!;
  await writeFile(source, new Uint8Array([14, 15, 16]));
  await index.refresh();
  expect(index.trash.has(id)).toBe(false);
  restoreLibraryAsset(storage.assetRoot, id);
  expect(() => storage.assetPath(id)).toThrow("Asset not found");
  await writeFile(source, bytes);
  await index.refresh();
  await index.verify(id);
  expect(index.trash.has(id)).toBe(true);
  await writeFile(source, new Uint8Array([14, 15, 16]));
  restoreLibraryAsset(storage.assetRoot, id);
  expect(() => storage.assetPath(id)).toThrow("Asset not found");
  await writeFile(source, bytes);
  await index.refresh();
  await index.verify(id);
  restoreLibraryAsset(storage.assetRoot, id);
  expect(storage.assetPath(id)).toBe(
    path.join(storage.assetRoot, "images", name),
  );
});

it("startup inventories hash no contents, idle does not rescan, and changing roots disposes watchers", async () => {
  const { storage, root } = await storedDocument();
  const index = libraryIndex(storage.assetRoot)!;
  expect(index.diagnostics().hashedBytes).toBe(0);
  const scans = index.diagnostics().scans;
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(60000);
    expect(index.diagnostics().scans).toBe(scans);
  } finally {
    vi.useRealTimers();
  }
  await storage.setAssetRoot(path.join(root, "new-library"));
  expect(index.diagnostics()).toMatchObject({ disposed: true, watchers: 0 });
  expect(libraryIndex(index.root)).toBeUndefined();
});

it("cold inventory persists metadata but still verifies content at consumption", async () => {
  const { storage, root } = await storedDocument();
  const bytes = Buffer.alloc(1024, 21),
    id = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(
    storage.assetRoot,
    "images",
    managedFilename("cold.png", id),
  );
  await writeFile(file, bytes);
  const cold = new LibraryIndex(
    storage.assetRoot,
    path.join(root, "inventory-cache"),
  );
  await cold.ready();
  const changed = vi.fn();
  const unsubscribe = cold.subscribe(changed);
  expect(cold.diagnostics().hashedBytes).toBe(0);
  expect(await cold.verify(id)).toBe(file);
  expect(cold.diagnostics().hashedBytes).toBe(bytes.length);
  expect(changed).not.toHaveBeenCalled();
  await writeFile(file, Buffer.alloc(1024, 22));
  expect(await cold.verify(id)).toBeNull();
  expect(changed).toHaveBeenCalled();
  unsubscribe();
  cold.dispose();
});

it("stream imports hash their written payload without rereading the source or temporary", async () => {
  const { storage, root } = await storedDocument(),
    source = path.join(root, "source-video.mp4"),
    bytes = Buffer.alloc(1024 * 1024, 43);
  await writeFile(source, bytes);
  const streamed = vi.spyOn(nodeFs, "createReadStream");
  try {
    const result = await importManagedFile(
      storage.assetRoot,
      "video.mp4",
      source,
    );
    expect(result.id).toBe(
      createHash("sha256")
        .update(await readFile(result.file))
        .digest("hex"),
    );
    expect(streamed.mock.calls.map((call) => String(call[0]))).toEqual([
      source,
    ]);
  } finally {
    streamed.mockRestore();
  }
});

it("a referenced missing Library asset invalidates the open document when it arrives", async () => {
  const { storage, session, id, runtime } = await storedDocument();
  const bytes = Buffer.from("arrives-later"),
    assetId = createHash("sha256").update(bytes).digest("hex"),
    filename = managedFilename("synced.png", assetId);
  const asset: Asset = {
    version: 1,
    id: assetId,
    filename,
    names: ["synced.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: bytes.length,
    width: 32,
    height: 32,
    createdAt: "2026-10-12T00:00:00Z",
  };
  const media = createMediaElement("synced-media", asset);
  session.apply(
    insertElements(
      session.snapshot!,
      [media],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  const revision = runtime.authority.revision,
    changed = vi.fn();
  storage.onResourcesChanged = changed;

  await writeFile(path.join(storage.assetRoot, "images", filename), bytes);
  await libraryIndex(storage.assetRoot)!.refresh();

  expect(changed).toHaveBeenCalledWith([id]);
  expect(runtime.authority.revision).toBe(revision);
});

it("an unrelated Library arrival does not invalidate an open document", async () => {
  const { storage } = await storedDocument(),
    changed = vi.fn(),
    inventoryChanged = vi.fn();
  storage.onResourcesChanged = changed;
  storage.onMediaInventoryChanged = inventoryChanged;
  const bytes = Buffer.from("unused"),
    id = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    path.join(storage.assetRoot, "images", managedFilename("unused.png", id)),
    bytes,
  );
  await libraryIndex(storage.assetRoot)!.refresh();
  expect(changed).not.toHaveBeenCalled();
  expect(inventoryChanged).toHaveBeenCalled();
  expect(
    (await storage.listAssets("", 0, 100)).items.map((item) => item.id),
  ).toContain(id);
});

it("startup reconciles files copied into a Library after its inventory was cached", async () => {
  const { root } = await storedDocument();
  const assetRoot = path.join(root, "copied-library"),
    cacheRoot = path.join(root, "copied-cache"),
    bytes = Buffer.from("copied while ShowMe was closed"),
    id = createHash("sha256").update(bytes).digest("hex"),
    staleId = "a".repeat(64);
  await mkdir(path.join(assetRoot, "images"), { recursive: true });
  await mkdir(path.join(cacheRoot, "library-index"), { recursive: true });
  await writeFile(
    path.join(assetRoot, "images", managedFilename("copied.png", id)),
    bytes,
  );
  await writeFile(
    path.join(
      cacheRoot,
      "library-index",
      createHash("sha256").update(assetRoot).digest("hex") + ".json",
    ),
    JSON.stringify({
      version: 1,
      root: assetRoot,
      files: [
        {
          id: staleId,
          file: "images/" + managedFilename("missing.png", staleId),
          signature: "stale",
        },
      ],
    }),
  );
  const media = new StorageMedia(assetRoot, cacheRoot);
  try {
    await media.init();
    const listed = await media.listAssets("", 0, 100);
    expect(listed.items.map((item) => item.id)).toEqual([id]);
    expect(libraryIndex(assetRoot)!.diagnostics().hashedBytes).toBe(0);
  } finally {
    media.dispose();
  }
});


it("unified native Library view keeps inherited cleanup protection", async () => {
  const { storage, root } = await storedDocument();
  const imageSource = path.join(root, "protected.png");
  const videoSource = path.join(root, "clip.mp4");
  await writeFile(imageSource, Buffer.from("protected-image"));
  await writeFile(videoSource, Buffer.from("video"));
  const image = await storage.importFile(imageSource, "album");
  const video = await storage.importFile(videoSource, "clips");
  const browser = new NativeLibraryBrowser(
    storage.assetRoot,
    (id) => storage.libraryAssetMetadata(id),
    (file, folder) => storage.importFile(file, folder),
    async () => undefined,
    () => {},
  );

  await browser.run({
    type: "protect",
    path: "images/album",
    protected: true,
  });

  const directoryReads = vi.spyOn(nodeFs.promises, "readdir");
  const all = await browser.run({
    type: "list",
    category: "all",
    folder: "",
    query: "",
    all: true,
    offset: 0,
    limit: 100,
  });
  const readsAfterFirstPage = directoryReads.mock.calls.length;
  await browser.run({
    type: "list",
    category: "all",
    folder: "",
    query: "",
    all: true,
    offset: 1,
    limit: 1,
  });
  expect(directoryReads.mock.calls.length).toBe(readsAfterFirstPage);
  expect(all.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "images",
        asset: expect.objectContaining({ id: image.id }),
        protection: "parent",
      }),
      expect.objectContaining({
        category: "video",
        asset: expect.objectContaining({ id: video.id }),
        protection: undefined,
      }),
    ]),
  );

  const images = await browser.run({
    type: "list",
    category: "images",
    folder: "",
    query: "",
    all: false,
    offset: 0,
    limit: 100,
  });
  expect(images.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "images/album",
        kind: "folder",
        protection: "self",
      }),
    ]),
  );
  directoryReads.mockRestore();
  browser.dispose();
});

it("restoring one Effect ignores unrelated malformed Effect files", async () => {
  const { storage } = await storedDocument();
  const effectsRoot = path.join(storage.assetRoot, "Effects");
  const effects = new EffectLibraryStorage(effectsRoot);
  const created = await effects.run({
    type: "save",
    definition: { ...blankEffect("shader"), name: "Recover Me" },
  });
  const asset = created.entries[0].asset;
  await effects.run({
    type: "delete",
    id: asset.id,
    revision: asset.revision,
  });
  await writeFile(path.join(effectsRoot, "broken.txt"), "{ definitely invalid");

  const trashRoot = path.join(storage.assetRoot, "Trash", "assets");
  const [trashFolder] = await readdir(trashRoot);
  const trashDirectory = path.join(trashRoot, trashFolder);
  const trashFiles = await readdir(trashDirectory);
  const effectFile = trashFiles.find((name) => name !== "item.json");
  expect(effectFile).toBeTruthy();

  const browser = new NativeLibraryBrowser(
    storage.assetRoot,
    (id) => storage.libraryAssetMetadata(id),
    (file, folder) => storage.importFile(file, folder),
    async () => undefined,
    () => {},
  );
  await browser.run({
    type: "restore",
    path: `Trash/assets/${trashFolder}/${effectFile!}`,
  });
  expect((await readdir(effectsRoot)).some((name) => name !== "broken.txt")).toBe(
    true,
  );
  expect(await readFile(path.join(effectsRoot, "broken.txt"), "utf8")).toContain(
    "definitely invalid",
  );
  browser.dispose();
});
