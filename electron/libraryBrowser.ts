import { promises as fs } from "node:fs";
import path from "node:path";
import {
  libraryBrowserRequestSchema,
  LIBRARY_CATEGORIES,
  type LibraryBrowserResult,
  type LibraryCategory,
} from "../src/core/libraryBrowser";
import { libraryEffectSchema } from "../src/core/libraryEffects";
import { libraryPath } from "./libraryFilesystem";
import {
  managedFilename,
  assetIdFromFilename,
  libraryIndex,
  hashManagedSource,
} from "./mediaLibrary";
import {
  libraryTrashSchema,
  validateTrashDestination,
} from "./libraryLifecycle";
import type { Asset } from "../src/core/assets";

/** Native folder inventory; document asset identity remains owned by Storage. */
export class NativeLibraryBrowser {
  constructor(
    readonly root: string,
    private readonly asset: (id: string) => Promise<Asset>,
    private readonly importAsset: (
      file: string,
      folder?: string,
    ) => Promise<Asset>,
    private readonly preview: (file: string) => Promise<string | undefined>,
    private readonly reveal: (file: string) => void,
  ) {}

  private mediaPath(relative: string) {
    if (!LIBRARY_CATEGORIES.includes(relative.split("/")[0] as LibraryCategory))
      throw new Error("Outside Library categories");
    return libraryPath(this.root, relative);
  }
  private async refresh() {
    await libraryIndex(this.root)?.refresh();
  }

