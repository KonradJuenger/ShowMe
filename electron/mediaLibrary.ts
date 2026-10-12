import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { atomicWrite } from "./storage/io";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readdirSync,
  lstatSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export const MEDIA_FOLDERS = [
  "images",
  "video",
  "audio",
  "fonts",
  "other",
] as const;
export type MediaFolder = (typeof MEDIA_FOLDERS)[number];
const managedPattern = /__([a-f0-9]{64})(\.[^./\\]+)?$/;
const MAX_FILENAME_BYTES = 240;

export function mediaFolder(name: string): MediaFolder {
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext))
    return "images";
  if ([".mp4", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext))
    return "audio";
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "fonts";
  return "other";
}

export function managedFilename(name: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid asset ID");
  const ext = path.extname(name);
  if (ext && !/^\.[a-zA-Z0-9]{1,32}$/.test(ext))
    throw new Error("Invalid media extension");
  const base =
    Array.from(path.basename(name, ext).trim(), (character) =>
      /[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32
        ? "_"
        : character,
    ).join("") || "media";
  const available = MAX_FILENAME_BYTES - Buffer.byteLength(`__${id}${ext}`);
  if (available < 1) throw new Error("Media extension is too long");
  let readable = base;
  while (Buffer.byteLength(readable) > available)
    readable = readable.slice(0, -1);
  return `${readable.replace(/[. ]+$/, "") || "m"}__${id}${ext}`;
}

export function assetIdFromFilename(name: string): string | null {
  return managedPattern.exec(name)?.[1] ?? null;
}

export type MediaType = "image" | "video" | "audio" | "font" | "other";
export function folderForMediaType(type: MediaType): MediaFolder {
  return {
    image: "images",
    video: "video",
    audio: "audio",
    font: "fonts",
    other: "other",
  }[type] as MediaFolder;
}

export function findManagedFile(
  root: string,
  id: string,
  filename?: string,
  type?: MediaType,
): string | null {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid asset ID");
  const index = libraryIndex(root);
  if (index) return index.lookup(id);
  const preferred = type ? folderForMediaType(type) : null;
  if (filename && preferred && assetIdFromFilename(filename) === id) {
    const direct = path.join(root, preferred, filename);
    try {
      if (statSync(direct).isFile()) return direct;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const folder of preferred
    ? [preferred, ...MEDIA_FOLDERS.filter((item) => item !== preferred)]
    : MEDIA_FOLDERS) {
    let entries;
    try {
      entries = readdirSync(path.join(root, folder), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries)
      if (entry.isFile() && assetIdFromFilename(entry.name) === id)
        return path.join(root, folder, entry.name);
  }
  return null;
}

export async function hashManagedSource(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function importManagedFile(
  root: string,
  name: string,
  source: string | Uint8Array,
  protect?: (hash: string) => void,
) {
  const directory = path.join(root, mediaFolder(name));
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, randomUUID() + ".tmp");
  try {
    const hash = createHash("sha256");
    if (typeof source === "string") {
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(source),
        hashing,
        createWriteStream(temporary, { flags: "wx" }),
      );
    } else {
      hash.update(source);
      await fs.writeFile(temporary, source, { flag: "wx" });
    }
    const id = hash.digest("hex");
    protect?.(id);
    const index = libraryIndex(root);
    const existing = index ? await index.verify(id) : findManagedFile(root, id);
    if (existing) return { id, file: existing, created: false };
    const destination = path.join(directory, managedFilename(name, id));
    // Hard-link publication cannot replace another importer's immutable winner.
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await hashManagedSource(destination)) !== id)
        throw new Error("Conflicting managed asset", { cause: error });
    }
    index?.register(id, destination);
    return { id, file: destination, created: true };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export interface LibraryFile {
  id: string;
  file: string;
  signature: string;
}
export interface LibraryChange {
  ids: readonly string[] | null;
}
const indexes = new Map<string, LibraryIndex>();
export function libraryIndex(root: string) {
  return indexes.get(path.resolve(root));
}
export async function ensureLibraryIndex(root: string, cacheRoot?: string) {
  root = path.resolve(root);
  let index = indexes.get(root);
  if (!index) {
    index = new LibraryIndex(root, cacheRoot);
    indexes.set(root, index);
  }
  await index.ready();
  return index;
}
const signatureOf = (stat: import("node:fs").BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
/** Disposable metadata inventory. Content is verified only when consumed. */
export class LibraryIndex {
  readonly files = new Map<string, LibraryFile>();
  readonly trash = new Map<string, string[]>();
  readonly trashFiles = new Map<string, string>();
  private trashSources = new Map<
    string,
    { file: string; folder: string; signature: string }
  >();
  private fontIds = new Map<string, Set<string>>();
  private fontKeys = new Map<string, string>();
  private verified = new Map<string, string>();
  private verifications = new Map<string, Promise<string | null>>();
  private watchers: FSWatcher[] = [];
  private listeners = new Set<(change: LibraryChange) => void>();
  private pending: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private dirty = new Set<string>();
  private broad = false;
  private disposed = false;
  private scans = 0;
  private hashedBytes = 0;
  private saving: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly cacheFile: string | undefined;
  constructor(
    readonly root: string,
    cacheRoot?: string,
  ) {
    this.cacheFile = cacheRoot
      ? path.join(
          cacheRoot,
          "library-index",
          createHash("sha256").update(root).digest("hex") + ".json",
        )
      : undefined;
  }
  private fontKey(usage: { family: string; weight: number; italic: boolean }) {
    return [
      usage.family.normalize("NFC").toLocaleLowerCase(),
      usage.weight,
      usage.italic,
    ].join("\0");
  }
  private indexFont(id: string, name?: string) {
    const previous = this.fontKeys.get(id);
    if (previous) {
      this.fontIds.get(previous)?.delete(id);
      this.fontKeys.delete(id);
    }
    const match =
      name &&
      /^(.*)-(\d{3})(-italic)?__([a-f0-9]{64})\.(ttf|otf|woff2?)$/i.exec(name);
    if (!match) return;
    const key = this.fontKey({
      family: match[1],
      weight: Number(match[2]),
      italic: !!match[3],
    });
    const ids = this.fontIds.get(key) ?? new Set<string>();
    ids.add(id);
    this.fontIds.set(key, ids);
    this.fontKeys.set(id, key);
  }
  fontHashes(
    usages: readonly { family: string; weight: number; italic: boolean }[],
    restrict?: ReadonlySet<string>,
  ) {
    const hashes = new Set<string>();
    for (const usage of usages)
      for (const id of this.fontIds.get(this.fontKey(usage)) ?? [])
        if (!restrict || restrict.has(id)) hashes.add(id);
    return [...hashes];
  }
  diagnostics() {
    return {
      scans: this.scans,
      files: this.files.size,
      watchers: this.watchers.length,
      disposed: this.disposed,
      hashedBytes: this.hashedBytes,
    };
  }
  ready() {
    return (this.initialization ??= (async () => {
      if (this.cacheFile)
        try {
          const cache = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
          if (
            cache.version !== 1 ||
            cache.root !== this.root ||
            !Array.isArray(cache.files)
          )
            throw new Error("Invalid inventory cache");
          for (const entry of cache.files) {
            if (
              typeof entry.file !== "string" ||
              typeof entry.signature !== "string" ||
              !/^[a-f0-9]{64}$/.test(entry.id)
            )
              throw new Error("Invalid inventory entry");
            const parts = entry.file.split("/");
            if (
              parts.length !== 2 ||
              !MEDIA_FOLDERS.includes(parts[0]) ||
              parts[1] !== path.basename(parts[1]) ||
              assetIdFromFilename(parts[1]) !== entry.id
            )
              throw new Error("Invalid inventory path");
            this.indexFont(entry.id, parts[1]);
            this.files.set(entry.id, {
              ...entry,
              file: path.join(this.root, ...parts),
            });
          }
          return;
        } catch {
          this.files.clear();
        }
      await this.refresh();
    })());
  }
  subscribe(listener: (change: LibraryChange) => void) {
    this.listeners.add(listener);
    this.watch();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.dispose();
    };
  }
  private watch() {
    if (this.disposed || this.poll) return;
    for (const folder of [...MEDIA_FOLDERS, "Trash"])
      try {
        this.watchers.push(
          watch(
            path.join(this.root, folder),
            { persistent: false, recursive: folder === "Trash" },
            (_event, name) => {
              if (!name || folder === "Trash") this.broad = true;
              else if (assetIdFromFilename(String(name))) {
                if (_event === "change")
                  this.verified.delete(
                    path.join(this.root, folder, String(name)),
                  );
                this.dirty.add(path.join(folder, String(name)));
              } else return;
              this.schedule();
            },
          ).on("error", () => {
            this.broad = true;
            this.schedule();
          }),
        );
      } catch {
        /* Slow reconciliation recovers missing watchers and missed hints. */
      }
    this.poll = setInterval(
      () => {
        this.broad = true;
        this.schedule();
      },
      15 * 60 * 1000,
    );
    this.poll.unref();
  }
  dispose() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    this.listeners.clear();
    if (indexes.get(this.root) === this) indexes.delete(this.root);
  }
  register(id: string, file: string) {
    const signature = signatureOf(statSync(file, { bigint: true }));
    this.files.set(id, { id, file, signature });
    this.indexFont(id, path.basename(file));
    this.verified.set(file, signature);
    this.persist();
  }
  /** Location metadata only; byte consumers must await verify(). */
  lookup(id: string) {
    const entry = this.files.get(id);
    if (entry)
      try {
        const stat = lstatSync(entry.file);
        if (stat.isFile() && !stat.isSymbolicLink()) return entry.file;
      } catch {
        /* unavailable */
      }
    return null;
  }
  async verify(id: string): Promise<string | null> {
    const prior = this.verifications.get(id);
    if (prior) return prior;
    const job = (async () => {
      await this.ready();
      let entry = this.files.get(id);
      if (!entry) {
        await this.refresh();
        entry = this.files.get(id);
      }
      const source = entry ?? this.trashSources.get(id);
      if (!source || this.disposed) return null;
      try {
        const before = await fs.lstat(source.file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) return null;
        const signature = signatureOf(before);
        if (
          !this.listeners.size ||
          this.verified.get(source.file) !== signature
        ) {
          this.hashedBytes += Number(before.size);
          if ((await hashManagedSource(source.file)) !== id) {
            if (entry) this.files.delete(id);
            this.verified.delete(source.file);
            this.publish([id]);
            return null;
          }
          if (
            signatureOf(await fs.lstat(source.file, { bigint: true })) !==
            signature
          )
            return null;
          this.verified.set(source.file, signature);
          if (entry) entry.signature = signature;
          else this.trash.set(id, [(source as { folder: string }).folder]);
          this.publish([id]);
          this.persist();
        }
        return source.file;
      } catch {
        return null;
      }
    })().finally(() => this.verifications.delete(id));
    this.verifications.set(id, job);
    return job;
  }
  trustedTrash(file: string) {
    try {
      return (
        this.verified.get(file) ===
        signatureOf(statSync(file, { bigint: true }))
      );
    } catch {
      return false;
    }
  }
  private schedule() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushChanges().catch((error) =>
        console.error("Library reconciliation failed", error),
      );
    }, 150);
    this.timer.unref();
  }
  private async flushChanges() {
    if (this.broad) {
      this.broad = false;
      this.dirty.clear();
      await this.refresh();
      return;
    }
    const changed = new Set<string>();
    for (const relative of [...this.dirty]) {
      this.dirty.delete(relative);
      const id = assetIdFromFilename(path.basename(relative));
      if (!id) continue;
      const file = path.join(this.root, relative);

      try {
        const stat = await fs.lstat(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        this.files.set(id, { id, file, signature: signatureOf(stat) });
      } catch {
        if (this.files.get(id)?.file === file) this.files.delete(id);
      }
      this.indexFont(
        id,
        this.files.get(id)?.file
          ? path.basename(this.files.get(id)!.file)
          : undefined,
      );
      changed.add(id);
    }
    if (!this.disposed && changed.size) {
      this.publish([...changed]);
      this.persist();
    }
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return (this.pending ??= this.rebuild().finally(() => {
      this.pending = null;
    }));
  }
  private async rebuild() {
    this.scans++;
    const next = new Map<string, LibraryFile>();
    for (const folder of MEDIA_FOLDERS) {
      const entries = await fs
        .readdir(path.join(this.root, folder), { withFileTypes: true })
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      for (const entry of entries) {
        const id = assetIdFromFilename(entry.name);
        if (!id || !entry.isFile() || entry.isSymbolicLink()) continue;
        const file = path.join(this.root, folder, entry.name);
        try {
          const stat = await fs.lstat(file, { bigint: true });
          const signature = signatureOf(stat);
          next.set(id, { id, file, signature });
        } catch {
          /* changing entry */
        }
      }
    }
    const trashSources = new Map<
        string,
        { file: string; folder: string; signature: string }
      >(),
      trashFiles = new Map<string, string>();
    const trashRoot = path.join(this.root, "Trash", "assets");
    for (const dir of await fs
      .readdir(trashRoot, { withFileTypes: true })
      .catch(() => [])) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      try {
        const item = JSON.parse(
          await fs.readFile(
            path.join(trashRoot, dir.name, "item.json"),
            "utf8",
          ),
        );
        if (typeof item.originalRelativePath !== "string") continue;
        const name = path.basename(item.originalRelativePath),
          id = assetIdFromFilename(name);
        if (!id || id !== item.hash) continue;
        const file = path.join(trashRoot, dir.name, name),
          stat = await fs.lstat(file, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        trashSources.set(id, {
          file,
          folder: dir.name,
          signature: signatureOf(stat),
        });
        trashFiles.set(id, name);
      } catch {
        /* incomplete external entry */
      }
    }
    if (this.disposed) return;
    const changed = new Set<string>();
    for (const [id, entry] of next)
      if (
        this.files.get(id)?.signature !== entry.signature ||
        this.files.get(id)?.file !== entry.file
      )
        changed.add(id);
    for (const id of this.files.keys()) if (!next.has(id)) changed.add(id);
    for (const [id, entry] of trashSources)
      if (this.trashSources.get(id)?.signature !== entry.signature)
        changed.add(id);
    for (const id of this.trashSources.keys())
      if (!trashSources.has(id)) changed.add(id);
    this.files.clear();
    this.fontIds.clear();
    this.fontKeys.clear();
    for (const [id, entry] of next) {
      this.files.set(id, entry);
      this.indexFont(id, path.basename(entry.file));
    }
    this.trashSources = trashSources;
    this.trashFiles.clear();
    for (const [id, name] of trashFiles) {
      this.trashFiles.set(id, name);
      if (!next.has(id)) this.indexFont(id, name);
    }
    this.trash.clear();
    for (const [id, entry] of trashSources)
      if (this.verified.get(entry.file) === entry.signature)
        this.trash.set(id, [entry.folder]);
    if (changed.size) this.publish([...changed]);
    this.persist();
  }
  private publish(ids: readonly string[]) {
    if (this.disposed) return;
    for (const listener of this.listeners)
      try {
        listener({ ids });
      } catch (error) {
        console.error("Library notification failed", error);
      }
  }
  private persist() {
    if (!this.cacheFile || this.disposed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saving = this.saving
        .catch(() => {})
        .then(async () => {
          if (this.disposed) return;
          await atomicWrite(
            this.cacheFile!,
            JSON.stringify({
              version: 1,
              root: this.root,
              files: [...this.files.values()].map((entry) => ({
                ...entry,
                file: path
                  .relative(this.root, entry.file)
                  .split(path.sep)
                  .join("/"),
              })),
            }),
          );
        })
        .catch((error) => console.error("Inventory cache write failed", error));
    }, 500);
    this.saveTimer.unref();
  }
}
