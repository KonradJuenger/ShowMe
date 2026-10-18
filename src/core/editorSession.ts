import { recordPerformance } from "./performance";
import {
  scopesForOperations,
  type EditScope,
  type LeaseDenied,
  type LeaseGrant,
} from "./documentAuthority";
import {
  setEditorOperations,
  stripEditorOperations,
  editorOperations,
  type EditorChange,
} from "./editorChange";
import type { EditorSnapshot } from "./editorCommands";
import {
  applyAcceptedTransactionToReplica,
  installDocumentProjection,
  setEditorReplicaDraft,
  type EditorReplica,
} from "./editorReplica";
import {
  applyDocumentOperationsToProjection,
  type DocumentProjection,
} from "./documentProjection";
import type { DocumentOperation } from "./documentOperations";
import type {
  AcceptedTransaction,
  DocumentTransaction,
} from "./documentTransactions";

export interface EditorHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export type EditorLeaseResult =
  { denied: false; grants: LeaseGrant[] } | LeaseDenied;

export interface EditorTransport {
  projection(documentId: string, slideId?: string): Promise<DocumentProjection>;
  commit(
    documentId: string,
    transaction: DocumentTransaction,
  ): Promise<AcceptedTransaction>;
  acquire(documentId: string, scopes: EditScope[]): Promise<EditorLeaseResult>;
  renew(documentId: string, tokens: string[]): Promise<LeaseGrant[]>;
  release(documentId: string, tokens: string[]): Promise<void>;
  undo(documentId: string, leaseTokens: string[]): Promise<AcceptedTransaction>;
  redo(documentId: string, leaseTokens: string[]): Promise<AcceptedTransaction>;
  historyState(documentId: string): Promise<EditorHistoryState>;
  subscribeAccepted?(
    documentId: string,
    callback: (accepted: AcceptedTransaction) => void,
  ): () => void;
  subscribeInvalidated?(documentId: string, callback: () => void): () => void;
}

export interface DraftConflict {
  reason:
    | "lease-denied"
    | "revision-gap"
    | "accepted-projection"
    | "draft-rebase"
    | "projection-refresh";
  operations: DocumentOperation[];
}

export interface EditorSessionOptions {
  idFactory?: () => string;
  leaseRenewMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

type Listener = () => void;
export class EditorLeaseDeniedError extends Error {
  constructor() {
    super("A collaborator owns this edit scope");
  }
}

export class EditorSession {
  private replicaState: EditorReplica | null = null;
  private historyStateValue: EditorHistoryState = {
    canUndo: false,
    canRedo: false,
  };
  private listeners = new Set<Listener>();
  private pendingTransactionIds = new Set<string>();
  private activeLeaseTokens: string[] = [];
  private leaseRenewTimer: ReturnType<typeof globalThis.setInterval> | null =
    null;
  private commitQueue: Promise<void> = Promise.resolve();
  private queuedOperations: DocumentOperation[][] = [];
  private latestRun: Promise<void> = Promise.resolve();
  private failedIntents: { run: () => Promise<void>; error: unknown }[] = [];
  private historyGroupId: string | undefined;
  private leaseHold = false;
  private leaseHoldGeneration = 0;
  private leaseRequestGeneration = 0;
  private acceptedUnsubscribe: (() => void) | undefined;
  private invalidatedUnsubscribe: (() => void) | undefined;
  private disposed = false;
  private lastErrorValue: unknown = null;
  private committed: AcceptedTransaction | null = null;
  private draftConflictValue: DraftConflict | null = null;
  private readonly idFactory: () => string;
  private readonly leaseRenewMs: number;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  constructor(
    readonly documentId: string,
    readonly transport: EditorTransport,
    options: EditorSessionOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.leaseRenewMs = options.leaseRenewMs ?? 5_000;
    this.setIntervalFn =
      options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn =
      options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    if (transport.subscribeAccepted)
      this.acceptedUnsubscribe = transport.subscribeAccepted(
        documentId,
        (accepted) => {
          void this.receiveAccepted(accepted);
        },
      );
    if (transport.subscribeInvalidated)
      this.invalidatedUnsubscribe = transport.subscribeInvalidated(
        documentId,
        () => {
          void this.receiveInvalidated().catch((error) => {
            this.lastErrorValue = error;
            this.emit();
          });
        },
      );
  }

