import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { setSlideNotes } from "../../../src/core/editorCommands";
import { storedDocument, storageAt } from "../../helpers/storage";
import { RecoveryJournal } from "../../../electron/storage/recoveryJournal";

it("untitled and opened decks are clean until an accepted edit and become clean after saving", async () => {
  const { root, storage, session, id } = await storedDocument();
  expect(storage.summary(id)).toMatchObject({ dirty: false, untitled: true });
  session.apply(setSlideNotes(session.snapshot!, "Edited"));
  await session.flush();
  expect(storage.summary(id).dirty).toBe(true);
  const file = path.join(root, "Clean.sme");
  await storage.saveDocument(id, file);
  expect(storage.summary(id)).toMatchObject({ dirty: false, untitled: false });
  const other = await storageAt(root, "other");
  const opened = await other.openDocument(file);
  expect(opened.dirty).toBe(false);
});

it("recovery rejects unsupported checkpoint and metadata versions", async () => {
  const { root, session, id, runtime } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "Accepted v1 journal"));
  await session.flush();
  const recoveryPath = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
  );
  const handle = { recoveryPath, documentId: id, fileRevision: null };
  const journal = new RecoveryJournal();
  expect(
    (await journal.read(handle, runtime.authority.document)).document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("Accepted v1 journal");
  const metadataFile = path.join(recoveryPath, "metadata.json");
  const checkpointFile = path.join(recoveryPath, "checkpoint.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
  expect(metadata.version).toBe(1);
  expect(checkpoint.version).toBe(1);
  await writeFile(metadataFile, JSON.stringify({ ...metadata, version: 2 }));
  await expect(
    journal.read(handle, runtime.authority.document),
  ).rejects.toThrow();
  await writeFile(metadataFile, JSON.stringify(metadata));
  await writeFile(
    checkpointFile,
    JSON.stringify({ ...checkpoint, version: 2 }),
  );
  await expect(
    journal.read(handle, runtime.authority.document),
  ).rejects.toThrow();
});

it("a failed journal sync rolls back the unaccepted record before explicit retry", async () => {
  const { root, session, id } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "First"));
  await session.flush();
  const journal = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
    "transactions.jsonl",
  );
  const originalOpen = fs.open.bind(fs);
  const injected = new Error("Injected sync failure");
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] === journal && args[1] === "r+")
      vi.spyOn(file, "sync").mockRejectedValueOnce(injected);
    return file;
  });
  try {
    session.apply(setSlideNotes(session.snapshot!, "Second"));
    await expect(session.flush()).rejects.toBe(injected);
    expect(session.revision).toBe(1);
  } finally {
    opening.mockRestore();
  }
  expect((await readFile(journal, "utf8")).trim().split("\n")).toHaveLength(1);
  await session.retryFailedIntents();
  const cold = await storageAt(root);
  const recovered = await cold.recoverUntitled(id);
  expect(cold.documentRuntime(recovered.id).authority.revision).toBe(2);
  expect(
    cold.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("Second");
});

it("repairs only an incomplete journal tail before the next accepted append", async () => {
  const { root, session, id } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "First"));
  await session.flush();
  const journal = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
    "transactions.jsonl",
  );
  await appendFile(journal, '{"transactionId":"interrupted');
  const before = await storageAt(root);
  const recoveredBefore = await before.recoverUntitled(id);
  expect(before.documentRuntime(recoveredBefore.id).authority.revision).toBe(1);
  session.apply(setSlideNotes(session.snapshot!, "Second"));
  await session.flush();
  const cold = await storageAt(root);
  const recovered = await cold.recoverUntitled(id);
  expect(cold.documentRuntime(recovered.id).authority.revision).toBe(2);
  expect(
    cold.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("Second");
  expect(
    (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).revision),
  ).toEqual([1, 2]);
});

it("discovers current untitled recovery and rejects incomplete directories", async () => {
  const { root, session, id } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "Unsaved notes"));
  await session.flush();
  const recoveryRoot = path.join(root, "source", "recovery");
  const incomplete = path.join(recoveryRoot, "incomplete.recovery.sme");
  await mkdir(incomplete, { recursive: true });
  await writeFile(path.join(incomplete, "checkpoint.json"), "{}");
  const restarted = await storageAt(root);
  expect(
    (await restarted.listUntitledRecoveries()).map((entry) => entry.documentId),
  ).toEqual([id]);
  const recovered = await restarted.recoverUntitled(id);
  expect(
    restarted.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("Unsaved notes");
});

