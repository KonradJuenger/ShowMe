import type { Asset } from "../src/core/assets";
import { AgentMutationError } from "../src/core/agentMutation";
export interface PreparedAgentMedia {
  asset: Asset | null;
  preview: number[] | null;
  failure?: "unsupported" | "pending";
}
interface Dependencies {
  authorize(file: string): Promise<string>;
  importFile(file: string): Promise<Asset>;
  prepare(asset: Asset): Promise<PreparedAgentMedia | null>;
  updateAsset(asset: Asset): Promise<unknown>;
  storePreview(id: string, bytes: Uint8Array): Promise<unknown>;
}
/** Indexed receipts for native library side effects, including interrupted preparation. */
export async function importAgentMedia(
  paths: string[],
  admit: () => void,
  dependencies: Dependencies,
) {
  const assets = [],
    items = [];
  for (const [index, file] of paths.entries()) {
    let imported: import("../src/core/assets").Asset | undefined;
    try {
      admit();
      const source = await dependencies.authorize(file);
      admit();
      imported = await dependencies.importFile(source);
      admit();
      const prepared = await dependencies.prepare(imported);
      admit();
      if (prepared?.failure)
        throw new AgentMutationError(
          prepared.failure === "unsupported"
            ? "MEDIA_PREPARATION_UNSUPPORTED"
            : "MEDIA_PREPARATION_UNAVAILABLE",
          prepared.failure === "unsupported"
            ? "The production renderer could not decode this asset. Its managed ID is retained; use a supported encoding before insertion."
            : "Media preparation did not finish. Its managed ID is retained; retry only this item.",
        );
      if (!prepared?.asset?.width || !prepared.asset.height)
        throw new AgentMutationError(
          "MEDIA_PREPARATION_UNAVAILABLE",
          "Production media preparation did not return dimensions; the imported asset remains available for recovery.",
        );
      await dependencies.updateAsset(prepared.asset);
      imported = prepared.asset;
      if (prepared.preview)
        await dependencies.storePreview(
          prepared.asset.id,
          new Uint8Array(prepared.preview),
        );
      assets.push(prepared.asset);
      items.push({
        index,
        status: "imported",
        preparation: "prepared",
        asset: prepared.asset,
      });
    } catch (error) {
      if (imported) assets.push(imported);
      const code =
        error instanceof AgentMutationError
          ? error.code
          : imported
            ? "MEDIA_PREPARATION_FAILED"
            : "IMPORT_FAILED";
      items.push({
        index,
        status: imported ? "imported" : "failed",
        preparation:
          code === "MEDIA_PREPARATION_UNSUPPORTED"
            ? "unsupported"
            : imported
              ? "pending"
              : "not-attempted",
        ...(imported ? { asset: imported } : {}),
        error: {
          code,
          message:
            error instanceof AgentMutationError
              ? error.message
              : imported
                ? "Asset imported, but production decoding failed. Retry this item; its managed ID is retained."
                : "Could not import this item. Check its format and selected-root authorization.",
        },
      });
      if (
        [
          "REQUEST_CANCELLED",
          "MCP_ACCESS_CHANGED",
          "DOCUMENT_NOT_ACTIVE",
          "EPOCH_CONFLICT",
          "REVISION_CONFLICT",
        ].includes(code)
      ) {
        // Preserve receipts for library side effects already completed; remaining inputs were not attempted.
        for (let next = index + 1; next < paths.length; next++)
          items.push({
            index: next,
            status: "not-attempted",
            preparation: "not-attempted",
            error: {
              code,
              message: "Request admission ended before this item.",
            },
          });
        break;
      }
    }
  }
  return { cancelled: !paths.length, atomic: false, assets, items };
}
