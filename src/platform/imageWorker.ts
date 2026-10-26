import createPica from "pica/pica_main";
import {
  imageRecipe,
  imageMime,
  type ImageCacheFormat,
  canPrepareImage,
  imageDimensions,
  imageIdentity,
  MAX_PREPARED_IMAGE_PIXELS,
  type PreparedImage,
} from "../core/presentationImages";
import { animatedRaster } from "../core/rasterAnimation";

const resizer = createPica({ concurrency: 1, features: ["js", "wasm"] });
// Pica cannot probe DOM canvas support inside this worker. All scratch surfaces
// use the worker-native canvas, including intermediate stages.
Object.assign(resizer, {
  createCanvas: (width: number, height: number) =>
    new OffscreenCanvas(width, height),
});

async function sourceFormat(
  image: ImageBitmap,
  blob: Blob,
  preferred: ImageCacheFormat,
) {
  if (preferred === "png") return "png" as const;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg" as const;
  if (
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    if (bytes[24] === 16) return "png" as const;
    const alpha = bytes[25] === 4 || bytes[25] === 6;
    let transparency = false;
    const view = new DataView(bytes.buffer);
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at);
      if (
        bytes[at + 4] === 116 &&
        bytes[at + 5] === 82 &&
        bytes[at + 6] === 78 &&
        bytes[at + 7] === 83
      )
        transparency = true;
      at += length + 12;
    }
    if (!alpha && !transparency) return "jpg" as const;
  }
  // Scan the source in bounded tiles: even a transparent pixel lost during
  // downsampling must keep every variant of this source in PNG.
  const canvas = new OffscreenCanvas(512, 512);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  for (let y = 0; y < image.height; y += 512)
    for (let x = 0; x < image.width; x += 512) {
      const width = Math.min(512, image.width - x),
        height = Math.min(512, image.height - y);
      context.clearRect(0, 0, 512, 512);
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      for (let at = 3; at < pixels.length; at += 4)
        if (pixels[at] !== 255) return "png" as const;
    }
  return "jpg" as const;
}

async function inspect(blob: Blob, format: ImageCacheFormat) {
  if (blob.size > 256 * 1024 ** 2) return null;
  const image = await createImageBitmap(blob, {
    imageOrientation: "from-image",
  });
  try {
    if (image.width * image.height > MAX_PREPARED_IMAGE_PIXELS) return null;
    return {
      width: image.width,
      height: image.height,
      format: await sourceFormat(image, blob, format),
    };
  } finally {
    image.close();
  }
}

async function prepare(
  blob: Blob,
  assetId: string,
  size: number,
  targetWidth?: number,
  targetHeight?: number,
  preferredFormat: ImageCacheFormat = "png",
) {
  if (blob.size > 256 * 1024 ** 2) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== assetId) throw new Error("Source image hash mismatch");
  if (animatedRaster(bytes)) return null;
  const text = (at: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(at, at + length));
  if (bytes[0] === 137 && text(1, 3) === "PNG") {
    if (bytes[24] === 16) return null;
  }
  // Chromium decodes ICC/EXIF into the canvas's explicit SDR sRGB space.
  const image = await createImageBitmap(blob, {
    imageOrientation: "from-image",
    colorSpaceConversion: "default",
  });
  try {
    if (image.width * image.height > MAX_PREPARED_IMAGE_PIXELS) return null;
    const fallback = imageDimensions(image.width, image.height, size);
    const width = targetWidth ?? fallback.width,
      height = targetHeight ?? fallback.height;
    if (!canPrepareImage(image.width, image.height, width, height)) return null;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!context) throw new Error("Image canvas unavailable");
    // Read bounded tiles instead of allocating a full-source canvas and RGBA array.
    await resizer.resize(image, canvas, {
      filter: "lanczos3",
      unsharpAmount: 0,
    });
    const format = await sourceFormat(image, blob, preferredFormat);
    const encoded = await canvas.convertToBlob({
      type: imageMime(format),
      quality: 1,
    });
    if (encoded.type !== imageMime(format))
      throw new Error("Requested image encoding is unavailable");
    const descriptor: Omit<PreparedImage, "url"> = {
      assetId,
      hash: Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              imageIdentity(assetId, width, height, format),
            ),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
      size,
      sourceWidth: image.width,
      sourceHeight: image.height,
      width,
      height,
      mime: imageMime(format),
      recipe: imageRecipe(format),
    };
    return { blob: encoded, descriptor };
  } finally {
    image.close();
  }
}

self.onmessage = (
  event: MessageEvent<{
    blob: Blob;
    assetId: string;
    size: number;
    width?: number;
    height?: number;
    format?: ImageCacheFormat;
    operation?: "inspect";
  }>,
) => {
  void (
    event.data.operation === "inspect"
      ? inspect(event.data.blob, event.data.format ?? "png")
      : prepare(
          event.data.blob,
          event.data.assetId,
          event.data.size,
          event.data.width,
          event.data.height,
          event.data.format,
        )
  ).then(
    (result) => self.postMessage({ result }),
    (error) =>
      self.postMessage({
        error: error instanceof Error ? error.message : String(error),
      }),
  );
};
