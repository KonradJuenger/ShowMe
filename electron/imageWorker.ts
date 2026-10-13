import { parentPort } from "node:worker_threads";
import { processPresentationImage } from "./imageProcessor";

export interface ImageWorkerRequest {
  source: string;
  assetId: string;
  size: number;
  output: string;
  width?: number;
  height?: number;
}
parentPort?.on(
  "message",
  ({ source, assetId, size, output, width, height }: ImageWorkerRequest) => {
    void processPresentationImage(
      source,
      assetId,
      size,
      output,
      width,
      height,
    ).then(
      (result) => parentPort?.postMessage({ result }),
      (error) =>
        parentPort?.postMessage({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  },
);
