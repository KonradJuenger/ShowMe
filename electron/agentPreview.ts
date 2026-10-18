import {
  agentPreviewRequestSchema,
  type AgentPreviewErrorCode,
  type AgentPreviewRequest,
  type AgentPreviewResult,
  type SlidePreviewCapture,
} from "../src/core/agentPreview";
import type { DocumentProjection } from "../src/core/documentProjection";
import {
  resolveAgentTimelineSample,
  type AgentPreviewSample,
} from "../src/core/agentPreviewSample";
import { resolveSlideTransition } from "../src/core/slideTransitions";

interface AgentPreviewDependencies {
  /** null while disabled; changes on each successful MCP setting transition. */
  access(): number | null;
  activeDocumentId(): string | null;
  projection(documentId: string, slideId?: string): Promise<DocumentProjection>;
  capture(
    projection: DocumentProjection,
    width: number,
    height: number,
    signal?: AbortSignal,
    sample?: AgentPreviewSample,
    previous?: DocumentProjection,
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
  private pending = new Set<AbortController>();
  constructor(private readonly dependencies: AgentPreviewDependencies) {}

  cancelAll() {
    for (const controller of this.pending) controller.abort();
  }

  private accessFailure(
    request: AgentPreviewRequest,
    access: number,
    signal?: AbortSignal,
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
    if (signal?.aborted)
      return failure("REQUEST_CANCELLED", "The preview request was cancelled.");
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

  async preview(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentPreviewResult> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.pending.add(controller);
    try {
      const parsed = agentPreviewRequestSchema.safeParse(input);
      if (parsed.success && parsed.data.samples) {
        const { samples, ...request } = parsed.data;
        const frames: Array<
          SlidePreviewCapture & { sample: Record<string, unknown> }
        > = [];
        let first: Extract<AgentPreviewResult, { ok: true }> | undefined;
        for (const sample of samples) {
          const result = await this.performPreview(
            { ...request, sample },
            controller.signal,
          );
          if (!result.ok) return result;
          first ??= result;
          frames.push({
            width: result.width,
            height: result.height,
            pngDataUrl: result.pngDataUrl,
            warnings: result.warnings,
            sample: result.sample!,
          });
        }
        return { ...first!, pngDataUrl: "", frames };
      }
      return await this.performPreview(input, controller.signal);
    } finally {
      this.pending.delete(controller);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private async performPreview(
    input: unknown,
    signal: AbortSignal,
  ): Promise<AgentPreviewResult> {
    const parsed = agentPreviewRequestSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_REQUEST",
        "Use exact document/slide/revision, output dimensions from 1 to 2048, and a bounded event trace for optional sampling.",
      );
    const request = parsed.data;
    const access = this.dependencies.access();
    if (access === null)
      return failure(
        "MCP_DISABLED",
        "Enable MCP in Settings before requesting a preview.",
      );
    const accessError = this.accessFailure(request, access, signal);
    if (accessError) return accessError;
    try {
      // Metadata first distinguishes missing slides from an unavailable document.
      const head = await this.dependencies.projection(request.documentId);
      const error =
        this.accessFailure(request, access, signal) ??
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
        this.accessFailure(request, access, signal) ??
        this.projectionFailure(request, projection);
      if (before) return before;
      if (projection.slide.id !== request.slideId)
        return failure("UNKNOWN_SLIDE", "The requested slide is unavailable.");
      let sampleMetadata: Record<string, unknown> | undefined,
        previous: DocumentProjection | undefined;
      if (request.sample) {
        try {
          const sample = request.sample;
          if (sample.mode === "transition") {
            if (
              sample.previousSlideId === request.slideId ||
              !projection.deck.slideIds.includes(sample.previousSlideId)
            )
              throw new Error(
                "Use a distinct existing previous slide for a transition.",
              );
            previous = await this.dependencies.projection(
              request.documentId,
              sample.previousSlideId,
            );
            const invalid =
              this.accessFailure(request, access, signal) ??
              this.projectionFailure(request, previous);
            if (invalid) return invalid;
            if (previous.slide.id !== sample.previousSlideId)
              throw new Error("Previous slide is unavailable.");
            if (
              sample.incoming.captureTimeMs !==
                sample.incoming.activationMs + sample.elapsedMs ||
              sample.outgoing.captureTimeMs !== sample.incoming.captureTimeMs ||
              sample.outgoing.presentationOriginMs !==
                sample.incoming.presentationOriginMs ||
              sample.incoming.previousSlideId !== sample.previousSlideId
            )
              throw new Error(
                "Transition traces must share presentation origin and capture time; incoming activation plus elapsedMs must equal captureTimeMs, with the explicit previousSlideId.",
              );
            const incoming = resolveAgentTimelineSample(
                projection,
                sample.incoming,
              ),
              outgoing = resolveAgentTimelineSample(previous, sample.outgoing);
            sampleMetadata = {
              mode: "transition",
              elapsedMs: sample.elapsedMs,
              previousSlideId: sample.previousSlideId,
              transition: resolveSlideTransition(
                projection.deck.slideMeta[projection.slide.id].transition,
                projection.deck.transitionDefaults,
              ),
              incoming: incoming.metadata,
              outgoing: outgoing.metadata,
            };
          } else
            sampleMetadata = resolveAgentTimelineSample(
              projection,
              sample,
              sample.mode === "finite-complete",
            ).metadata;
        } catch (error) {
          return failure(
            "INVALID_REQUEST",
            error instanceof Error ? error.message : "Invalid sampling trace.",
          );
        }
      }
      let capture: SlidePreviewCapture | null;
      try {
        capture = await this.dependencies.capture(
          projection,
          request.width,
          request.height,
          signal,
          request.sample,
          previous,
        );
      } catch {
        capture = null;
      }
      const changedAccess = this.accessFailure(request, access, signal);
      if (changedAccess) return changedAccess;
      const current = await this.dependencies.projection(request.documentId);
      const after =
        this.accessFailure(request, access, signal) ??
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
        state: request.sample ? "sampled" : "base",
        ...(sampleMetadata ? { sample: sampleMetadata } : {}),
        ...capture,
      };
    } catch {
      return (
        this.accessFailure(request, access, signal) ??
        failure(
          "DOCUMENT_UNAVAILABLE",
          "The document or slide is unavailable. Read context again.",
        )
      );
    }
  }
}
