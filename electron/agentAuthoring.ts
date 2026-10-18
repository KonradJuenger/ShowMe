import {
  agentAuthoringRequestSchema,
  buildAgentAuthoringGuide,
  effectAuthoringKind,
  isAgentEffectAuthoringKind,
} from "../src/core/agentAuthoring";
import type { AgentContext } from "../src/core/agentContext";
import type { DocumentProjection } from "../src/core/documentProjection";
import { agentFailure } from "../src/core/agentRead";
import { findElement } from "../src/core/scene";
import { resolveVisualSlide } from "../src/core/templates";

interface Dependencies {
  access(): number | null;
  activeDocumentId(): string | null;
  context(): Promise<AgentContext>;
  projection(documentId: string, pageId?: string): Promise<DocumentProjection>;
}

export class AgentAuthoringService {
  constructor(private readonly dependencies: Dependencies) {}

  async authoring(input: unknown) {
    const parsed = agentAuthoringRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use a supported authoring kind and a complete exact document scope when editing an existing Effect.",
      );
    const request = parsed.data;
    const access = this.dependencies.access();
    if (access === null)
      return agentFailure("MCP_DISABLED", "Enable MCP in Settings.");
    if (!request.documentId)
      return {
        ok: true as const,
        data: buildAgentAuthoringGuide(request.kind),
      };
    if (this.dependencies.activeDocumentId() !== request.documentId)
      return agentFailure(
        "DOCUMENT_NOT_ACTIVE",
        "Read context for the active document.",
      );
    try {
      const projection = await this.dependencies.projection(
        request.documentId,
        request.slideId,
      );
      if (this.dependencies.access() !== access)
        return agentFailure(
          "MCP_ACCESS_CHANGED",
          "MCP access changed. Read context again.",
        );
      if (projection.epoch !== request.epoch)
        return agentFailure(
          "EPOCH_CONFLICT",
          "The document was replaced. Read context again.",
        );
      if (projection.revision !== request.revision)
        return agentFailure(
          "REVISION_CONFLICT",
          "Inspect the current revision and retry.",
          projection.revision,
        );
      if (projection.slide.id !== request.slideId)
        return agentFailure(
          "UNKNOWN_SLIDE",
          "The requested slide is unavailable.",
        );
      if (!isAgentEffectAuthoringKind(request.kind))
        return {
          ok: true as const,
          data: buildAgentAuthoringGuide(request.kind),
        };
      const visual = resolveVisualSlide(
        projection.deck,
        projection.slide,
        projection.templates ?? {},
      ).slide;
      const element = request.elementId
        ? findElement(visual, request.elementId)
        : undefined;
      if (request.elementId && !element)
        return agentFailure(
          "UNKNOWN_ELEMENT",
          "Inspect the slide and use an existing element ID.",
        );
      let definition;
      if (request.effectInstanceId) {
        const instance = element?.effects?.find(
          ({ id }) => id === request.effectInstanceId,
        );
        definition =
          instance && visual.effectResources?.[instance.resourceId];
        if (!definition)
          return agentFailure(
            "UNKNOWN_EFFECT",
            "Inspect the element and use an existing Effect instance ID.",
          );
        const actual = effectAuthoringKind(definition);
        if (actual !== request.kind)
          return agentFailure(
            "EFFECT_KIND_MISMATCH",
            `The Effect is ${actual}; request that authoring context before editing it.`,
          );
      }
      return {
        ok: true as const,
        data: buildAgentAuthoringGuide(request.kind, {
          ...(definition ? { definition } : {}),
          ...(element?.name ? { previewElementName: element.name } : {}),
          ...(request.elementId ? { elementId: request.elementId } : {}),
          ...(request.effectInstanceId
            ? { effectInstanceId: request.effectInstanceId }
            : {}),
        }),
      };
    } catch {
      return agentFailure(
        "DOCUMENT_UNAVAILABLE",
        "The document is unavailable. Read context again.",
      );
    }
  }
}
