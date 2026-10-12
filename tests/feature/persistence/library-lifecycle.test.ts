import { expect, it, vi } from "vitest";
import {
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  realpath,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { storedDocument } from "../../helpers/storage";
import { LibraryLifecycle } from "../../../electron/libraryLifecycle";
import { createMediaElement } from "../../../src/core/media";
import { LIBRARY_RETENTION_MS } from "../../../src/core/libraryLifecycle";
import { digest } from "../../../electron/storage/io";
import {
  defaultPresentationsFolderPath,
  initializePresentationsFolder,
  readSettings,
  writeSettings,
} from "../../../electron/settings";

async function libraryFixture() {
  const context = await storedDocument();
  const presentations = path.join(context.root, "presentations");
  await mkdir(presentations);
  const asset = await context.storage.importAssetData(
    "used.png",
    new Uint8Array([1, 2, 3]),
  );
  const unused = await context.storage.importAssetData(
    "unused.png",
    new Uint8Array([4, 5, 6]),
  );
  const source = context.storage.assetPath(asset.id);
  const unusedSource = context.storage.assetPath(unused.id);
  const document = structuredClone(context.runtime.authority.document);
  document.slides[document.deck.slideIds[0]].nodes[0].children.push(
    createMediaElement("library-image", { ...asset, width: 32, height: 32 }),
  );
  context.session.dispose();
  context.storage.closeDocument(context.id);
  let now = Date.parse("2026-10-12T12:00:00Z");
  const deleteTrash = vi.fn(async (file: string) => {
    await rm(file, { recursive: true });
  });
  const lifecycle = new LibraryLifecycle(
    context.storage.assetRoot,
    presentations,
    () => context.storage.openDocuments(),
    context.storage.openProtection,
    deleteTrash,
    () => now,
  );
  await lifecycle.init();
  return {
    ...context,
    presentations,
    asset,
    unused,
    source,
    unusedSource,
    document,
    lifecycle,
    deleteTrash,
    ageTrash: () => {
      now += LIBRARY_RETENTION_MS + 1;
    },
  };
}

it("separate presentations subfolders protect referenced media while cleanup stays inside the media library", async () => {
  const fixture = await libraryFixture();
  const nested = path.join(fixture.presentations, "client", "project");
  await mkdir(nested, { recursive: true });
  const file = path.join(nested, "deck.SME");
  const text = JSON.stringify(fixture.document);
  await writeFile(file, text);
  await writeFile(path.join(nested, "portable.smp"), "not a native document");
  await mkdir(path.join(nested, "deck.recovery.sme"));
  await writeFile(
    path.join(nested, "deck.recovery.sme", "journal.sme"),
    "not a document",
  );
  const outside = path.join(fixture.storage.assetRoot, "outside.sme");
  await writeFile(outside, "not in the selected presentation scope");
  const result = await fixture.lifecycle.scan(true);
  expect(result.complete).toBe(true);
  expect(result.presentations).toBe(1);
  expect(result.referencedBytes).toBe(3);
  expect(result.trash.map((item) => item.hash)).toEqual([fixture.unused.id]);
  await expect(access(fixture.source)).resolves.toBeUndefined();
  await expect(access(fixture.unusedSource)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(text);
  expect(await readFile(outside, "utf8")).toBe(
    "not in the selected presentation scope",
  );
});

it("a malformed nested .sme stops moves and expiry of existing trash", async () => {
  const fixture = await libraryFixture();
  await fixture.lifecycle.scan(true);
  fixture.ageTrash();
  await mkdir(path.join(fixture.presentations, "nested"));
  await writeFile(
    path.join(fixture.presentations, "nested", "invalid.sme"),
    "{",
  );
  const before = await readFile(
    path.join(fixture.presentations, "nested", "invalid.sme"),
    "utf8",
  );
  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(fixture.deleteTrash).not.toHaveBeenCalled();
  expect(
    await readFile(
      path.join(fixture.presentations, "nested", "invalid.sme"),
      "utf8",
    ),
  ).toBe(before);
  await rm(path.join(fixture.presentations, "nested", "invalid.sme"));
  expect((await fixture.lifecycle.scan()).trash).toHaveLength(2);
});

it("an unavailable presentations folder is not recreated and prevents cleanup", async () => {
  const fixture = await libraryFixture();
  await rm(fixture.presentations, { recursive: true });
  await fixture.lifecycle.init();
  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(false);
  await expect(access(fixture.presentations)).rejects.toThrow();
  await expect(access(fixture.source)).resolves.toBeUndefined();
  await expect(access(fixture.unusedSource)).resolves.toBeUndefined();
  expect(fixture.deleteTrash).not.toHaveBeenCalled();
});

it("changed presentations abort cleanup before any media is moved", async () => {
  const fixture = await libraryFixture();
  const file = path.join(fixture.presentations, "deck.sme");
  await writeFile(file, JSON.stringify(fixture.document));
  vi.spyOn(fixture.storage.openProtection, "hashes").mockImplementationOnce(
    async () => {
      fixture.document.slides[fixture.document.deck.slideIds[0]].notes =
        "Changed during scan";
      await writeFile(file, JSON.stringify(fixture.document));
      return new Set();
    },
  );
  const result = await fixture.lifecycle.scan(true);
  expect(result.complete).toBe(false);
  expect(result.errors).toEqual([
    "Presentations changed during Library scan; retry",
  ]);
  await expect(access(fixture.source)).resolves.toBeUndefined();
  await expect(access(fixture.unusedSource)).resolves.toBeUndefined();
});

it("a newly referenced asset in trash is restored from a nested presentation before expiry", async () => {
  const fixture = await libraryFixture();
  expect((await fixture.lifecycle.scan(true)).trash).toHaveLength(2);
  fixture.ageTrash();
  await mkdir(path.join(fixture.presentations, "nested"));
  await writeFile(
    path.join(fixture.presentations, "nested", "deck.sme"),
    JSON.stringify(fixture.document),
  );
  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(true);
  await expect(access(fixture.source)).resolves.toBeUndefined();
  expect(result.referencedBytes).toBe(3);
  expect(result.trash).toHaveLength(0);
  expect(fixture.deleteTrash).toHaveBeenCalledTimes(1);
});

it("open documents and imports remain protected independently of the presentations folder", async () => {
  const fixture = await libraryFixture();
  const lifecycle = new LibraryLifecycle(
    fixture.storage.assetRoot,
    fixture.presentations,
    () => [fixture.document],
    fixture.storage.openProtection,
    fixture.deleteTrash,
  );
  fixture.storage.openProtection.protect([fixture.unused.id]);
  const protectedResult = await lifecycle.scan(true);
  expect(protectedResult.complete, protectedResult.errors.join("\n")).toBe(
    true,
  );
  expect(protectedResult.referencedBytes).toBe(6);
  expect(protectedResult.trash).toHaveLength(0);
  fixture.storage.openProtection.replace([]);
  const result = await lifecycle.scan(true);
  expect(result.complete).toBe(true);
  expect(result.presentations).toBe(0);
  expect(result.referencedBytes).toBe(3);
  expect(result.trash.map((item) => item.hash)).toEqual([fixture.unused.id]);
});

it("collector locks preserve imports, exclude competing collectors and avoid Windows TCP contention", async () => {
  const fixture = await libraryFixture();
  fixture.storage.openProtection.protect([fixture.asset.id, fixture.unused.id]);
  const tcp = createServer();
  let tcpBound = false;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hashes = fixture.storage.openProtection.hashes.bind(
    fixture.storage.openProtection,
  );
  let scanning: ReturnType<LibraryLifecycle["scan"]> | undefined;
  try {
    if (process.platform === "win32") {
      const key = (await realpath(fixture.storage.assetRoot)).toLowerCase();
      const port = 49152 + (parseInt(digest(key).slice(0, 8), 16) % 16384);
      await new Promise<void>((resolve, reject) => {
        tcp.once("error", (error: NodeJS.ErrnoException) => {
          // An already occupied/reserved port also supplies the intended contention.
          if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve();
          else reject(error);
        });
        tcp.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          tcpBound = true;
          resolve();
        });
      });
      const result = await fixture.lifecycle.scan(true);
      expect(result.complete, result.errors.join("\n")).toBe(true);
      expect(result.referencedBytes).toBe(6);
    }
    vi.spyOn(fixture.storage.openProtection, "hashes").mockImplementationOnce(
      async () => {
        entered();
        await held;
        return hashes();
      },
    );
    scanning = fixture.lifecycle.scan(true);
    await acquired;
    const competing = await fixture.lifecycle.scan(true);
    expect(competing.complete).toBe(false);
    expect(competing.errors).toHaveLength(1);
    await expect(access(fixture.source)).resolves.toBeUndefined();
    await expect(access(fixture.unusedSource)).resolves.toBeUndefined();
    release();
    const result = await scanning;
    expect(result.complete, result.errors.join("\n")).toBe(true);
    expect(result.referencedBytes).toBe(6);
    expect(result.trash).toHaveLength(0);
    expect((await fixture.lifecycle.scan(true)).complete).toBe(true);
  } finally {
    release();
    await scanning;
    if (tcpBound)
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
});

it("new settings create an independent presentations default and preserve both paths across reload", async () => {
  const { root } = await storedDocument();
  const user = path.join(root, "new-user");
  await mkdir(user);
  const media = path.join(root, "new-media");
  const settings = { mediaLibraryPath: media };
  const folder = await initializePresentationsFolder(user, settings);
  expect(folder).toBe(defaultPresentationsFolderPath(user));
  expect(folder).not.toContain(media);
  const loaded = await readSettings(user);
  expect(loaded.mediaLibraryPath).toBe(media);
  expect(loaded.presentationsFolderPath).toBe(folder);
  loaded.mediaLibraryPath = path.join(root, "another-media");
  await writeSettings(user, loaded);
  expect((await readSettings(user)).presentationsFolderPath).toBe(folder);
});

it("configured missing presentations paths are preserved without creating an empty cleanup scope", async () => {
  const { root, storage } = await storedDocument();
  const user = path.join(root, "user");
  await mkdir(user);
  const missing = path.join(root, "missing-drive", "presentations");
  await writeSettings(user, {
    mediaLibraryPath: storage.assetRoot,
    presentationsFolderPath: missing,
  });
  const loaded = await readSettings(user);
  expect(await initializePresentationsFolder(user, loaded)).toBe(missing);
  await expect(access(missing)).rejects.toThrow();
});

it("unreadable settings never become a default cleanup scope or get overwritten during initialization", async () => {
  const { root } = await storedDocument();
  const user = path.join(root, "corrupt-user");
  await mkdir(user);
  const file = path.join(user, "settings.json");
  await writeFile(file, "{");
  await expect(readSettings(user)).rejects.toThrow(
    "Could not read ShowMe settings",
  );
  await expect(initializePresentationsFolder(user, {})).rejects.toThrow(
    "Could not read ShowMe settings",
  );
  expect(await readFile(file, "utf8")).toBe("{");
  await writeFile(
    file,
    JSON.stringify({ presentationsFolderPath: "relative/path" }),
  );
  await expect(readSettings(user)).rejects.toThrow(
    "Could not read ShowMe settings",
  );
  await rm(file);
  expect(await readSettings(user)).toEqual({});
  await expect(readSettings(user, { requireExisting: true })).rejects.toThrow(
    "Could not read ShowMe settings",
  );
});
