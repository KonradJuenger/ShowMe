import {
  agentPreviewRequestSchema,
  type AgentPreviewErrorCode,
  type AgentPreviewRequest,
  type AgentPreviewResult,
  type SlidePreviewCapture,
} from "../src/core/agentPreview";
import type { DocumentProjection } from "../src/core/documentProjection";

interface AgentPreviewDependencies {
  /** null while disabled; changes on each successful MCP setting transition. */
  access(): number | null;
  activeDocumentId(): string | null;
  projection(documentId: string, slideId?: string): Promise<DocumentProjection>;
  capture(
    projection: DocumentProjection,
    width: number,
    height: number,
  ): Promise<SlidePreviewCapture | null>;
}

function failure(
  code: AgentPreviewErrorCode,
  message: string,
  actualRevision?: number,
): AgentPreviewResult {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: code !== "INVALID_REQUEST",
      ...(actualRevision !== undefined ? { actualRevision } : {}),
    },
  };
}

/** Stateless read adapter; all pixels and document state belong to production services. */
export class AgentPreviewService {
  constructor(private readonly dependencies: AgentPreviewDependencies) {}

  private accessFailure(
    request: AgentPreviewRequest,
    access: number,
  ): AgentPreviewResult | null {
    const current = this.dependencies.access();
    if (current === null)
      return failure(
        "MCP_DISABLED",
        "Enable MCP in Settings before requesting a preview.",
      );
    if (current !== access)
      return failure(
        "MCP_ACCESS_CHANGED",
        "MCP access changed during capture. Retry the preview.",
      );
    if (this.dependencies.activeDocumentId() !== request.documentId)
      return failure(
        "DOCUMENT_NOT_ACTIVE",
        "The requested document is no longer active. Read context again.",
      );
    return null;
  }

  private projectionFailure(
    request: AgentPreviewRequest,
    projection: DocumentProjection,
  ): AgentPreviewResult | null {
    if (
      projection.documentId !== request.documentId ||
      projection.epoch !== request.epoch
    )
      return failure(
        "EPOCH_CONFLICT",
        "The document was replaced or reopened. Read context and inspect again.",
      );
    if (projection.revision !== request.revision)
      return failure(
        "REVISION_CONFLICT",
        "The document changed. Inspect the current revision and retry.",
        projection.revision,
      );
    if (!projection.deck.slideIds.includes(request.slideId))
      return failure(
        "UNKNOWN_SLIDE",
        "The requested presentation slide does not exist at this revision.",
      );
    return null;
  }

  async preview(input: unknown): Promise<AgentPreviewResult> {
    const parsed = agentPreviewRequestSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_REQUEST",
        "Use document/slide IDs, epoch, revision and integer output dimensions from 1 to 2048. Timeline samples are not supported yet.",
      );
    const request = parsed.data;
    const access = this.dependencies.access();
    if (access === null)
      return failure(
        "MCP_DISABLED",
        "Enable MCP in Settings before requesting a preview.",
      );
    const accessError = this.accessFailure(request, access);
    if (accessError) return accessError;
    try {
      // Metadata first distinguishes missing slides from an unavailable document.
      const head = await this.dependencies.projection(request.documentId);
      const error =
        this.accessFailure(request, access) ??
        this.projectionFailure(request, head);
      if (error) return error;
      const projection =
        head.slide.id === request.slideId
          ? head
          : await this.dependencies.projection(
              request.documentId,
              request.slideId,
            );
      const before =
        this.accessFailure(request, access) ??
        this.projectionFailure(request, projection);
      if (before) return before;
      if (projection.slide.id !== request.slideId)
        return failure("UNKNOWN_SLIDE", "The requested slide is unavailable.");
      let capture: SlidePreviewCapture | null;
      try {
        capture = await this.dependencies.capture(
          projection,
          request.width,
          request.height,
        );
      } catch {
        capture = null;
      }
      const changedAccess = this.accessFailure(request, access);
      if (changedAccess) return changedAccess;
      const current = await this.dependencies.projection(request.documentId);
      const after =
        this.accessFailure(request, access) ??
        this.projectionFailure(request, current);
      if (after) return after;
      if (!capture)
        return failure(
          "PREVIEW_FAILED",
          "The preview was busy, unavailable or did not become ready. Retry the preview.",
        );
      return {
        ok: true,
        documentId: request.documentId,
        epoch: request.epoch,
        revision: request.revision,
        slideId: request.slideId,
        mimeType: "image/png",
        state: "base",
        ...capture,
      };
    } catch {
      return (
        this.accessFailure(request, access) ??
        failure(
          "DOCUMENT_UNAVAILABLE",
          "The document or slide is unavailable. Read context again.",
        )
      );
    }
  }
}
