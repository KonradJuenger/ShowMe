import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  duplicateElementsWithResult,
  frameElements,
  insertElements,
  removeElements,
  reorderElements,
  setElementContents,
  setElementEffectDefinition,
  unframeElement,
  type EditorSnapshot,
  type ReorderMode,
} from "../../core/editorCommands";
import {
  createBasicShape,
  createEmptyFrame,
  BASIC_SHAPE_SIZE,
  type BasicShape,
} from "../../core/elementFactory";
import { isNeutralFrame } from "../../core/element";
import {
  getChildren,
  isEditableScope,
  resolveEditableScope,
  worldPointToScope,
} from "../../core/scene";
import { uid } from "../../core/ids";
import type { Point } from "../../core/geometry";
import type { EffectDefinition } from "../../core/effects";
import { createTextElement } from "../../core/text";
import type { CanvasSelection } from "../editorCanvasCoordinator";
import {
  captureElementsClipboard,
  hasElementsClipboard,
  pasteElements,
  readElementsClipboard,
  writeElementsClipboard,
} from "../../core/clipboard";

export interface SelectionActionResult {
  snapshot: EditorSnapshot;
  selection: CanvasSelection;
}

interface SelectionActionController {
  snapshotRef: RefObject<EditorSnapshot | null>;
  apply(value: EditorSnapshot, commit?: boolean): void;
  flush(): Promise<void>;
}

interface UseSelectionActionsOptions {
  controller: SelectionActionController;
  selection: CanvasSelection;
  setSelection: Dispatch<SetStateAction<CanvasSelection>>;
  getInsertionWorldPoint(): Point;
  getInsertionScopeId(): string | null;
  run(task: () => Promise<void>): Promise<void>;
  idFactory?: () => string;
}

function unchanged(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): SelectionActionResult {
  return { snapshot, selection };
}

function directEditableSelection(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
) {
  if (!selection.scopeId || !selection.elementIds.length) return null;
  if (!isEditableScope(snapshot.slide, snapshot.deck, selection.scopeId))
    throw new Error("Selected Layer is hidden or locked");

  const children = getChildren(snapshot.slide, selection.scopeId);
  if (!children)
    throw new Error("Selection scope is not an editable container");
  const selectedIds = new Set(selection.elementIds);
  const selected = children.filter((element) => selectedIds.has(element.id));
  if (selected.length !== selectedIds.size)
    throw new Error(
      "Structural selection must be direct siblings in one scope",
    );
  return selected;
}

export function canFrameSelection(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): boolean {
  try {
    return (directEditableSelection(snapshot, selection)?.length ?? 0) >= 2;
  } catch {
    return false;
  }
}

export function canUnframeSelection(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): boolean {
  if (selection.elementIds.length !== 1) return false;
  try {
    const selected = directEditableSelection(snapshot, selection);
    return !!selected?.[0] && isNeutralFrame(selected[0]);
  } catch {
    return false;
  }
}

export function deleteSelectionElements(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): SelectionActionResult {
  if (!selection.elementIds.length) return unchanged(snapshot, selection);
  directEditableSelection(snapshot, selection);
  return {
    snapshot: removeElements(snapshot, selection.elementIds),
    selection: { ...selection, elementIds: [] },
  };
}

export function duplicateSelectionElements(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  newId: () => string,
): SelectionActionResult {
  if (!selection.elementIds.length) return unchanged(snapshot, selection);
  directEditableSelection(snapshot, selection);
  const result = duplicateElementsWithResult(
    snapshot,
    selection.elementIds,
    newId,
  );
  return {
    snapshot: result.snapshot,
    selection: {
      elementIds: result.elementIds,
      scopeId: selection.scopeId,
    },
  };
}

export function reorderSelectionElements(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  mode: ReorderMode,
): SelectionActionResult {
  if (!selection.elementIds.length || !selection.scopeId)
    return unchanged(snapshot, selection);
  directEditableSelection(snapshot, selection);
  return {
    snapshot: reorderElements(
      snapshot,
      selection.scopeId,
      selection.elementIds,
      mode,
    ),
    selection,
  };
}

export function frameSelectionElements(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  frameId: string,
): SelectionActionResult {
  const selected = directEditableSelection(snapshot, selection);
  if (!selected || selected.length < 2) return unchanged(snapshot, selection);
  return {
    snapshot: frameElements(snapshot, selection.elementIds, frameId),
    selection: {
      elementIds: [frameId],
      scopeId: selection.scopeId,
    },
  };
}

export function unframeSelectionElements(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): SelectionActionResult {
  const selected = directEditableSelection(snapshot, selection);
  if (!selected || selected.length !== 1 || !isNeutralFrame(selected[0]))
    return unchanged(snapshot, selection);
  const frame = selected[0];
  const childIds = frame.children.map(({ id }) => id);
  return {
    snapshot: unframeElement(snapshot, frame.id),
    selection: {
      elementIds: childIds,
      scopeId: selection.scopeId,
    },
  };
}

