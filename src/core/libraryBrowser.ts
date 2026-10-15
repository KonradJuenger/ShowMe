import { z } from "zod";
import type { Asset } from "./assets";
import { effectFolderSchema } from "./libraryEffects";

export const LIBRARY_CATEGORIES = [
  "images",
  "video",
  "audio",
  "fonts",
  "other",
  "Effects",
] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];
const category = z.enum(LIBRARY_CATEGORIES);
const relative = effectFolderSchema.refine((value) => value.length > 0);
export const libraryBrowserRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("list"),
      category,
      folder: effectFolderSchema,
      query: z.string().max(500),
      all: z.boolean(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("trash"),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
  z.object({ type: z.literal("mkdir"), path: relative }).strict(),
  z
    .object({
      type: z.literal("rename"),
      path: relative,
      name: relative.refine((value) => !value.includes("/")),
    })
    .strict(),
  z
    .object({ type: z.literal("move"), path: relative, destination: relative })
    .strict(),
  z.object({ type: z.literal("remove-folder"), path: relative }).strict(),
  z
    .object({
      type: z.literal("protect"),
      path: relative,
      protected: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("reveal"), path: relative }).strict(),
  z.object({ type: z.literal("import"), path: relative }).strict(),
  z
    .object({
      type: z.literal("import-files"),
      category,
      folder: effectFolderSchema,
    })
    .strict(),
  z.object({ type: z.literal("preview"), path: relative }).strict(),
  z.object({ type: z.literal("restore"), path: relative }).strict(),
]);
export type LibraryBrowserRequest = z.infer<typeof libraryBrowserRequestSchema>;
export interface LibraryBrowserEntry {
  path: string;
  name: string;
  kind: "folder" | "file" | "trash";
  category?: LibraryCategory;
  managed: boolean;
  protection?: "self" | "parent";
  bytes?: number;
  signature?: string;
  asset?: Asset;
  originalPath?: string;
  trashedAt?: string;
  error?: string;
}
export interface LibraryBrowserResult {
  entries: LibraryBrowserEntry[];
  total: number;
  folders: string[];
  asset?: Asset;
  preview?: string;
}
