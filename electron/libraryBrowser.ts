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
import { setLibraryProtection } from "./libraryProtection";
import {
  managedFilename,
  assetIdFromFilename,
  isManagedFilenameProtected,
  libraryIndex,
  hashManagedSource,
} from "./mediaLibrary";
import {
  libraryTrashSchema,
  validateTrashDestination,
} from "./libraryLifecycle";
import type { Asset } from "../src/core/assets";

type LibraryInventorySnapshot = {
  entries: LibraryBrowserResult["entries"];
  folders: string[];
};

/** Native folder inventory; document asset identity remains owned by Storage. */
export class NativeLibraryBrowser {
  private inventory: Promise<LibraryInventorySnapshot> | null = null;
  private inventoryGeneration = 0;
  private unsubscribe?: () => void;

  constructor(
    readonly root: string,
    private readonly asset: (id: string) => Promise<Asset>,
    private readonly importAsset: (
      file: string,
      folder?: string,
    ) => Promise<Asset>,
    private readonly preview: (file: string) => Promise<string | undefined>,
    private readonly reveal: (file: string) => void,
  ) {
    this.unsubscribe = libraryIndex(this.root)?.subscribe(() => this.invalidate());
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.inventory = null;
  }

  invalidate() {
    this.inventoryGeneration++;
    this.inventory = null;
  }

  private mediaPath(relative: string) {
    if (!LIBRARY_CATEGORIES.includes(relative.split("/")[0] as LibraryCategory))
      throw new Error("Outside Library categories");
    return libraryPath(this.root, relative);
  }
  private async refresh() {
    await libraryIndex(this.root)?.refresh();
  }

  private async inventorySnapshot(): Promise<LibraryInventorySnapshot> {
    if (this.inventory) return this.inventory;
    const generation = this.inventoryGeneration;
    const job = (async () => {
      await this.refresh();
      const entries: LibraryBrowserResult["entries"] = [];
      const folders: string[] = [];

      const visit = async (
        relative: string,
        category: LibraryCategory,
      ): Promise<{ managed: number; protected: number }> => {
        let managed = 0;
        let protectedCount = 0;
        for (const entry of await fs.readdir(this.mediaPath(relative), {
          withFileTypes: true,
        })) {
          const child = `${relative}/${entry.name}`;
          this.mediaPath(child);
          if (entry.isDirectory()) {
            folders.push(child);
            const folderEntry: LibraryBrowserResult["entries"][number] = {
              path: child,
              name: entry.name,
              kind: "folder",
              category,
              managed: false,
            };
            entries.push(folderEntry);
            const descendants = await visit(child, category);
            if (descendants.managed > 0)
              folderEntry.protection =
                descendants.protected === descendants.managed
                  ? "self"
                  : descendants.protected > 0
                    ? "mixed"
                    : undefined;
            managed += descendants.managed;
            protectedCount += descendants.protected;
            continue;
          }
          if (!entry.isFile()) continue;
          const id = assetIdFromFilename(entry.name);
          const protectedFromCleanup =
            Boolean(id) && isManagedFilenameProtected(entry.name);
          if (id) {
            managed++;
            if (protectedFromCleanup) protectedCount++;
          }
          const stat = await fs.stat(this.mediaPath(child));
          let effect;
          let name = id
            ? entry.name.slice(0, entry.name.lastIndexOf("__")) +
              path.extname(entry.name)
            : entry.name;
          if (category === "Effects" && entry.name.endsWith(".txt"))
            try {
              effect = libraryEffectSchema.parse(
                JSON.parse(await fs.readFile(this.mediaPath(child), "utf8")),
              );
              name = effect.definition.name;
            } catch {
              // Invalid effects remain visible and revealable.
            }
          entries.push({
            path: child,
            name,
            kind: "file",
            category,
            managed: !!id || category === "Effects",
            protection: protectedFromCleanup ? "self" : undefined,
            bytes: stat.size,
            signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
            effect,
          });
        }
        return { managed, protected: protectedCount };
      };

      for (const category of LIBRARY_CATEGORIES) await visit(category, category);
      entries.sort(
        (a, b) =>
          Number(b.kind === "folder") - Number(a.kind === "folder") ||
          a.name.localeCompare(b.name) ||
          a.path.localeCompare(b.path),
      );
      return { entries, folders };
    })();
    this.inventory = job;
    try {
      const snapshot = await job;
      if (generation !== this.inventoryGeneration) {
        if (this.inventory === job) this.inventory = null;
        return this.inventorySnapshot();
      }
      return snapshot;
    } catch (error) {
      if (this.inventory === job) this.inventory = null;
      throw error;
    }
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
      const unified = request.category === "all";
      if (unified && request.folder)
        throw new Error("The unified Library view does not enter folders");
      const snapshot = await this.inventorySnapshot();
      const query = request.query.toLocaleLowerCase();
      const current = unified
        ? ""
        : `${request.category}${request.folder ? "/" + request.folder : ""}`;

      result.folders =
        request.category === "all"
          ? [...snapshot.folders]
          : snapshot.folders.filter((folder) =>
              folder.startsWith(request.category + "/"),
            );

      result.entries = snapshot.entries
        .filter((entry) => {
          if (!entry.category) return false;
          if (!unified && entry.category !== request.category) return false;
          if (query && !entry.path.toLocaleLowerCase().includes(query))
            return false;
          if (unified) return entry.kind === "file";
          if (entry.kind === "folder")
            return query
              ? true
              : entry.path.startsWith(current + "/") &&
                  entry.path.split("/").length ===
                    current.split("/").length + 1;
          return (
            request.all ||
            !!query ||
            path.posix.dirname(entry.path) === current
          );
        })
        .map((entry) => ({ ...entry }));

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
              // Noninsertable files stay browsable.
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
          let existing;
          try {
            existing = libraryEffectSchema.parse(
              JSON.parse(await fs.readFile(this.mediaPath(relative), "utf8")),
            );
          } catch {
            // Malformed hand-edited effects do not block restoring another effect.
            continue;
          }
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
      this.invalidate();
      await this.refresh();
      return result;
    }
    if (request.type === "import-files")
      throw new Error("Import requires the desktop file picker");
    const source = this.mediaPath(request.path);
    if (request.type === "protect") {
      const stat = await fs.lstat(source);
      if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink())
        throw new Error("Only Library files and folders can be protected");
      try {
        await setLibraryProtection(
          this.root,
          request.path,
          request.protected,
        );
      } catch (error) {
        this.invalidate();
        await this.refresh().catch(() => undefined);
        throw error;
      }
      this.invalidate();
      await this.refresh();
      return result;
    }
    if (request.type === "rename") {
      const hash = assetIdFromFilename(path.basename(source));
      if (hash && path.extname(request.name) !== path.extname(source))
        throw new Error("Keep the file extension when renaming media");
      const name = hash
        ? managedFilename(
            request.name,
            hash,
            isManagedFilenameProtected(path.basename(source)),
          )
        : request.name;
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
      if (
        hash &&
        isManagedFilenameProtected(path.basename(source)) !==
          isManagedFilenameProtected(path.basename(destination))
      )
        throw new Error("Move must preserve cleanup protection");
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
    this.invalidate();
    await this.refresh();
    return result;
  }
}
