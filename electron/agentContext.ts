import {
  agentUiKey,
  editorAgentContextRequestSchema,
  normalizeAgentEditorContext,
  type AgentContext,
  type AgentEditorSnapshot,
  type AgentPresentationContext,
  type EditorAgentContextReply,
} from "../src/core/agentContext";
import type { DocumentProjection } from "../src/core/documentProjection";

interface AgentContextDependencies {
  activeDocumentId(): string | null;
  projection(documentId: string, pageId?: string): Promise<DocumentProjection>;
  presentation(): AgentPresentationContext | null;
  newToken?(): string;
}

/** Ephemeral UI handles only. Document state is always read from the existing owner. */
export class AgentContextService {
  private enabled = false;
  private uiEpoch = 0;
  private generation = 0;
  private view: {
    token: string;
    documentId: string;
    documentEpoch: string;
    sequence: number;
  } | null = null;
  private snapshot: AgentEditorSnapshot | null = null;
  private publishedKey = "null";
  private effectiveKey = "null";
  private availabilityKey = "";
  private presentationKey = "null";

  constructor(private readonly dependencies: AgentContextDependencies) {}

  get isEnabled() {
    return this.enabled;
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate();
    if (!enabled) this.uiEpoch++;
  }

  invalidate() {
    this.generation++;
    if (this.enabled) this.uiEpoch++;
    this.view = null;
    this.snapshot = null;
    this.publishedKey = this.effectiveKey = "null";
    this.availabilityKey = "";
    this.presentationKey = "null";
  }

  update(input: unknown): EditorAgentContextReply {
    const request = editorAgentContextRequestSchema.parse(input);
    const rejected = { accepted: false, token: null };
    if (!this.enabled) return rejected;
    if (request.type === "attach") {
      if (request.documentId !== this.dependencies.activeDocumentId())
        return rejected;
      this.invalidate();
      const token = this.dependencies.newToken?.() ?? crypto.randomUUID();
      this.view = {
        token,
        documentId: request.documentId,
        documentEpoch: request.documentEpoch,
        sequence: -1,
      };
      return { accepted: true, token };
    }
    if (!this.view || request.token !== this.view.token) return rejected;
    if (request.type === "detach") {
      this.invalidate();
      return { accepted: true, token: null };
    }
    const { snapshot, sequence } = request;
    if (
      sequence <= this.view.sequence ||
      snapshot.documentId !== this.dependencies.activeDocumentId() ||
      snapshot.documentId !== this.view.documentId ||
      snapshot.documentEpoch !== this.view.documentEpoch
    )
      return rejected;
    this.view.sequence = sequence;
    this.snapshot = structuredClone({
      ...snapshot,
      selectionIds: [...new Set(snapshot.selectionIds)],
    });
    const key = agentUiKey(this.snapshot);
    if (key !== this.publishedKey) {
      this.uiEpoch++;
      this.effectiveKey = key;
      this.publishedKey = key;
    }
    return { accepted: true, token: this.view.token };
  }

  async read(): Promise<AgentContext> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.enabled) return this.result("disabled", null, null, null);
      const generation = this.generation;
      const snapshot = this.snapshot;
      const sequence = this.view?.sequence;
      const documentId = this.dependencies.activeDocumentId();
      let projection: DocumentProjection | null = null;
      try {
        if (documentId)
          projection = await this.dependencies.projection(
            documentId,
            snapshot?.page.id,
          );
      } catch {
        /* Closed/deleted/unavailable state is not replaced by another page. */
      }
      if (
        generation !== this.generation ||
        documentId !== this.dependencies.activeDocumentId() ||
        sequence !== this.view?.sequence
      )
        continue;
      let editor: AgentEditorSnapshot | null = null;
      try {
        if (projection && snapshot)
          editor = normalizeAgentEditorContext(snapshot, projection);
      } catch {
        /* Incomplete current projection is unavailable, never a local-only fallback. */
      }
      if (
        snapshot &&
        projection &&
        snapshot.documentEpoch !== projection.epoch
      ) {
        this.invalidate();
        return this.result(
          "unavailable",
          projection,
          null,
          this.dependencies.presentation(),
        );
      }
      return this.result(
        !documentId
          ? "unavailable"
          : !snapshot
            ? "loading"
            : editor
              ? "ready"
              : "unavailable",
        projection,
        editor,
        this.dependencies.presentation(),
      );
    }
    return this.result(
      this.enabled ? "unavailable" : "disabled",
      null,
      null,
      null,
    );
  }

  private result(
    availability: AgentContext["availability"],
    projection: DocumentProjection | null,
    editor: AgentEditorSnapshot | null,
    presentation: AgentPresentationContext | null,
  ): AgentContext {
    if (this.enabled) {
      const key = agentUiKey(editor);
      if (key !== this.effectiveKey) {
        this.effectiveKey = key;
        this.uiEpoch++;
      }
      const availableKey = JSON.stringify([
        availability,
        projection?.documentId,
        projection?.epoch,
      ]);
      if (availableKey !== this.availabilityKey) {
        this.availabilityKey = availableKey;
        this.uiEpoch++;
      }
      const presentationKey = presentation
        ? JSON.stringify({
            ...presentation,
            stageTimeMs: presentation.running ? null : presentation.stageTimeMs,
          })
        : "null";
      if (presentationKey !== this.presentationKey) {
        this.presentationKey = presentationKey;
        this.uiEpoch++;
      }
    }
    return structuredClone({
      enabled: this.enabled,
      uiEpoch: this.uiEpoch,
      availability,
      document: projection
        ? {
            id: projection.documentId,
            name: projection.deck.name,
            epoch: projection.epoch,
            revision: projection.revision,
            savedRevision: projection.savedRevision,
            dirty: projection.revision !== projection.savedRevision,
          }
        : null,
      editor,
      presentation,
    });
  }
}