export function insertBasicShape(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  shape: BasicShape,
  id: string,
  worldCenter: Point,
): SelectionActionResult {
  if (
    selection.scopeId &&
    getChildren(snapshot.slide, selection.scopeId) &&
    !isEditableScope(snapshot.slide, snapshot.deck, selection.scopeId)
  )
    throw new Error("Select an unlocked, visible layer to add objects");
  const scopeId = resolveEditableScope(
    snapshot.slide,
    snapshot.deck,
    selection.scopeId,
  );
  const center = worldPointToScope(snapshot.slide, scopeId, worldCenter);
  const element = createBasicShape(id, shape, {
    x: center.x - BASIC_SHAPE_SIZE.width / 2,
    y: center.y - BASIC_SHAPE_SIZE.height / 2,
  });
  return {
    snapshot: insertElements(snapshot, [element], scopeId),
    selection: { elementIds: [element.id], scopeId },
  };
}

export function insertEmptyFrame(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  id: string,
  worldCenter: Point,
): SelectionActionResult {
  const scopeId = resolveEditableScope(
    snapshot.slide,
    snapshot.deck,
    selection.scopeId,
  );
  const center = worldPointToScope(snapshot.slide, scopeId, worldCenter);
  const element = createEmptyFrame(id, {
    x: center.x - BASIC_SHAPE_SIZE.width / 2,
    y: center.y - BASIC_SHAPE_SIZE.height / 2,
  });
  return {
    snapshot: insertElements(snapshot, [element], scopeId),
    selection: { elementIds: [element.id], scopeId },
  };
}

/** One semantic edit: apply to the selection, or insert an already-effected frame. */
export function applySelectionEffect(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  definition: EffectDefinition,
  worldCenter: Point,
  newId: () => string = uid,
  stageIndex = 0,
): SelectionActionResult {
  let result: SelectionActionResult;
  if (selection.elementIds.length) {
    directEditableSelection(snapshot, selection);
    result = { snapshot, selection };
  } else {
    result = insertEmptyFrame(snapshot, selection, newId(), worldCenter);
    if (definition.target === "text") {
      const elementId = result.selection.elementIds[0];
      result.snapshot = setElementContents(result.snapshot, [
        { elementId, value: createTextElement(elementId).content },
      ]);
    }
  }
  for (const elementId of result.selection.elementIds)
    result.snapshot = setElementEffectDefinition(
      result.snapshot,
      elementId,
      structuredClone(definition),
      undefined,
      stageIndex,
    );
  return result;
}

export function selectAllInSelectionScope(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
): CanvasSelection {
  if (
    !selection.scopeId ||
    !isEditableScope(snapshot.slide, snapshot.deck, selection.scopeId)
  )
    return { ...selection, elementIds: [] };
  const children = getChildren(snapshot.slide, selection.scopeId);
  return {
    ...selection,
    elementIds: children ? children.map(({ id }) => id) : [],
  };
}

function sameSelection(left: CanvasSelection, right: CanvasSelection) {
  return (
    left.scopeId === right.scopeId &&
    left.elementIds.length === right.elementIds.length &&
    left.elementIds.every((id, index) => id === right.elementIds[index])
  );
}

