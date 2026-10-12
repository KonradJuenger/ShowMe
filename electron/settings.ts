import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "./storage";

const appSettingsSchema = z.object({
  storageWarningSeen: z.boolean().optional(),
  imageCachingEnabled: z.boolean().optional(),
  deleteImageCacheOnClose: z.boolean().optional(),
  imageCachePath: z.string().nullable().optional(),
  mediaLibraryPath: z.string().nullable().optional(),
  presentationsFolderPath: z
    .string()
    .refine(path.isAbsolute)
    .nullable()
    .optional(),
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

export function defaultMediaLibraryPath(userDataPath: string): string {
  return path.join(userDataPath, "assets");
}

export function defaultImageCachePath(userDataPath: string): string {
  return path.join(userDataPath, "image-cache");
}

export function defaultPresentationsFolderPath(userDataPath: string): string {
  return path.join(userDataPath, "Presentations");
}

/** Initialize the independent presentations folder without replacing explicit settings. */
export async function initializePresentationsFolder(
  userDataPath: string,
  settings: AppSettings,
): Promise<string> {
  if (settings.presentationsFolderPath !== undefined)
    return (
      settings.presentationsFolderPath ??
      defaultPresentationsFolderPath(userDataPath)
    );
  let existingSettings = false;
  try {
    existingSettings = (await fs.stat(settingsFile(userDataPath))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Another editor may have completed initialization while this one inspected the filesystem.
  const current = await readSettings(userDataPath, {
    requireExisting: existingSettings,
  });
  if (current.presentationsFolderPath !== undefined)
    return (
      current.presentationsFolderPath ??
      defaultPresentationsFolderPath(userDataPath)
    );
  const folder = defaultPresentationsFolderPath(userDataPath);
  await fs.mkdir(folder, { recursive: true });
  settings.presentationsFolderPath = folder;
  await writeSettings(userDataPath, settings);
  return folder;
}
