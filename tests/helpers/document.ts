import { afterEach } from "vitest";
import { newPresentationDocument } from "../../src/core/document";
import {
  DocumentRuntime,
  type DocumentRuntimeOptions,
} from "../../src/core/documentRuntime";
import { EditorSession } from "../../src/core/editorSession";
import { createBasicShape } from "../../src/core/elementFactory";
import { insertElements } from "../../src/core/editorCommands";

const sessions: EditorSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

export async function editing(
  durableCommit: DocumentRuntimeOptions["durableCommit"] = async () => {},
) {
  const document = newPresentationDocument("Lifecycle");
  const runtime = new DocumentRuntime(document, {
    actorId: "local",
    durableCommit,
  });
  const session = new EditorSession(document.documentId, runtime);
  sessions.push(session);
  await session.loadProjection();
  return {
    document,
    runtime,
    session,
    slideId: document.deck.slideIds[0],
    layerId: document.deck.layers[0].id,
  };
}

export async function insertShape(session: EditorSession, id = "shape") {
  const shape = createBasicShape(id, "rectangle");
  session.apply(
    insertElements(
      session.snapshot!,
      [shape],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  return shape;
}
