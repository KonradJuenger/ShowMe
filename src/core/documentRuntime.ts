import { stageDuration } from "./motionModel";
import { editablePage } from "./templates";
import {
  DocumentAuthority,
  type DocumentAuthorityOptions,
  type EditScope,
  type CommitAdmission,
} from "./documentAuthority";
import {
  presentationDocumentSchema,
  PRESENTATION_FILE_VERSION,
  type PresentationDocument,
} from "./document";
import { documentHasSpeakerNotes, type DocumentProjection } from "./documentProjection";
import type {
  DocumentTransaction,
  AcceptedTransaction,
} from "./documentTransactions";
import type { EditorTransport } from "./editorSession";

/** Current-format boundary. Only the current private format is accepted. */
export function parseRuntimeDocument(input: unknown): PresentationDocument {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (typeof value !== "object" || value === null || !("version" in value))
    throw new Error("Invalid ShowMe document envelope");
  if (value.version !== PRESENTATION_FILE_VERSION)
    throw new Error(
      `Unsupported ShowMe document version: ${String(value.version)}.`,
    );
  return presentationDocumentSchema.parse(value);
}

export interface DocumentRuntimeOptions {
  actorId: string;
  durableCommit: NonNullable<DocumentAuthorityOptions["durableCommit"]>;
  epoch?: string;
  revision?: number;
  savedRevision?: number;
}

/**
 * Host-side transport over exactly one document authority. Local editor operations and
 * collaboration actors are alternate callers of the same authority and revision
 * sequence. The host supplies the existing durable writer.
 */
export class DocumentRuntime implements EditorTransport {
  readonly authority: DocumentAuthority;
  private readonly listeners = new Set<
    (accepted: AcceptedTransaction) => void
  >();
  private readonly actorId: string;

  constructor(input: unknown, options: DocumentRuntimeOptions) {
    this.actorId = options.actorId;
    this.authority = new DocumentAuthority(parseRuntimeDocument(input), {
      durableCommit: options.durableCommit,
      epoch: options.epoch,
      revision: options.revision,
      savedRevision: options.savedRevision,
      onAccepted: (accepted) => {
        for (const listener of this.listeners) {
          try {
            listener(accepted);
          } catch (error) {
            console.error("Document notification failed", error);
          }
        }
      },
    });
  }

  private requireDocument(documentId: string) {
    if (documentId !== this.authority.document.documentId)
      throw new Error("Transport targets another document");
  }

  metadata(documentId: string) {
    this.requireDocument(documentId);
    return {
      documentId,
      epoch: this.authority.epoch,
      revision: this.authority.revision,
      savedRevision: this.authority.savedRevision,
    };
  }

  presentationDeck(documentId: string) {
    this.requireDocument(documentId);
    return structuredClone(this.authority.document.deck);
  }

  presentationMetadata(documentId: string) {
    this.requireDocument(documentId);
    const document = this.authority.document;
    return {
      ...this.metadata(documentId),
      deck: structuredClone(document.deck),
      motionSlides: presentationMotionStages(document),
    };
  }

  fullSnapshot(documentId: string) {
    this.requireDocument(documentId);
    const snapshot = this.authority.snapshot();
    return {
      ...snapshot,
      document: structuredClone(snapshot.document),
    };
  }

  async projection(
    documentId: string,
    slideId?: string,
  ): Promise<DocumentProjection> {
    this.requireDocument(documentId);
    const snapshot = this.authority.snapshot();
    const id = slideId ?? snapshot.document.deck.slideIds[0];
    const slide = editablePage(snapshot.document, id);
    if (!slide) throw new Error(`Unknown slide: ${id}`);
    return {
      documentId,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      savedRevision: snapshot.savedRevision,
      hasSpeakerNotes: documentHasSpeakerNotes(snapshot.document),
      deck: structuredClone(snapshot.document.deck),
      slide: structuredClone(slide),
      templates: structuredClone(snapshot.document.templates),
    };
  }

