import { promises as fs } from "node:fs";
import path from "node:path";
import { libraryPath, libraryWalk } from "./libraryFilesystem";
import {
  assetIdFromFilename,
  hashManagedSource,
  isManagedFilenameProtected,
  setManagedFilenameProtected,
} from "./mediaLibrary";

export function libraryProtectionState(
  relative: string,
): "self" | null {
  return isManagedFilenameProtected(path.posix.basename(relative))
    ? "self"
    : null;
}

async function setManagedFileProtection(
  root: string,
  relative: string,
  protect: boolean,
) {
  const source = libraryPath(root, relative);
  const name = path.basename(source);
  const hash = assetIdFromFilename(name);
  if (!hash) return false;
  if (isManagedFilenameProtected(name) === protect) return false;

  const destinationName = setManagedFilenameProtected(name, protect);
  const destinationRelative = path.posix.join(
    path.posix.dirname(relative.replaceAll("\\", "/")),
    destinationName,
  );
  const destination = libraryPath(root, destinationRelative, true);

  try {
    await fs.link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await hashManagedSource(destination)) !== hash)
      throw new Error("Conflicting managed asset protection filename", {
        cause: error,
      });
  }
  await fs.unlink(source);
  return true;
}

/**
 * Protection is encoded in managed media filenames as:
 *   name__<sha256>~p.ext
 *
 * Protecting a directory is deliberately a bulk operation over the managed
 * files currently inside it. The directory itself stores no protection state,
 * so files added later remain unprotected until explicitly protected.
 */
export async function setLibraryProtection(
  root: string,
  relative: string,
  protect: boolean,
) {
  const target = relative.replaceAll("\\", "/");
  const source = libraryPath(root, target);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink())
    throw new Error("Only real Library files and folders can be protected");

  if (stat.isFile()) {
    if (!assetIdFromFilename(path.basename(source)))
      throw new Error("Only managed Library media can be protected");
    await setManagedFileProtection(root, target, protect);
    return;
  }
  if (!stat.isDirectory())
    throw new Error("Only Library files and folders can be protected");

  for (const child of await libraryWalk(root, target))
    if (assetIdFromFilename(path.posix.basename(child)))
      await setManagedFileProtection(root, child, protect);
}
