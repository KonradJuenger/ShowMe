import { recordAcceptedImpact } from "../documentImpact";
import {
  presentationDocumentSchema,
  type PresentationDocument,
} from "../document";
import { applyValidatedDocumentOperations } from "../documentOperations";
import type { AcceptedTransaction } from "../documentTransactions";

/**
 * Full-document guest replica used only as the collaboration transport cache.
 * The host DocumentAuthority remains the sole accepting authority.
 */
export class ClientReplica {
  private current: PresentationDocument | null = null;
  private currentEpoch = "";
  private sequence = 0;
  private seen = new Map<string, number>();

  get document() {
    return this.current;
  }

  get epoch() {
    return this.currentEpoch;
  }

  get revision() {
    return this.sequence;
  }

  install(document: PresentationDocument, epoch: string, revision: number) {
    if (!epoch) throw new Error("Snapshot epoch is missing");
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error("Invalid snapshot revision");
    this.current = presentationDocumentSchema.parse(document);
    this.currentEpoch = epoch;
    this.sequence = revision;
    this.seen.clear();
  }

  apply(message: AcceptedTransaction) {
    if (!this.current) throw new Error("Client needs a snapshot");
    if (message.documentId !== this.current.documentId)
      throw new Error("Accepted transaction targets another document");
    if (message.epoch !== this.currentEpoch)
      throw new Error("Accepted transaction epoch changed");

    const prior = this.seen.get(message.transactionId);
    if (prior !== undefined) {
      if (prior !== message.revision)
        throw new Error("Transaction ID reused at another revision");
      return this.current;
    }

    if (message.revision <= this.sequence) {
      // A fresh snapshot may already include a replayed transaction. Remember
      // the observed ID so a later reuse at another revision is still rejected.
      this.seen.set(message.transactionId, message.revision);
      return this.current;
    }

    if (message.revision !== this.sequence + 1)
      throw new Error(
        `Collaboration stream gap: expected ${this.sequence + 1}, got ${message.revision}`,
      );

    const before = this.current;
    this.current = applyValidatedDocumentOperations(
      this.current,
      message.operations,
    );
    recordAcceptedImpact(message, before, this.current);
    this.sequence = message.revision;
    this.seen.set(message.transactionId, message.revision);
    while (this.seen.size > 4096)
      this.seen.delete(this.seen.keys().next().value!);
    return this.current;
  }

  applyMany(messages: readonly AcceptedTransaction[]) {
    for (const message of messages) this.apply(message);
    return this.current;
  }
}