  get replica() {
    return this.replicaState;
  }

  get snapshot(): EditorSnapshot | EditorChange | null {
    return this.replicaState?.draft ?? null;
  }

  get acceptedSnapshot(): EditorSnapshot | null {
    return this.replicaState?.accepted ?? null;
  }

  get revision() {
    return this.replicaState?.revision ?? 0;
  }

  get savedRevision() {
    return this.replicaState?.savedRevision ?? 0;
  }

  get epoch() {
    return this.replicaState?.epoch ?? "";
  }

  get historyState() {
    return this.historyStateValue;
  }

  get canUndo() {
    return this.historyStateValue.canUndo;
  }

  get canRedo() {
    return this.historyStateValue.canRedo;
  }

  get isDirty() {
    return (
      this.hasFailedIntent ||
      (!!this.replicaState &&
        this.replicaState.revision !== this.replicaState.savedRevision)
    );
  }

  get leaseTokens() {
    return [...this.activeLeaseTokens];
  }

  get lastError() {
    return this.failedIntents[0]?.error ?? this.lastErrorValue;
  }

  /** Receipt remains available even if post-acceptance refresh/notification fails. */
  get lastCommittedTransaction() {
    return this.committed && structuredClone(this.committed);
  }

  get hasFailedIntent() {
    return this.failedIntents.length > 0;
  }

