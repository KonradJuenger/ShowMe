import { expect, it, vi } from "vitest";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { storedDocument } from "../../helpers/storage";
import {
  LibraryLifecycle,
  assertShowMeRootChangeAllowed,
} from "../../../electron/libraryLifecycle";
import { createMediaElement } from "../../../src/core/media";
import { LIBRARY_RETENTION_MS } from "../../../src/core/libraryLifecycle";
import { digest } from "../../../electron/storage/io";
import {
  readSettings,
  showMeLibraryPath,
  validateShowMeRoot,
  writeSettings,
} from "../../../electron/settings";

async function libraryFixture() {
  const context = await storedDocument();
  const showMeRoot = path.join(context.root, "Studio Shared");
  await mkdir(showMeRoot);
  await context.storage.setAssetRoot(showMeLibraryPath(showMeRoot));

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
    showMeRoot,
    () => context.storage.openDocuments(),
    context.storage.openProtection,
    deleteTrash,
    () => now,
  );
  await lifecycle.init();
  return {
    ...context,
    showMeRoot,
    libraryRoot: showMeLibraryPath(showMeRoot),
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

it("one ShowMe root owns the visible Library and recursive presentation scope", async () => {
  const fixture = await libraryFixture();
  expect(fixture.lifecycle.root).toBe(fixture.showMeRoot);
  expect(fixture.lifecycle.libraryRoot).toBe(fixture.libraryRoot);

  const nested = path.join(
    fixture.showMeRoot,
    "clients",
    "alpha",
    "presentations",
    "2026",
  );
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

  const outside = path.join(fixture.root, "outside.sme");
  await writeFile(outside, "{ this deliberately is not a valid document");

  const result = await fixture.lifecycle.scan(true);
  expect(result.complete, result.errors.join("\n")).toBe(true);
  expect(result.presentations).toBe(1);
  expect(result.referencedBytes).toBe(3);
  expect(result.trash.map((item) => item.hash)).toEqual([fixture.unused.id]);
  await expect(access(fixture.source)).resolves.toBeUndefined();
  await expect(access(fixture.unusedSource)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(text);
  expect(await readFile(outside, "utf8")).toContain("deliberately");
});

it("a malformed nested .sme anywhere below the root blocks moves and expiry", async () => {
  const fixture = await libraryFixture();
  expect((await fixture.lifecycle.scan(true)).complete).toBe(true);
  fixture.ageTrash();

  const nested = path.join(fixture.showMeRoot, "project", "nested");
  await mkdir(nested, { recursive: true });
  const invalid = path.join(nested, "invalid.sme");
  await writeFile(invalid, "{");
  const before = await readFile(invalid, "utf8");

  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(fixture.deleteTrash).not.toHaveBeenCalled();
  expect(await readFile(invalid, "utf8")).toBe(before);

  await rm(invalid);
  expect((await fixture.lifecycle.scan()).trash).toHaveLength(2);
});

it("an unavailable ShowMe root prevents cleanup instead of creating a new scope", async () => {
  const fixture = await libraryFixture();
  const unavailable = fixture.showMeRoot + "-offline";
  await import("node:fs/promises").then(({ rename }) =>
    rename(fixture.showMeRoot, unavailable),
  );

  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(fixture.deleteTrash).not.toHaveBeenCalled();
  await expect(access(fixture.showMeRoot)).rejects.toThrow();
  await expect(
    access(
      path.join(
        unavailable,
        path.relative(fixture.showMeRoot, fixture.unusedSource),
      ),
    ),
  ).resolves.toBeUndefined();
});

it("changed presentations abort cleanup before any Library asset is moved", async () => {
  const fixture = await libraryFixture();
  const file = path.join(fixture.showMeRoot, "deck.sme");
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

it("a managed Library directory escaping through a symlink blocks cleanup", async () => {
  const fixture = await libraryFixture();
  const effects = path.join(fixture.libraryRoot, "Effects");
  const outside = path.join(fixture.root, "outside-effects");
  await rm(effects, { recursive: true });
  await mkdir(outside);
  await symlink(
    outside,
    effects,
    process.platform === "win32" ? "junction" : "dir",
  );

  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete).toBe(false);
  expect(result.errors.join("\n")).toContain("Unsafe Library directory");
  await expect(access(fixture.source)).resolves.toBeUndefined();
  await expect(access(fixture.unusedSource)).resolves.toBeUndefined();
  expect(fixture.deleteTrash).not.toHaveBeenCalled();
});

it("a referenced Trash asset is restored from a deeply nested presentation before expiry", async () => {
  const fixture = await libraryFixture();
  expect((await fixture.lifecycle.scan(true)).trash).toHaveLength(2);
  fixture.ageTrash();

  const nested = path.join(fixture.showMeRoot, "project-a", "slides", "final");
  await mkdir(nested, { recursive: true });
  await writeFile(
    path.join(nested, "deck.sme"),
    JSON.stringify(fixture.document),
  );

  const result = await fixture.lifecycle.scan(true, true);
  expect(result.complete, result.errors.join("\n")).toBe(true);
  await expect(access(fixture.source)).resolves.toBeUndefined();
  expect(result.referencedBytes).toBe(3);
  expect(result.trash).toHaveLength(0);
  expect(fixture.deleteTrash).toHaveBeenCalledTimes(1);
});

it("open documents and imports remain protected independently of saved root files", async () => {
  const fixture = await libraryFixture();
  const lifecycle = new LibraryLifecycle(
    fixture.showMeRoot,
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

it("collector locks preserve imports and exclude competing cleanup collectors", async () => {
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
      const key = (await realpath(fixture.showMeRoot)).toLowerCase();
      const port = 49152 + (parseInt(digest(key).slice(0, 8), 16) % 16384);
      await new Promise<void>((resolve, reject) => {
        tcp.once("error", (error: NodeJS.ErrnoException) => {
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

it("a new installation has no implicit root and requires explicit root setup", async () => {
  const { root } = await storedDocument();
  const user = path.join(root, "new-user");
  const selected = path.join(root, "selected-root");
  await mkdir(user);
  await mkdir(selected);

  expect(await readSettings(user)).toEqual({});
  await expect(validateShowMeRoot(selected)).rejects.toThrow(
    "does not contain a Library directory",
  );
  await expect(access(showMeLibraryPath(selected))).rejects.toThrow();

  await validateShowMeRoot(selected, { createLibrary: true });
  await expect(access(showMeLibraryPath(selected))).resolves.toBeUndefined();
});

it("old two-folder settings do not configure or infer the new ShowMe root", async () => {
  const { root } = await storedDocument();
  const user = path.join(root, "legacy-user");
  await mkdir(user);
  const settingsFile = path.join(user, "settings.json");
  await writeFile(
    settingsFile,
    JSON.stringify({
      mediaLibraryPath: path.join(root, "old-media"),
      presentationsFolderPath: path.join(root, "old-presentations"),
      libraryLifecycleMode: "managed",
    }),
  );

  const loaded = await readSettings(user);
  expect(loaded).toEqual({ libraryLifecycleMode: "managed" });
  expect(loaded.showMeRootPath).toBeUndefined();
});

it("explicit root setup creates only Library and never moves old filesystem contents", async () => {
  const { root } = await storedDocument();
  const selected = path.join(root, "selected-root");
  const oldMedia = path.join(root, "old-media");
  const oldPresentations = path.join(root, "old-presentations");
  await mkdir(selected);
  await mkdir(oldMedia);
  await mkdir(oldPresentations);
  await writeFile(path.join(oldMedia, "asset.bin"), "asset");
  await writeFile(path.join(oldPresentations, "deck.sme"), "presentation");

  const canonical = await validateShowMeRoot(selected, { createLibrary: true });
  expect(canonical).toBe(await realpath(selected));
  await expect(access(showMeLibraryPath(selected))).resolves.toBeUndefined();
  expect(await readFile(path.join(oldMedia, "asset.bin"), "utf8")).toBe("asset");
  expect(
    await readFile(path.join(oldPresentations, "deck.sme"), "utf8"),
  ).toBe("presentation");
});

it("configured missing or malformed roots never become cleanup scopes", async () => {
  const { root } = await storedDocument();
  const user = path.join(root, "user");
  await mkdir(user);
  const missing = path.join(root, "missing-drive", "shared");
  await writeSettings(user, { showMeRootPath: missing });

  const loaded = await readSettings(user);
  expect(loaded.showMeRootPath).toBe(missing);
  await expect(validateShowMeRoot(missing)).rejects.toThrow();
  await expect(access(missing)).rejects.toThrow();

  const file = path.join(user, "settings.json");
  await writeFile(file, "{");
  await expect(readSettings(user)).rejects.toThrow(
    "Could not read ShowMe settings",
  );
  expect(await readFile(file, "utf8")).toBe("{");

  await writeFile(file, JSON.stringify({ showMeRootPath: "relative/path" }));
  await expect(readSettings(user)).rejects.toThrow(
    "Could not read ShowMe settings",
  );
  await rm(file);
  expect(await readSettings(user)).toEqual({});
  await expect(readSettings(user, { requireExisting: true })).rejects.toThrow(
    "Could not read ShowMe settings",
  );
});

it("active host and guest collaboration states block ShowMe root changes", () => {
  expect(() =>
    assertShowMeRootChangeAllowed({
      hosted: { sessionId: "host" },
      clientStatus: "idle",
    }),
  ).toThrow(
    "Stop hosting or leave the active collaboration session before changing the ShowMe root.",
  );
  expect(() =>
    assertShowMeRootChangeAllowed({
      hosted: null,
      clientStatus: "connected",
    }),
  ).toThrow(
    "Stop hosting or leave the active collaboration session before changing the ShowMe root.",
  );
  expect(() =>
    assertShowMeRootChangeAllowed({
      hosted: null,
      clientStatus: "idle",
    }),
  ).not.toThrow();
});
