import { ImageWorkQueue } from "../../src/core/imageWorkQueue";
import { validPng } from "../../src/core/pngValidation";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ImageProcessorPool } from "../imageProcessorPool";
import sharp from "sharp";
import { hashSchema } from "../../src/core/assets";
import {
  IMAGE_RECIPE,
  canPrepareImage,
  imageDimensions,
  imageIdentity,
  MAX_PREPARED_IMAGE_PIXELS,
  type PreparedImage,
} from "../../src/core/presentationImages";
/** Disposable PNGs addressed directly by source, exact dimensions and recipe. */
export class ImageVariantCache {
  private closing = false;
  private async ensureRoot(root: string) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(root), "owner.json"),
      JSON.stringify({ pid: process.pid }),
    );
  }
  /** Cancel publication and remove visibility with constant-size metadata work. */
  async releaseOnQuit(includeRetained = true) {
    this.closing = true;
    this.processors.close();
    this.generation++;
    this.verified.clear();
    const quarantine = async (root: string, expectedParent: string) => {
      try {
        if (
          (await fs.lstat(root)).isSymbolicLink() ||
          (await fs.realpath(root)) !==
            path.join(await fs.realpath(expectedParent), path.basename(root))
        )
          throw new Error("Image cache root is redirected");
        await fs.rename(
          root,
          path.join(expectedParent, "discarded-" + randomUUID()),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    await quarantine(this.root, this.cacheRoot());
    const retained = includeRetained ? this.retainedRoot?.() : null;
    if (retained) await quarantine(retained, path.dirname(retained));
  }
  private pending = new Map<string, Promise<PreparedImage | null>>();
  private demands = new Map<string, { priority: number; canvas?: string }>();
  private activeCanvas: string | undefined;
  prioritizeCanvas(documentId: string, slideId: string) {
    this.activeCanvas = `${documentId}:${slideId}`;
    this.work.setPriorities(
      new Map(
        [...this.demands].map(([key, demand]) => [key, this.priority(demand)]),
      ),
    );
  }
  private priority(demand: { priority: number; canvas?: string }) {
    return demand.canvas &&
      this.activeCanvas &&
      demand.canvas !== this.activeCanvas
      ? 0
      : demand.priority;
  }
  private generation = 0;
  private clearing: Promise<void> | null = null;
  private verified = new Map<
    string,
    { signature: string; image: PreparedImage }
  >();
  private unsupportedSources = new Set<string>();
  private metadata = new Map<string, ReturnType<typeof this.readMetadata>>();
  private work = new ImageWorkQueue();
  private processors: ImageProcessorPool;

  private readMetadata(source: string) {
    return sharp(source, {
      animated: true,
      limitInputPixels: MAX_PREPARED_IMAGE_PIXELS,
    }).metadata();
  }
  private sourceMetadata(source: string) {
    let result = this.metadata.get(source);
    if (!result) {
      result = this.readMetadata(source).catch((error) => {
        this.metadata.delete(source);
        throw error;
      });
      this.metadata.set(source, result);
    }
    return result;
  }
  private jobs = 0;
  private cacheHits = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  constructor(
    private readonly cacheRoot: () => string,
    workerFile: string,
    private readonly retainedRoot?: () => string | null,
    private readonly retentionEnabled: () => boolean = () => true,
  ) {
    this.processors = new ImageProcessorPool(workerFile);
  }
  get root() {
    return path.join(this.cacheRoot(), "images");
  }
  diagnostics() {
    return {
      jobs: this.jobs,
      workerStarts: this.processors.starts,
      cacheHits: this.cacheHits,
      pending: this.pending.size,
      rssBytes: process.memoryUsage().rss,
    };
  }
  async lookup(image: PreparedImage): Promise<PreparedImage | null> {
    hashSchema.parse(image.hash);
    if (
      image.recipe !== IMAGE_RECIPE ||
      image.hash !==
        createHash("sha256")
          .update(imageIdentity(image.assetId, image.width, image.height))
          .digest("hex") ||
      !canPrepareImage(
        image.sourceWidth,
        image.sourceHeight,
        image.width,
        image.height,
      )
    )
      return null;
    try {
      const file = path.join(this.root, image.hash + ".png");
      const stat = await fs.stat(file);
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const known = this.verified.get(file);
      if (known?.signature !== signature) {
        if (!validPng(await fs.readFile(file), image.width, image.height))
          return null;
        this.verified.set(file, { signature, image });
      }
      return image;
    } catch {
      return null;
    }
  }
  prepare(
    source: string,
    assetId: string,
    size: number,
    targetWidth?: number,
    targetHeight?: number,
    priority = 0,
    canvas?: string,
  ): Promise<PreparedImage | null> {
    hashSchema.parse(assetId);
    if (this.clearing || this.closing) return Promise.resolve(null);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100000)
      throw new Error("Invalid image size");
    const root = this.root,
      generation = this.generation;
    const key =
      root +
      ":" +
      generation +
      ":" +
      assetId +
      ":" +
      size +
      ":" +
      targetWidth +
      ":" +
      targetHeight;
    const prior = this.pending.get(key);
    const existing = this.demands.get(key);
    const demand =
      existing && existing.priority > priority
        ? existing
        : { priority, canvas };
    this.demands.set(key, demand);
    if (prior) {
      this.work.setPriorities(new Map([[key, this.priority(demand)]]));
      return prior;
    }
    const job = this.generate(
      root,
      source,
      assetId,
      size,
      generation,
      targetWidth,
      targetHeight,
      key,
    ).finally(() => {
      this.pending.delete(key);
      this.demands.delete(key);
    });
    this.pending.set(key, job);
    return job;
  }
  private async generate(
    root: string,
    source: string,
    assetId: string,
    size: number,
    generation: number,
    targetWidth?: number,
    targetHeight?: number,
    key = "",
  ) {
    if (this.unsupportedSources.has(source)) return null;
    const metadata = await this.sourceMetadata(source);
    if ((metadata.pages ?? 1) > 1 || metadata.format === "svg") {
      this.unsupportedSources.add(source);
      return null;
    }
    if (!metadata.width || !metadata.height)
      throw new Error("Image dimensions unavailable");
    const swapped = (metadata.orientation ?? 1) >= 5;
    const sourceWidth = swapped ? metadata.height : metadata.width;
    const sourceHeight = swapped ? metadata.width : metadata.height;
    const fallback = imageDimensions(sourceWidth, sourceHeight, size);
    const requestedWidth = targetWidth ?? fallback.width,
      requestedHeight = targetHeight ?? fallback.height;
    const width = Math.min(sourceWidth, requestedWidth),
      height = Math.min(sourceHeight, requestedHeight);
    if (
      ![width, height].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 100000,
      )
    )
      throw new Error("Invalid image dimensions");
    if (!canPrepareImage(sourceWidth, sourceHeight, width, height)) return null;
    const hash = createHash("sha256")
      .update(imageIdentity(assetId, width, height))
      .digest("hex");
    const image: PreparedImage = {
      assetId,
      hash,
      size,
      sourceWidth,
      sourceHeight,
      width,
      height,
      recipe: IMAGE_RECIPE,
      mime: "image/png",
      url: "studio://presentation-image/" + hash + ".png",
    };
    if ((await this.lookup(image)) || (await this.restoreRetained(image))) {
      this.cacheHits++;
      return image;
    }
    await this.ensureRoot(root);
    const output = path.join(
      root,
      createHash("sha256").update(randomUUID()).digest("hex") + ".tmp.png",
    );
    try {
      const result = await this.work.run(
        sourceWidth * sourceHeight * 24,
        () => {
          this.jobs++;
          return this.processors.run({
            source,
            assetId,
            size,
            output,
            width,
            height,
          });
        },
        {
          key,
          priority: this.priority(this.demands.get(key) ?? { priority: 0 }),
        },
      );
      if (!result) {
        this.unsupportedSources.add(source);
        return null;
      }
      if (
        result.hash !== hash ||
        result.width !== width ||
        result.height !== height
      )
        throw new Error("Image worker returned different dimensions");
      const bytes = await fs.readFile(output);
      await this.serializeWrite(async () => {
        if (root !== this.root || generation !== this.generation)
          throw new Error("Image cache generation changed");
        if (!validPng(bytes, width, height))
          throw new Error("Image worker returned invalid PNG");
        // Publish once: another process may already have published this same key.
        // Never overwrite a valid immutable preview or unlink a winner on cancellation.
        const destination = path.join(root, hash + ".png");
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fs.link(output, destination);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (await this.lookup(image)) return;
            await fs.unlink(destination).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        }
        throw new Error("Image cache publication interrupted");
      });
      await this.lookup(image);
      await this.retain(image).catch((error) =>
        console.error("Retained image cache publication failed", error),
      );
      return image;
    } finally {
      await fs.unlink(output).catch(() => {});
    }
  }
  private async restoreRetained(image: PreparedImage) {
    if (!this.retentionEnabled()) return false;
    const retained = this.retainedRoot?.();
    if (!retained) return false;
    const source = path.join(retained, image.hash + ".png");
    try {
      if (!validPng(await fs.readFile(source), image.width, image.height))
        return false;
      await this.ensureRoot(this.root);
      await fs
        .link(source, path.join(this.root, image.hash + ".png"))
        .catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      return !!(await this.lookup(image));
    } catch {
      return false;
    }
  }
  private async retain(image: PreparedImage) {
    if (this.closing || !this.retentionEnabled()) return;
    const retained = this.retainedRoot?.();
    if (!retained) return;
    await fs.mkdir(retained, { recursive: true });
    const destination = path.join(retained, image.hash + ".png");
    try {
      await fs.link(path.join(this.root, image.hash + ".png"), destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        !validPng(await fs.readFile(destination), image.width, image.height)
      ) {
        await fs.unlink(destination);
        await fs
          .link(path.join(this.root, image.hash + ".png"), destination)
          .catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
      }
    }
  }
  async remove(hash: string) {
    hashSchema.parse(hash);
    // Generation resolves before publication; wait until active writers finish.
    if (this.pending.size) return false;
    const root = this.root;
    try {
      const realCache = await fs.realpath(this.cacheRoot());
      if ((await fs.realpath(root)) !== path.join(realCache, "images"))
        throw new Error("Image cache root is redirected");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (root !== this.root || this.pending.size) return false;
    await fs.unlink(path.join(root, hash + ".png")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }
  clear(includeRetained = true): Promise<void> {
    if (this.clearing) return this.clearing;
    this.generation++;
    this.verified.clear();
    const pending = [...this.pending.values()];
    this.clearing = (async () => {
      // Let cancelled writers remove their temporary files before quitting.
      await Promise.allSettled(pending);
      await this.serializeWrite(async () => {
        const root = path.resolve(this.root);
        await fs.mkdir(root, { recursive: true });
        const realCache = await fs.realpath(this.cacheRoot());
        if ((await fs.realpath(root)) !== path.join(realCache, "images"))
          throw new Error("Image cache root is redirected");
        const retained = includeRetained ? this.retainedRoot?.() : null;
        if (retained) {
          const expected = path.resolve(retained);
          await fs.mkdir(expected, { recursive: true });
          if ((await fs.realpath(expected)) !== expected)
            throw new Error("Retained image cache root is redirected");
          // Other processes pin immutable entries through their own hard links.
          for (const name of await fs.readdir(expected))
            if (/^[a-f0-9]{64}\.png$/.test(name))
              await fs.unlink(path.join(expected, name)).catch((error) => {
                if (error.code !== "ENOENT") throw error;
              });
        }
        for (const name of await fs.readdir(root)) {
          if (/^[a-f0-9]{64}(?:\.tmp)?\.png$/.test(name))
            await fs.unlink(path.join(root, name)).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
      });
    })().finally(() => {
      this.clearing = null;
    });
    return this.clearing;
  }
}

/** Only disposable, explicitly quarantined entries are removed; unknown files survive. */
export async function cleanupDiscardedImages(parent: string) {
  for (const entry of await fs
    .readdir(parent, { withFileTypes: true })
    .catch(() => [])) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^discarded-[a-f0-9-]{36}$/.test(entry.name)
    )
      continue;
    const folder = path.join(parent, entry.name);
    for (const file of await fs.readdir(folder, { withFileTypes: true })) {
      if (
        file.isFile() &&
        !file.isSymbolicLink() &&
        (/^[a-f0-9]{64}(?:\.tmp)?\.png$/.test(file.name) ||
          file.name === "owner.json")
      )
        await fs.unlink(path.join(folder, file.name)).catch(() => {});
    }
    await fs.rmdir(folder).catch(() => {});
  }
}

export async function cleanupImageSessions(parent: string) {
  for (const entry of await fs
    .readdir(parent, { withFileTypes: true })
    .catch(() => [])) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^[a-f0-9-]{36}$/.test(entry.name)
    )
      continue;
    const session = path.join(parent, entry.name);
    try {
      const owner = JSON.parse(
        await fs.readFile(path.join(session, "owner.json"), "utf8"),
      );
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
      try {
        process.kill(owner.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      const images = path.join(session, "images");
      const stat = await fs.lstat(images).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink())
        await fs.rename(
          images,
          path.join(session, "discarded-" + randomUUID()),
        );
      await cleanupDiscardedImages(session);
      if ((await fs.readdir(session)).every((name) => name === "owner.json")) {
        await fs.unlink(path.join(session, "owner.json"));
        await fs.rmdir(session);
      }
    } catch {
      /* Unknown ownership is preserved. */
    }
  }
}
