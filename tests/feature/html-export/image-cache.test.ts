import { beforeAll, afterAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import sharp from "sharp";
import { HtmlExportImageCache } from "../../../electron/export/imageCache";
import { createHtmlExport } from "../../../electron/export/html";
import { hashFile } from "../../../electron/storage/io";
import {
  imageIdentity,
  JPEG_IMAGE_RECIPE,
  type ImageRequirement,
} from "../../../src/core/presentationImages";
import type { HtmlExportPayload } from "../../../src/export/html/types";
import { htmlExportFixture } from "../../helpers/htmlExportFixture";

let directory: string;
let worker: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "showme-export-images-test-"),
  );
  worker = path.join(directory, "worker.cjs");
  const sharpPath = createRequire(import.meta.url).resolve("sharp");
  await build({
    entryPoints: ["electron/imageWorker.ts"],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [sharpPath],
    alias: { sharp: sharpPath },
  });
  await fs.writeFile(path.join(directory, "runtime.js"), "void 0;");
});
afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function requirement(assetId: string): ImageRequirement {
  return {
    assetId,
    size: 320,
    width: 320,
    height: 180,
    slideIds: [],
    instances: [],
    estimatedBytes: 0,
  };
}

it("caches export JPEGs at the selected quality with original bytes intact and removes temporary images", async () => {
  const file = path.join(directory, "photo.png");
  const pixels = Buffer.alloc(640 * 360 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 97 + (i >> 7)) % 256;
  const original = await sharp(pixels, {
    raw: { width: 640, height: 360, channels: 3 },
  })
    .png()
    .toBuffer();
  await fs.writeFile(file, original);
  const assetId = await hashFile(file);
  const low = new HtmlExportImageCache(worker, 40),
    high = new HtmlExportImageCache(worker, 90);
  let temporary = "";
  try {
    const first = (await low.prepare(
      { file, mime: "image/png" },
      requirement(assetId),
    ))!;
    temporary = path.dirname(path.dirname(first.file));
    expect(
      await low.prepare({ file, mime: "image/png" }, requirement(assetId)),
    ).toEqual(first);
    const second = (await high.prepare(
      { file, mime: "image/png" },
      requirement(assetId),
    ))!;
    expect(first).toMatchObject({
      mime: "image/jpeg",
      sourceWidth: 640,
      sourceHeight: 360,
    });
    expect(await sharp(second.file).metadata()).toMatchObject({
      format: "jpeg",
      width: 320,
      height: 180,
    });
    expect((await fs.stat(second.file)).size).toBeGreaterThan(
      (await fs.stat(first.file)).size,
    );
    expect(path.basename(first.file)).not.toBe(path.basename(second.file));
    expect(imageIdentity(assetId, 320, 180, "jpg")).toBe(
      `${JPEG_IMAGE_RECIPE}:${assetId}:320x180`,
    );
    expect(await fs.readFile(file)).toEqual(original);
  } finally {
    await low.dispose();
    await high.dispose();
  }
  await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves transparency and leaves vector and animated media unconverted", async () => {
  const cache = new HtmlExportImageCache(worker, 90);
  try {
    const file = path.join(directory, "transparent.png");
    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toFile(file);
    const image = (await cache.prepare(
      { file, mime: "image/png" },
      requirement(await hashFile(file)),
    ))!;
    expect(image.mime).toBe("image/png");
    expect((await sharp(image.file).raw().toBuffer())[3]).toBe(128);
    const svg = path.join(directory, "vector.svg");
    await fs.writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>',
    );
    expect(
      await cache.prepare(
        { file: svg, mime: "image/svg+xml" },
        requirement(await hashFile(svg)),
      ),
    ).toBeNull();
    const gif = path.join(directory, "animation.gif");
    const frames = Buffer.concat([
      Buffer.alloc(4 * 4 * 3, 0),
      Buffer.alloc(4 * 4 * 3, 255),
    ]);
    await sharp(frames, {
      raw: { width: 4, height: 8, channels: 3, pageHeight: 4 },
    })
      .gif({ delay: [100, 100] })
      .toFile(gif);
    expect(
      await cache.prepare(
        { file: gif, mime: "image/gif" },
        requirement(await hashFile(gif)),
      ),
    ).toBeNull();
  } finally {
    await cache.dispose();
  }
});

it("embeds prepared sampling only in the exported snapshot and cleans up after assembly failure", async () => {
  const file = path.join(directory, "large.png");
  await sharp({
    create: { width: 1280, height: 720, channels: 3, background: "orange" },
  })
    .png()
    .toFile(file);
  const assetId = await hashFile(file);
  const document = htmlExportFixture();
  const image = document.slides[1].nodes[0].children[0];
  if (image.content?.type !== "image") throw Error("Image fixture required");
  image.content.assetId = assetId;
  const before = structuredClone(document);
  const cache = new HtmlExportImageCache(worker, 90);
  let temporary = "";
  try {
    const { html } = await createHtmlExport({
      document,
      runtimeVersion: "test",
      runtimeDirectory: directory,
      resolveAsset: async (id) =>
        id === assetId ? { file, mime: "image/png" } : null,
      managedFonts: async () => [],
      prepareImage: async (source, requirement) => {
        const prepared = await cache.prepare(source, requirement);
        temporary = path.dirname(path.dirname(prepared!.file));
        return prepared;
      },
    });
    const payload = JSON.parse(
      html.match(
        /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
      )![1],
    ) as HtmlExportPayload;
    const embedded = payload.assets[0];
    expect(embedded.mime).toBe("image/jpeg");
    const bytes = Buffer.from(embedded.data, "base64");
    expect(await sharp(bytes).metadata()).toMatchObject({
      width: 320,
      height: 180,
    });
    expect(
      payload.document.slides[1].nodes[0].children[0].content,
    ).toMatchObject({ assetId: embedded.id });
    expect(document).toEqual(before);
    await expect(
      createHtmlExport({
        document,
        runtimeVersion: "test",
        runtimeDirectory: directory,
        resolveAsset: async (id) =>
          id === assetId ? { file, mime: "image/png" } : null,
        managedFonts: async () => [],
        prepareImage: async () => {
          throw Error("processor failed");
        },
      }),
    ).rejects.toThrow("processor failed");
  } finally {
    await cache.dispose();
  }
  await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
});
