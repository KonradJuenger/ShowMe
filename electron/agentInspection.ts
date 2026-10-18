import type { AgentContext } from "../src/core/agentContext";
import { agentFailure, agentInspectRequestSchema } from "../src/core/agentRead";
import {
  AgentProjectionError,
  projectAgentDeck,
  projectAgentElements,
  projectAgentSlide,
} from "../src/core/agentProjection";
import type { DocumentProjection } from "../src/core/documentProjection";
import type { Asset } from "../src/core/assets";

interface Dependencies {
  access(): number | null;
  activeDocumentId(): string | null;
  context(): Promise<AgentContext>;
  projection(documentId: string, pageId?: string): Promise<DocumentProjection>;
  listAssets(
    documentId: string,
    query: string,
    offset: number,
    limit: number,
  ): Promise<{
    items: Asset[];
    total: number;
    counts: { images: number; videos: number };
  }>;
}
export class AgentInspectionService {
  constructor(private readonly dependencies: Dependencies) {}
  async inspect(input: unknown) {
    const parsed = agentInspectRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use explicit document identity, revision and a supported inspection target.",
      );
    const request = parsed.data,
      d = this.dependencies,
      access = d.access();
    const check = () =>
      d.access() === null
        ? agentFailure("MCP_DISABLED", "Enable MCP in Settings.")
        : d.access() !== access
          ? agentFailure(
              "MCP_ACCESS_CHANGED",
              "MCP access changed. Read context again.",
            )
          : d.activeDocumentId() !== request.documentId
            ? agentFailure(
                "DOCUMENT_NOT_ACTIVE",
                "Read context for the active document.",
              )
            : null;
    const initial = check();
    if (initial) return initial;
    const fresh = (p: DocumentProjection) =>
      p.documentId !== request.documentId || p.epoch !== request.epoch
        ? agentFailure(
            "EPOCH_CONFLICT",
            "The document was replaced. Read context again.",
          )
        : p.revision !== request.revision
          ? agentFailure(
              "REVISION_CONFLICT",
              "Inspect the current revision and retry.",
              p.revision,
            )
          : null;
    try {
      const target = request.target;
      let selection: AgentContext | undefined;
      if (target.type === "selection") {
        selection = await d.context();
        if (selection.uiEpoch !== target.uiEpoch)
          return agentFailure(
            "UI_CONTEXT_CONFLICT",
            "Selection changed. Read context again.",
          );
        if (!selection.editor || selection.availability !== "ready")
          return agentFailure(
            "DOCUMENT_UNAVAILABLE",
            "The editor context is unavailable. Read context again.",
          );
        if (selection.editor.page.kind !== "slide")
          return agentFailure(
            "UNSUPPORTED_PAGE",
            "Inspect an explicit presentation slide; template selection is not supported.",
          );
        if (selection.editor.selectionIds.length > 128)
          return agentFailure(
            "PAYLOAD_TOO_LARGE",
            "Inspect at most 128 explicit element IDs.",
          );
      }
      const head = await d.projection(request.documentId);
      const before = check() ?? fresh(head);
      if (before) return before;
      if (target.type === "assets") {
        const query = target.query ?? "";
        const offset = target.offset ?? 0;
        const limit = target.limit ?? 25;
        const result = await d.listAssets(
          request.documentId,
          query,
          offset,
          limit,
        );
        const current = await d.projection(request.documentId);
        const pending = check() ?? fresh(current);
        if (pending) return pending;
        return {
          ok: true as const,
          data: {
            documentId: request.documentId,
            epoch: request.epoch,
            revision: request.revision,
            assets: {
              query,
              offset,
              limit,
              total: result.total,
              counts: result.counts,
              items: result.items.map((asset) => ({
                assetId: asset.id,
                name: asset.names[0] ?? asset.filename,
                type: asset.type,
                mediaType: asset.mediaType,
                ...(asset.width === undefined ? {} : { width: asset.width }),
                ...(asset.height === undefined ? {} : { height: asset.height }),
                ...(asset.duration === undefined
                  ? {}
                  : { duration: asset.duration }),
              })),
            },
          },
        };
      }
      const pageId =
        target.type === "deck"
          ? head.deck.slideIds[0]
          : target.type === "selection"
            ? selection!.editor!.page.id
            : target.slideId;
      if (
        !pageId ||
        !head.deck.slideIds.concat(head.deck.templateIds).includes(pageId)
      )
        return agentFailure(
          "UNKNOWN_SLIDE",
          "Inspect an existing presentation slide.",
        );
      const p =
        head.slide.id === pageId
          ? head
          : await d.projection(request.documentId, pageId);
      const pending = check() ?? fresh(p);
      if (pending) return pending;
      if (p.slide.id !== pageId)
        return agentFailure(
          "UNKNOWN_SLIDE",
          "The requested slide is unavailable.",
        );
      const data =
        target.type === "deck"
          ? projectAgentDeck(p, target)
          : target.type === "slide"
            ? {
                ...projectAgentSlide(p, target),
                ...(target.includeEffectResources
                  ? { effectResources: p.slide.effectResources ?? {} }
                  : {}),
              }
            : projectAgentElements(
                p,
                target.type === "selection"
                  ? selection!.editor!.selectionIds
                  : target.elementIds,
                target,
              );
      if (
        target.type === "selection" &&
        (await d.context()).uiEpoch !== target.uiEpoch
      )
        return agentFailure(
          "UI_CONTEXT_CONFLICT",
          "Selection changed. Read context again.",
        );
      const current = await d.projection(request.documentId);
      return check() ?? fresh(current) ?? { ok: true as const, data };
    } catch (error) {
      return (
        check() ??
        (error instanceof AgentProjectionError
          ? agentFailure(
              error.code,
              "The requested scope is unavailable. Inspect the slide outline again.",
            )
          : agentFailure(
              "DOCUMENT_UNAVAILABLE",
              "The document is unavailable. Read context again.",
            ))
      );
    }
  }
}
