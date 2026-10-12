import { afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentStorage } from "../../electron/storage";
import { EditorSession } from "../../src/core/editorSession";

const roots: string[] = [];
const sessions: EditorSession[] = [];
const storages: DocumentStorage[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const storage of storages.splice(0)) await storage.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
export async function storageAt(root: string, name = "source") {
  const storage = new DocumentStorage(
    path.join(root, name, "assets"),
    path.join(root, name, "cache"),
  );
  await storage.init();
  storages.push(storage);
  return storage;
}
export async function storedDocument() {
  const root = await mkdtemp(path.join(os.tmpdir(), "showme-lifecycle-"));
  roots.push(root);
  const storage = await storageAt(root);
  const created = await storage.createDocument("Lifecycle");
  const runtime = storage.documentRuntime(created.id);
  const session = new EditorSession(created.id, runtime);
  sessions.push(session);
  await session.loadProjection();
  return { root, storage, session, id: created.id, runtime };
}
