import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { storedDocument } from "../../helpers/storage";
import { NativeLibraryBrowser } from "../../../electron/libraryBrowser";
import {
  LibraryIndex,
  libraryIndex,
  managedFilename,
} from "../../../electron/mediaLibrary";
import {
  LibraryObservationChanged,
  observeLibrary,
} from "../../../electron/libraryFilesystem";

const browsers: NativeLibraryBrowser[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const browser of browsers.splice(0)) browser.dispose();
});

async function fixture() {
  const { storage, root } = await storedDocument();
  const browser = new NativeLibraryBrowser(
    storage.assetRoot,
    (id) => storage.libraryAssetMetadata(id),
    (file, folder) => storage.importFile(file, folder),
    async () => undefined,
    () => {},
  );
  browsers.push(browser);
  const list = () =>
    browser.run({
      type: "list",
      category: "images",
      folder: "",
      query: "",
      all: true,
      offset: 0,
      limit: 100,
    });
  return { root, storage, browser, list };
}

it("index retries an enumerated managed file moving before lstat and publishes only its current path", async () => {
  const { storage } = await fixture();
  const asset = await storage.importAssetData("race.png", Buffer.from("race"));
  const old = storage.assetPath(asset.id);
  const directory = path.join(storage.assetRoot, "images", "nested");
  await fs.mkdir(directory);
  const destination = path.join(directory, path.basename(old));
  const index = libraryIndex(storage.assetRoot)!;
  const original = fs.lstat.bind(fs);
  let moved = false;
  const changed = vi.fn();
  const off = index.subscribe(changed);
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === old && !moved) {
        moved = true;
        await fs.rename(old, destination);
      }
      return original(...args);
    },
  );
  try {
    await expect(index.refresh()).resolves.toBeUndefined();
    expect(moved).toBe(true);
    expect(index.lookup(asset.id)).toBe(destination);
    expect(await storage.verifiedAssetPath(asset.id)).toBe(destination);
    expect(changed).toHaveBeenCalled();
    expect(
      createHash("sha256")
        .update(await fs.readFile(destination))
        .digest("hex"),
    ).toBe(asset.id);
  } finally {
    off();
  }
});

it("browser retries an entry disappearing before stat and returns the relocated asset", async () => {
  const { storage, list } = await fixture();
  const asset = await storage.importAssetData(
    "browser.png",
    Buffer.from("browser race"),
  );
  const old = storage.assetPath(asset.id);
  const folder = path.join(storage.assetRoot, "images", "destination");
  await fs.mkdir(folder);
  const destination = path.join(folder, path.basename(old));
  const original = fs.stat.bind(fs);
  let moved = false;
  vi.spyOn(fs, "stat").mockImplementation(
    async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === old && !moved) {
        moved = true;
        await fs.rename(old, destination);
      }
      return original(...args);
    },
  );
  const result = await list();
  expect(moved).toBe(true);
  expect(result.entries.filter((entry) => entry.kind === "file")).toEqual([
    expect.objectContaining({
      path: `images/destination/${path.basename(old)}`,
      asset: expect.objectContaining({ id: asset.id }),
    }),
  ]);
});

it("two moves complete while an older inventory is paused between enumeration and lstat", async () => {
  const { storage, browser, list } = await fixture();
  const first = await storage.importAssetData(
    "first.png",
    Buffer.from("first"),
  );
  const second = await storage.importAssetData(
    "second.png",
    Buffer.from("second"),
  );
  await browser.run({ type: "mkdir", path: "images/batch" });
  await list();
  const firstSource = storage.assetPath(first.id);
  let observed!: () => void;
  let release!: () => void;
  const observing = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lstat = fs.lstat.bind(fs);
  let paused = false;
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === firstSource && !paused) {
        paused = true;
        observed();
        await resume;
      }
      return lstat(...args);
    },
  );
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    await unlink(file);
    if (String(file) === firstSource) release();
  });
  const scan = libraryIndex(storage.assetRoot)!.refresh();
  await observing;
  try {
    for (const asset of [first, second]) {
      const name = asset.filename;
      await expect(
        browser.run({
          type: "move",
          path: `images/${name}`,
          destination: `images/batch/${name}`,
        }),
      ).resolves.toMatchObject({ reconciliationError: undefined });
    }
    await scan;
    const files = (await list()).entries.filter(
      (entry) => entry.kind === "file",
    );
    expect(files.map((entry) => entry.path).sort()).toEqual(
      [first, second].map((asset) => `images/batch/${asset.filename}`).sort(),
    );
    for (const asset of [first, second])
      expect(await storage.verifiedAssetPath(asset.id)).toBe(
        path.join(storage.assetRoot, "images", "batch", asset.filename),
      );
  } finally {
    release();
    await scan;
  }
});

