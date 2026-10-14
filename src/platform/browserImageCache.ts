import { validPreparedImage } from "../core/preparedImageValidation";
import {
  imageRecipe,
  imageMime,
  imageExtension,
  type ImageCacheFormat,
  type PreparedImageMime,
  canPrepareImage,
  imageIdentity,
  MAX_PREPARED_IMAGE_PIXELS,
  type PreparedImage,
} from "../core/presentationImages";

const sourceDimensions = new Map<
  string,
  Promise<{ width: number; height: number; format: ImageCacheFormat } | null>
>();

export const BROWSER_IMAGE_PREFIX = "images/";
export interface BrowserImageRecord {
  blob: Blob;
  descriptor: Omit<PreparedImage, "url">;
}

const imageWorkers = new Set<Worker>();
const idleImageWorkers: Worker[] = [];
const imageWorkerWaiters: Array<{
  resolve: (worker: Worker) => void;
  reject: (error: Error) => void;
}> = [];
const activeImageJobs = new Map<Worker, (error: Error) => void>();

function createImageWorker() {
  const worker = new Worker(new URL("./imageWorker.ts", import.meta.url), {
    type: "module",
  });
  imageWorkers.add(worker);
  worker.addEventListener("error", () => {
    imageWorkers.delete(worker);
    const index = idleImageWorkers.indexOf(worker);
    if (index >= 0) idleImageWorkers.splice(index, 1);
    worker.terminate();
  });
  return worker;
}

async function acquireImageWorker() {
  const idle = idleImageWorkers.pop();
  if (idle) return idle;
  if (imageWorkers.size < 2) return createImageWorker();
  return new Promise<Worker>((resolve, reject) =>
    imageWorkerWaiters.push({ resolve, reject }),
  );
}

function releaseImageWorker(worker: Worker) {
  const waiter = imageWorkerWaiters.shift();
  if (waiter)
    waiter.resolve(imageWorkers.has(worker) ? worker : createImageWorker());
  else if (imageWorkers.has(worker)) idleImageWorkers.push(worker);
}

window.addEventListener("pagehide", () => {
  const error = new Error("Image worker owner closed");
  for (const job of activeImageJobs.values()) job(error);
  for (const worker of imageWorkers) worker.terminate();
  imageWorkers.clear();
  idleImageWorkers.length = 0;
  for (const waiter of imageWorkerWaiters.splice(0)) waiter.reject(error);
});

export async function validBrowserImage(
  record: BrowserImageRecord,
  assetId: string,
) {
  if (!record?.descriptor || !(record.blob instanceof Blob)) return false;
  const image = record.descriptor;
  if (
    image.assetId !== assetId ||
    !["image/png", "image/jpeg"].includes(image.mime) ||
    image.recipe !== imageRecipe(imageExtension(image.mime)) ||
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
  return validPreparedImage(bytes, image.width, image.height, image.mime);
}

export async function createBrowserImage(
  blob: Blob,
  assetId: string,
  size: number,
  width?: number,
  height?: number,
  format: ImageCacheFormat = "png",
): Promise<BrowserImageRecord | null> {
  return runImageWorker<BrowserImageRecord | null>({
    blob,
    assetId,
    size,
    width,
    height,
    format,
  });
}

async function runImageWorker<T>(request: {
  blob: Blob;
  assetId: string;
  size: number;
  width?: number;
  height?: number;
  format: ImageCacheFormat;
  operation?: "inspect";
}): Promise<T> {
  const worker = await acquireImageWorker();
  try {
    return await new Promise((resolve, reject) => {
      activeImageJobs.set(worker, reject);
      worker.onmessage = (
        event: MessageEvent<{
          result: T;
          error?: string;
        }>,
      ) => {
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(request);
    });
  } finally {
    activeImageJobs.delete(worker);
    worker.onmessage = worker.onerror = null;
    releaseImageWorker(worker);
  }
}

export function browserImageKey(
  hash: string,
  mime: PreparedImageMime = "image/png",
) {
  return `${BROWSER_IMAGE_PREFIX}${hash}.${imageExtension(mime)}`;
}

export async function browserImageDescriptor(
  blob: Blob,
  assetId: string,
  size: number,
  targetWidth: number,
  targetHeight: number,
  preferredFormat: ImageCacheFormat = "png",
): Promise<Omit<PreparedImage, "url"> | null> {
  if (blob.size > 256 * 1024 ** 2) return null;
  const key = `${assetId}:${preferredFormat}`;
  let dimensions = sourceDimensions.get(key);
  if (!dimensions) {
    dimensions = runImageWorker<{
      width: number;
      height: number;
      format: ImageCacheFormat;
    } | null>({
      blob,
      assetId,
      size: 1,
      format: preferredFormat,
      operation: "inspect",
    }).catch((error) => {
      sourceDimensions.delete(key);
      throw error;
    });
    sourceDimensions.set(key, dimensions);
  }
  const image = await dimensions;
  if (!image || image.width * image.height > MAX_PREPARED_IMAGE_PIXELS)
    return null;
  const width = Math.min(image.width, targetWidth),
    height = Math.min(image.height, targetHeight);
  if (!canPrepareImage(image.width, image.height, width, height)) return null;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          imageIdentity(assetId, width, height, image.format),
        ),
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
    recipe: imageRecipe(image.format),
    mime: imageMime(image.format),
  };
}
