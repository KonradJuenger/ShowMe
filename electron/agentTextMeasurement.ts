import {
  agentMeasureTextRequestSchema,
  type AgentTextMeasureItem,
  type AgentTextFitMeasurement,
} from "../src/core/agentTextMeasure";
import { agentFailure } from "../src/core/agentRead";
import { AgentMutationError } from "../src/core/agentMutation";

interface AgentTextMeasurementDependencies {
  access(): number | null;
  activeDocumentId(): string | null;
  state(documentId: string): Promise<{
    documentId: string;
    epoch: string;
    revision: number;
  }>;
  measure(
    documentId: string,
    items: readonly AgentTextMeasureItem[],
  ): Promise<readonly AgentTextFitMeasurement[] | null>;
}

export class AgentTextMeasurementService {
  constructor(
    private readonly dependencies: AgentTextMeasurementDependencies,
  ) {}

  async measure(input: unknown) {
    const parsed = agentMeasureTextRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use exact document identity/revision and 1-64 valid text measurement items.",
      );
    const request = parsed.data;
    const d = this.dependencies;
    const access = d.access();
    if (access === null)
      return agentFailure("MCP_DISABLED", "Enable MCP in Settings.");
    if (d.activeDocumentId() !== request.documentId)
      return agentFailure(
        "DOCUMENT_NOT_ACTIVE",
        "Read context for the active document.",
      );

    const checkState = async () => {
      const state = await d.state(request.documentId);
      if (
        state.documentId !== request.documentId ||
        state.epoch !== request.epoch
      )
        return agentFailure(
          "EPOCH_CONFLICT",
          "The document was replaced. Read context again.",
        );
      if (state.revision !== request.revision)
        return agentFailure(
          "REVISION_CONFLICT",
          "Inspect the accepted revision before measuring layout.",
          state.revision,
        );
      return null;
    };

    try {
      const stale = await checkState();
      if (stale) return stale;
      const measurements = await d.measure(request.documentId, request.items);
      if (d.access() === null)
        return agentFailure("MCP_DISABLED", "Enable MCP in Settings.");
      if (d.access() !== access)
        return agentFailure(
          "MCP_ACCESS_CHANGED",
          "MCP access changed. Read context again.",
        );
      if (d.activeDocumentId() !== request.documentId)
        return agentFailure(
          "DOCUMENT_NOT_ACTIVE",
          "Read context for the active document.",
        );
      const changed = await checkState();
      if (changed) return changed;
      if (
        !measurements ||
        measurements.length !== request.items.length ||
        measurements.some(
          (value) =>
            !Number.isFinite(value.width) ||
            !Number.isFinite(value.height) ||
            value.width < 0 ||
            value.height < 0,
        )
      )
        return agentFailure(
          "MEASUREMENT_UNAVAILABLE",
          "Production text measurement is unavailable. Retry when the renderer is ready.",
        );
      return {
        ok: true as const,
        documentId: request.documentId,
        epoch: request.epoch,
        revision: request.revision,
        measurements: measurements.map(
          ({ width, height, font, overflow, contentExtent }) => ({
            width,
            height,
            ...(font ? { font } : {}),
            ...(overflow ? { overflow } : {}),
            ...(contentExtent ? { contentExtent } : {}),
          }),
        ),
      };
    } catch (error) {
      if (error instanceof AgentMutationError)
        return agentFailure(
          error.code,
          error.message,
          error.actualRevision,
          error.details,
        );
      return agentFailure(
        "MEASUREMENT_UNAVAILABLE",
        "Production text measurement is unavailable. Retry when the renderer is ready.",
      );
    }
  }
}
