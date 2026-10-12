import { z } from "zod";
import { assetSchema, hashSchema } from "./assets";
import { idSchema } from "./ids";
import { PRESENTATION_FILE_VERSION } from "./document";
import type { PresentationDocument } from "./document";

export function withoutSpeakerNotes(
  document: PresentationDocument,
): PresentationDocument {
  return {
    ...document,
    slides: Object.fromEntries(
      Object.entries(document.slides).map(([id, slide]) => [
        id,
        { ...slide, notes: "" },
      ]),
    ),
  };
}

export const SHOWME_DOCUMENT_EXTENSION = ".sme" as const;
export const SHOWME_PACKAGE_EXTENSION = ".smp" as const;
export const SHOWME_PACKAGE_FORMAT = "showme-packaged-presentation" as const;
export const SHOWME_PACKAGE_VERSION = 1 as const;
export const SHOWME_PACKAGE_DOCUMENT_PATH =
  "document/presentation.sme" as const;

export const packageAssetSchema = z.object({
  id: hashSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1),
  metadataPath: z.string().min(1),
  originalPath: z.string().min(1),
});

const currentPackageManifestSchema = z.object({
  format: z.literal(SHOWME_PACKAGE_FORMAT),
  packageVersion: z.literal(SHOWME_PACKAGE_VERSION),
  documentVersion: z.literal(PRESENTATION_FILE_VERSION),
  sourceDocumentId: idSchema,
  documentName: z.string().min(1).max(200),
  documentPath: z.literal(SHOWME_PACKAGE_DOCUMENT_PATH),
  createdAt: z.string().datetime(),
  lockMediaFiles: z.boolean(),
  assets: z.array(packageAssetSchema).max(100000),
});

export const packageManifestSchema = currentPackageManifestSchema;

export const packagedAssetMetadataSchema = assetSchema;
export type ShowMePackageManifest = z.infer<typeof packageManifestSchema>;

export function parsePackageManifest(input: unknown): ShowMePackageManifest {
  return packageManifestSchema.parse(input);
}

export function parsePackagedAssetMetadata(
  input: unknown,
): z.infer<typeof packagedAssetMetadataSchema> {
  return packagedAssetMetadataSchema.parse(input);
}