  async run(raw: unknown): Promise<LibraryBrowserResult> {
    const request = libraryBrowserRequestSchema.parse(raw);
    const result: LibraryBrowserResult = { entries: [], total: 0, folders: [] };
    if (request.type === "trash") {
      let entries;
      try {
        entries = await fs.readdir(libraryPath(this.root, "Trash/assets"), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
        throw error;
      }
      for (const entry of entries) {
        const relative = `Trash/assets/${entry.name}`;
        try {
          libraryPath(this.root, relative);
          if (!entry.isDirectory()) throw new Error("Unexpected Trash entry");
          const item = libraryTrashSchema.parse(
            JSON.parse(
              await fs.readFile(
                libraryPath(this.root, `${relative}/item.json`),
                "utf8",
              ),
            ),
          );
          validateTrashDestination(this.root, item);
          const file = libraryPath(
            this.root,
            `${relative}/${path.posix.basename(item.originalRelativePath.replaceAll("\\", "/"))}`,
          );
          const stat = await fs.stat(file);
          if (stat.size !== item.bytes) throw new Error("Trash size mismatch");
          result.entries.push({
            path: `${relative}/${path.basename(file)}`,
            name: path.posix.basename(
              item.originalRelativePath.replaceAll("\\", "/"),
            ),
            kind: "trash",
            category: item.originalRelativePath.split(
              /[\\/]/,
            )[0] as LibraryCategory,
            managed: true,
            bytes: item.bytes,
            signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
            originalPath: item.originalRelativePath.replaceAll("\\", "/"),
            trashedAt: item.trashedAt,
          });
        } catch (error) {
          result.entries.push({
            path: relative,
            name: entry.name,
            kind: "trash",
            managed: false,
            error: String(error),
          });
        }
      }
      result.entries.sort((a, b) =>
        (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""),
      );
      result.total = result.entries.length;
      result.entries = result.entries.slice(
        request.offset,
        request.offset + request.limit,
      );
      return result;
    }
    if (request.type === "list") {
      const current = `${request.category}${request.folder ? "/" + request.folder : ""}`;
      const query = request.query.toLocaleLowerCase();
      await this.refresh();
      const visit = async (relative: string) => {
        for (const entry of await fs.readdir(this.mediaPath(relative), {
          withFileTypes: true,
        })) {
          const child = `${relative}/${entry.name}`;
          this.mediaPath(child);
          if (entry.isDirectory()) {
            result.folders.push(child);
            if (
              (!query && !request.all && relative === current) ||
              (!!query && child.toLocaleLowerCase().includes(query))
            )
              result.entries.push({
                path: child,
                name: entry.name,
                kind: "folder",
                category: request.category,
                managed: false,
              });
            await visit(child);
          } else if (
            entry.isFile() &&
            (request.all || query || relative === current) &&
            (!query || child.toLocaleLowerCase().includes(query))
          ) {
            const id = assetIdFromFilename(entry.name);
            const stat = await fs.stat(this.mediaPath(child));
            result.entries.push({
              path: child,
              name: id
                ? entry.name.slice(0, entry.name.lastIndexOf("__")) +
                  path.extname(entry.name)
                : entry.name,
              kind: "file",
              category: request.category,
              managed: !!id || request.category === "Effects",
              bytes: stat.size,
              signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
            });
          }
        }
      };
      await visit(request.category);
      result.entries = result.entries.filter(
        (entry) => request.all || entry.path.startsWith(current + "/"),
      );
      result.entries = result.entries.filter((entry) =>
        entry.kind === "folder"
          ? !!query ||
            (entry.path.startsWith(current + "/") &&
              entry.path.split("/").length === current.split("/").length + 1)
          : request.all ||
            !!query ||
            path.posix.dirname(entry.path) === current,
      );
      result.entries.sort(
        (a, b) =>
          Number(b.kind === "folder") - Number(a.kind === "folder") ||
          a.name.localeCompare(b.name) ||
          a.path.localeCompare(b.path),
      );
      result.total = result.entries.length;
      result.entries = result.entries.slice(
        request.offset,
        request.offset + request.limit,
      );
      await Promise.all(
        result.entries.map(async (entry) => {
          if (entry.kind !== "file") return;
          const id = assetIdFromFilename(path.posix.basename(entry.path));
          if (id)
            try {
              entry.asset = await this.asset(id);
            } catch {
              /* Noninsertable files stay browsable. */
            }
        }),
      );
      return result;
    }
    if (
      request.type === "restore" ||
      request.type === "preview" ||
      request.type === "reveal"
    ) {
      const isTrash = request.path.startsWith("Trash/assets/");
      const file = isTrash
        ? libraryPath(this.root, request.path)
        : this.mediaPath(request.path);
      if (request.type === "reveal") {
        this.reveal(file);
        return result;
      }
      if (request.type === "preview") {
        result.preview = await this.preview(file);
        return result;
      }
      if (!isTrash || request.path.split("/").length !== 4)
        throw new Error("Invalid Trash item");
      const directory = path.dirname(file);
      const metadata = libraryPath(
        this.root,
        `${path.posix.dirname(request.path)}/item.json`,
      );
      const item = libraryTrashSchema.parse(
        JSON.parse(await fs.readFile(metadata, "utf8")),
      );
      validateTrashDestination(this.root, item);
      if (
        path.basename(file) !==
          path.posix.basename(
            item.originalRelativePath.replaceAll("\\", "/"),
          ) ||
        (await hashManagedSource(file)) !== item.hash
      )
        throw new Error("Trash content mismatch");
      if ("kind" in item && item.kind === "effect") {
        const effect = libraryEffectSchema.parse(
          JSON.parse(await fs.readFile(file, "utf8")),
        );
        const { libraryWalk } = await import("./libraryFilesystem");
        for (const relative of await libraryWalk(this.root, "Effects")) {
          if (!relative.endsWith(".txt")) continue;
          const existing = libraryEffectSchema.parse(
            JSON.parse(await fs.readFile(this.mediaPath(relative), "utf8")),
          );
          if (existing.id === effect.id)
            throw new Error(
              "An effect with this identity already exists; keep the Trash copy for review",
            );
        }
      }
      const destination = libraryPath(
        this.root,
        item.originalRelativePath,
        true,
      );
      // Hard-link publication preserves a conflicting destination and the Trash copy.
      await fs.link(file, destination);
      await fs.unlink(file);
      await fs.unlink(metadata);
      await fs.rmdir(directory);
      await this.refresh();
      return result;
    }
    if (request.type === "import-files")
      throw new Error("Import requires the desktop file picker");
    const source = this.mediaPath(request.path);
    if (request.type === "rename") {
      const hash = assetIdFromFilename(path.basename(source));
      if (hash && path.extname(request.name) !== path.extname(source))
        throw new Error("Keep the file extension when renaming media");
      const name = hash ? managedFilename(request.name, hash) : request.name;
      return this.run({
        type: "move",
        path: request.path,
        destination: `${path.posix.dirname(request.path)}/${name}`,
      });
    }
    if (request.type === "mkdir") await fs.mkdir(source, { recursive: true });
    else if (request.type === "remove-folder") {
      if (request.path.split("/").length < 2)
        throw new Error("Cannot delete a category");
      await fs.rmdir(source);
    } else if (request.type === "move") {
      if (
        request.path.split("/").length < 2 ||
        request.destination.split("/").length < 2 ||
        request.path.split("/")[0] !== request.destination.split("/")[0]
      )
        throw new Error("Move within the same category");
      const destination = libraryPath(this.root, request.destination, true);
      try {
        await fs.lstat(destination);
        throw new Error("Destination already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Native directories retain their complete subtree. Renaming a managed file retains its hash.
      const hash = assetIdFromFilename(path.basename(source));
      if (hash && assetIdFromFilename(path.basename(destination)) !== hash)
        throw new Error("Renaming must preserve the asset hash");
      if ((await fs.lstat(source)).isFile()) {
        await fs.link(source, destination);
        await fs.unlink(source);
      } else await fs.rename(source, destination);
    } else if (request.type === "import") {
      result.asset = await this.importAsset(
        source,
        path.posix.dirname(request.path).split("/").slice(1).join("/"),
      );
    }
    await this.refresh();
    return result;
  }
}
