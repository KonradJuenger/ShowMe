import { validPng } from "../core/pngValidation";
import {
  IMAGE_RECIPE,
  canPrepareImage,
  imageIdentity,
  MAX_PREPARED_IMAGE_PIXELS,
  type PreparedImage,
} from "../core/presentationImages";

const sourceDimensions = new Map<
  string,
  Promise<{ width: number; height: number }>
>();

export const BROWSER_IMAGE_PREFIX = "images/";
export interface BrowserImageRecord {
  blob: Blob;
  descriptor: Omit<PreparedImage, "url">;
}

export async function validBrowserImage(
  record: BrowserImageRecord,
  assetId: string,
) {
  if (!record?.descriptor || !(record.blob instanceof Blob)) return false;
  const image = record.descriptor;
  if (
    image.assetId !== assetId ||
    image.recipe !== IMAGE_RECIPE ||
    image.mime !== "image/png" ||
    !canPrepareImage(
      image.sourceWidth,
      image.sourceHeight,
      image.width,
      image.height,
    ) ||
    ![
      image.size,
      image.width,
      image.height,
      image.sourceWidth,
      image.sourceHeight,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    return false;
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  return validPng(bytes, image.width, image.height);
}

export async function createBrowserImage(
  blob: Blob,
  assetId: string,
  size: number,
  width?: number,
  height?: number,
): Promise<BrowserImageRecord | null> {
  const worker = new Worker(new URL("./imageWorker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{
          result: BrowserImageRecord | null;
          error?: string;
        }>,
      ) => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ blob, assetId, size, width, height });
    });
  } finally {
    worker.terminate();
  }
}

export function browserImageKey(hash: string) {
  return `${BROWSER_IMAGE_PREFIX}${hash}.png`;
}

export async function browserImageDescriptor(
  blob: Blob,
  assetId: string,
  size: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Omit<PreparedImage, "url"> | null> {
  if (blob.size > 256 * 1024 ** 2) return null;
  let dimensions = sourceDimensions.get(assetId);
  if (!dimensions) {
    dimensions = createImageBitmap(blob, { imageOrientation: "from-image" })
      .then((image) => {
        const result = { width: image.width, height: image.height };
        image.close();
        return result;
      })
      .catch((error) => {
        sourceDimensions.delete(assetId);
        throw error;
      });
    sourceDimensions.set(assetId, dimensions);
  }
  const image = await dimensions;
  if (image.width * image.height > MAX_PREPARED_IMAGE_PIXELS) return null;
  const width = Math.min(image.width, targetWidth),
    height = Math.min(image.height, targetHeight);
  if (!canPrepareImage(image.width, image.height, width, height)) return null;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(imageIdentity(assetId, width, height)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    assetId,
    hash,
    size,
    sourceWidth: image.width,
    sourceHeight: image.height,
    width,
    height,
    recipe: IMAGE_RECIPE,
    mime: "image/png",
  };
}