it("completed mutations survive exhausted transient refreshes and expose separate permission failures", async () => {
  const { storage, browser, list } = await fixture();
  const asset = await storage.importAssetData(
    "refresh.png",
    Buffer.from("refresh"),
  );
  const index = libraryIndex(storage.assetRoot)!;
  await browser.run({ type: "mkdir", path: "images/target" });
  vi.spyOn(index, "refresh").mockRejectedValueOnce(
    new LibraryObservationChanged(),
  );
  await expect(
    browser.run({
      type: "move",
      path: `images/${asset.filename}`,
      destination: `images/target/${asset.filename}`,
    }),
  ).resolves.toMatchObject({ reconciliationError: undefined });
  expect(
    (await list()).entries.some(
      (entry) => entry.path === `images/target/${asset.filename}`,
    ),
  ).toBe(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(index, "refresh").mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );
  const result = await browser.run({
    type: "move",
    path: `images/target/${asset.filename}`,
    destination: `images/${asset.filename}`,
  });
  expect(result.reconciliationError).toContain("permission denied");
  expect(
    (await list()).entries.some(
      (entry) => entry.path === `images/${asset.filename}`,
    ),
  ).toBe(true);
});

it("observation retries are bounded and permission and unsafe-structure errors remain visible", async () => {
  const missing = vi.fn(async () => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  });
  await expect(observeLibrary(missing)).rejects.toBeInstanceOf(
    LibraryObservationChanged,
  );
  expect(missing).toHaveBeenCalledTimes(3);
  const permission = Object.assign(new Error("denied"), { code: "EACCES" });
  const denied = vi.fn(async () => {
    throw permission;
  });
  await expect(observeLibrary(denied)).rejects.toBe(permission);
  expect(denied).toHaveBeenCalledTimes(1);
  const { root, storage, list } = await fixture();
  await storage.importAssetData("denied.png", Buffer.from("denied"));
  const deniedStat = vi.spyOn(fs, "stat").mockRejectedValue(permission);
  await expect(list()).rejects.toBe(permission);
  deniedStat.mockRestore();
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(storage.assetRoot, "images", "unsafe"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(list()).rejects.toThrow("symbolic link");
});

it("folder mutations reject nonportable names and case or Unicode-equivalent siblings", async () => {
  const { root, browser, storage } = await fixture();
  for (const name of [
    "CON",
    "CONIN$",
    "CONOUT$",
    "nul.txt",
    "COM1",
    "LPT²",
    "bad:name",
    "bad?name",
    "tail.",
    "tail ",
    ".",
    "..",
    "",
    "bad\\name",
  ])
    await expect(
      browser.run({ type: "mkdir", path: `images/${name}` }),
    ).rejects.toThrow();
  await browser.run({ type: "mkdir", path: "images/Project" });
  await expect(
    browser.run({ type: "mkdir", path: "images/project" }),
  ).rejects.toThrow("collides");
  const importSource = path.join(root, "incoming.png");
  await fs.writeFile(importSource, Buffer.from("new import"));
  await expect(storage.importFile(importSource, "project/new")).rejects.toThrow(
    "collides",
  );
  const asset = await storage.importAssetData(
    "parent.png",
    Buffer.from("new parent"),
  );
  await expect(
    browser.run({
      type: "move",
      path: `images/${asset.filename}`,
      destination: `images/project/new/${asset.filename}`,
    }),
  ).rejects.toThrow("collides");
  await browser.run({ type: "mkdir", path: "images/Café" });
  await expect(
    browser.run({ type: "mkdir", path: "images/Cafe\u0301" }),
  ).rejects.toThrow("collides");
  await browser.run({ type: "mkdir", path: "images/other" });
  await expect(
    browser.run({ type: "rename", path: "images/other", name: "PROJECT" }),
  ).rejects.toThrow("collides");
  await expect(
    browser.run({
      type: "move",
      path: "images/other",
      destination: "images/café",
    }),
  ).rejects.toThrow("collides");
  expect(await fs.readdir(path.join(storage.assetRoot, "images"))).toContain(
    "other",
  );
});

