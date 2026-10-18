import { expect, it, vi } from "vitest";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { storedDocument } from "../../helpers/storage";
import { AgentEditingService } from "../../../electron/agentEditing";
import { DocumentClosing } from "../../../electron/documentClosing";
import { RecoveryJournal } from "../../../electron/storage/recoveryJournal";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const f = await storedDocument();
  const service = new AgentEditingService({
    access: () => 1,
    eligibility: () => null,
    activeDocumentId: () => f.id,
    runtime: () => f.storage.documentRuntime(f.id),
    measure: async () => null,
    changed: () => {},
  });
  const closing = new DocumentClosing(service);
  const input = () => ({
    documentId: f.id,
    epoch: f.runtime.metadata(f.id).epoch,
    expectedRevision: f.runtime.currentRevision(f.id),
    mutationId: crypto.randomUUID(),
    slideId: f.session.snapshot!.slide.id,
    operations: [
      {
        type: "element.insert_shape",
        parentId: f.session.snapshot!.slide.nodes[0].id,
        shape: "rectangle",
        frame: { x: 1, y: 2, width: 30, height: 40 },
      },
    ],
  });
  return { ...f, service, closing, input };
}
async function heldWrite(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred(),
    held = deferred();
  const append = RecoveryJournal.prototype.append;
  const spy = vi
    .spyOn(RecoveryJournal.prototype, "append")
    .mockImplementationOnce(async function (this: RecoveryJournal, ...args) {
      entered.resolve();
      await held.promise;
      return append.apply(this, args);
    });
  const pending = f.service.apply(f.input());
  await entered.promise;
  return { pending, release: held.resolve, restore: () => spy.mockRestore() };
}
async function closeHeldWrite(save: boolean) {
  const f = await fixture(),
    file = path.join(f.root, "Deck.sme");
  await f.storage.saveDocument(f.id, file);
  const write = await heldWrite(f);
  let decided = false;
  try {
    const closed = f.closing.run(f.id, async () => {
      decided = true;
      expect(f.storage.summary(f.id).dirty).toBe(true);
      expect(f.runtime.currentRevision(f.id)).toBe(1);
      if (save) {
        await f.storage.saveDocument(f.id);
        await f.storage.closeDocument(f.id);
      } else await f.storage.discardDocumentChanges(f.id);
      return true;
    });
    expect(decided).toBe(false);
    expect(f.storage.hasDocument(f.id)).toBe(true);
    expect(await f.service.apply(f.input())).toMatchObject({
      error: { code: "DOCUMENT_CLOSING" },
    });
    write.release();
    expect(await write.pending).toMatchObject({ ok: true, revision: 1 });
    expect(await closed).toBe(true);
    expect(f.storage.hasDocument(f.id)).toBe(false);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(
      saved.slides[f.session.snapshot!.slide.id].nodes[0].children,
    ).toHaveLength(save ? 1 : 0);
    await expect(
      access(path.join(f.root, "Deck.recovery.sme")),
    ).rejects.toThrow();
    await expect(f.runtime.undoForActor(f.id, "mcp-local")).rejects.toThrow(
      "Document is closing",
    );
    await expect(
      access(path.join(f.root, "Deck.recovery.sme")),
    ).rejects.toThrow();
  } finally {
    write.release();
    await write.pending;
    write.restore();
  }
}
it("Save waits for an admitted MCP durable write and saves its published revision before closing", async () => {
  await closeHeldWrite(true);
});
it("Don't Save drains admitted MCP durability before discarding recovery and cannot resurrect it", async () => {
  await closeHeldWrite(false);
});
it("direct storage close drains the authority and blocks retained runtime writes", async () => {
  const f = await fixture(),
    write = await heldWrite(f);
  try {
    const closed = f.storage.closeDocument(f.id);
    expect(f.storage.hasDocument(f.id)).toBe(true);
    write.release();
    expect(await write.pending).toMatchObject({ ok: true });
    await closed;
    expect(f.storage.hasDocument(f.id)).toBe(false);
    await expect(f.runtime.undoForActor(f.id, "mcp-local")).rejects.toThrow(
      "Document is closing",
    );
  } finally {
    write.release();
    await write.pending;
    write.restore();
  }
});
it("cancelled close coalesces concurrent decisions and reopens agent and authority admission", async () => {
  const f = await fixture(),
    entered = deferred(),
    choice = deferred();
  const closed = f.closing.run(f.id, async () => {
    entered.resolve();
    await choice.promise;
    return false;
  });
  expect(
    f.closing.run(f.id, async () => {
      throw new Error("Duplicate dialog");
    }),
  ).toBe(closed);
  await entered.promise;
  expect(await f.service.apply(f.input())).toMatchObject({
    error: { code: "DOCUMENT_CLOSING" },
  });
  choice.resolve();
  expect(await closed).toBe(false);
  expect(await f.service.apply(f.input())).toMatchObject({
    ok: true,
    revision: 1,
  });
});
it("failed close reopens admission without discarding accepted recovery", async () => {
  const f = await fixture();
  await expect(
    f.closing.run(f.id, async () => {
      throw new Error("Save failed");
    }),
  ).rejects.toThrow("Save failed");
  expect(await f.service.apply(f.input())).toMatchObject({ ok: true });
  expect(await f.storage.listUntitledRecoveries()).toHaveLength(1);
});
