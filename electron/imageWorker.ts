import { parentPort } from "node:worker_threads";
import { processPresentationImage } from "./imageProcessor";
import type { ImageCacheFormat } from "../src/core/presentationImages";

export interface ImageWorkerRequest {
  source: string;
  assetId: string;
  size: number;
  output: string;
  width?: number;
  height?: number;
  format?: ImageCacheFormat;
}
parentPort?.on(
  "message",
  ({
    source,
    assetId,
    size,
    output,
    width,
    height,
    format,
  }: ImageWorkerRequest) => {
    void processPresentationImage(
      source,
      assetId,
      size,
      output,
      width,
      height,
      format,
    ).then(
      (result) => parentPort?.postMessage({ result }),
      (error) =>
        parentPort?.postMessage({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  },
);
