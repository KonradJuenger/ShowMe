import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PresentationDocument } from "../src/core/document";
import {
  fontUsageLabel,
  collectUsedFontUsages,
  type FontUsage,
} from "../src/core/fonts";
import type { DocumentStorage } from "./storage";
import { atomicWrite, hashFile } from "./storage/io";
import {
  readStoredZipFile,
  readArchiveEntry,
  type ZipEntryInput,
} from "./packageArchive";
import { managedFilename } from "./mediaLibrary";
import {
  resolveFontUsages,
  saveResolvedFontToLibrary,
  managedFontsFromLibrary,
  type ResolvedFontFace,
} from "./fontLibrary";

const FONT_BYTES = 32 * 1024 ** 2;
const TOTAL_FONT_BYTES = 128 * 1024 ** 2;
const packagedFontSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  family: z.string().min(1).max(200),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  bytes: z.number().int().nonnegative().max(FONT_BYTES),
  originalName: z.string().min(1).max(500),
  originalPath: z.string().min(1),
});
type PackagedFont = z.infer<typeof packagedFontSchema>;
export interface PackageFontResources {
  families: Awaited<ReturnType<typeof managedFontsFromLibrary>>;
  files: ResolvedFontFace[];
}
function sameUsage(a: FontUsage, b: FontUsage) {
  return (
    a.family.localeCompare(b.family, undefined, { sensitivity: "accent" }) ===
      0 &&
    a.weight === b.weight &&
    a.italic === b.italic
  );
}
async function packageResolvedFonts(resolved: ResolvedFontFace[]) {
  const fonts: PackagedFont[] = [];
  const entries: ZipEntryInput[] = [];
  const added = new Set<string>();
  let total = 0;
  for (const face of resolved) {
    const bytes = (await fs.stat(face.filePath)).size;
    total += bytes;
    if (bytes > FONT_BYTES || total > TOTAL_FONT_BYTES)
      throw new Error("Package fonts exceed size limit");
    const id = await hashFile(face.filePath);
    const originalName = path.basename(face.filePath);
    const originalPath = `fonts/${managedFilename(originalName, id)}`;
    fonts.push(
      packagedFontSchema.parse({
        id,
        family: face.family,
        weight: face.weight,
        italic: face.italic,
        bytes,
        originalName,
        originalPath,
      }),
    );
    if (!added.has(originalPath)) {
      entries.push({ name: originalPath, file: face.filePath });
      added.add(originalPath);
    }
  }
  return { fonts, entries };
}
async function loadPackagedFonts(storage: DocumentStorage, file: string) {
  const archive = await readStoredZipFile(file);
  try {
    const manifest = archive.entries.get("manifest.json");
    if (!manifest) throw new Error("Package manifest is missing");
    const raw = JSON.parse((await readArchiveEntry(manifest)).toString("utf8"));
    const fonts = z
      .array(packagedFontSchema)
      .max(1000)
      .parse(raw.fonts ?? []);
    let total = 0;
    for (const font of fonts) {
      total += font.bytes;
      if (total > TOTAL_FONT_BYTES)
        throw new Error("Package fonts exceed size limit");
      const entry = archive.entries.get(font.originalPath);
      if (
        !entry ||
        entry.bytes !== font.bytes ||
        (await hashFile(entry.file)) !== font.id
      )
        throw new Error(
          `Packaged font ${font.family} failed hash verification`,
        );
    }
    const families = new Map<
      string,
      PackageFontResources["families"][number]
    >();
    const files: ResolvedFontFace[] = [];
    for (const font of fonts) {
      const bytes = await readArchiveEntry(
        archive.entries.get(font.originalPath)!,
        FONT_BYTES,
      );
      const filePath = path.join(
        storage.cacheRoot,
        "package-fonts",
        font.id,
        path.basename(font.originalPath),
      );
      await atomicWrite(filePath, bytes);
      files.push({
        family: font.family,
        weight: font.weight,
        italic: font.italic,
        filePath,
      });
      const family = families.get(font.family) ?? {
        family: font.family,
        weights: [],
        sources: [],
      };
      family.weights = [...new Set([...family.weights, font.weight])];
      family.sources = [
        ...(family.sources ?? []),
        {
          id: font.id,
          weight: font.weight,
          italic: font.italic,
          data: new Uint8Array(bytes),
        },
      ];
      families.set(font.family, family);
    }
    return { families: [...families.values()], files };
  } finally {
    await archive.dispose();
  }
}
async function packageWithFonts(
  storage: DocumentStorage,
  document: PresentationDocument,
  resources?: PackageFontResources,
  embedLocalFonts = false,
) {
  // Public packages retain document-owned fonts but never collect local fonts.
  // Developer callers may opt into the existing embedding implementation.
  if (!embedLocalFonts) return packageResolvedFonts(resources?.files ?? []);
  const usages = collectUsedFontUsages(
    [
      ...Object.values(document.slides),
      ...Object.values(document.templates).map((page) => ({
        ...page,
        notes: "",
      })),
    ],
    document.deck,
  );
  if (!usages.length) return { fonts: [], entries: [] };
  const resolution = await resolveFontUsages(storage.assetRoot, usages);
  const embedded = resolution.missing.flatMap((usage) => {
    const found = resources?.files.find((face) => sameUsage(face, usage));
    return found ? [found] : [];
  });
  const missing = resolution.missing.filter(
    (usage) => !embedded.some((face) => sameUsage(face, usage)),
  );
  if (missing.length)
    throw new Error(
      `Cannot create a portable package because these fonts cannot be located: ${missing.map(fontUsageLabel).join(", ")}`,
    );
  return packageResolvedFonts([...resolution.resolved, ...embedded]);
}
export const fontStorageService = {
  load: loadPackagedFonts,
  package: packageWithFonts,
  async toLibrary(
    storage: DocumentStorage,
    documentId: string,
    resources?: PackageFontResources,
  ) {
    for (const face of resources?.files ?? []) {
      storage.protectAssetImports(documentId, [await hashFile(face.filePath)]);
      await saveResolvedFontToLibrary(storage.assetRoot, face);
    }
  },
  async managed(storage: DocumentStorage, resources?: PackageFontResources) {
    return [
      ...(await managedFontsFromLibrary(storage.assetRoot)),
      ...(resources?.families ?? []),
    ];
  },
};