  get draftConflict() {
    return this.draftConflictValue;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private requireReplica() {
    if (!this.replicaState)
      throw new Error("Editor session projection is not loaded");
    return this.replicaState;
  }

  private setReplica(replica: EditorReplica) {
    this.replicaState = replica;
    this.emit();
  }

  private async refreshHistoryState() {
    this.historyStateValue = await this.transport.historyState(this.documentId);
    this.emit();
  }

  private installProjection(
    projection: DocumentProjection,
    preserveDraft: boolean,
    refreshReason: DraftConflict["reason"] = "projection-refresh",
  ) {
    if (projection.documentId !== this.documentId)
      throw new Error("Projection targets another document");

    const previous = this.replicaState;
    const pendingOperations =
      preserveDraft && previous ? [...editorOperations(previous.draft)] : [];
    let replica = installDocumentProjection(projection);
    this.draftConflictValue = null;

    if (
      pendingOperations.length &&
      previous?.draft.slide.id === projection.slide.id
    ) {
      try {
        const rebased = applyDocumentOperationsToProjection(
          replica.accepted,
          pendingOperations,
        );
        if (!rebased) throw new Error("Projected slide was removed");
        replica = setEditorReplicaDraft(
          replica,
          setEditorOperations(rebased, pendingOperations),
        );
      } catch {
        this.draftConflictValue = {
          reason: refreshReason,
          operations: pendingOperations,
        };
      }
    }

    this.setReplica(replica);
  }

  async loadProjection(slideId?: string, preserveDraft = false) {
    try {
      const projection = await this.transport.projection(
        this.documentId,
        slideId,
      );
      if (this.disposed) return projection;
      this.installProjection(projection, preserveDraft);
      await this.refreshHistoryState();
      this.lastErrorValue = null;
      this.emit();
      return projection;
    } catch (error) {
      if (!this.disposed) {
        this.lastErrorValue = error;
        this.emit();
      }
      throw error;
    }
  }

  async refreshProjection(
    slideId?: string,
    preserveDraft = true,
    refreshReason: DraftConflict["reason"] = "projection-refresh",
  ) {
    const projection = await this.transport.projection(
      this.documentId,
      slideId,
    );
    this.installProjection(projection, preserveDraft, refreshReason);
    await this.refreshHistoryState();
    return projection;
  }

  apply(value: EditorSnapshot | EditorChange, commit = true) {
    const replica = this.requireReplica();
    if (value === replica.draft) return;
    recordPerformance("editor.snapshotUpdate", performance.now(), 0);

    if (!commit) {
      this.draftConflictValue = null;
      this.setReplica(setEditorReplicaDraft(replica, value));
      return;
    }

    const operations = [...editorOperations(value)];
    if (!operations.length)
      throw new Error(
        "Persistent editor mutation has no DocumentOperation intent",
      );

    this.draftConflictValue = null;
    this.setReplica(
      setEditorReplicaDraft(replica, stripEditorOperations(value)),
    );
    this.scheduleCommit(operations);
  }

  commitPreview() {
    const replica = this.requireReplica();
    const operations = [...editorOperations(replica.draft)];
    if (!operations.length) return;
    this.setReplica(
      setEditorReplicaDraft(replica, stripEditorOperations(replica.draft)),
    );
    this.scheduleCommit(operations);
  }

  discardPreview() {
    const replica = this.requireReplica();
    this.draftConflictValue = null;
    this.setReplica(setEditorReplicaDraft(replica, replica.accepted));
  }

  private scheduleCommit(operations: DocumentOperation[]) {
    this.queuedOperations.push(operations);
    const result: { accepted?: AcceptedTransaction } = {};
    this.scheduleIntent(async () => {
      try {
        await this.commitOperations(operations, result);
      } finally {
        this.queuedOperations = this.queuedOperations.filter(
          (batch) => batch !== operations,
        );
      }
    });
  }

  private scheduleIntent(intent: () => Promise<void>) {
    const run = this.commitQueue.then(async () => {
      if (this.hasFailedIntent) throw this.failedIntents[0].error;
      await intent();
    });
    this.latestRun = run.catch((error) => {
      this.failedIntents.push({ run: intent, error });
      this.lastErrorValue = error;
      this.emit();
    });
    this.commitQueue = this.latestRun;
  }

  async flush() {
    await this.latestRun;
    if (this.hasFailedIntent) throw this.failedIntents[0].error;
  }

  async retryFailedIntents() {
    await this.commitQueue;
    const intents = this.failedIntents.splice(0);
    for (const intent of intents) this.scheduleIntent(intent.run);
    await this.flush();
  }

  async discardFailedIntents() {
    await this.commitQueue;
    this.failedIntents = [];
    this.queuedOperations = [];
    this.lastErrorValue = null;
    this.discardPreview();
  }

  private async commitOperations(
    operations: DocumentOperation[],
    result: { accepted?: AcceptedTransaction },
  ) {
    if (result.accepted) {
      await this.applyAccepted(result.accepted, false);
      if (!this.historyGroupId && !this.leaseHold) await this.releaseLeases();
      await this.refreshHistoryState();
      return;
    }
    if (!operations.length)
      throw new Error("Cannot commit an empty editor transaction");

    let tokens = this.activeLeaseTokens;
    if (!tokens.length) {
      const scopes = scopesForOperations(
        this.requireReplica().accepted,
        operations,
      );
      const granted = await this.acquireScopes(scopes);
      if (!granted) {
        const replica = this.requireReplica();
        this.draftConflictValue = {
          reason: "lease-denied",
          operations: [...operations],
        };
        this.setReplica(setEditorReplicaDraft(replica, replica.accepted));
        throw new EditorLeaseDeniedError();
      }
      tokens = this.activeLeaseTokens;
    }

    const replica = this.requireReplica();
    const transactionId = this.idFactory();
    const transaction: DocumentTransaction = {
      transactionId,
      documentId: this.documentId,
      epoch: replica.epoch,
      baseRevision: replica.revision,
      leaseTokens: [...tokens],
      operations: [...operations],
      ...(this.historyGroupId ? { historyGroupId: this.historyGroupId } : {}),
    };

    this.pendingTransactionIds.add(transactionId);
    try {
      const accepted = await this.transport.commit(
        this.documentId,
        transaction,
      );
      result.accepted = accepted;
      this.committed = accepted;
      this.queuedOperations = this.queuedOperations.filter(
        (batch) => batch !== operations,
      );
      await this.applyAccepted(accepted, false);
      this.lastErrorValue = null;
    } catch (error) {
      await this.releaseLeases().catch(() => undefined);
      const activeSlideId = this.replicaState?.accepted.slide.id;
      await this.refreshProjection(activeSlideId, true).catch(() => undefined);
      throw error;
    } finally {
      this.pendingTransactionIds.delete(transactionId);
    }

    if (!this.historyGroupId && !this.leaseHold) await this.releaseLeases();
    await this.refreshHistoryState();
  }

  private async applyAccepted(
    accepted: AcceptedTransaction,
    preserveDraftOnRefresh: boolean,
  ) {
    const replica = this.replicaState;
    if (!replica) {
      await this.refreshProjection(undefined, preserveDraftOnRefresh);
      return;
    }

    const transition = applyAcceptedTransactionToReplica(replica, accepted);
    if (
      transition.status === "applied" ||
      transition.status === "already-applied"
    ) {
      let next = transition.replica;
      if (this.queuedOperations.length) {
        const preview = editorOperations(next.draft);
        const draft = applyDocumentOperationsToProjection(next.accepted, [
          ...this.queuedOperations.flat(),
          ...preview,
        ]);
        if (draft)
          next = {
            ...next,
            draft: preview.length
              ? setEditorOperations(draft, preview)
              : stripEditorOperations(draft),
          };
      }
      this.setReplica(next);
      return;
    }
    if (transition.status === "not-applicable") {
      if (
        transition.reason === "epoch" &&
        accepted.documentId === this.documentId
      ) {
        try {
          await this.refreshProjection(
            replica.accepted.slide.id,
            preserveDraftOnRefresh,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("Unknown slide:")
          )
            throw error;
          await this.refreshProjection(undefined, preserveDraftOnRefresh);
        }
      }
      return;
    }

    if (transition.status === "refresh-required") {
      try {
        await this.refreshProjection(
          replica.accepted.slide.id,
          preserveDraftOnRefresh,
          transition.reason,
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Unknown slide:")
        )
          throw error;
        await this.refreshProjection(
          undefined,
          preserveDraftOnRefresh,
          transition.reason,
        );
      }
    }
  }

  private async receiveAccepted(accepted: AcceptedTransaction) {
    if (this.disposed || accepted.documentId !== this.documentId) return;
    if (this.pendingTransactionIds.has(accepted.transactionId)) return;
    await this.applyAccepted(accepted, true);
    await this.refreshHistoryState().catch(() => undefined);
  }

  private async receiveInvalidated() {
    if (this.disposed) return;
    await this.releaseLeases().catch(() => undefined);
    const activeSlideId = this.replicaState?.accepted.slide.id;
    try {
      await this.refreshProjection(activeSlideId, true, "projection-refresh");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Unknown slide:")
      )
        throw error;
      await this.refreshProjection(undefined, true, "projection-refresh");
    }
  }

