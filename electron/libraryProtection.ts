import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./storage/io";
import { libraryPath } from "./libraryFilesystem";

const protectionSchema = z
  .object({
    version: z.literal(1),
    paths: z.array(z.string().min(1).max(2000)).max(10000),
  })
  .strict();

const metadataPath = (root: string) =>
  libraryPath(root, ".showme/protected.json", true);

const normalize = (value: string) => value.replaceAll("\\", "/");

export async function readLibraryProtection(root: string) {
  const file = metadataPath(root);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw error;
  }
  const parsed = protectionSchema.parse(raw);
  const paths = new Set<string>();
  for (const value of parsed.paths) {
    const relative = normalize(value);
    libraryPath(root, relative);
    paths.add(relative);
  }
  return paths;
}

async function writeLibraryProtection(root: string, paths: Set<string>) {
  const file = metadataPath(root);
  await atomicWrite(
    file,
    JSON.stringify(
      { version: 1, paths: [...paths].sort((a, b) => a.localeCompare(b)) },
      null,
      2,
    ) + "\n",
  );
}

export function libraryProtectionState(
  protectedPaths: ReadonlySet<string>,
  relative: string,
): "self" | "parent" | null {
  const target = normalize(relative);
  if (protectedPaths.has(target)) return "self";
  for (const candidate of protectedPaths)
    if (target.startsWith(candidate + "/")) return "parent";
  return null;
}

export async function setLibraryProtection(
  root: string,
  relative: string,
  protect: boolean,
) {
  const target = normalize(relative);
  libraryPath(root, target);
  const paths = await readLibraryProtection(root);
  if (protect) paths.add(target);
  else paths.delete(target);
  await writeLibraryProtection(root, paths);
  return libraryProtectionState(paths, target);
}

export async function moveLibraryProtection(
  root: string,
  source: string,
  destination: string,
) {
  const from = normalize(source);
  const to = normalize(destination);
  libraryPath(root, from);
  libraryPath(root, to);
  const paths = await readLibraryProtection(root);
  let changed = false;
  const next = new Set<string>();
  for (const candidate of paths) {
    if (candidate === from || candidate.startsWith(from + "/")) {
      next.add(to + candidate.slice(from.length));
      changed = true;
    } else next.add(candidate);
  }
  if (changed) await writeLibraryProtection(root, next);
}

export async function removeLibraryProtection(root: string, relative: string) {
  const target = normalize(relative);
  libraryPath(root, target);
  const paths = await readLibraryProtection(root);
  let changed = false;
  for (const candidate of [...paths])
    if (candidate === target || candidate.startsWith(target + "/")) {
      paths.delete(candidate);
      changed = true;
    }
  if (changed) await writeLibraryProtection(root, paths);
}