export function useSelectionActions({
  controller,
  selection,
  setSelection,
  getInsertionWorldPoint,
  getInsertionScopeId,
  run,
  idFactory = uid,
}: UseSelectionActionsOptions) {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const { snapshotRef, apply, flush } = controller;

  const perform = useCallback(
    async (
      change: (
        snapshot: EditorSnapshot,
        selection: CanvasSelection,
      ) => SelectionActionResult,
      override?: CanvasSelection,
    ) => {
      await run(async () => {
        await flush();
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const current = override ?? selectionRef.current;
        const result = change(snapshot, current);
        if (result.snapshot === snapshot) {
          setSelection(result.selection);
          return;
        }
        apply(result.snapshot);
        setSelection(result.selection);
        await flush();
      });
    },
    [apply, flush, run, setSelection, snapshotRef],
  );

  const deleteSelection = useCallback(
    (override?: CanvasSelection) => perform(deleteSelectionElements, override),
    [perform],
  );

  const duplicateSelection = useCallback(
    (override?: CanvasSelection) =>
      perform(
        (snapshot, current) =>
          duplicateSelectionElements(snapshot, current, idFactory),
        override,
      ),
    [idFactory, perform],
  );

  const reorderSelection = useCallback(
    (mode: ReorderMode, override?: CanvasSelection) =>
      perform(
        (snapshot, current) =>
          reorderSelectionElements(snapshot, current, mode),
        override,
      ),
    [perform],
  );

  const frameSelection = useCallback(
    (override?: CanvasSelection) =>
      perform(
        (snapshot, current) =>
          frameSelectionElements(snapshot, current, idFactory()),
        override,
      ),
    [idFactory, perform],
  );

  const unframeSelection = useCallback(
    (override?: CanvasSelection) => perform(unframeSelectionElements, override),
    [perform],
  );

  const insertElement = useCallback(
    (shape: BasicShape) =>
      perform((snapshot, current) =>
        insertBasicShape(
          snapshot,
          { ...current, scopeId: getInsertionScopeId() },
          shape,
          idFactory(),
          getInsertionWorldPoint(),
        ),
      ),
    [getInsertionScopeId, getInsertionWorldPoint, idFactory, perform],
  );

  const insertFrame = useCallback(
    () =>
      perform((snapshot, current) =>
        insertEmptyFrame(
          snapshot,
          { ...current, scopeId: getInsertionScopeId() },
          idFactory(),
          getInsertionWorldPoint(),
        ),
      ),
    [getInsertionScopeId, getInsertionWorldPoint, idFactory, perform],
  );

  const applyEffect = useCallback(
    (definition: EffectDefinition, stageIndex = 0) =>
      perform((snapshot, current) =>
        applySelectionEffect(
          snapshot,
          current.elementIds.length
            ? current
            : { ...current, scopeId: getInsertionScopeId() },
          definition,
          getInsertionWorldPoint(),
          idFactory,
          stageIndex,
        ),
      ),
    [getInsertionScopeId, getInsertionWorldPoint, idFactory, perform],
  );

  const copySelection = useCallback(
    async (override?: CanvasSelection) => {
      const snapshot = snapshotRef.current;
      if (!snapshot) return false;
      const current = override ?? selectionRef.current;
      const payload = captureElementsClipboard(snapshot, current);
      if (!payload) return false;
      await writeElementsClipboard(payload);
      return true;
    },
    [snapshotRef],
  );

  const cutSelection = useCallback(
    async (override?: CanvasSelection) => {
      await run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const current = override ?? selectionRef.current;
        directEditableSelection(snapshot, current);
        const payload = captureElementsClipboard(snapshot, current);
        if (!payload) return;
        const deckId = snapshot.deck.id;
        const slideId = snapshot.slide.id;
        await writeElementsClipboard(payload);
        const latest = snapshotRef.current;
        if (
          !latest ||
          latest.deck.id !== deckId ||
          latest.slide.id !== slideId ||
          !sameSelection(selectionRef.current, current)
        )
          return;
        directEditableSelection(latest, current);
        apply(removeElements(latest, current.elementIds));
        setSelection({ ...current, elementIds: [] });
        await flush();
      });
    },
    [apply, flush, run, setSelection, snapshotRef],
  );

  const pasteSelection = useCallback(async () => {
    await run(async () => {
      const source = snapshotRef.current;
      if (!source) return;
      const deckId = source.deck.id;
      const slideId = source.slide.id;
      const requestedScopeId = getInsertionScopeId();
      const payload = await readElementsClipboard();
      if (!payload) return;
      const latest = snapshotRef.current;
      if (
        !latest ||
        latest.deck.id !== deckId ||
        latest.slide.id !== slideId ||
        getInsertionScopeId() !== requestedScopeId
      )
        return;
      const result = pasteElements(
        latest,
        requestedScopeId,
        payload,
        idFactory,
      );
      apply(result.snapshot);
      setSelection({
        elementIds: result.elementIds,
        scopeId: result.scopeId,
      });
      await flush();
    });
  }, [
    apply,
    flush,
    getInsertionScopeId,
    idFactory,
    run,
    setSelection,
    snapshotRef,
  ]);

  const selectAll = useCallback(
    (override?: CanvasSelection) => {
      const snapshot = snapshotRef.current;
      const current = override ?? selectionRef.current;
      setSelection(
        snapshot
          ? selectAllInSelectionScope(snapshot, current)
          : { ...current, elementIds: [] },
      );
    },
    [setSelection, snapshotRef],
  );

  const hasClipboard = useCallback(() => hasElementsClipboard(), []);

  const canFrame = useCallback(
    (override?: CanvasSelection) => {
      const snapshot = snapshotRef.current;
      return (
        !!snapshot &&
        canFrameSelection(snapshot, override ?? selectionRef.current)
      );
    },
    [snapshotRef],
  );

  const canUnframe = useCallback(
    (override?: CanvasSelection) => {
      const snapshot = snapshotRef.current;
      return (
        !!snapshot &&
        canUnframeSelection(snapshot, override ?? selectionRef.current)
      );
    },
    [snapshotRef],
  );

  return useMemo(
    () => ({
      deleteSelection,
      duplicateSelection,
      reorderSelection,
      frameSelection,
      unframeSelection,
      insertElement,
      insertFrame,
      applyEffect,
      copySelection,
      cutSelection,
      pasteSelection,
      selectAll,
      hasClipboard,
      canFrame,
      canUnframe,
    }),
    [
      canFrame,
      canUnframe,
      deleteSelection,
      duplicateSelection,
      frameSelection,
      insertElement,
      insertFrame,
      applyEffect,
      copySelection,
      cutSelection,
      pasteSelection,
      selectAll,
      hasClipboard,
      reorderSelection,
      unframeSelection,
    ],
  );
}