  private stopLeaseRenewal() {
    if (!this.leaseRenewTimer) return;
    this.clearIntervalFn(this.leaseRenewTimer);
    this.leaseRenewTimer = null;
  }

  private startLeaseRenewal() {
    this.stopLeaseRenewal();
    this.leaseRenewTimer = this.setIntervalFn(() => {
      void this.renewLeasesNow().catch((error) => {
        this.lastErrorValue = error;
        this.emit();
      });
    }, this.leaseRenewMs);
  }

  async renewLeasesNow() {
    const tokens = [...this.activeLeaseTokens];
    if (!tokens.length) return [];
    try {
      const grants = await this.transport.renew(this.documentId, tokens);
      if (
        this.activeLeaseTokens.length === tokens.length &&
        this.activeLeaseTokens.every((token, index) => token === tokens[index])
      )
        this.activeLeaseTokens = grants.map((grant) => grant.token);
      return grants;
    } catch (error) {
      this.activeLeaseTokens = [];
      this.stopLeaseRenewal();
      this.lastErrorValue = error;
      this.emit();
      throw error;
    }
  }

  async releaseLeases() {
    this.leaseRequestGeneration += 1;
    this.stopLeaseRenewal();
    const tokens = this.activeLeaseTokens;
    this.activeLeaseTokens = [];
    if (tokens.length) await this.transport.release(this.documentId, tokens);
    this.emit();
  }

