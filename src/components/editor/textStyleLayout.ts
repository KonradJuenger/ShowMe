import { platform } from "../../platform";
import type { DocumentOperation } from "../../core/documentOperations";
import {
  editorOperations,
  appendEditorOperations,
} from "../../core/editorChange";
import { applyDocumentOperationsToProjection } from "../../core/documentProjection";
import { walkElements } from "../../core/element";
import type { EditorSnapshot } from "../../core/editorCommands";
import { editTextStyleDeck, editTextStylePage } from "../../core/textStyles";
import { resolveTextAutoSizeFrame } from "../../core/text";
import { measureText } from "./textLayout";

/** Measure once on the authoring client; accepted/recovered replicas use those exact frames. */
export async function prepareTextStyleLayout(
  snapshot: EditorSnapshot,
  next: EditorSnapshot,
) {
  const operations = structuredClone(editorOperations(next));
  const styleEdits = operations.filter(
    (op): op is Extract<DocumentOperation, { type: "text-style.set" }> =>
      op.type === "text-style.set" &&
      !!op.value &&
      snapshot.deck.textStyles.some((s) => s.id === op.styleId) &&
      JSON.stringify(
        snapshot.deck.textStyles.find((s) => s.id === op.styleId)?.typography,
      ) !== JSON.stringify(op.value.typography),
  );
  if (!styleEdits.length) return operations;
  if (!platform.documentProjection)
    throw new Error("Document projection is unavailable");
  await document.fonts.ready;
  const pageIds = [...snapshot.deck.slideIds, ...snapshot.deck.templateIds];
  // Bound IPC and projection memory to one page at a time.
  for (const edit of styleEdits) edit.layouts = {};
  for (const pageId of pageIds) {
    const projection = await platform.documentProjection(
      snapshot.deck.id,
      pageId,
    );
    if (
      JSON.stringify(projection.deck.textStyles) !==
      JSON.stringify(snapshot.deck.textStyles)
    )
      throw new Error("Text Styles changed while preparing layout. Try again.");
    const page = projection.slide;
    if (
      page.id === snapshot.slide.id &&
      JSON.stringify(page.nodes) !== JSON.stringify(snapshot.slide.nodes)
    )
      throw new Error(
        "Selected text changed while preparing the style edit. Try again.",
      );
    for (const edit of styleEdits) {
      const deck = editTextStyleDeck(snapshot.deck, edit);
      const after = editTextStylePage(page, snapshot.deck, edit);
      const before = new Map(
        walkElements(page.nodes.flatMap((r) => r.children)).map((e) => [
          e.id,
          e,
        ]),
      );
      for (const e of walkElements(after.nodes.flatMap((r) => r.children))) {
        const content = e.content;
        if (
          content?.type !== "text" ||
          content.autoSize === "none" ||
          content.format.kind !== "style" ||
          content.format.styleId !== edit.styleId
        )
          continue;
        const measured = measureText({ ...e, content }, deck);
        if (!measured) throw new Error("Text measurement is unavailable");
        const original = before.get(e.id)!;
        (edit.layouts![page.id] ??= {})[e.id] = {
          expectedContent: original.content!,
          expectedFrame: original.frame,
          frame: resolveTextAutoSizeFrame({ ...e, content }, measured),
        };
      }
    }
  }
  return operations;
}
export function applyPreparedTextStyleLayout(
  snapshot: EditorSnapshot,
  operations: ReturnType<typeof editorOperations>,
) {
  const next = applyDocumentOperationsToProjection(snapshot, operations);
  if (!next) throw new Error("Current page is unavailable");
  return appendEditorOperations(snapshot, next, operations);
}
