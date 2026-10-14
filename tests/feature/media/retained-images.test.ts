import { processPresentationImage } from "../../../electron/imageProcessor";
import { promises as fileSystem } from "node:fs";
import { mkdir } from "node:fs/promises";
import { cleanupDiscardedImages } from "../../../electron/storage/imageVariantCache";
import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import sharp from "sharp";
import { ImageVariantCache } from "../../../electron/storage/imageVariantCache";

it("cold image variants reuse processing workers and recover from rejected source validation", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-image-pool-"));
  const cache = new ImageVariantCache(
    () => path.join(folder, "cache"),
    path.join(folder, "worker.cjs"),
  );
  try {
    const sharpPath = createRequire(import.meta.url).resolve("sharp");
    await build({
      entryPoints: ["electron/imageWorker.ts"],
      outfile: path.join(folder, "worker.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: [sharpPath],
      alias: { sharp: sharpPath },
    });
    const bytes = await sharp({
      create: { width: 1024, height: 768, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const source = path.join(folder, "source.png");
    await writeFile(source, bytes);
    const assetId = createHash("sha256").update(bytes).digest("hex");
    await expect(
      cache.prepare(source, "a".repeat(64), 100, 100, 100),
    ).rejects.toThrow("Source image hash mismatch");
    const first = await cache.prepare(source, assetId, 320, 320, 180);
    const second = await cache.prepare(source, assetId, 640, 640, 360);
    expect(first).toMatchObject({
      width: 320,
      height: 180,
      sourceWidth: 1024,
      sourceHeight: 768,
    });
    expect(second).toMatchObject({
      width: 640,
      height: 360,
      sourceWidth: 1024,
      sourceHeight: 768,
    });
    expect(cache.diagnostics()).toMatchObject({ jobs: 3, workerStarts: 1 });
    const pixels = await sharp(
      await readFile(path.join(cache.root, second!.hash + ".png")),
    )
      .raw()
      .toBuffer();
    expect([...pixels.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  } finally {
    await cache.releaseOnQuit(false);
    await rm(folder, { recursive: true, force: true });
  }
});

it("retained derivatives survive restart, clear safely across processes, and rebuild after deletion", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-retained-"));
  try {
    const worker = path.join(folder, "worker.cjs");
    await build({
      entryPoints: ["electron/imageWorker.ts"],
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: [createRequire(import.meta.url).resolve("sharp")],
      alias: { sharp: createRequire(import.meta.url).resolve("sharp") },
    });
    const bytes = await sharp({
      create: { width: 1024, height: 768, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const source = path.join(folder, "source.png");
    await writeFile(source, bytes);
    const assetId = createHash("sha256").update(bytes).digest("hex"),
      retained = path.join(folder, "retained");
    const first = new ImageVariantCache(
      () => path.join(folder, "session1"),
      worker,
      () => retained,
    );
    const image = await first.prepare(source, assetId, 320, 320, 180);
    expect(image).not.toBeNull();
    expect(first.diagnostics().jobs).toBe(1);
    await first.clear(false);
    let retain = true;
    const second = new ImageVariantCache(
      () => path.join(folder, "session2"),
      worker,
      () => retained,
      () => retain,
    );
    const third = new ImageVariantCache(
      () => path.join(folder, "session3"),
      worker,
      () => retained,
    );
    expect(await second.prepare(source, assetId, 320, 320, 180)).toEqual(image);
    expect(await third.prepare(source, assetId, 320, 320, 180)).toEqual(image);
    expect(second.diagnostics()).toMatchObject({ jobs: 0, cacheHits: 1 });
    retain = false;
    await second.clear();
    expect(await third.lookup(image!)).toEqual(image);
    const pixels = await sharp(
      await readFile(path.join(third.root, image!.hash + ".png")),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixels.info).toMatchObject({ width: 320, height: 180 });
    expect([...pixels.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    const restarted = new ImageVariantCache(
      () => path.join(folder, "session4"),
      worker,
      () => retained,
    );
    expect(await restarted.prepare(source, assetId, 320, 320, 180)).toEqual(
      image,
    );
    expect(restarted.diagnostics().jobs).toBe(1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("quit releases cache visibility without waiting for pending jobs or enumerating entries", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-quit-cache-"));
  try {
    const cache = new ImageVariantCache(
      () => path.join(folder, "session"),
      "unused-worker",
    );
    await mkdir(cache.root, { recursive: true });
    await writeFile(
      path.join(cache.root, "a".repeat(64) + ".png"),
      "disposable",
    );
    const internal = cache as unknown as {
      pending: Map<string, Promise<null>>;
    };
    internal.pending.set("blocked", new Promise(() => {}));
    const listing = vi.spyOn(fileSystem, "readdir");
    try {
      await cache.releaseOnQuit(false);
      expect(listing).not.toHaveBeenCalled();
    } finally {
      listing.mockRestore();
    }
    await expect(fileSystem.stat(cache.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cleanupDiscardedImages(path.join(folder, "session"));
    expect(await fileSystem.readdir(path.join(folder, "session"))).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("Audience resizes directly from the original despite a smaller editor derivative", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-direct-image-"));
  try {
    const pixels = Buffer.alloc(1024 * 768 * 4);
    for (let i = 0; i < pixels.length; i++)
      pixels[i] = (i * 37 + Math.floor(i / 4096) * 73) % 256;
    const bytes = await sharp(pixels, {
      raw: { width: 1024, height: 768, channels: 4 },
    })
      .png()
      .toBuffer();
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const source = path.join(folder, "original.png");
    const editor = path.join(folder, "editor.png");
    const audience = path.join(folder, "audience.png");
    await writeFile(source, bytes);
    const smaller = await processPresentationImage(
      source,
      assetId,
      256,
      editor,
      256,
      256,
    );
    const exact = await processPresentationImage(
      source,
      assetId,
      600,
      audience,
      600,
      300,
    );
    expect(exact).toMatchObject({
      assetId,
      width: 600,
      height: 300,
      sourceWidth: 1024,
      sourceHeight: 768,
    });
    expect(exact!.hash).not.toBe(smaller!.hash);
    const direct = await sharp(bytes)
      .autoOrient()
      .resize(600, 300, {
        kernel: sharp.kernel.lanczos3,
        fastShrinkOnLoad: false,
        fit: "fill",
      })
      .withIccProfile("srgb")
      .raw()
      .toBuffer();
    expect(await sharp(audience).raw().toBuffer()).toEqual(direct);
    await expect(
      processPresentationImage(editor, assetId, 600, audience, 600, 300),
    ).rejects.toThrow("Source image hash mismatch");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("JPG cache encoding uses quality 100 and 4:4:4 while transparency and high bit depth keep PNG", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-cache-format-"));
  try {
    const rgba = Buffer.from(Array.from({ length: 64 * 48 * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 37) % 256));
    const opaque = await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
    const source = path.join(folder, "opaque.png"), jpeg = path.join(folder, "result.jpg");
    await writeFile(source, opaque);
    const id = createHash("sha256").update(opaque).digest("hex");
    const image = await processPresentationImage(source, id, 32, jpeg, 32, 24, "jpg");
    expect(image?.mime).toBe("image/jpeg");
    const encoded = await readFile(jpeg);
    expect(await sharp(encoded).metadata()).toMatchObject({ format: "jpeg", width: 32, height: 24, chromaSubsampling: "4:4:4" });
    const expected = await sharp(opaque).autoOrient().resize(32, 24, { kernel: sharp.kernel.lanczos3, fastShrinkOnLoad: false, fit: "fill" })
      .withIccProfile("srgb").jpeg({ quality: 100, chromaSubsampling: "4:4:4", optimiseCoding: true }).toBuffer();
    expect(encoded).toEqual(expected);
    const png = await processPresentationImage(source, id, 32, path.join(folder, "result.png"), 32, 24, "png");
    expect(png?.hash).not.toBe(image?.hash);
    const { validPreparedImage } = await import("../../../src/core/preparedImageValidation");
    expect(validPreparedImage(encoded, 32, 24, "image/jpeg")).toBe(true);
    expect(validPreparedImage(encoded, 31, 24, "image/jpeg")).toBe(false);
    expect(validPreparedImage(encoded.subarray(0, encoded.length - 2), 32, 24, "image/jpeg")).toBe(false);
    expect(validPreparedImage(encoded, 32, 24, "image/png")).toBe(false);
    rgba[3] = 0;
    const transparent = await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
    await writeFile(source, transparent);
    const alpha = await processPresentationImage(source, createHash("sha256").update(transparent).digest("hex"), 32, jpeg, 32, 24, "jpg");
    expect(alpha?.mime).toBe("image/png");
    expect((await sharp(jpeg).metadata()).hasAlpha).toBe(true);
    const high = await sharp(opaque).toColourspace("rgb16").png().toBuffer();
    await writeFile(source, high);
    const precise = await processPresentationImage(source, createHash("sha256").update(high).digest("hex"), 32, jpeg, 32, 24, "jpg");
    expect(precise?.mime).toBe("image/png");
    expect((await sharp(jpeg).metadata()).depth).toBe("ushort");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("PNG and JPG variants coexist, reuse retained files and clear both encodings", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-cache-format-retained-"));
  let format: import("../../../src/core/presentationImages").ImageCacheFormat = "png";
  const cache = new ImageVariantCache(() => path.join(folder, "session1"), path.join(folder, "worker.cjs"), () => path.join(folder, "retained"), () => true, () => format);
  const restarted = new ImageVariantCache(() => path.join(folder, "session2"), path.join(folder, "worker.cjs"), () => path.join(folder, "retained"), () => true, () => format);
  try {
    await build({ entryPoints: ["electron/imageWorker.ts"], outfile: path.join(folder, "worker.cjs"), bundle: true, platform: "node", format: "cjs", external: [createRequire(import.meta.url).resolve("sharp")], alias: { sharp: createRequire(import.meta.url).resolve("sharp") } });
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 4, background: "#00ff00" } }).png().toBuffer();
    const source = path.join(folder, "source.png"), id = createHash("sha256").update(bytes).digest("hex");
    await writeFile(source, bytes);
    const png = await cache.prepare(source, id, 32, 32, 24);
    format = "jpg";
    const jpg = await cache.prepare(source, id, 32, 32, 24);
    expect(jpg?.mime).toBe("image/jpeg");
    expect(jpg?.hash).not.toBe(png?.hash);
    expect(jpg?.url).toMatch(/\.jpg$/);
    expect(await restarted.prepare(source, id, 32, 32, 24)).toEqual(jpg);
    expect(restarted.diagnostics()).toMatchObject({ jobs: 0, cacheHits: 1 });
    format = "png";
    expect(await cache.prepare(source, id, 32, 32, 24)).toEqual(png);
    expect(cache.diagnostics().jobs).toBe(2);
    await cache.clear();
    expect(await fileSystem.readdir(cache.root)).toEqual([]);
    expect(await fileSystem.readdir(path.join(folder, "retained"))).toEqual([]);
    expect(await restarted.lookup(jpg!)).toEqual(jpg);
  } finally {
    await cache.releaseOnQuit(false); await restarted.releaseOnQuit(false);
    await rm(folder, { recursive: true, force: true });
  }
});
