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
