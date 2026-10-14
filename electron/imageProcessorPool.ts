import { Worker } from "node:worker_threads";
import type { ImageWorkerRequest } from "./imageWorker";
import type { PreparedImage } from "../src/core/presentationImages";

// Sharp jobs share libuv's process-wide pool (normally four threads). Keep
// admission below that capacity so foreground work and filesystem IO retain room.
export const nativeImageConcurrency = 2;

/** Called only after CPU/memory admission; reuse workers across image jobs. */
export class ImageProcessorPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private closed = false;
  starts = 0;

  constructor(private readonly workerFile: string) {}

  run(request: ImageWorkerRequest): Promise<Omit<PreparedImage, "url"> | null> {
    if (this.closed) return Promise.resolve(null);
    let worker = this.idle.pop();
    if (!worker) {
      worker = new Worker(this.workerFile);
      this.workers.add(worker);
      this.starts++;
      const created = worker;
      const remove = () => {
        this.workers.delete(created);
        this.idle = this.idle.filter((item) => item !== created);
      };
      // Keep idle-worker failures handled, and replace failed slots on demand.
      worker.on("error", remove);
      worker.once("exit", remove);
    }
    const slot = worker;
    slot.ref();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        slot.removeListener("message", message);
        slot.removeListener("error", failed);
        slot.removeListener("exit", exited);
      };
      const message = (reply: {
        result: Omit<PreparedImage, "url"> | null;
        error?: string;
      }) => {
        cleanup();
        if (!this.closed && this.workers.has(slot)) this.idle.push(slot);
        slot.unref();
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply.result);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const exited = (code: number) =>
        failed(new Error("Image worker exited (" + code + ")"));
      slot.once("message", message);
      slot.once("error", failed);
      slot.once("exit", exited);
      slot.postMessage(request);
    });
  }

  close() {
    this.closed = true;
    this.idle = [];
    for (const worker of this.workers) void worker.terminate();
    this.workers.clear();
  }
}
