import { expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  readStoredZipFile,
  readArchiveEntry,
} from "../../electron/packageArchive";
import { setSlideNotes } from "../../src/core/editorCommands";
import { storedDocument, storageAt } from "../helpers/storage";

it("saves and reopens current .sme state in a fresh storage host", async () => {
  const { root, storage, session, id, runtime } = await storedDocument();
  const slideId = session.snapshot!.slide.id;
  session.apply(setSlideNotes(session.snapshot!, "Saved notes"));
  await session.flush();
  const file = path.join(root, "Saved.sme");
  await storage.saveDocument(id, file);
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  const reader = await storageAt(root, "reader");
  const reopened = await reader.openDocument(file);
  expect(
    reader.documentRuntime(reopened.id).authority.document.slides[slideId]
      .notes,
  ).toBe("Saved notes");
  expect(runtime.authority.savedRevision).toBe(runtime.authority.revision);
});

it("recovers an accepted unsaved revision after replacing the storage host", async () => {
  const { root, session, id } = await storedDocument();
  const slideId = session.snapshot!.slide.id;
  session.apply(setSlideNotes(session.snapshot!, "Recover me"));
  await session.flush();
  const restarted = await storageAt(root);
  const recovery = path.join(root, "source", "recovery", id + ".recovery.sme");
  expect(
    JSON.parse(await readFile(path.join(recovery, "metadata.json"), "utf8"))
      .version,
  ).toBe(1);
  expect(
    JSON.parse(await readFile(path.join(recovery, "checkpoint.json"), "utf8"))
      .version,
  ).toBe(1);
  const recovered = await restarted.recoverUntitled(id);
  expect(
    restarted.documentRuntime(recovered.id).authority.document.slides[slideId]
      .notes,
  ).toBe("Recover me");
});

it("portable .smp carries accepted dirty state to a separate host", async () => {
  const { root, storage, session, id } = await storedDocument();
  const slideId = session.snapshot!.slide.id;
  session.apply(setSlideNotes(session.snapshot!, "Portable notes"));
  await session.flush();
  const file = path.join(root, "Portable.smp");
  await storage.packageDocument(id, file);
  const archive = await readStoredZipFile(file);
  try {
    const manifest = JSON.parse(
      (
        await readArchiveEntry(archive.entries.get("manifest.json")!)
      ).toString(),
    );
    expect(manifest.packageVersion).toBe(1);
    expect(manifest.documentVersion).toBe(1);
  } finally {
    await archive.dispose();
  }
  const destination = await storageAt(root, "destination");
  const opened = await destination.openPackage(file);
  expect(opened.id).not.toBe(id);
  expect(
    destination.documentRuntime(opened.id).authority.document.slides[slideId]
      .notes,
  ).toBe("Portable notes");
});
