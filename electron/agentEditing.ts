import { createHash } from "node:crypto";
import {
  AgentMutationError,
  agentApplyRequestSchema,
  assembleAgentMutation,
  type AgentApplyRequest,
  type AgentTextMeasure,
  type AgentEffectValidate,
} from "../src/core/agentMutation";
import { agentFailure } from "../src/core/agentRead";
import {
  EditorLeaseDeniedError,
  EditorSession,
  type EditorTransport,
} from "../src/core/editorSession";
import { DocumentRuntime } from "../src/core/documentRuntime";
import type { AcceptedTransaction } from "../src/core/documentTransactions";
import type { Element } from "../src/core/element";
import type { TextContent } from "../src/core/text";

const ACTOR = "mcp-local";
const RESERVATION_BYTES = 32768;
interface Dependencies {
  access(): number | null;
  eligibility(documentId: string): string | null;
  activeDocumentId(): string | null;
  runtime(documentId: string): DocumentRuntime;
  measure(
    documentId: string,
    element: Element & { content: TextContent },
  ): ReturnType<AgentTextMeasure>;
  validateEffect?: (
    documentId: string,
    ...args: Parameters<AgentEffectValidate>
  ) => ReturnType<AgentEffectValidate>;
  changed(): void;
  maxIdentities?: number;
  maxReceiptBytes?: number;
}
interface EpochLedger {
  epoch: string;
  summary: string | null;
  bytes: number;
  entries: Map<string, { fingerprint: string; promise: Promise<any> }>;
  queue: Promise<void>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export class AgentEditingService {
  private ledgers = new Map<string, EpochLedger>();
  private closedRuntimes = new WeakSet<DocumentRuntime>();
  private closing = new Map<string, DocumentRuntime>();
  constructor(private readonly dependencies: Dependencies) {}
  private notify() {
    try {
      this.dependencies.changed();
    } catch {
      /* Notifications cannot reject an accepted edit. */
    }
  }
  /** Starts before the close dialog or any save/discard decision. */
  async beginClose(documentId: string) {
    const runtime = this.dependencies.runtime(documentId);
    this.closing.set(documentId, runtime);
    const authority = runtime.authority.beginClose();
    this.notify();
    await Promise.all([authority, this.ledgers.get(documentId)?.queue]);
  }
  cancelClose(documentId: string) {
    this.closing.get(documentId)?.authority.cancelClose();
    this.closing.delete(documentId);
    this.notify();
  }
  /** Called when the existing host closes a document; does not cancel admitted durability. */
  forget(documentId: string) {
    this.closing.delete(documentId);
    if (
      this.dependencies.eligibility(documentId) !== "GUEST_EDITING_UNSUPPORTED"
    ) {
      try {
        this.closedRuntimes.add(this.dependencies.runtime(documentId));
      } catch {
        /* Already closed. */
      }
    }
    this.ledgers.delete(documentId);
  }
  private requireAccess(documentId: string, access?: number) {
    const d = this.dependencies;
    if (this.closing.has(documentId))
      throw new AgentMutationError(
        "DOCUMENT_CLOSING",
        "The document is closing. Wait for the user to finish or cancel closing.",
      );
    if (d.activeDocumentId() !== documentId)
      throw new AgentMutationError(
        "DOCUMENT_NOT_ACTIVE",
        "Read context for the active document.",
      );
    const reason = d.eligibility(documentId);
    if (reason)
      throw new AgentMutationError(
        reason,
        reason === "GUEST_EDITING_UNSUPPORTED"
          ? "Agent editing currently requires a locally owned document."
          : "Enable MCP and Allow agent editing in Settings.",
      );
    const current = d.access();
    if (current === null)
      throw new AgentMutationError(
        "EDITING_DISABLED",
        "Enable Allow agent editing in Settings.",
      );
    if (access !== undefined && current !== access)
      throw new AgentMutationError(
        "MCP_ACCESS_CHANGED",
        "Editing access changed before commit. Inspect and deliberately retry.",
      );
    return current;
  }
  availability() {
    const id = this.dependencies.activeDocumentId();
    const reason = !id
      ? "DOCUMENT_UNAVAILABLE"
      : this.closing.has(id)
        ? "DOCUMENT_CLOSING"
        : (this.dependencies.eligibility(id) ??
          (this.dependencies.access() === null ? "EDITING_DISABLED" : null));
    const ledger = id ? this.ledgers.get(id) : undefined;
    const full =
      !!ledger &&
      (ledger.entries.size >= (this.dependencies.maxIdentities ?? 1024) ||
        ledger.bytes + RESERVATION_BYTES >
          (this.dependencies.maxReceiptBytes ?? 8 * 1024 * 1024));
    return {
      available: !reason && !full,
      reason: reason ?? (full ? "MUTATION_CAPACITY_REACHED" : null),
    };
  }
  async apply(input: unknown, signal?: AbortSignal): Promise<any> {
    const parsed = agentApplyRequestSchema.safeParse(input);
    if (!parsed.success)
      return agentFailure(
        "INVALID_REQUEST",
        "Use explicit document/slide/epoch/revision, a mutation ID and supported bounded semantic operations.",
      );
    const request = parsed.data;
    try {
      const access = this.requireAccess(request.documentId),
        runtime = this.dependencies.runtime(request.documentId);
      if (this.closedRuntimes.has(runtime))
        throw new AgentMutationError(
          "DOCUMENT_CLOSED",
          "The original document is closing. Read context again.",
        );
      if (runtime.metadata(request.documentId).epoch !== request.epoch)
        throw new AgentMutationError(
          "EPOCH_CONFLICT",
          "The document was reopened. Inspect it before creating another intent.",
        );
      let ledger = this.ledgers.get(request.documentId);
      if (!ledger || ledger.epoch !== request.epoch) {
        ledger = {
          epoch: request.epoch,
          summary: null,
          bytes: 0,
          entries: new Map(),
          queue: Promise.resolve(),
        };
        this.ledgers.set(request.documentId, ledger);
      }
      const fingerprint = createHash("sha256")
        .update(canonical(request))
        .digest("hex");
      const prior = ledger.entries.get(request.mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentMutationError(
            "MUTATION_ID_REUSED",
            "Use a mutation ID only for an identical request.",
          );
        const value = await prior.promise;
        this.requireAccess(request.documentId);
        return value.ok ? { ...value, replayed: true } : value;
      }
      if (
        ledger.entries.size >= (this.dependencies.maxIdentities ?? 1024) ||
        ledger.bytes + RESERVATION_BYTES >
          (this.dependencies.maxReceiptBytes ?? 8 * 1024 * 1024)
      )
        throw new AgentMutationError(
          "MUTATION_CAPACITY_REACHED",
          "The live epoch retry registry is full. Save/reopen and inspect before new editing intents.",
        );
      const ownedLedger = ledger;
      ledger.bytes += RESERVATION_BYTES;
      const promise = ledger.queue
        .then(() => this.execute(request, runtime, access, signal))
        .catch((error) => this.failure(error))
        .then((value) => {
          if (value.ok && value.changed) {
            const count = new Set([
              ...value.createdIds,
              ...value.changedIds,
              ...value.removedIds,
            ]).size;
            ownedLedger.summary = value.createdSlideIds.length
              ? "Agent added a slide"
              : count
                ? `Agent changed ${count} ${count === 1 ? "element" : "elements"}`
                : "Agent updated the presentation";
          }
          ownedLedger.bytes +=
            Buffer.byteLength(JSON.stringify(value)) + 64 - RESERVATION_BYTES;
          this.notify();
          return value;
        });
      ledger.entries.set(request.mutationId, { fingerprint, promise });
      ledger.queue = promise.then(() => undefined);
      return await promise;
    } catch (error) {
      return this.failure(error);
    }
  }
  private failure(error: unknown) {
    if (error instanceof AgentMutationError)
      return {
        ...agentFailure(
          error.code,
          error.message,
          error.actualRevision,
          error.details,
        ),
        ...(error.stepIndex === undefined
          ? {}
          : { stepIndex: error.stepIndex }),
      };
    if (error instanceof EditorLeaseDeniedError)
      return agentFailure(
        "LEASE_DENIED",
        "An active editor or collaborator owns this edit scope. Retry after it is released.",
      );
    return agentFailure(
      "COMMIT_FAILED",
      "The edit could not be accepted. Retry this mutation ID to recover its outcome; inspect before a new intent.",
    );
  }
  private async execute(
    request: AgentApplyRequest,
    runtime: DocumentRuntime,
    access: number,
    signal?: AbortSignal,
  ) {
    const check = (
      state: {
        documentId: string;
        epoch: string;
        revision: number;
      } = runtime.metadata(request.documentId),
    ) => {
      this.requireAccess(request.documentId, access);
      if (this.closedRuntimes.has(runtime))
        throw new AgentMutationError(
          "DOCUMENT_CLOSED",
          "The original document closed before admission.",
        );
      if (signal?.aborted)
        throw new AgentMutationError(
          "REQUEST_CANCELLED",
          "The request was cancelled before durable commit.",
        );
      if (
        this.dependencies.runtime(request.documentId) !== runtime ||
        state.epoch !== request.epoch
      )
        throw new AgentMutationError(
          "EPOCH_CONFLICT",
          "The document was replaced. Read context again.",
        );
      if (state.revision !== request.expectedRevision)
        throw new AgentMutationError(
          "REVISION_CONFLICT",
          "Inspect the accepted revision and deliberately retry with a new intent.",
          undefined,
          state.revision,
        );
    };
    check();
    if (
      !runtime
        .presentationDeck(request.documentId)
        .slideIds.includes(request.slideId)
    )
      throw new AgentMutationError(
        "UNKNOWN_SLIDE",
        "Edit an existing presentation slide.",
      );
    const projection = await runtime.projection(
      request.documentId,
      request.slideId,
    );
    check();
    const staged = await assembleAgentMutation(
      projection,
      request,
      async (element) => {
        check();
        const measured = await this.dependencies.measure(
          request.documentId,
          element,
        );
        check();
        return measured;
      },
      undefined,
      this.dependencies.validateEffect
        ? async (definition, sampleText) => {
            check();
            const result = await this.dependencies.validateEffect!(
              request.documentId,
              definition,
              sampleText,
            );
            check();
            return result;
          }
        : undefined,
    );
    check();
    const base = {
      documentId: request.documentId,
      epoch: request.epoch,
      slideId: request.slideId,
      mutationId: request.mutationId,
      previousRevision: request.expectedRevision,
      replayed: false,
      createdIds: staged.createdIds,
      changedIds: staged.changedIds,
      removedIds: staged.removedIds,
      createdSlideIds: staged.createdSlideIds,
      updatedSlideIds: staged.updatedSlideIds,
      createdEffectInstanceIds: staged.createdEffectInstanceIds,
      updatedEffectInstanceIds: staged.updatedEffectInstanceIds,
      deckChanged: projection.deck !== staged.snapshot.deck,
    };
    const changed = staged.changed;
    if (!changed)
      return {
        ok: true,
        ...base,
        changed: false,
        revision: request.expectedRevision,
        transactionId: null,
        changes: [],
        warnings: [],
      };
    let receipt: AcceptedTransaction | null = null;
    const transport: EditorTransport = {
      projection: (id, pageId) => runtime.projection(id, pageId),
      commit: async (id, transaction) => {
        const accepted = await runtime.commitForActor(
          id,
          ACTOR,
          transaction,
          check,
        );
        receipt = accepted;
        return accepted;
      },
      acquire: async (id, scopes) => runtime.acquireForActor(id, ACTOR, scopes),
      renew: async (id, tokens) => runtime.renewForActor(id, ACTOR, tokens),
      release: async (id, tokens) => {
        runtime.releaseForActor(id, ACTOR, tokens);
      },
      undo: (id, tokens) => runtime.undoForActor(id, ACTOR, tokens),
      redo: (id, tokens) => runtime.redoForActor(id, ACTOR, tokens),
      historyState: async (id) => runtime.historyStateForActor(id, ACTOR),
      subscribeAccepted: (id, callback) =>
        runtime.subscribeAccepted(id, callback),
    };
    const session = new EditorSession(request.documentId, transport);
    const warnings: Array<{ code: string; message: string }> = [];
    try {
      await session.refreshProjection(request.slideId, false);
      session.apply(staged.snapshot);
      await session.flush();
    } catch (error) {
      receipt ??= session.lastCommittedTransaction;
      if (!receipt) throw error;
      warnings.push({
        code: "REFRESH_FAILED",
        message: "The edit was accepted; refresh context before further edits.",
      });
    } finally {
      // Actor is serialized by this service; release even a failed session's leases.
      runtime.releaseForActor(request.documentId, ACTOR);
      session.dispose();
    }
    if (!receipt) throw new Error("Missing accepted receipt");
    const accepted = receipt as AcceptedTransaction;
    return {
      ok: true,
      ...base,
      changed: true,
      revision: accepted.revision,
      transactionId: accepted.transactionId,
      changes: [
        ...(staged.createdIds.length
          ? [{ kind: "created", elementIds: staged.createdIds }]
          : []),
        ...(staged.changedIds.length
          ? [{ kind: "changed", elementIds: staged.changedIds }]
          : []),
        ...(staged.removedIds.length
          ? [{ kind: "removed", elementIds: staged.removedIds }]
          : []),
      ],
      warnings,
    };
  }
  history() {
    const id = this.dependencies.activeDocumentId();
    if (id && this.dependencies.eligibility(id) === "GUEST_EDITING_UNSUPPORTED")
      return { documentId: id, canUndo: false, canRedo: false, summary: null };
    try {
      return id
        ? {
            documentId: id,
            ...this.dependencies.runtime(id).historyStateForActor(id, ACTOR),
            summary: this.ledgers.get(id)?.summary ?? null,
          }
        : { documentId: null, canUndo: false, canRedo: false, summary: null };
    } catch {
      return { documentId: id, canUndo: false, canRedo: false, summary: null };
    }
  }
  async undo(input: { documentId: string; redo: boolean }) {
    if (
      this.dependencies.eligibility(input.documentId) ===
        "GUEST_EDITING_UNSUPPORTED" ||
      this.dependencies.activeDocumentId() !== input.documentId
    )
      return agentFailure(
        "DOCUMENT_NOT_ACTIVE",
        "Agent history requires the active locally owned document.",
      );
    const d = this.dependencies,
      runtime = d.runtime(input.documentId),
      epoch = runtime.metadata(input.documentId).epoch;
    const check = () => {
      if (
        d.activeDocumentId() !== input.documentId ||
        this.closedRuntimes.has(runtime) ||
        d.runtime(input.documentId) !== runtime ||
        runtime.metadata(input.documentId).epoch !== epoch
      )
        throw new AgentMutationError(
          "DOCUMENT_NOT_ACTIVE",
          "Return to the original active document before using agent history.",
        );
      if (d.eligibility(input.documentId) === "GUEST_EDITING_UNSUPPORTED")
        throw new AgentMutationError(
          "GUEST_EDITING_UNSUPPORTED",
          "Agent history requires a locally owned document.",
        );
    };
    try {
      check();
      const ledger = this.ledgers.get(input.documentId);
      const run = (ledger?.queue ?? Promise.resolve()).then(async () => {
        check();
        const accepted = await (input.redo
          ? runtime.redoForActor(input.documentId, ACTOR, [], check)
          : runtime.undoForActor(input.documentId, ACTOR, [], check));
        if (ledger)
          ledger.summary = input.redo
            ? "Agent edit restored"
            : "Agent edit undone";
        this.notify();
        return { ok: true, revision: accepted.revision };
      });
      if (ledger)
        ledger.queue = run.then(
          () => undefined,
          () => undefined,
        );
      return await run;
    } catch {
      return agentFailure(
        "HISTORY_CONFLICT",
        "Agent history is unavailable or conflicts with later changes/an active edit. No history change was accepted.",
      );
    }
  }
}