it("renamed valid copies resolve by hash while conflicts and partial sync bytes never become that asset", async () => {
  const { storage, list } = await fixture();
  const bytes = Buffer.from("immutable complete payload");
  const id = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(storage.assetRoot, "images");
  const filename = managedFilename("renamed.png", id, true);
  await fs.writeFile(path.join(folder, filename), bytes.subarray(0, 3));
  await fs.writeFile(
    path.join(folder, `renamed__${id}.sync-conflict.png`),
    Buffer.from("conflict"),
  );
  await fs.writeFile(path.join(folder, "broken__abc.png"), bytes);
  await libraryIndex(storage.assetRoot)!.refresh();
  await expect(storage.verifiedAssetPath(id)).rejects.toThrow(
    "Asset not found",
  );
  const visible = await list();
  expect(visible.entries.filter((entry) => entry.kind === "file")).toHaveLength(
    3,
  );
  expect(
    visible.entries.find((entry) => entry.path.endsWith("broken__abc.png"))
      ?.managed,
  ).toBe(false);
  // Inventory metadata is deliberately cheap and unverified; insertion and
  // presentation byte consumption must still reject these candidate filenames.
  await expect(storage.asset(id)).rejects.toThrow("Asset not found");
  await fs.writeFile(path.join(folder, filename), bytes);
  await libraryIndex(storage.assetRoot)!.refresh();
  expect(await storage.verifiedAssetPath(id)).toBe(path.join(folder, filename));
});

it("deleting and replacing a local inventory cache still reconstructs nested protected media", async () => {
  const { root, storage } = await fixture();
  const folder = path.join(storage.assetRoot, "images", "deep", "nested");
  await fs.mkdir(folder, { recursive: true });
  const bytes = Buffer.from("filesystem owns availability");
  const id = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(folder, managedFilename("available.png", id, true));
  await fs.writeFile(file, bytes);
  const cacheRoot = path.join(root, "replaceable-cache");
  await fs.mkdir(path.join(cacheRoot, "library-index"), { recursive: true });
  await fs.writeFile(
    path.join(
      cacheRoot,
      "library-index",
      createHash("sha256").update(storage.assetRoot).digest("hex") + ".json",
    ),
    "unusable local cache",
  );
  const replaced = new LibraryIndex(storage.assetRoot, cacheRoot);
  try {
    await replaced.ready();
    expect(await replaced.verify(id)).toBe(file);
  } finally {
    replaced.dispose();
  }
  await fs.rm(cacheRoot, { recursive: true });
  const rebuilt = new LibraryIndex(storage.assetRoot, cacheRoot);
  try {
    await rebuilt.ready();
    expect(await rebuilt.verify(id)).toBe(file);
  } finally {
    rebuilt.dispose();
  }
});

it("directory fingerprints catch relocation after a file stat without relying on watcher delivery", async () => {
  const { storage } = await fixture();
  const asset = await storage.importAssetData(
    "late.png",
    Buffer.from("late tree move"),
  );
  const source = storage.assetPath(asset.id);
  const folder = path.join(storage.assetRoot, "images", "earlier");
  await fs.mkdir(folder);
  const destination = path.join(folder, asset.filename);
  const index = new LibraryIndex(storage.assetRoot);
  const lstat = fs.lstat.bind(fs);
  let moved = false;
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      if (!moved && String(args[0]) === path.join(storage.assetRoot, "video")) {
        moved = true;
        await fs.rename(source, destination);
      }
      return lstat(...args);
    },
  );
  try {
    await index.ready();
    expect(moved).toBe(true);
    expect(index.lookup(asset.id)).toBe(destination);
    expect(index.diagnostics().scans).toBe(2);
  } finally {
    index.dispose();
  }
});

it("a partial file move exposes both physical copies immediately without rolling back publication", async () => {
  const { storage, browser, list } = await fixture();
  const asset = await storage.importAssetData(
    "partial.png",
    Buffer.from("partial move"),
  );
  await browser.run({ type: "mkdir", path: "images/destination" });
  await list();
  const source = storage.assetPath(asset.id);
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (String(file) === source)
      throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
    return unlink(file);
  });
  await expect(
    browser.run({
      type: "move",
      path: `images/${asset.filename}`,
      destination: `images/destination/${asset.filename}`,
    }),
  ).rejects.toThrow("unlink denied");
  const files = (await list()).entries.filter((entry) => entry.kind === "file");
  expect(files.map((entry) => entry.path).sort()).toEqual(
    [`images/${asset.filename}`, `images/destination/${asset.filename}`].sort(),
  );
});

it("an exhausted startup observation can be retried instead of poisoning the disposable index", async () => {
  const { storage } = await fixture();
  const asset = await storage.importAssetData(
    "startup.png",
    Buffer.from("startup retry"),
  );
  const source = storage.assetPath(asset.id);
  const index = new LibraryIndex(storage.assetRoot);
  const lstat = fs.lstat.bind(fs);
  let failures = 0;
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === source && failures++ < 3)
        throw Object.assign(new Error("disappeared"), { code: "ENOENT" });
      return lstat(...args);
    },
  );
  try {
    await expect(index.ready()).rejects.toBeInstanceOf(
      LibraryObservationChanged,
    );
    expect(index.files.size).toBe(0);
    await index.ready();
    expect(await index.verify(asset.id)).toBe(source);
  } finally {
    index.dispose();
  }
});
