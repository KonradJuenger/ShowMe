import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageVariantCache } from "../storage/imageVariantCache";
import {
  imageExtension,
  type ImageRequirement,
} from "../../src/core/presentationImages";
import type { HtmlAssetSource } from "./html";

/** Reuses the presentation cache pipeline without changing desktop cache settings. */
export class HtmlExportImageCache {
  private directory: string | undefined;
  private cache: ImageVariantCache | undefined;

  constructor(
    private readonly workerFile: string,
    private readonly quality: number,
  ) {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100)
      throw new Error("HTML export JPEG quality must be between 1 and 100");
  }

  async prepare(source: HtmlAssetSource, requirement: ImageRequirement) {
    if (!this.cache) {
      this.directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "showme-html-images-"),
      );
      this.cache = new ImageVariantCache(
        () => this.directory!,
        this.workerFile,
        undefined,
        () => false,
        () => "jpg",
        () => this.quality,
      );
    }
    const image = await this.cache.prepare(
      source.file,
      requirement.assetId,
      requirement.size,
      requirement.width,
      requirement.height,
    );
    return image
      ? {
          file: path.join(
            this.cache.root,
            image.hash + "." + imageExtension(image.mime),
          ),
          mime: image.mime,
          sourceWidth: image.sourceWidth,
          sourceHeight: image.sourceHeight,
        }
      : null;
  }

  async dispose() {
    try {
      await this.cache?.releaseOnQuit(false);
    } finally {
      if (this.directory)
        await fs.rm(this.directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
    }
  }
}
