import { libraryPath, libraryWalk, libraryWalkSync } from "./libraryFilesystem";
import { createHash, randomUUID } from "node:crypto";
import {
  promises as fs,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  realpathSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { z } from "zod";
import { documentAssetIds } from "../src/core/documentAssets";
import { parseRuntimeDocument } from "../src/core/documentRuntime";
import type { PresentationDocument } from "../src/core/document";
import { collectUsedFontUsages } from "../src/core/fonts";
import {
  LIBRARY_RETENTION_MS,
  type LibraryScanResult,
  type LibraryTrashItem,
} from "../src/core/libraryLifecycle";
import {
  MEDIA_FOLDERS,
  assetIdFromFilename,
  hashManagedSource,
  libraryIndex,
} from "./mediaLibrary";
import { atomicWrite, digest } from "./storage/io";
import { managedFontFaceFromFilename } from "./fontLibrary";

export function documentFontUsages(
  document: PresentationDocument,
  pageIds?: readonly string[],
) {
  return collectUsedFontUsages(
    (pageIds
      ? pageIds.flatMap(
          (id) => document.slides[id] ?? document.templates[id] ?? [],
        )
      : [
          ...Object.values(document.slides),
          ...Object.values(document.templates),
        ]
    ).map((page) => ({ ...page, notes: "" })),
    document.deck,
  );
}
function usesFont(
  usages: ReturnType<typeof documentFontUsages>,
  filename: string,
) {
  const face = managedFontFaceFromFilename(filename);
  return face &&
    usages.some(
      (usage) =>
        usage.family.localeCompare(face.family, undefined, {
          sensitivity: "accent",
        }) === 0 &&
        usage.weight === face.weight &&
        usage.italic === face.italic,
    )
    ? face.id
    : null;
}
export function documentLibraryHashes(
  root: string,
  document: PresentationDocument,
  pageIds?: readonly string[],
) {
  const hashes = new Set(documentAssetIds(document, pageIds));
  const usages = documentFontUsages(document, pageIds);
  if (!usages.length) return [...hashes];
  const index = libraryIndex(root);
  if (index) {
    for (const id of index.fontHashes(usages)) hashes.add(id);
    return [...hashes];
  }
  for (const folder of MEDIA_FOLDERS)
    for (const relative of libraryWalkSync(root, folder)) {
      const hash = usesFont(usages, path.basename(relative));
      if (hash) hashes.add(hash);
    }
  const trash = path.join(root, "Trash", "assets");
  if (existsSync(trash))
    for (const entry of readdirSync(trash, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const file of readdirSync(path.join(trash, entry.name), {
        withFileTypes: true,
      })) {
        if (!file.isFile() || file.name === "item.json") continue;
        const hash = usesFont(usages, file.name);
        if (hash) hashes.add(hash);
      }
    }
  return [...hashes];
}

export function canonicalFilesystemPath(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  while (!existsSync(current) && path.dirname(current) !== current) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(realpathSync(current), ...suffix);
}
export function isInsideRoot(root: string, file: string): boolean {
  const relative = path.relative(
    canonicalFilesystemPath(root),
    canonicalFilesystemPath(file),
  );
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertShowMeRootChangeAllowed(status: {
  hosted: unknown;
  clientStatus:
    | "idle"
    | "connecting"
    | "waiting"
    | "connected"
    | "rejected"
    | "incompatible"
    | "lost";
}) {
  if (status.hosted || status.clientStatus !== "idle")
    throw new Error(
      "Stop hosting or leave the active collaboration session before changing the ShowMe root.",
    );
}

export function librarySavePath(
  showMeRoot: string,
  file: string,
  portable: boolean,
): string {
  const current = path.extname(file);
  const explicitPortable = current.toLowerCase() === ".smp";
  const ext =
    explicitPortable || portable || !isInsideRoot(showMeRoot, file)
      ? ".smp"
      : ".sme";
  return /^(\.sme|\.smp)$/i.test(current)
    ? file.slice(0, -current.length) + ext
    : file + ext;
}

const mediaTrashSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    trashedAt: z.string().datetime(),
    originalRelativePath: z.string(),
    bytes: z.number().nonnegative(),
  })
  .strict();
