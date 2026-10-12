import { parentPort, workerData } from "node:worker_threads";
import { processPresentationImage } from "./imageProcessor";

const { source, assetId, size, output, width, height } = workerData as {
  source: string;
  assetId: string;
  size: number;
  output: string;
  width?: number;
  height?: number;
};
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
