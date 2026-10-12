import { ASSET_VERSION } from "../../src/core/assets";
import { promises as fs } from "node:fs";
import path from "node:path";
import { idSchema } from "../../src/core/ids";
import {
  assetCategoryCounts,
  assetSchema,
  compareAssetsByCategoryAndName,
  hashSchema,
  mediaType,
  type Asset,
} from "../../src/core/assets";
import {
  findManagedFile,
  ensureLibraryIndex,
  libraryIndex,
  importManagedFile,
  MEDIA_FOLDERS,
} from "../mediaLibrary";
import { atomicWrite } from "./io";

type DerivedAssetEntry = { file: string; asset: Asset };

export class StorageMedia {
  public assetRoot: string;
  onChanged?: (change: import("../mediaLibrary").LibraryChange) => void;
  private unsubscribe?: () => void;
  public readonly cacheRoot: string;
  private readonly derivedAssets = new Map<string, DerivedAssetEntry>();
  private derivedAssetsLoaded = false;
  private readonly locators = new Map<
    string,
    {
      filename: string;
      mediaType: "image" | "video" | "audio" | "font" | "other";
    }
  >();

  constructor(assetRoot: string, cacheRoot: string) {
    this.assetRoot = path.resolve(assetRoot);
    this.cacheRoot = path.resolve(cacheRoot);
  }

