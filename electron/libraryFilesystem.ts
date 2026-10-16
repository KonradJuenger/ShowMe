import path from "node:path";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";

/** Relative native paths only. Each ancestor is checked before consuming files. */
export function libraryPath(
  root: string,
  relative: string,
  createParents = false,
): string {
  const parts = relative.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/.test(part) ||
        /^(con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(
          part,
        ),
    )
  )
    throw new Error("Invalid Library path");
  if (createParents) libraryMutationPath(root, relative);
  let current = path.resolve(root);
  for (const part of ["", ...parts]) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Unsafe Library symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (createParents && current !== path.join(root, ...parts))
        mkdirSync(current);
    }
  }
  return current;
}

/** Mutation-only portability check; no synced catalog or canonical-path identity. */
export function libraryMutationPath(root: string, relative: string): string {
  const destination = libraryPath(root, relative);
  const parts = relative.replaceAll("\\", "/").split("/");
  let parent = root;
  for (const part of parts) {
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    const key = part.normalize("NFC").toLowerCase();
    if (
      names.some(
        (name) => name !== part && name.normalize("NFC").toLowerCase() === key,
      )
    )
      throw new Error("Library name collides by case or Unicode normalization");
    parent = path.join(parent, part);
  }
  return destination;
}

export class LibraryObservationChanged extends Error {
  constructor() {
    super("Library changed during observation; reconciliation will retry");
  }
}

/** Discard incomplete observations, never permission/structure/symlink errors. */
export async function observeLibrary<T>(observe: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await observe();
    } catch (error) {
      if (
        !(error instanceof LibraryObservationChanged) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
  }
  throw new LibraryObservationChanged();
}

/** Detect tree changes even when a watcher hint arrives after the scan finishes. */
export class LibraryDirectoryObservation {
  private signatures = new Map<string, string>();
  constructor(private readonly root: string) {}

  private async signature(relative: string) {
    const stat = await fs.lstat(libraryPath(this.root, relative), {
      bigint: true,
    });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe Library directory: ${relative}`);
    return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(":");
  }

  async read(relative: string) {
    this.signatures.set(relative, await this.signature(relative));
    return fs.readdir(libraryPath(this.root, relative), {
      withFileTypes: true,
    });
  }

  async assertUnchanged() {
    for (const [relative, signature] of this.signatures)
      if ((await this.signature(relative)) !== signature)
        throw new LibraryObservationChanged();
  }
}

export async function libraryWalk(
  root: string,
  folder: string,
  observation?: LibraryDirectoryObservation,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string) => {
    const directory = libraryPath(root, relative);
    const entries = observation
      ? await observation.read(relative)
      : await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Unsafe Library symbolic link: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await visit(folder);
  return files;
}

export function libraryWalkSync(root: string, folder: string): string[] {
  const directory = libraryPath(root, folder);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (entry.isSymbolicLink())
        throw new Error(`Unsafe Library symbolic link: ${entry.name}`);
      const child = `${folder}/${entry.name}`;
      return entry.isDirectory()
        ? libraryWalkSync(root, child)
        : entry.isFile()
          ? [child]
          : [];
    });
}
