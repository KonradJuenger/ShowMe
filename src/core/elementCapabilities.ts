import type { Element } from "./element";
import type { EditorSnapshot } from "./editorCommands";
import { isEditableScope, locateElement } from "./scene";

export function elementCapabilities(
  elements: readonly Element[],
  snapshot: EditorSnapshot,
) {
  const selected = elements.length > 0;
  const editable =
    selected &&
    elements.every((e) => isEditableScope(snapshot.slide, snapshot.deck, e.id));
  const parent = selected
    ? locateElement(snapshot.slide, elements[0].id)?.parentId
    : null;
  const siblings =
    selected &&
    elements.every(
      (e) => locateElement(snapshot.slide, e.id)?.parentId === parent,
    );
  return {
    editable,
    commonTransform: editable,
    appearance: editable,
    text: selected && elements.every((e) => e.content?.type === "text"),
    media:
      selected &&
      elements.every((e) => !!e.content && e.content.type !== "text"),
    video: selected && elements.every((e) => e.content?.type === "video"),
    frameSelection: editable && siblings,
    reparent: editable && siblings,
    align: editable && siblings,
    distribute: editable && siblings && elements.length >= 3,
  };
}