  async renderProjection(
    documentId: string,
    slideId?: string,
  ): Promise<DocumentProjection> {
    this.requireDocument(documentId);
    const snapshot = this.authority.snapshot();
    const id = slideId ?? snapshot.document.deck.slideIds[0];
    const slide = editablePage(snapshot.document, id);
    if (!slide) throw new Error("Unknown slide: " + id);
    const templateId = snapshot.document.deck.slideMeta[id]?.templateId;
    const template = templateId && snapshot.document.templates[templateId];
    return {
      documentId,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      savedRevision: snapshot.savedRevision,
      hasSpeakerNotes: documentHasSpeakerNotes(snapshot.document),
      deck: structuredClone(snapshot.document.deck),
      slide: structuredClone(slide),
      templates: template ? { [templateId]: structuredClone(template) } : {},
    };
  }

  commit(documentId: string, transaction: DocumentTransaction) {
    return this.commitForActor(documentId, this.actorId, transaction);
  }

  commitForActor(
    documentId: string,
    actorId: string,
    transaction: DocumentTransaction,
    admit?: CommitAdmission,
  ) {
    this.requireDocument(documentId);
    if (transaction.documentId !== documentId)
      throw new Error("Document transaction mismatch");
    return this.authority.commit(actorId, transaction, admit);
  }

  async acquire(documentId: string, scopes: EditScope[]) {
    return this.acquireForActor(documentId, this.actorId, scopes);
  }

  acquireForActor(documentId: string, actorId: string, scopes: EditScope[]) {
    this.requireDocument(documentId);
    return this.authority.acquire(actorId, scopes);
  }

  async renew(documentId: string, tokens: string[]) {
    return this.renewForActor(documentId, this.actorId, tokens);
  }

  renewForActor(documentId: string, actorId: string, tokens: string[]) {
    this.requireDocument(documentId);
    return this.authority.renew(actorId, tokens);
  }

  async release(documentId: string, tokens: string[]) {
    this.releaseForActor(documentId, this.actorId, tokens);
  }

  releaseForActor(documentId: string, actorId: string, tokens?: string[]) {
    this.requireDocument(documentId);
    this.authority.release(actorId, tokens);
  }

  leaseState(documentId: string) {
    this.requireDocument(documentId);
    return this.authority.leaseState;
  }

  actorOwns(documentId: string, actorId: string, scopes: EditScope[]) {
    this.requireDocument(documentId);
    return this.authority.owns(actorId, scopes);
  }

  undo(documentId: string, leaseTokens: string[]) {
    return this.undoForActor(documentId, this.actorId, leaseTokens);
  }

  undoForActor(
    documentId: string,
    actorId: string,
    leaseTokens: string[] = [],
    admit?: CommitAdmission,
  ) {
    this.requireDocument(documentId);
    return this.authority.undo(actorId, leaseTokens, admit);
  }

  redo(documentId: string, leaseTokens: string[]) {
    return this.redoForActor(documentId, this.actorId, leaseTokens);
  }

  redoForActor(
    documentId: string,
    actorId: string,
    leaseTokens: string[] = [],
    admit?: CommitAdmission,
  ) {
    this.requireDocument(documentId);
    return this.authority.redo(actorId, leaseTokens, admit);
  }

  async historyState(documentId: string) {
    return this.historyStateForActor(documentId, this.actorId);
  }

  historyStateForActor(documentId: string, actorId: string) {
    this.requireDocument(documentId);
    return {
      canUndo: this.authority.canUndo(actorId),
      canRedo: this.authority.canRedo(actorId),
    };
  }

  acceptedAfter(documentId: string, revision: number) {
    this.requireDocument(documentId);
    return this.authority.acceptedAfter(revision);
  }

  currentRevision(documentId: string) {
    this.requireDocument(documentId);
    return this.authority.revision;
  }

  subscribeAccepted(
    documentId: string,
    callback: (accepted: AcceptedTransaction) => void,
  ) {
    this.requireDocument(documentId);
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

export function presentationMotionStages(
  document: PresentationDocument,
  slideIds = document.deck.slideIds,
) {
  return Object.fromEntries(
    slideIds.map((id) => [
      id,
      document.slides[id].motion?.stages.map((stage) => ({
        id: stage.id,
        duration: stageDuration(stage),
      })) ?? [],
    ]),
  );
}