export const libraryTrashSchema = z.union([
  mediaTrashSchema,
  mediaTrashSchema
    .extend({ version: z.literal(1), kind: z.literal("effect") })
    .strict(),
]);
const protectionSchema = z.object({
  pid: z.number().int().positive(),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
});

export function validateTrashDestination(root: string, item: LibraryTrashItem) {
  const parts = item.originalRelativePath.replaceAll("\\", "/").split("/");
  if (
    parts.length < 2 ||
    !(item.kind === "effect"
      ? parts[0] === "Effects" && parts.at(-1)!.endsWith(".txt")
      : MEDIA_FOLDERS.includes(parts[0] as (typeof MEDIA_FOLDERS)[number]) &&
        assetIdFromFilename(parts.at(-1)!) === item.hash)
  )
    throw new Error("Invalid library trash destination");
  libraryPath(root, item.originalRelativePath);
}

function verifyRestoredSource(file: string, expected: string) {
  // Restoration is exceptional; normal indexed lookup never reads source bytes.
  // Recheck canonical bytes with bounded memory even when timestamps collide.
  const handle = openSync(file, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let length: number;
    while ((length = readSync(handle, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length));
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex") === expected;
}

/** Synchronous path resolution also restores referenced media between scans. */
export function restoreLibraryAsset(root: string, hash: string) {
  const index = libraryIndex(root);
  if (index?.lookup(hash)) return;
  const directory = path.join(root, "Trash", "assets");
  if (!existsSync(directory)) return;
  for (const folder of [path.join(root, "Trash"), directory])
    if (lstatSync(folder).isSymbolicLink())
      throw new Error("Unsafe Library Trash path");
  const entries = index
    ? (index.trash.get(hash) ?? []).map((name) => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }))
    : readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(directory, entry.name);
    if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink())
      throw new Error("Unsafe Library Trash entry");
    const metadata = path.join(dir, "item.json");
    if (!existsSync(metadata)) continue;
    const item = libraryTrashSchema.parse(
      JSON.parse(readFileSync(metadata, "utf8")),
    );
    if (item.kind === "effect" || item.hash !== hash) continue;
    validateTrashDestination(root, item);
    const source = path.join(
      dir,
      path.posix.basename(item.originalRelativePath.replaceAll("\\", "/")),
    );
    const destination = libraryPath(root, item.originalRelativePath, true);
    if (existsSync(source) && !existsSync(destination)) {
      if (lstatSync(source).isSymbolicLink())
        throw new Error("Unsafe Library Trash asset");
      if (index && !index.trustedTrash(source)) continue;
      if (!verifyRestoredSource(source, hash)) continue;
      renameSync(source, destination);
      index?.register(hash, destination);
      unlinkSync(metadata);
      rmdirSync(dir);
    }
  }
}

