import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./storage";

const appSettingsSchema = z.object({
  mcpEnabled: z.boolean().optional(),
  mcpEditingEnabled: z.boolean().optional(),
  storageWarningSeen: z.boolean().optional(),
  imageCachingEnabled: z.boolean().optional(),
  htmlExportJpegQuality: z.number().int().min(1).max(100).optional(),
  imageCacheFormat: z.enum(["png", "jpg"]).optional(),
  deleteImageCacheOnClose: z.boolean().optional(),
  imageCachePath: z.string().nullable().optional(),
  showMeRootPath: z.string().refine(path.isAbsolute).optional(),
  libraryLifecycleMode: z.enum(["managed", "keep-all", "portable"]).optional(),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const settingsFile = (userDataPath: string) =>
  path.join(userDataPath, "settings.json");

export async function readSettings(
  userDataPath: string,
  { requireExisting = false }: { requireExisting?: boolean } = {},
): Promise<AppSettings> {
  try {
    const text = await fs.readFile(settingsFile(userDataPath), "utf8");
    return appSettingsSchema.parse(JSON.parse(text));
  } catch (error) {
    if (!requireExisting && (error as NodeJS.ErrnoException).code === "ENOENT")
      return {};
    throw new Error(
      "Could not read ShowMe settings. Restore the settings file before changing storage folders or running cleanup.",
      { cause: error },
    );
  }
}

export async function writeSettings(
  userDataPath: string,
  settings: AppSettings,
) {
  await atomicWrite(
    settingsFile(userDataPath),
    JSON.stringify(settings, null, 2) + "\n",
  );
}

export function defaultImageCachePath(userDataPath: string): string {
  return path.join(userDataPath, "image-cache");
}

export function showMeLibraryPath(showMeRoot: string): string {
  return path.join(path.resolve(showMeRoot), "ShowMe Library");
}

function samePath(a: string, b: string) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Validate an explicitly selected ShowMe root and return its canonical path.
 * The root itself must already exist. The visible ShowMe Library directory is created
 * only when the user explicitly selects/configures that root.
 */
export async function validateShowMeRoot(
  selected: string,
  { createLibrary = false }: { createLibrary?: boolean } = {},
): Promise<string> {
  if (!path.isAbsolute(selected))
    throw new Error("Choose an absolute ShowMe root");
  const resolved = path.resolve(selected);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Choose a ShowMe root directory");
  const root = await fs.realpath(resolved);
  const library = showMeLibraryPath(root);
  if (createLibrary) await fs.mkdir(library, { recursive: true });
  let libraryStat;
  try {
    libraryStat = await fs.lstat(library);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "The ShowMe root does not contain a ShowMe Library directory",
        {
          cause: error,
        },
      );
    throw error;
  }
  if (!libraryStat.isDirectory() || libraryStat.isSymbolicLink())
    throw new Error(
      "ShowMe Library must be a real directory inside the ShowMe root",
    );
  const canonicalLibrary = await fs.realpath(library);
  if (!samePath(canonicalLibrary, path.join(root, "ShowMe Library")))
    throw new Error("ShowMe Library must not escape the ShowMe root");
  return root;
}
