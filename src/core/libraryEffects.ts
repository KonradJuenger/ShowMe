import { z } from "zod";
import {
  effectDefinitionSchema,
  effectAuthoringDiagnostics,
  type EffectDefinition,
} from "./effects";
import { uid } from "./ids";

export const LIBRARY_EFFECT_VERSION = 1 as const;

export const libraryEffectSchema = z
  .object({
    format: z.literal("showme-effect"),
    version: z.literal(LIBRARY_EFFECT_VERSION),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    revision: z.number().int().positive(),
    definition: effectDefinitionSchema,
  })
  .strict();
export type LibraryEffectAsset = z.infer<typeof libraryEffectSchema>;
export type LibraryEffectEntry = { asset: LibraryEffectAsset; folder: string };
export type EffectLibrary = {
  entries: LibraryEffectEntry[];
  folders: string[];
};

/** Stable identity suffix; editing code or renaming never changes the hash. */
export function libraryEffectFilename(asset: LibraryEffectAsset): string {
  let hash = 2166136261;
  for (const character of asset.id)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  const name =
    asset.definition.name
      .normalize("NFC")
      .replace(/[<>:"/\\|?*]/g, "-")
      .split("")
      .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
      .join("")
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, "") || "Effect";
  return `${name}-${suffix}.txt`;
}
export const effectFolderSchema = z
  .string()
  .max(500)
  .refine(
    (folder) =>
      folder === "" ||
      folder
        .split("/")
        .every(
          (part) =>
            /^[^<>:"\\|?*/]+$/.test(part) &&
            [...part].every((c) => c.charCodeAt(0) >= 32) &&
            part !== "." &&
            part !== ".." &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
        ),
    "Invalid Effects folder",
  );
export const effectLibraryRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z
    .object({
      type: z.literal("save"),
      definition: effectDefinitionSchema,
      id: z.string().optional(),
      revision: z.number().int().positive().optional(),
      folder: effectFolderSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      id: z.string(),
      revision: z.number().int().positive(),
      folder: effectFolderSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("delete"),
      id: z.string(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("folder"), folder: effectFolderSchema }).strict(),
  z.object({ type: z.literal("reveal"), id: z.string() }).strict(),
]);
export type EffectLibraryRequest = z.infer<typeof effectLibraryRequestSchema>;

/** One EffectDefinition contract; the independently versioned envelope is Library ownership. */
export function savedLibraryEffect(
  definition: EffectDefinition,
  previous?: LibraryEffectAsset,
): LibraryEffectAsset {
  const parsed = effectDefinitionSchema.parse(definition);
  const diagnostics = effectAuthoringDiagnostics(parsed);
  if (diagnostics.length) throw new Error(diagnostics.join("; "));
  return libraryEffectSchema.parse({
    format: "showme-effect",
    version: LIBRARY_EFFECT_VERSION,
    id: previous?.id ?? uid(),
    revision: (previous?.revision ?? 0) + 1,
    definition: parsed,
  });
}
export function editEffectLibrary(
  input: EffectLibrary,
  raw: EffectLibraryRequest,
): EffectLibrary {
  const request = effectLibraryRequestSchema.parse(raw);
  const next = structuredClone(input);
  if (request.type === "list" || request.type === "reveal") return next;
  if (request.type === "folder") {
    addFolders(next, request.folder);
    return next;
  }
  const previous = request.id
    ? next.entries.find((e) => e.asset.id === request.id)
    : undefined;
  if (request.id && (!previous || previous.asset.revision !== request.revision))
    throw new Error("This Library Effect changed. Reopen it before saving.");
  if (request.type === "delete")
    next.entries = next.entries.filter((e) => e !== previous);
  else if (request.type === "move") {
    previous!.folder = request.folder;
    addFolders(next, request.folder);
  } else {
    if (
      previous &&
      request.folder !== undefined &&
      request.folder !== previous.folder
    )
      throw new Error("Use Move to change an Effect folder");
    const asset = savedLibraryEffect(request.definition, previous?.asset);
    const folder = request.folder ?? previous?.folder ?? "";
    if (previous) {
      previous.asset = asset;
      previous.folder = folder;
    } else next.entries.push({ asset, folder });
    addFolders(next, folder);
  }
  return next;
}
function addFolders(library: EffectLibrary, folder: string) {
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    if (parent && !library.folders.includes(parent))
      library.folders.push(parent);
  }
}
