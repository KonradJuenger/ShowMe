import type { AcceptedTransaction } from "./documentTransactions";
import type { EditorSnapshot } from "./editorCommands";
import {
  setEditorOperations,
  stripEditorOperations,
  editorOperations,
  type EditorChange,
} from "./editorChange";
import {
  applyDocumentOperationsToProjection,
  type DocumentProjection,
} from "./documentProjection";

export interface EditorReplica {
  documentId: string;
  epoch: string;
  revision: number;
  savedRevision: number;
  accepted: EditorSnapshot;
  draft: EditorSnapshot | EditorChange;
}

export type EditorReplicaTransition =
  | {
      status: "applied" | "already-applied";
      replica: EditorReplica;
    }
  | {
      status: "not-applicable";
      reason: "document" | "epoch";
      replica: EditorReplica;
    }
  | {
      status: "refresh-required";
      reason: "revision-gap" | "accepted-projection" | "draft-rebase";
      replica: EditorReplica;
    };

export function installDocumentProjection(
  projection: DocumentProjection,
): EditorReplica {
  const accepted = stripEditorOperations({
    deck: projection.deck,
    slide: projection.slide,
    templates: projection.templates,
  });
  return {
    documentId: projection.documentId,
    epoch: projection.epoch,
    revision: projection.revision,
    savedRevision: projection.savedRevision,
    accepted,
    draft: accepted,
  };
}

export function setEditorReplicaDraft(
  replica: EditorReplica,
  draft: EditorSnapshot | EditorChange,
): EditorReplica {
  if (draft.deck.id !== replica.documentId)
    throw new Error("Draft targets another document");
  if (draft.slide.id !== replica.accepted.slide.id)
    throw new Error("Draft targets another projected slide");
  return { ...replica, draft };
}

export function applyAcceptedTransactionToReplica(
  replica: EditorReplica,
  accepted: AcceptedTransaction,
): EditorReplicaTransition {
  if (accepted.documentId !== replica.documentId)
    return { status: "not-applicable", reason: "document", replica };
  if (accepted.epoch !== replica.epoch)
    return { status: "not-applicable", reason: "epoch", replica };
  if (accepted.revision <= replica.revision)
    return { status: "already-applied", replica };
  if (accepted.revision !== replica.revision + 1)
    return { status: "refresh-required", reason: "revision-gap", replica };

  let projectedAccepted: EditorSnapshot | null;
  try {
    projectedAccepted = applyDocumentOperationsToProjection(
      stripEditorOperations(replica.accepted),
      accepted.operations,
    );
  } catch {
    projectedAccepted = null;
  }
  if (!projectedAccepted)
    return {
      status: "refresh-required",
      reason: "accepted-projection",
      replica,
    };

  const nextAccepted = stripEditorOperations(projectedAccepted);
  const localOperations = editorOperations(replica.draft);
  let nextDraft: EditorSnapshot | EditorChange = nextAccepted;

  if (localOperations.length) {
    let projectedDraft: EditorSnapshot | null;
    try {
      projectedDraft = applyDocumentOperationsToProjection(
        stripEditorOperations(replica.draft),
        accepted.operations,
      );
    } catch {
      projectedDraft = null;
    }
    if (!projectedDraft)
      return {
        status: "refresh-required",
        reason: "draft-rebase",
        replica,
      };
    nextDraft = setEditorOperations(projectedDraft, localOperations);
  }

  return {
    status: "applied",
    replica: {
      ...replica,
      revision: accepted.revision,
      accepted: nextAccepted,
      draft: nextDraft,
    },
  };
}