  async init() {
    await fs.mkdir(this.assetRoot, { recursive: true });
    for (const folder of MEDIA_FOLDERS)
      await fs.mkdir(path.join(this.assetRoot, folder), { recursive: true });
    await fs.rm(path.join(this.assetRoot, ".showme", "catalog.json"), {
      force: true,
    });
    try {
      await fs.rmdir(path.join(this.assetRoot, ".showme"));
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    await fs.rm(path.join(this.assetRoot, "fonts", ".showme-fonts.json"), {
      force: true,
    });
    const index = await ensureLibraryIndex(this.assetRoot, this.cacheRoot);
    this.unsubscribe?.();
    this.unsubscribe = index.subscribe((change) => this.onChanged?.(change));
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async setAssetRoot(newRoot: string) {
    const previousRoot = this.assetRoot;
    this.assetRoot = path.resolve(newRoot);
    try {
      await this.init();
    } catch (error) {
      this.assetRoot = previousRoot;
      throw error;
    }
    this.derivedAssets.clear();
    this.derivedAssetsLoaded = false;
    this.locators.clear();
  }

  private async ensureDerivedAssets() {
    if (!this.derivedAssetsLoaded) await this.loadDerivedAssets();
  }

  async loadDerivedAssets() {
    this.derivedAssetsLoaded = true;
    await this.refreshManagedAssets();
  }

  private async refreshManagedAssets() {
    const index =
      libraryIndex(this.assetRoot) ??
      (await ensureLibraryIndex(this.assetRoot));
    for (const id of this.derivedAssets.keys())
      if (!index.files.has(id)) this.derivedAssets.delete(id);
    for (const [id, { file: absolute }] of index.files) {
      const filename = path.basename(absolute);
      const file = path.relative(this.assetRoot, absolute);
      const previous = this.derivedAssets.get(id);
      if (previous) {
        previous.file = file;
        previous.asset.filename = filename;
        continue;
      }
      try {
        const type = mediaType(filename);
        const stat = await fs.stat(absolute);
        this.derivedAssets.set(id, {
          file,
          asset: {
            version: ASSET_VERSION,
            id,
            filename,
            mediaType: type.type === "video" ? "video" : "image",
            ...type,
            names: [
              filename.slice(0, filename.lastIndexOf("__")) +
                path.extname(filename),
            ],
            bytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
          },
        });
      } catch {
        /* Unsupported managed files remain in the inventory. */
      }
    }
  }

  assetPath(id: string) {
    const parsed = hashSchema.parse(id);
    const locator = this.locators.get(parsed);
    const file = findManagedFile(
      this.assetRoot,
      parsed,
      locator?.filename,
      locator?.mediaType,
    );
    if (file && locator) {
      locator.filename = path.basename(file);
      const folder = path.basename(path.dirname(file));
      locator.mediaType =
        folder === "images"
          ? "image"
          : folder === "fonts"
            ? "font"
            : folder === "audio"
              ? "audio"
              : folder === "video"
                ? "video"
                : "other";
    }
    if (file) return file;
    throw new Error(`Asset not found: ${parsed}`);
  }

  previewPath(id: string) {
    return path.join(this.cacheRoot, "assets", hashSchema.parse(id) + ".jpg");
  }

  async listAssets(query: string, offset: number, limit: number) {
    await this.ensureDerivedAssets();
    await this.refreshManagedAssets();
    const q = query.toLowerCase();
    const items: Asset[] = [];
    for (const [id, { asset }] of this.derivedAssets)
      if (libraryIndex(this.assetRoot)?.files.has(id))
        if (
          q === "" ||
          asset.names.some((name) => name.toLowerCase().includes(q))
        )
          items.push(asset);
    const counts = assetCategoryCounts(items);
    items.sort(compareAssetsByCategoryAndName);
    return {
      items: items.slice(offset, offset + Math.min(200, limit)),
      total: items.length,
      counts,
    };
  }

  async importFile(file: string, protect?: (hash: string) => void) {
    return this.importSource(path.basename(file), file, protect);
  }

  async importBytes(
    name: string,
    bytes: Uint8Array,
    protect?: (hash: string) => void,
  ) {
    return this.importSource(name, bytes, protect);
  }

  private async importSource(
    originalBasename: string,
    source: string | Uint8Array,
    protect?: (hash: string) => void,
  ) {
    await this.ensureDerivedAssets();
    const type = mediaType(originalBasename);
    const imported = await importManagedFile(
      this.assetRoot,
      originalBasename,
      source,
      protect,
    );
    const { id } = imported;
    const existing = this.derivedAssets.get(id);
    if (existing) {
      existing.file = path.relative(this.assetRoot, imported.file);
      existing.asset.filename = path.basename(imported.file);
      if (!existing.asset.names.includes(originalBasename))
        existing.asset.names.push(originalBasename);
      return existing.asset;
    }
    const asset: Asset = {
      version: ASSET_VERSION,
      id,
      filename: path.basename(imported.file),
      mediaType: type.type === "video" ? "video" : "image",
      ...type,
      names: [originalBasename],
      bytes: (await fs.stat(imported.file)).size,
      createdAt: new Date().toISOString(),
    };
    this.derivedAssets.set(id, {
      file: path.relative(this.assetRoot, imported.file),
      asset,
    });
    return asset;
  }

  async asset(id: string): Promise<Asset> {
    const parsed = hashSchema.parse(id);
    const file = this.assetPath(parsed);
    const entry = this.derivedAssets.get(parsed);
    if (entry) return entry.asset;
    const type = mediaType(file);
    const stat = await fs.stat(file);
    const name = path.basename(file);
    const asset: Asset = {
      version: ASSET_VERSION,
      id: parsed,
      filename: name,
      mediaType:
        path.basename(path.dirname(file)) === "images"
          ? "image"
          : path.basename(path.dirname(file)) === "video"
            ? "video"
            : "other",
      ...type,
      names: [name.slice(0, name.lastIndexOf("__")) + path.extname(name)],
      bytes: stat.size,
      createdAt: stat.birthtime.toISOString(),
    };
    this.derivedAssets.set(parsed, {
      file: path.relative(this.assetRoot, file),
      asset,
    });
    return asset;
  }

  async updateAsset(asset: Asset) {
    const parsed = assetSchema.parse(asset);
    await this.ensureDerivedAssets();
    const entry = this.derivedAssets.get(parsed.id);
    if (entry) {
      entry.asset = {
        ...entry.asset,
        width: parsed.width,
        height: parsed.height,
        duration: parsed.duration,
      };
    }
  }

  async storePreview(id: string, data: Uint8Array) {
    if (data.length > 8_000_000) throw new Error("Preview too large");
    await atomicWrite(this.previewPath(id), data);
  }

  thumbnailPath(documentId: string, slideId: string) {
    return path.join(
      this.cacheRoot,
      "slides",
      idSchema.parse(documentId),
      idSchema.parse(slideId) + ".svg",
    );
  }

  async storeThumbnail(documentId: string, slideId: string, data: string) {
    if (data.length > 2_000_000) throw new Error("Thumbnail too large");
    await atomicWrite(this.thumbnailPath(documentId, slideId), data);
  }
}
