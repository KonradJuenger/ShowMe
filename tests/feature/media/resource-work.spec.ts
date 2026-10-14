import { expect, test } from "@playwright/test";
import sharp from "sharp";

test("24 MP to a small preview uses bounded tile readback and preserves source dimensions and pixels", async ({
  page,
}) => {
  const png = await sharp({
    create: { width: 6000, height: 4000, channels: 4, background: "#00ff00" },
  })
    .png()
    .toBuffer();
  await page.goto("/");
  const measured = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const blob = new Blob([bytes], { type: "image/png" });
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const worker = new Worker("/tests/helpers/imageMemoryWorker.ts", {
      type: "module",
    });
    try {
      const result = await new Promise<{
        result: {
          blob: Blob;
          descriptor: {
            width: number;
            height: number;
            sourceWidth: number;
            sourceHeight: number;
          };
        };
        peakReadbackBytes: number;
        error?: string;
      }>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = reject;
        worker.postMessage({
          blob,
          assetId: hash,
          size: 320,
          width: 320,
          height: 180,
        });
      });
      if (result.error) throw new Error(result.error);
      const image = await createImageBitmap(result.result.blob),
        canvas = new OffscreenCanvas(320, 180),
        context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      image.close();
      return {
        ...result.result.descriptor,
        peakReadbackBytes: result.peakReadbackBytes,
        pixel: [...context.getImageData(160, 90, 1, 1).data],
      };
    } finally {
      worker.terminate();
    }
  }, png.toString("base64"));
  expect(measured).toMatchObject({
    width: 320,
    height: 180,
    sourceWidth: 6000,
    sourceHeight: 4000,
    pixel: [0, 255, 0, 255],
  });
  expect(measured.peakReadbackBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  console.log(
    "24 MP preview peak RGBA readback bytes:",
    measured.peakReadbackBytes,
  );
});

test("Chromium warmup reuses the actual decoder player in canonical rendering without loading a future slide", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/tests/helpers/videoWarmupHarness.ts";
    const {
      exerciseVideoWarmup,
    }: typeof import("../../helpers/videoWarmupHarness") = await import(
      /* @vite-ignore */ path
    );
    return exerciseVideoWarmup();
  });
  expect(result).toMatchObject({
    unrelated: 0,
    samePlayer: true,
    reloadsBeforeDisposal: 0,
    volume: 0.25,
    muted: true,
    paused: true,
    replay: { same: true, source: true },
  });
  expect(result.readyBefore).toBeGreaterThanOrEqual(2);
  expect(result.replay.start).toBeCloseTo(0.1, 2);
});

test("tiled image preparation preserves EXIF orientation, alpha and representative fine-detail sampling", async ({
  page,
}) => {
  const svg = Buffer.from(
    '<svg width="2048" height="1024" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="17" height="17" patternUnits="userSpaceOnUse"><rect width="17" height="17" fill="white" fill-opacity="0.5"/><path d="M0 0L17 17M17 0L0 17" stroke="black" stroke-width="2"/></pattern></defs><rect width="2048" height="1024" fill="url(#p)"/></svg>',
  );
  const detail = await sharp(svg).png().toBuffer();
  const rotated = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "red" },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 60, height: 80, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer(),
        left: 60,
        top: 0,
      },
    ])
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 100 })
    .toBuffer();
  await page.goto("/");
  const samples = await page.evaluate(
    async ({ detail, rotated }) => {
      const path = "/tests/helpers/imageQualityHarness.ts";
      const {
        compareImageQuality,
      }: typeof import("../../helpers/imageQualityHarness") = await import(
        /* @vite-ignore */ path
      );
      return {
        detail: await compareImageQuality(detail, 512, 256),
        rotated: await compareImageQuality(rotated, 40, 60),
      };
    },
    { detail: detail.toString("base64"), rotated: rotated.toString("base64") },
  );
  expect(samples.detail.meanDifference).toBeLessThan(1);
  expect(samples.detail.maxDifference).toBeLessThanOrEqual(6);
  expect(samples.detail.top[3]).toBeLessThan(255);
  expect(samples.rotated).toMatchObject({
    sourceWidth: 80,
    sourceHeight: 120,
    width: 40,
    height: 60,
  });
  expect(samples.rotated.top[0]).toBeGreaterThan(245);
  expect(samples.rotated.top[2]).toBeLessThan(5);
  expect(samples.rotated.bottom[2]).toBeGreaterThan(245);
  expect(samples.rotated.bottom[0]).toBeLessThan(5);
});

test("browser JPG preference uses maximum quality and preserves even a single source transparency pixel as PNG", async ({ page }) => {
  const rgba = Buffer.alloc(64 * 48 * 4, 255);
  const opaque = await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
  rgba[3] = 0;
  const alpha = await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
  await page.goto("/");
  const results = await page.evaluate(async inputs => {
    const { browserImageDescriptor, createBrowserImage, validBrowserImage } = await import("/src/platform/browserImageCache.ts" as string) as typeof import("../../../src/platform/browserImageCache");
    const rows = [];
    for (const input of inputs) {
      const bytes = Uint8Array.from(atob(input), ch => ch.charCodeAt(0));
      const blob = new Blob([bytes], { type: "image/png" });
      const id = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const descriptor = await browserImageDescriptor(blob, id, 32, 32, 24, "jpg");
      const image = await createBrowserImage(blob, id, 32, 32, 24, "jpg");
      const encoded = new Uint8Array(await image!.blob.arrayBuffer());
      rows.push({ descriptor, image: image!.descriptor, mime: image!.blob.type, valid: await validBrowserImage(image!, id), bytes: Array.from(encoded) });
    }
    return rows;
  }, [opaque.toString("base64"), alpha.toString("base64")]);
  expect(results[0].descriptor?.mime).toBe("image/jpeg");
  expect(results[0].mime).toBe("image/jpeg");
  expect(results[0].descriptor?.hash).toBe(results[0].image.hash);
  expect(await sharp(Buffer.from(results[0].bytes)).metadata()).toMatchObject({ format: "jpeg", chromaSubsampling: "4:4:4", width: 32, height: 24 });
  expect(results[1].descriptor?.mime).toBe("image/png");
  expect(results[1].mime).toBe("image/png");
  expect(results[1].descriptor?.hash).toBe(results[1].image.hash);
  expect(results.map(row => row.valid)).toEqual([true, true]);
});
