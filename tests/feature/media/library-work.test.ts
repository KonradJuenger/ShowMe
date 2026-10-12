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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { storedDocument } from "../../helpers/storage";
import { libraryIndex, managedFilename } from "../../../electron/mediaLibrary";

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
  expect(cold.diagnostics().hashedBytes).toBe(0);
  expect(await cold.verify(id)).toBe(file);
  expect(cold.diagnostics().hashedBytes).toBe(bytes.length);
  await writeFile(file, Buffer.alloc(1024, 22));
  expect(await cold.verify(id)).toBeNull();
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

it("an unrelated Library arrival does not invalidate an open document", async () => {
  const { storage } = await storedDocument(),
    changed = vi.fn();
  storage.onResourcesChanged = changed;
  const bytes = Buffer.from("unused"),
    id = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    path.join(storage.assetRoot, "images", managedFilename("unused.png", id)),
    bytes,
  );
  await libraryIndex(storage.assetRoot)!.refresh();
  expect(changed).not.toHaveBeenCalled();
});
