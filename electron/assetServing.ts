import type { DocumentStorage } from "./storage";

export async function resolveOriginalAsset(
  storage: DocumentStorage,
  documentId: string | null,
  assetId: string,
) {
  const file = documentId
    ? await storage.verifiedAssetPathForDocument(documentId, assetId)
    : await storage.verifiedAssetPath(assetId);
  const asset = documentId
    ? await storage.assetForDocument(documentId, assetId)
    : await storage.asset(assetId);
  return { file, mime: asset.mime };
}
