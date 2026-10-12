import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./storage/io";
import {
  libraryEffectSchema,
  editEffectLibrary,
  effectLibraryRequestSchema,
  libraryEffectFilename,
  type EffectLibrary,
  type EffectLibraryRequest,
} from "../src/core/libraryEffects";

/** Serialized by the IPC owner. IDs, never user paths, address canonical assets. */
export class EffectLibraryStorage {
  constructor(
    readonly root: string,
    private write = atomicWrite,
  ) {}
  async list(): Promise<EffectLibrary> {
    await this.directory("");
    const library: EffectLibrary = { entries: [], folders: [] };
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(await this.directory(folder), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink())
          throw new Error(
            "Symbolic links are not supported in Library / Effects",
          );
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          library.folders.push(relative);
          await visit(relative);
        } else if (entry.name.endsWith(".txt")) {
          const asset = libraryEffectSchema.parse(
            JSON.parse(
              await fs.readFile(path.join(this.root, relative), "utf8"),
            ),
          );
          if (library.entries.some((e) => e.asset.id === asset.id))
            throw new Error("Duplicate Library Effect identity");
          library.entries.push({ asset, folder });
          this.files.set(asset.id, path.join(this.root, relative));
        }
      }
    };
    this.files.clear();
    await visit("");
    return library;
  }
  private files = new Map<string, string>();
  private async directory(folder: string) {
    const resolved = path.resolve(this.root, folder);
    const relative = path.relative(path.resolve(this.root), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Invalid Effects path");
    // Check every ancestor before mkdir or write; a folder must not escape via a symlink.
    let current = path.resolve(this.root);
    for (const part of ["", ...folder.split("/").filter(Boolean)]) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error("Unsafe Effects folder");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }
  async run(raw: EffectLibraryRequest): Promise<EffectLibrary> {
    const request = effectLibraryRequestSchema.parse(raw);
    if (request.type === "list" || request.type === "reveal")
      return this.list();
    await this.directory("");
    const lockFile = path.join(this.root, ".write-lock");
    let lock;
    try {
      lock = await fs.open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await fs.readFile(lockFile, "utf8"));
      let live = true;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ESRCH") live = false;
        }
      } else if (Date.now() - (await fs.stat(lockFile)).mtimeMs > 60000)
        live = false;
      if (live)
        throw new Error(
          "Another ShowMe window is saving a Library Effect. Try again.",
          { cause: error },
        );
      await fs.unlink(lockFile);
      lock = await fs.open(lockFile, "wx");
    }
    try {
      await lock.writeFile(String(process.pid));
      await lock.sync();
      const before = await this.list();
      const next = editEffectLibrary(before, request);
      if (request.type === "save" || request.type === "move") {
        const entry = request.id
          ? next.entries.find((e) => e.asset.id === request.id)!
          : next.entries.at(-1)!;
        const old = this.files.get(entry.asset.id);
        const directory = await this.directory(entry.folder);
        const destination = path.join(
          directory,
          libraryEffectFilename(entry.asset),
        );
        if (old !== destination) {
          if (
            await fs.stat(destination).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return false;
              },
            )
          )
            throw new Error("An Effect file with this name already exists");
        }
        if (request.type === "move") await fs.rename(old!, destination);
        else {
          // Update in place first, then rename: interruption never leaves duplicate identities.
          await this.write(
            old ?? destination,
            JSON.stringify(entry.asset, null, 2) + "\n",
          );
          if (old && old !== destination) await fs.rename(old, destination);
        }
      } else if (request.type === "delete")
        await fs.unlink(this.files.get(request.id)!);
      else if (request.type === "folder") await this.directory(request.folder);
      return next;
    } finally {
      await lock.close();
      await fs.unlink(lockFile);
    }
  }
  async file(id: string) {
    await this.list();
    const file = this.files.get(id);
    if (!file) throw new Error("Effect no longer exists");
    return file;
  }
}