it("saved open and explicit recovery distinguish saved and newer accepted revisions", async () => {
  const { root, storage, session, id } = await storedDocument();
  const file = path.join(root, "Recovery.sme");
  await storage.saveDocument(id, file);
  session.apply(setSlideNotes(session.snapshot!, "After save"));
  await session.flush();
  expect(
    JSON.parse(await readFile(file, "utf8")).slides[session.snapshot!.slide.id]
      .notes,
  ).toBe("");
  const restarted = await storageAt(root);
  expect(await restarted.recoveryCandidate(file)).not.toBeNull();
  const saved = await restarted.openDocument(file);
  expect(
    restarted.documentRuntime(saved.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("");
  const recovering = await storageAt(root, "recovering");
  const recovered = await recovering.openDocument(file, "recover");
  expect(
    recovering.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("After save");
});

it("warm recovery append never reads or replays previous accepted records", async () => {
  const { session } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "Warm"));
  await session.flush();
  const reads = vi.spyOn(fs, "readFile");
  try {
    for (let index = 0; index < 20; index++) {
      session.apply(setSlideNotes(session.snapshot!, String(index)));
      await session.flush();
    }
    expect(
      reads.mock.calls.filter(([file]) =>
        /transactions.jsonl|checkpoint.json|metadata.json/.test(String(file)),
      ),
    ).toEqual([]);
    expect(session.revision).toBe(21);
  } finally {
    reads.mockRestore();
  }
});

it("a close error after successful sync cannot reject an already durable transaction", async () => {
  const { root, session, id } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "First"));
  await session.flush();
  const journal = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
    "transactions.jsonl",
  );
  const originalOpen = fs.open.bind(fs),
    reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] === journal && args[1] === "r+") {
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        await close();
        throw new Error("Injected close failure");
      });
    }
    return file;
  });
  try {
    session.apply(setSlideNotes(session.snapshot!, "Second"));
    await session.flush();
    expect(session.revision).toBe(2);
    expect(reported).toHaveBeenCalled();
  } finally {
    opening.mockRestore();
    reported.mockRestore();
  }
  const cold = await storageAt(root),
    recovered = await cold.recoverUntitled(id);
  expect(cold.documentRuntime(recovered.id).authority.revision).toBe(2);
});

it("failed optional compaction preserves the durable prefix and the next append recovers writer state", async () => {
  const { root, session, id } = await storedDocument();
  const checkpoint = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
    "checkpoint.json",
  );
  // Establish the initial checkpoint before failing optional maintenance.
  session.apply(setSlideNotes(session.snapshot!, "0"));
  await session.flush();
  const rename = fs.rename.bind(fs),
    reported = vi.spyOn(console, "error").mockImplementation(() => {});
  const renaming = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, destination) => {
      if (destination === checkpoint)
        throw new Error("Injected compaction failure");
      return rename(source, destination);
    });
  try {
    for (let index = 1; index < 256; index++) {
      session.apply(setSlideNotes(session.snapshot!, String(index)));
      await session.flush();
    }
    expect(session.revision).toBe(256);
    await vi.waitFor(() => expect(reported).toHaveBeenCalled());
    expect(reported).toHaveBeenCalled();
  } finally {
    renaming.mockRestore();
    reported.mockRestore();
  }
  session.apply(setSlideNotes(session.snapshot!, "After compaction failure"));
  await session.flush();
  const cold = await storageAt(root),
    recovered = await cold.recoverUntitled(id);
  expect(cold.documentRuntime(recovered.id).authority.revision).toBe(257);
  expect(
    cold.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("After compaction failure");
});

it("acceptance and later appends proceed while checkpoint construction is blocked", async () => {
  const { storage, session, id, root } = await storedDocument();
  const checkpoint = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
    "checkpoint.json",
  );
  session.apply(setSlideNotes(session.snapshot!, "0"));
  await session.flush();
  const originalOpen = fs.open.bind(fs);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    arrived = new Promise<void>((resolve) => (started = resolve));
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).includes(".maintenance.") && args[1] === "wx") {
      started();
      await gate;
    }
    return originalOpen(...args);
  });
  try {
    for (let i = 1; i < 256; i++) {
      session.apply(setSlideNotes(session.snapshot!, String(i)));
      await session.flush();
    }
    expect(session.revision).toBe(256);
    await arrived;
    session.apply(setSlideNotes(session.snapshot!, "During maintenance"));
    await session.flush();
    expect(session.revision).toBe(257);
    expect(JSON.parse(await fs.readFile(checkpoint, "utf8")).revision).toBe(0);
  } finally {
    release();
    opening.mockRestore();
    await storage.dispose();
  }
  const cold = await storageAt(root),
    recovered = await cold.recoverUntitled(id);
  expect(cold.documentRuntime(recovered.id).authority.revision).toBe(257);
  expect(
    cold.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].notes,
  ).toBe("During maintenance");
});
