import { textStyleSchema, resolveTextTypography } from "./textTypography";
import type { TextStyleEdit } from "./textStyles";
import { findElement } from "./scene";
import { uid } from "./ids";
import { appendEditorOperations } from "./editorChange";
import { applyDocumentOperationsToProjection } from "./documentProjection";
import type { DocumentOperation } from "./documentOperations";
import { updateText, type TextElement, type TextMeasure } from "./text";
import type { EditorSnapshot } from "./editorCommands";
export function setTextStyle(
  snapshot: EditorSnapshot,
  edit: TextStyleEdit,
): EditorSnapshot {
  const operation: DocumentOperation = {
    type: "text-style.set",
    expectedValue:
      snapshot.deck.textStyles.find((s) => s.id === edit.styleId) ?? null,
    ...edit,
  };
  const next = applyDocumentOperationsToProjection(snapshot, [operation]);
  if (!next) throw new Error("Style edit removed current page");
  return appendEditorOperations(snapshot, next, [operation]);
}
function selectedText(snapshot: EditorSnapshot, id: string): TextElement {
  const e = findElement(snapshot.slide, id);
  if (e?.content?.type !== "text") throw new Error("Select text");
  return e as TextElement;
}
export function applyTextStyle(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  styleId: string | null,
  measure?: TextMeasure,
) {
  if (styleId && !snapshot.deck.textStyles.some((s) => s.id === styleId))
    throw new Error("Unknown Text Style");
  return ids.reduce((next, id) => {
    const e = selectedText(next, id);
    return updateText(
      next,
      id,
      {
        format: styleId
          ? { kind: "style", styleId, overrides: {} }
          : {
              kind: "local",
              typography: resolveTextTypography(next.deck, e.content),
            },
      },
      styleId ? measure : undefined,
    );
  }, snapshot);
}
export function clearTextStyleOverrides(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  measure?: TextMeasure,
) {
  return ids.reduce((next, id) => {
    const format = selectedText(next, id).content.format;
    return format.kind === "style"
      ? updateText(next, id, { format: { ...format, overrides: {} } }, measure)
      : next;
  }, snapshot);
}
export function createTextStyleFromElement(
  snapshot: EditorSnapshot,
  id: string,
  name: string,
  styleId: string = uid(),
) {
  const e = selectedText(snapshot, id);
  const style = textStyleSchema.parse({
    id: styleId,
    name,
    typography: resolveTextTypography(snapshot.deck, e.content),
  });
  if (snapshot.deck.textStyles.some((s) => s.id === styleId))
    throw new Error("Duplicate Text Style ID");
  return applyTextStyle(
    setTextStyle(snapshot, { styleId, value: style }),
    [id],
    styleId,
  );
}
export function updateTextStyleFromElement(
  snapshot: EditorSnapshot,
  id: string,
) {
  const e = selectedText(snapshot, id);
  const format = e.content.format;
  if (format.kind !== "style") throw new Error("Text has no style");
  const style = snapshot.deck.textStyles.find((s) => s.id === format.styleId)!;
  return clearTextStyleOverrides(
    setTextStyle(snapshot, {
      styleId: style.id,
      value: {
        ...style,
        typography: resolveTextTypography(snapshot.deck, e.content),
      },
    }),
    [id],
  );
}