  async acquireScopes(scopes: EditScope[], signal?: AbortSignal) {
    if (signal?.aborted) return false;
    await this.releaseLeases();
    const requestGeneration = ++this.leaseRequestGeneration;
    const requestEpoch = this.replicaState?.epoch ?? "";
    const result = await this.transport.acquire(this.documentId, scopes);
    if (result.denied) return false;

    const tokens = result.grants.map((grant) => grant.token);
    if (
      signal?.aborted ||
      requestGeneration !== this.leaseRequestGeneration ||
      requestEpoch !== (this.replicaState?.epoch ?? "")
    ) {
      if (tokens.length)
        await this.transport
          .release(this.documentId, tokens)
          .catch(() => undefined);
      return false;
    }

    this.activeLeaseTokens = tokens;
    this.startLeaseRenewal();
    this.emit();
    return true;
  }

  async acquireElementScopes(
    slideId: string,
    elementIds: readonly string[],
    structuralParentIds: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    await this.commitQueue;
    const scopes: EditScope[] = [...new Set(elementIds)].map((elementId) => ({
      kind: "element" as const,
      slideId,
      elementId,
    }));
    scopes.push(
      ...[...new Set(structuralParentIds)].map((parentId) => ({
        kind: "structure" as const,
        slideId,
        parentId,
      })),
    );
    return this.acquireScopes(scopes, signal);
  }

  beginHistoryGroup(id = this.idFactory()) {
    this.historyGroupId = id;
    return id;
  }

  async endHistoryGroup() {
    await this.flush();
    this.historyGroupId = undefined;
    if (!this.leaseHold) await this.releaseLeases();
  }

  beginLeaseHold() {
    this.leaseHoldGeneration++;
    this.leaseHold = true;
  }

  async endLeaseHold() {
    const holdGeneration = this.leaseHoldGeneration;
    const requestGeneration = this.leaseRequestGeneration;
    await this.flush();
    if (holdGeneration !== this.leaseHoldGeneration) return;
    this.leaseHold = false;
    if (
      !this.historyGroupId &&
      requestGeneration === this.leaseRequestGeneration
    )
      await this.releaseLeases();
  }

  undo(redo = false) {
    let accepted: AcceptedTransaction | undefined;
    this.scheduleIntent(async () => {
      this.requireReplica();
      const endpoint = redo
        ? this.transport.redo.bind(this.transport)
        : this.transport.undo.bind(this.transport);
      accepted ??= await endpoint(this.documentId, [...this.activeLeaseTokens]);
      await this.applyAccepted(accepted, false);
      const next = this.requireReplica();
      this.setReplica(setEditorReplicaDraft(next, next.accepted));
      await this.releaseLeases();
      await this.refreshHistoryState();
    });
  }

  dispose() {
    this.disposed = true;
    this.acceptedUnsubscribe?.();
    this.acceptedUnsubscribe = undefined;
    this.invalidatedUnsubscribe?.();
    this.invalidatedUnsubscribe = undefined;
    void this.releaseLeases().catch(() => undefined);
    this.listeners.clear();
  }
}
