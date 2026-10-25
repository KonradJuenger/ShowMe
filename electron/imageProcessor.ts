import sharp from "sharp";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { PreparedImage } from "../src/core/presentationImages";
import {
  imageRecipe,
  imageMime,
  type ImageCacheFormat,
  canPrepareImage,
  imageDimensions,
  imageIdentity,
  MAX_PREPARED_IMAGE_PIXELS,
} from "../src/core/presentationImages";
import { animatedRaster } from "../src/core/rasterAnimation";

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 32 });

export async function processPresentationImage(
  source: string,
  assetId: string,
  size: number,
  output: string,
  targetWidth?: number,
  targetHeight?: number,
  preferredFormat: ImageCacheFormat = "png",
  jpegQuality = 100,
): Promise<Omit<PreparedImage, "url"> | null> {
  if ((await fs.stat(source)).size > 256 * 1024 ** 2) return null;
  const bytes = await fs.readFile(source);
  if (createHash("sha256").update(bytes).digest("hex") !== assetId)
    throw new Error("Source image hash mismatch");
  if (animatedRaster(bytes)) return null;
  const metadata = await sharp(bytes, {
    animated: true,
    limitInputPixels: MAX_PREPARED_IMAGE_PIXELS,
  }).metadata();
  if ((metadata.pages ?? 1) > 1 || metadata.format === "svg") return null;
  if (!metadata.width || !metadata.height)
    throw new Error("Image dimensions unavailable");
  const swapped = (metadata.orientation ?? 1) >= 5;
  const sourceWidth = swapped ? metadata.height : metadata.width;
  const sourceHeight = swapped ? metadata.width : metadata.height;
  const fallback = imageDimensions(sourceWidth, sourceHeight, size);
  const width = targetWidth ?? fallback.width,
    height = targetHeight ?? fallback.height;
  if (!canPrepareImage(sourceWidth, sourceHeight, width, height)) return null;
  const format =
    preferredFormat === "jpg" &&
    metadata.depth !== "ushort" &&
    (!metadata.hasAlpha || (await sharp(bytes).stats()).isOpaque)
      ? "jpg"
      : "png";
  // Colour conversion uses the input ICC profile. Tag the resulting SDR image.
  // rgb16 retains precision for high-bit-depth sources; EXIF is consumed once.
  let pipeline = sharp(bytes, { limitInputPixels: MAX_PREPARED_IMAGE_PIXELS })
    .autoOrient()
    .resize(width, height, {
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: false,
      fit: "fill",
    });
  if (metadata.depth === "ushort") pipeline = pipeline.toColourspace("rgb16");
  pipeline = pipeline.withIccProfile("srgb");
  if (format === "jpg")
    await pipeline
      .jpeg({
        quality: jpegQuality,
        chromaSubsampling: "4:4:4",
        optimiseCoding: true,
      })
      .toFile(output);
  else
    await pipeline.png({ compressionLevel: 3, palette: false }).toFile(output);
  const actual = await sharp(output).metadata();
  if (metadata.depth === "ushort" && actual.depth !== "ushort")
    throw new Error("Image processor cannot preserve sample depth");
  return {
    assetId,
    hash: createHash("sha256")
      .update(imageIdentity(assetId, width, height, format, jpegQuality))
      .digest("hex"),
    size,
    sourceWidth,
    sourceHeight,
    width,
    height,
    mime: imageMime(format),
    recipe: imageRecipe(format, jpegQuality),
  };
}
