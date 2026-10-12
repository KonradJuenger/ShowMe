import createPica from "pica/pica_main";
import type { PreparedImage } from "../../src/core/presentationImages";
export async function compareImageQuality(
  base64: string,
  width: number,
  height: number,
) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    blob = new Blob([bytes]);
  const assetId = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const worker = new Worker(
    new URL("../../src/platform/imageWorker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const reply = await new Promise<{
      result: { blob: Blob; descriptor: PreparedImage };
      error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = reject;
      worker.postMessage({ blob, assetId, size: width, width, height });
    });
    if (reply.error) throw new Error(reply.error);
    const original = await createImageBitmap(blob, {
        imageOrientation: "from-image",
        colorSpaceConversion: "default",
      }),
      source = new OffscreenCanvas(original.width, original.height),
      context = source.getContext("2d", { colorSpace: "srgb" })!;
    context.drawImage(original, 0, 0);
    original.close();
    const reference = await createPica({
      concurrency: 1,
      features: ["js", "wasm"],
    }).resizeBuffer({
      src: new Uint8Array(
        context.getImageData(0, 0, source.width, source.height).data.buffer,
      ),
      width: source.width,
      height: source.height,
      toWidth: width,
      toHeight: height,
      filter: "lanczos3",
      unsharpAmount: 0,
    });
    const image = await createImageBitmap(reply.result.blob),
      output = new OffscreenCanvas(width, height),
      target = output.getContext("2d")!;
    target.drawImage(image, 0, 0);
    image.close();
    const actual = target.getImageData(0, 0, width, height).data;
    let sum = 0,
      max = 0;
    for (let i = 0; i < actual.length; i++) {
      const difference = Math.abs(actual[i] - reference[i]);
      sum += difference;
      max = Math.max(max, difference);
    }
    const pixel = (x: number, y: number) => [
      ...actual.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
    ];
    return {
      ...reply.result.descriptor,
      meanDifference: sum / actual.length,
      maxDifference: max,
      top: pixel(Math.floor(width / 2), Math.floor(height / 4)),
      bottom: pixel(Math.floor(width / 2), Math.floor((3 * height) / 4)),
    };
  } finally {
    worker.terminate();
  }
}
