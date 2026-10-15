import path from "node:path";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";

/** Relative native paths only. Each ancestor is checked before consuming files. */
export function libraryPath(
  root: string,
  relative: string,
  createParents = false,
) {
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
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Invalid Library path");
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

export async function libraryWalk(
  root: string,
  folder: string,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string) => {
    const directory = libraryPath(root, relative);
    const entries = await fs.readdir(directory, { withFileTypes: true });
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
