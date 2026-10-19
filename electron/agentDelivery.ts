import {
  agentDeliveryRequestSchema,
  type AgentDeliveryRequest,
} from "../src/core/agentDelivery";
import { agentFailure } from "../src/core/agentRead";
import { AgentMutationError } from "../src/core/agentMutation";
import type { DocumentRuntime } from "../src/core/documentRuntime";

interface Dependencies {
  access(): number | null;
  activeDocumentId(): string | null;
  eligibility(documentId: string): string | null;
  runtime(documentId: string): DocumentRuntime;
  deliver(
    request: AgentDeliveryRequest,
    beforePersist: () => void,
  ): Promise<{
    destination: string;
    format: "sme" | "smp";
    overwrite: "native-policy";
    overwritten?: boolean;
  } | null>;
}

/** Delivery snapshots accepted state through native services; it never flushes editor drafts. */
export class AgentDeliveryService {
  private busy = false;
  constructor(private readonly dependencies: Dependencies) {}
  async deliver(input: unknown, signal?: AbortSignal) {
    const parsed = agentDeliveryRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use exact document identity, expectedRevision and save/save-as/package. Destinations follow native policy; arbitrary paths are not accepted.",
      );
    if (this.busy)
      return agentFailure(
        "DELIVERY_BUSY",
        "Another delivery is active. Wait for its native dialog or write to finish.",
      );
    const request = parsed.data,
      d = this.dependencies,
      access = d.access();
    if (access === null)
      return agentFailure("MCP_DISABLED", "Enable MCP before delivery.");
    let runtime: DocumentRuntime | undefined;
    let admitted = false;
    const check = () => {
      if (signal?.aborted)
        throw new AgentMutationError(
          "REQUEST_CANCELLED",
          "Delivery was cancelled before persistence admission.",
        );
      if (d.access() !== access)
        throw new AgentMutationError(
          "MCP_ACCESS_CHANGED",
          "MCP access changed. Read context again.",
        );
      if (d.activeDocumentId() !== request.documentId)
        throw new AgentMutationError(
          "DOCUMENT_NOT_ACTIVE",
          "Read context for the active document.",
        );
      const reason = d.eligibility(request.documentId);
      if (reason)
        throw new AgentMutationError(
          reason,
          "Delivery requires a locally owned available document.",
        );
      const current = d.runtime(request.documentId),
        state = current.metadata(request.documentId);
      if ((runtime && runtime !== current) || state.epoch !== request.epoch)
        throw new AgentMutationError(
          "EPOCH_CONFLICT",
          "The document was replaced. Read context again.",
        );
      runtime = current;
      if (state.revision !== request.expectedRevision)
        throw new AgentMutationError(
          "REVISION_CONFLICT",
          "Inspect accepted state before delivery.",
          undefined,
          state.revision,
        );
    };
    this.busy = true;
    try {
      check();
      const result = await d.deliver(request, () => {
        check();
        admitted = true;
      });
      if (!result)
        return {
          ok: true,
          data: {
            documentId: request.documentId,
            epoch: request.epoch,
            cancelled: true,
            written: false,
          },
        };
      if (!admitted)
        throw new Error("Native delivery did not guard its accepted snapshot");
      if (d.access() !== access)
        return agentFailure(
          "MCP_ACCESS_CHANGED",
          "Access changed after delivery admission. The native write may have completed; inspect context before retrying.",
        );
      let currentObservation = null;
      try {
        if (
          d.activeDocumentId() === request.documentId &&
          d.runtime(request.documentId) === runtime
        )
          currentObservation = runtime!.metadata(request.documentId);
      } catch {
        /* The written snapshot remains historical if the active runtime has gone away. */
      }
      return {
        ok: true,
        data: {
          documentId: request.documentId,
          epoch: request.epoch,
          revision: request.expectedRevision,
          ...result,
          cancelled: false,
          written: true,
          preservesAnimation: true,
          draftPolicy: "accepted-only",
          currentObservation,
          refreshContext: !currentObservation,
        },
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
        "DELIVERY_FAILED",
        "Native delivery failed. Check the destination and refresh context; no authoring revision was added.",
      );
    } finally {
      this.busy = false;
    }
  }
}
