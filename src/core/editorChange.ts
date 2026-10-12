import type { DocumentOperation } from "./documentOperations";
import type { EditorSnapshot } from "./editorCommands";

export interface EditorChange extends EditorSnapshot {
  operations: DocumentOperation[];
}

export function editorOperations(
  value: EditorSnapshot | EditorChange | null | undefined,
): readonly DocumentOperation[] {
  return value && "operations" in value ? value.operations : [];
}

export function stripEditorOperations(
  value: EditorSnapshot | EditorChange,
): EditorSnapshot {
  return "operations" in value
    ? { deck: value.deck, slide: value.slide, templates: value.templates }
    : value;
}

export function setEditorOperations(
  value: EditorSnapshot,
  operations: readonly DocumentOperation[],
): EditorChange {
  return {
    deck: value.deck,
    slide: value.slide,
    templates: value.templates,
    operations: [...operations],
  };
}

type ElementSetOperation = Extract<
  DocumentOperation,
  {
    type:
      | "elements.frame.set"
      | "elements.appearance.set"
      | "elements.geometry.set"
      | "elements.content.set"
      | "elements.container.set";
  }
>;

function mergeElementChanges(
  previous: ElementSetOperation,
  next: ElementSetOperation,
): DocumentOperation {
  type Change = { elementId: string; value: unknown };
  const before = previous.changes as readonly Change[];
  const after = next.changes as readonly Change[];
  const merged = new Map(before.map((entry) => [entry.elementId, entry.value]));
  for (const entry of after) merged.set(entry.elementId, entry.value);
  return {
    ...next,
    changes: [...merged].map(([elementId, value]) => ({ elementId, value })),
  } as unknown as DocumentOperation;
}

function isElementSetOperation(
  operation: DocumentOperation,
): operation is ElementSetOperation {
  return (
    operation.type === "elements.frame.set" ||
    operation.type === "elements.appearance.set" ||
    operation.type === "elements.geometry.set" ||
    operation.type === "elements.content.set" ||
    operation.type === "elements.container.set"
  );
}

function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameElementChangeSet(
  previous: ElementSetOperation,
  next: ElementSetOperation,
) {
  const previousIds = previous.changes.map(({ elementId }) => elementId);
  const nextIds = new Set(next.changes.map(({ elementId }) => elementId));
  return (
    previousIds.length === nextIds.size &&
    previousIds.every((elementId) => nextIds.has(elementId))
  );
}

function coalesce(
  previous: DocumentOperation,
  next: DocumentOperation,
): DocumentOperation | null {
  if (
    previous.type === "elements.frame.set" &&
    next.type === "elements.frame.set" &&
    previous.slideId === next.slideId &&
    sameElementChangeSet(previous, next)
  )
    return mergeElementChanges(previous, next);

  if (
    isElementSetOperation(previous) &&
    isElementSetOperation(next) &&
    previous.type !== "elements.frame.set" &&
    previous.type === next.type &&
    previous.slideId === next.slideId
  )
    return mergeElementChanges(previous, next);

  if (
    previous.type === "elements.replace" &&
    next.type === "elements.replace" &&
    previous.slideId === next.slideId &&
    sameIds(
      previous.elements.map(({ id }) => id),
      next.elements.map(({ id }) => id),
    )
  )
    return next;

  if (
    previous.type === "slide.background.set" &&
    next.type === "slide.background.set" &&
    previous.slideId === next.slideId
  )
    return next;

  if (
    previous.type === "slide.notes.set" &&
    next.type === "slide.notes.set" &&
    previous.slideId === next.slideId
  )
    return next;

  if (
    previous.type === "slide.meta.set" &&
    next.type === "slide.meta.set" &&
    previous.slideId === next.slideId
  )
    return next;

  if (
    previous.type === "deck.properties.set" &&
    next.type === "deck.properties.set"
  )
    return { ...next, changes: { ...previous.changes, ...next.changes } };

  return null;
}

export function appendEditorOperations(
  source: EditorSnapshot | EditorChange,
  value: EditorSnapshot,
  operations: readonly DocumentOperation[],
): EditorChange {
  const combined = [...editorOperations(source)];
  for (const operation of operations) {
    const previous = combined.at(-1);
    const merged = previous ? coalesce(previous, operation) : null;
    if (merged) combined[combined.length - 1] = merged;
    else combined.push(operation);
  }
  return setEditorOperations(value, combined);
}