/** Local process leases protect drafts, never persisted presentation ownership. */
export class LibraryOpenProtection {
  private readonly file: string;
  readonly directory: string;
  private readonly retained = new Set<string>();
  constructor(cacheRoot: string, root: string) {
    const resolvedRoot = canonicalFilesystemPath(root);
    const key =
      process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
    this.directory = path.join(cacheRoot, "library-open", digest(key));
    this.file = path.join(
      this.directory,
      `${process.pid}-${randomUUID()}.json`,
    );
  }
  protect(hashes: Iterable<string>) {
    let changed = !existsSync(this.file);
    for (const hash of hashes) {
      if (!this.retained.has(hash)) changed = true;
      this.retained.add(hash);
    }
    if (!changed) return;
    mkdirSync(this.directory, { recursive: true });
    const temporary = this.file + ".tmp";
    writeFileSync(
      temporary,
      JSON.stringify({ pid: process.pid, hashes: [...this.retained] }),
    );
    renameSync(temporary, this.file);
  }
  replace(hashes: Iterable<string>) {
    const next = new Set(hashes);
    if (
      next.size === this.retained.size &&
      [...next].every((hash) => this.retained.has(hash)) &&
      existsSync(this.file)
    )
      return;
    this.retained.clear();
    // Publish even when the replacement removes the last protected hash.
    for (const hash of next) this.retained.add(hash);
    const temporary = this.file + ".tmp";
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(
      temporary,
      JSON.stringify({ pid: process.pid, hashes: [...next] }),
    );
    renameSync(temporary, this.file);
  }
  async dispose() {
    await fs.rm(this.file, { force: true });
  }
  async hashes() {
    const hashes = new Set(this.retained);
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      let text;
      try {
        text = await fs.readFile(path.join(this.directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const lease = protectionSchema.parse(JSON.parse(text));
      try {
        process.kill(lease.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await fs.rm(path.join(this.directory, name), { force: true });
          continue;
        }
        throw error;
      }
      for (const hash of lease.hashes) hashes.add(hash);
    }
    return hashes;
  }
}

type PhysicalAsset = {
  hash: string;
  relative: string;
  bytes: number;
  mtimeMs: number;
};
type TrashEntry = LibraryTrashItem & { directory: string; file: string };

/** Full filesystem scans are authoritative. No reference counts or saved index. */
export class LibraryLifecycle {
  readonly libraryRoot: string;

  constructor(
    readonly root: string,
    private readonly openDocuments: () => PresentationDocument[],
    private readonly protection: LibraryOpenProtection,
    private readonly systemTrash: (file: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly mayCleanup: () => Promise<boolean> = async () => true,
  ) {
    this.libraryRoot = path.join(this.root, "ShowMe Library");
  }

  private async validateBoundary() {
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("ShowMe root must be a real directory");
    const libraryStat = await fs.lstat(this.libraryRoot);
    if (!libraryStat.isDirectory() || libraryStat.isSymbolicLink())
      throw new Error(
        "Library must be a real directory inside the ShowMe root",
      );
    const canonicalRoot = await fs.realpath(this.root);
    const canonicalLibrary = await fs.realpath(this.libraryRoot);
    const relative = path.relative(canonicalRoot, canonicalLibrary);
    if (
      relative.toLowerCase() !== "showme library" ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Library must not escape the ShowMe root");
  }

  private async libraryDirectory(relative: string, create = false) {
    const directory = path.join(this.libraryRoot, relative);
    if (create)
      try {
        await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(directory);
      }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe Library directory: ${relative}`);
    const canonicalLibrary = await fs.realpath(this.libraryRoot);
    const canonicalDirectory = await fs.realpath(directory);
    const inside = path.relative(canonicalLibrary, canonicalDirectory);
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      throw new Error(`Library directory escapes the ShowMe root: ${relative}`);
    return directory;
  }

  private async validateManagedDirectories() {
    for (const folder of [...MEDIA_FOLDERS, "Effects", "Trash"])
      await this.libraryDirectory(folder);
    await this.libraryDirectory(path.join("Trash", "assets"));
  }

  async init() {
    await this.validateBoundary();
    for (const folder of [...MEDIA_FOLDERS, "Effects", "Trash"])
      await this.libraryDirectory(folder, true);
    await this.libraryDirectory(path.join("Trash", "assets"), true);
  }

  private async trashEntries(): Promise<TrashEntry[]> {
    const directory = await this.libraryDirectory(path.join("Trash", "assets"));
    const items: TrashEntry[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Unexpected library trash entry");
      const dir = path.join(directory, entry.name);
      if ((await fs.readdir(dir)).length === 0) {
        await fs.rmdir(dir);
        continue;
      }
      const item = libraryTrashSchema.parse(
        JSON.parse(await fs.readFile(path.join(dir, "item.json"), "utf8")),
      );
      validateTrashDestination(this.libraryRoot, item);
      const file = path.join(
        dir,
        path.posix.basename(item.originalRelativePath.replaceAll("\\", "/")),
      );
      if (!existsSync(file)) {
        if (
          existsSync(path.join(this.libraryRoot, item.originalRelativePath))
        ) {
          await fs.unlink(path.join(dir, "item.json"));
          await fs.rmdir(dir);
          continue;
        }
        throw new Error(`Trash payload is missing: ${item.hash}`);
      }
      if ((await fs.lstat(file)).isSymbolicLink())
        throw new Error("Unsafe Library Trash asset");
      if ((await fs.stat(file)).size !== item.bytes)
        throw new Error(`Trash payload size mismatch: ${item.hash}`);
      items.push({ ...item, directory: dir, file });
    }
    return items;
  }

  private async readRoots() {
    const assetHashes = new Set<string>();
    const fontUsages = new Map<
      string,
      ReturnType<typeof documentFontUsages>[number]
    >();
    let presentations = 0;
    const fingerprints: string[] = [];

    const visit = async (directory: string) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (
          path.resolve(directory) === path.resolve(this.libraryRoot) &&
          entry.name.toLowerCase() === "trash"
        )
          continue;
        // Recovery directories contain journals, never presentation files.
        if (entry.isDirectory() && entry.name.endsWith(".recovery.sme"))
          continue;
        if (entry.isSymbolicLink())
          throw new Error(`Cannot safely scan symbolic link: ${file}`);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          if (path.extname(entry.name).toLowerCase() === ".sme") {
            const text = await fs.readFile(file, "utf8");
            const raw = JSON.parse(text);
            fingerprints.push(`${file}\0${digest(text)}`);
            const document = parseRuntimeDocument({
              ...raw,
              deck: {
                ...raw.deck,
                name: path.basename(file, path.extname(file)),
              },
            });
            presentations++;
            for (const hash of documentAssetIds(document))
              assetHashes.add(hash);
            for (const usage of documentFontUsages(document))
              fontUsages.set(JSON.stringify(usage), usage);
          }
        } else throw new Error(`Cannot safely scan filesystem entry: ${file}`);
      }
    };
    await visit(this.root);
    return {
      assetHashes,
      fontUsages: [...fontUsages.values()],
      presentations,
      fingerprint: digest(
        (await fs.realpath(this.root)) + "\n" + fingerprints.sort().join("\n"),
      ),
    };
  }

  private async libraryBytes() {
    let bytes = 0;
    const visit = async (directory: string) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (
          path.resolve(directory) === path.resolve(this.libraryRoot) &&
          entry.name.toLowerCase() === "trash"
        )
          continue;
        if (entry.isDirectory() && entry.name.endsWith(".recovery.sme"))
          continue;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error(`Cannot safely scan symbolic link: ${file}`);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) bytes += (await fs.stat(file)).size;
        else throw new Error(`Cannot safely scan filesystem entry: ${file}`);
      }
    };
    await visit(this.libraryRoot);
    return bytes;
  }

  private async physicalAssets() {
    const assets: PhysicalAsset[] = [];
    for (const folder of MEDIA_FOLDERS)
      for (const relative of await libraryWalk(this.libraryRoot, folder)) {
        const hash = assetIdFromFilename(path.basename(relative));
        if (!hash) continue;
        const stat = await fs.stat(libraryPath(this.libraryRoot, relative));
        assets.push({
          hash,
          relative,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    return assets;
  }

  private async liveHashes(
    roots: Awaited<ReturnType<LibraryLifecycle["readRoots"]>>,
    assets: PhysicalAsset[],
    trash: TrashEntry[],
  ) {
    const live = await this.protection.hashes();
    for (const hash of roots.assetHashes) live.add(hash);
    const allDocuments = this.openDocuments();
    for (const document of allDocuments)
      for (const hash of documentAssetIds(document)) live.add(hash);
    const usages = [
      ...roots.fontUsages,
      ...allDocuments.flatMap((document) => documentFontUsages(document)),
    ];
    for (const item of [
      ...assets.map((item) => ({
        hash: item.hash,
        name: path.basename(item.relative),
      })),
      ...trash.map((item) => ({
        hash: item.hash,
        name: path.posix.basename(
          item.originalRelativePath.replaceAll("\\", "/"),
        ),
      })),
    ]) {
      if (usesFont(usages, item.name)) live.add(item.hash);
    }
    return live;
  }

  async scan(
    cleanup = false,
    expire = false,
    restore = true,
  ): Promise<LibraryScanResult> {
    const result: LibraryScanResult = {
      complete: false,
      errors: [],
      presentations: 0,
      referencedBytes: 0,
      unusedBytes: 0,
      trashBytes: 0,
      otherBytes: 0,
      trash: [],
    };
    // OS leases serialize collectors and release automatically on crashes.
    // Windows named pipes avoid competing with its dynamic TCP port range.
    // Other hosts retain the exclusive loopback lease; collisions fail closed.
    const lease = createServer((socket) => socket.destroy());
    let locked = false;
    const moved: TrashEntry[] = [];
    try {
      await this.validateBoundary();
      await this.validateManagedDirectories();
      const canonicalRoot = await fs.realpath(this.root);
      const key =
        process.platform === "win32"
          ? canonicalRoot.toLowerCase()
          : canonicalRoot;
      const port = 49152 + (parseInt(digest(key).slice(0, 8), 16) % 16384);
      await new Promise<void>((resolve, reject) => {
        lease.once("error", reject);
        if (process.platform === "win32")
          lease.listen(
            `\\\\.\\pipe\\showme-library-scan-${digest(key)}`,
            resolve,
          );
        else
          lease.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      locked = true;
      const roots = await this.readRoots();
      const { fingerprint } = roots;
      const assertUnchanged = async () => {
        await this.validateBoundary();
        await this.validateManagedDirectories();
        if ((await this.readRoots()).fingerprint !== fingerprint)
          throw new Error("Presentations changed during Library scan; retry");
      };
      const otherBytes = await this.libraryBytes();
      const assets = await this.physicalAssets();
      let trash = await this.trashEntries();
      const live = await this.liveHashes(roots, assets, trash);
      // Validate every candidate and recheck the complete presentation tree
      // before the first move. A failed scan never produces a partial live set.
      if (cleanup)
        for (const item of assets) {
          if (
            !live.has(item.hash) &&
            (await hashManagedSource(
              libraryPath(this.libraryRoot, item.relative),
            )) !== item.hash
          )
            throw new Error(`Asset hash mismatch: ${item.relative}`);
        }
      for (const item of trash) {
        const needsRestore =
          restore && item.kind !== "effect" && live.has(item.hash);
        const needsExpiry =
          expire &&
          !live.has(item.hash) &&
          this.now() - Date.parse(item.trashedAt) >= LIBRARY_RETENTION_MS;
        if (
          (needsRestore || needsExpiry) &&
          (await hashManagedSource(item.file)) !== item.hash
        )
          throw new Error(`Trash hash mismatch: ${item.hash}`);
      }
      await assertUnchanged();
      result.presentations = roots.presentations;
      result.otherBytes = Math.max(
        0,
        otherBytes - assets.reduce((sum, item) => sum + item.bytes, 0),
      );
      for (const item of trash) {
        if (!restore || item.kind === "effect" || !live.has(item.hash))
          continue;
        const destination = libraryPath(
          this.libraryRoot,
          item.originalRelativePath,
          true,
        );
        if (!existsSync(destination)) {
          await fs.rename(item.file, destination);
          await fs.unlink(path.join(item.directory, "item.json"));
          await fs.rmdir(item.directory);
        } else if ((await hashManagedSource(destination)) !== item.hash)
          throw new Error("Restoration destination changed");
        // If both copies exist, keep the redundant trash copy for user review.
      }
      for (const item of assets) {
        if (live.has(item.hash)) {
          result.referencedBytes += item.bytes;
          continue;
        }
        result.unusedBytes += item.bytes;
        if (!cleanup || !(await this.mayCleanup())) continue;
        // Recheck process drafts immediately before the move, including imports
        // that started while filesystem scanning was in progress.
        if ((await this.protection.hashes()).has(item.hash)) continue;
        const source = libraryPath(this.libraryRoot, item.relative);
        const stat = await fs.stat(source);
        if (stat.size !== item.bytes || stat.mtimeMs !== item.mtimeMs)
          throw new Error(`Asset changed during scan: ${source}`);
        const directory = path.join(
          this.libraryRoot,
          "Trash",
          "assets",
          randomUUID(),
        );
        await fs.mkdir(directory);
        const metadata: LibraryTrashItem = {
          hash: item.hash,
          trashedAt: new Date(this.now()).toISOString(),
          originalRelativePath: item.relative,
          bytes: item.bytes,
        };
        const file = path.join(directory, path.basename(source));
        try {
          await atomicWrite(
            path.join(directory, "item.json"),
            JSON.stringify(metadata, null, 2),
          );
          if (
            (await this.protection.hashes()).has(item.hash) ||
            !(await this.mayCleanup())
          )
            continue;
          // Settings/protection checks can yield while a sync client changes the
          // tree. Validate after those checks, immediately before moving bytes.
          await assertUnchanged();
          await fs.rename(source, file);
          moved.push({ ...metadata, directory, file });
        } finally {
          if (!existsSync(file)) {
            await fs.rm(path.join(directory, "item.json"), { force: true });
            await fs.rmdir(directory);
          }
        }
      }
      // Even cleanup without expiry must detect arrivals during the move phase.
      await assertUnchanged();
      trash = await this.trashEntries();
      if (expire) {
        // A fresh complete scan is required even for aged items.
        await assertUnchanged();
        for (const item of trash) {
          if (
            live.has(item.hash) ||
            (await this.protection.hashes()).has(item.hash)
          )
            continue;
          if (
            this.now() - Date.parse(item.trashedAt) >= LIBRARY_RETENTION_MS &&
            (await this.mayCleanup())
          ) {
            await assertUnchanged();
            await this.systemTrash(item.directory);
          }
        }
        trash = await this.trashEntries();
      }
      result.trash = trash.map(
        ({ directory: _directory, file: _file, ...item }) => item,
      );
      result.trashBytes = trash.reduce((sum, item) => sum + item.bytes, 0);
      result.referencedBytes = 0;
      result.unusedBytes = 0;
      const currentProtection = await this.protection.hashes();
      for (const item of await this.physicalAssets()) {
        if (live.has(item.hash) || currentProtection.has(item.hash))
          result.referencedBytes += item.bytes;
        else result.unusedBytes += item.bytes;
      }
      await assertUnchanged();
      result.complete = true;
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : String(error),
      );
      // A late scan failure must not leave this scan's assets classified as
      // unused. Restore only our own moves and never overwrite arriving bytes.
      for (const item of moved.reverse()) {
        try {
          await this.validateBoundary();
          await this.validateManagedDirectories();
          const destination = libraryPath(
            this.libraryRoot,
            item.originalRelativePath,
            true,
          );
          try {
            await fs.copyFile(item.file, destination, constants.COPYFILE_EXCL);
          } catch (restoreError) {
            if (
              (restoreError as NodeJS.ErrnoException).code !== "EEXIST" ||
              (await hashManagedSource(destination)) !== item.hash
            )
              throw restoreError;
          }
          await fs.unlink(item.file);
          await fs.unlink(path.join(item.directory, "item.json"));
          await fs.rmdir(item.directory);
        } catch (restoreError) {
          result.errors.push(
            `Could not restore ${item.hash} from Library Trash: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
      }
    } finally {
      if (locked)
        await new Promise<void>((resolve) => lease.close(() => resolve()));
    }
    return result;
  }
}
