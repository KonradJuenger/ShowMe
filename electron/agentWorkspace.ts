import {
  agentWorkspaceRequestSchema,
  type AgentWorkspaceRequest,
} from "../src/core/agentWorkspace";
import { agentFailure } from "../src/core/agentRead";
import { AgentMutationError } from "../src/core/agentMutation";
import type { DocumentRuntime } from "../src/core/documentRuntime";
interface Dependencies {
  access(): number | null;
  activeDocumentId(): string | null;
  runtime(id: string): DocumentRuntime;
  eligibility(id: string): string | null;
  perform(request: AgentWorkspaceRequest, admit: () => void): Promise<unknown>;
}
/** Native lifecycle/library operations; no editor drafts or parallel document storage. */
export class AgentWorkspaceService {
  private busy = false;
  constructor(private readonly dependencies: Dependencies) {}
  async run(input: unknown, signal?: AbortSignal) {
    const parsed = agentWorkspaceRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use create/open/close/import-assets with current document identity and expectedRevision.",
      );
    if (this.busy)
      return agentFailure(
        "WORKSPACE_BUSY",
        "Wait for the current native workspace operation.",
      );
    const request = parsed.data,
      d = this.dependencies,
      access = d.access();
    if (access === null)
      return agentFailure(
        "EDITING_DISABLED",
        "Enable MCP and Allow agent editing.",
      );
    let runtime: DocumentRuntime | undefined;
    const admit = () => {
      if (signal?.aborted)
        throw new AgentMutationError(
          "REQUEST_CANCELLED",
          "Workspace operation cancelled before admission.",
        );
      if (d.access() !== access)
        throw new AgentMutationError(
          "MCP_ACCESS_CHANGED",
          "Read context again.",
        );
      if (d.activeDocumentId() !== request.documentId)
        throw new AgentMutationError(
          "DOCUMENT_NOT_ACTIVE",
          "Read context again.",
        );
      const reason = d.eligibility(request.documentId);
      if (reason)
        throw new AgentMutationError(
          reason,
          "Native workspace operations require a locally owned document.",
        );
      const current = d.runtime(request.documentId),
        state = current.metadata(request.documentId);
      if ((runtime && runtime !== current) || state.epoch !== request.epoch)
        throw new AgentMutationError("EPOCH_CONFLICT", "Read context again.");
      runtime = current;
      if (state.revision !== request.expectedRevision)
        throw new AgentMutationError(
          "REVISION_CONFLICT",
          "Inspect accepted state again.",
          undefined,
          state.revision,
        );
      if (
        request.action !== "import-assets" &&
        state.revision !== state.savedRevision
      )
        throw new AgentMutationError(
          "DOCUMENT_DIRTY",
          "Save the current document through showme.deliver before switching or closing.",
        );
    };
    this.busy = true;
    try {
      admit();
      const result = await d.perform(request, admit);
      return {
        ok: true,
        data: { action: request.action, result, refreshContext: true },
      };
    } catch (error) {
      return error instanceof AgentMutationError
        ? agentFailure(
            error.code,
            error.message,
            error.actualRevision,
            error.details,
          )
        : agentFailure(
            "WORKSPACE_FAILED",
            "The native workspace operation failed. Check the selected root, file type and destination; read context again.",
          );
    } finally {
      this.busy = false;
    }
  }
}
