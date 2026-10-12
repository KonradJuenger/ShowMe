import createPica from "pica/pica_main";
import {
  IMAGE_RECIPE,
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
Object.assign(resizer, { createCanvas: (width: number, height: number) => new OffscreenCanvas(width, height) });

async function prepare(
  blob: Blob,
  assetId: string,
  size: number,
  targetWidth?: number,
  targetHeight?: number,
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
    if (bytes[24] === 16)
      return null;
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
    await resizer.resize(image, canvas, { filter: "lanczos3", unsharpAmount: 0 });
    const png = await canvas.convertToBlob({ type: "image/png" });
    const descriptor: Omit<PreparedImage, "url"> = {
      assetId,
      hash: Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(imageIdentity(assetId, width, height)),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
      size,
      sourceWidth: image.width,
      sourceHeight: image.height,
      width,
      height,
      mime: "image/png",
      recipe: IMAGE_RECIPE,
    };
    return { blob: png, descriptor };
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
  }>,
) => {
  void prepare(
    event.data.blob,
    event.data.assetId,
    event.data.size,
    event.data.width,
    event.data.height,
  ).then(
    (result) => self.postMessage({ result }),
    (error) =>
      self.postMessage({
        error: error instanceof Error ? error.message : String(error),
      }),
  );
};
