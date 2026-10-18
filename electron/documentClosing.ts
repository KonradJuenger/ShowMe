import type { AgentEditingService } from "./agentEditing";

/** One host close decision at a time; no storage work precedes the authority barrier. */
export class DocumentClosing {
  private pending = new Map<string, Promise<boolean>>();
  constructor(
    private readonly editing: Pick<
      AgentEditingService,
      "beginClose" | "cancelClose" | "forget"
    >,
  ) {}

  run(
    documentId: string,
    decideAndClose: () => Promise<boolean>,
  ): Promise<boolean> {
    const prior = this.pending.get(documentId);
    if (prior) return prior;
    const task = (async () => {
      try {
        await this.editing.beginClose(documentId);
        const closed = await decideAndClose();
        if (closed) this.editing.forget(documentId);
        else this.editing.cancelClose(documentId);
        return closed;
      } catch (error) {
        this.editing.cancelClose(documentId);
        throw error;
      } finally {
        this.pending.delete(documentId);
      }
    })();
    this.pending.set(documentId, task);
    return task;
  }
}
