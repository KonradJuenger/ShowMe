import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { EditorSession } from "../../../src/core/editorSession";
import { setSlideNotes } from "../../../src/core/editorCommands";
import { storedDocument, storageAt } from "../../helpers/storage";

it("failed package replacement leaves the previous file and saved revision intact", async () => {
  const { root, storage, session, id } = await storedDocument();
  const file = path.join(root, "Atomic.smp");
  await storage.savePackageAs(id, file, false);
  const previous = await readFile(file);
  session.apply(setSlideNotes(session.snapshot!, "Dirty"));
  await session.flush();
  const originalRename = fs.rename.bind(fs);
  const rename = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (source, destination) => {
      if (destination === file) throw new Error("Injected replacement failure");
      return originalRename(source, destination);
    });
  try {
    await expect(storage.saveDocument(id)).rejects.toThrow(
      "replacement failure",
    );
  } finally {
    rename.mockRestore();
  }
  expect(await readFile(file)).toEqual(previous);
  expect(storage.documentRuntime(id).authority.savedRevision).toBe(0);
  await storage.saveDocument(id);
  expect(storage.documentRuntime(id).authority.savedRevision).toBe(1);
});

it("normal package Save refuses stale overwrite while explicit Save As succeeds", async () => {
  const { root, storage, session, id } = await storedDocument();
  const file = path.join(root, "Conflict.smp");
  await storage.savePackageAs(id, file, false);
  const other = await storageAt(root, "other");
  const opened = await other.openPackage(file);
  const editor = new EditorSession(opened.id, other.documentRuntime(opened.id));
  try {
    await editor.loadProjection();
    editor.apply(setSlideNotes(editor.snapshot!, "External"));
    await editor.flush();
    await other.saveDocument(opened.id);
    const externalBytes = await readFile(file);
    session.apply(setSlideNotes(session.snapshot!, "Local"));
    await session.flush();
    await expect(storage.saveDocument(id)).rejects.toThrow("changed on disk");
    expect(await readFile(file)).toEqual(externalBytes);
    expect(storage.documentRuntime(id).authority.savedRevision).toBe(0);
    await storage.savePackageAs(id, file, false);
    expect(storage.documentRuntime(id).authority.savedRevision).toBe(1);
    await expect(storage.saveDocument(id)).resolves.toBeDefined();
  } finally {
    editor.dispose();
  }
});
