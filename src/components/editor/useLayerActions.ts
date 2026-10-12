import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { EditorSnapshot } from "../../core/editorCommands";
import {
  addLayer as addLayerCommand,
  changeLayer as changeLayerCommand,
  deleteLayer as deleteLayerCommand,
  reparentHierarchy as reparentHierarchyCommand,
  type LayerPatch,
} from "../../core/layerActions";
import {
  getChildren,
  getOwningLayer,
  isEditableScope,
  locateElement,
} from "../../core/scene";
import { uid } from "../../core/ids";
import {
  pruneCanvasSelection,
  type CanvasSelection,
} from "../editorCanvasCoordinator";

interface LayerActionController {
  snapshotRef: RefObject<EditorSnapshot | null>;
  apply(value: EditorSnapshot, commit?: boolean): void;
  flush(): Promise<void>;
}

interface UseLayerActionsOptions {
  controller: LayerActionController;
  selection: CanvasSelection;
  setSelection: Dispatch<SetStateAction<CanvasSelection>>;
  setInsertionScopeId: Dispatch<SetStateAction<string | null>>;
  run(task: () => Promise<void>): Promise<void>;
  idFactory?: () => string;
}

export function useLayerActions({
  controller,
  selection,
  setSelection,
  setInsertionScopeId,
  run,
  idFactory = uid,
}: UseLayerActionsOptions) {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const { snapshotRef, apply, flush } = controller;

  const selectElement = useCallback(
    (parentId: string, id: string, additive = false) => {
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      const location = locateElement(snapshot.slide, id);
      if (
        !location ||
        location.parentId !== parentId ||
        !isEditableScope(snapshot.slide, snapshot.deck, id)
      )
        return;

      const current = selectionRef.current;
      if (current.scopeId !== parentId || !additive) {
        setSelection({ elementIds: [id], scopeId: parentId });
        return;
      }
      setSelection({
        scopeId: parentId,
        elementIds: current.elementIds.includes(id)
          ? current.elementIds.filter((value) => value !== id)
          : [...current.elementIds, id],
      });
    },
    [setSelection, snapshotRef],
  );

  const enterScope = useCallback(
    (scopeId: string) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || !getChildren(snapshot.slide, scopeId)) return;
      if (!isEditableScope(snapshot.slide, snapshot.deck, scopeId)) return;
      setInsertionScopeId(scopeId);
      setSelection({ elementIds: [], scopeId });
    },
    [setInsertionScopeId, setSelection, snapshotRef],
  );

  const reparentHierarchy = useCallback(
    (ids: string[], from: string | null, to: string | null, index: number) =>
      run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const next = reparentHierarchyCommand(snapshot, ids, from, to, index);
        if (next === snapshot) return;
        apply(next);
        setSelection(
          from === null && to === null
            ? { elementIds: [], scopeId: ids[0] ?? null }
            : { elementIds: [...ids], scopeId: to },
        );
        await flush();
      }),
    [apply, flush, run, setSelection, snapshotRef],
  );

  const addLayer = useCallback(
    () =>
      run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const result = addLayerCommand(snapshot, idFactory());
        apply(result.snapshot);
        setInsertionScopeId(result.id);
        setSelection({ elementIds: [], scopeId: result.id });
        await flush();
      }),
    [
      apply,
      flush,
      idFactory,
      run,
      setInsertionScopeId,
      setSelection,
      snapshotRef,
    ],
  );

  const deleteLayer = useCallback(
    async (id: string) => {
      const current = snapshotRef.current;
      const layer = current?.deck.layers.find((entry) => entry.id === id);
      if (!current || !layer || current.deck.layers.length <= 1) return;
      if (
        !window.confirm(
          `Delete ${layer.name} from the entire document?\n\nObjects on this layer will be deleted from every slide. You can undo this deletion.`,
        )
      )
        return;

      await run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const currentScope = selectionRef.current.scopeId;
        const activeLayer = currentScope
          ? getOwningLayer(snapshot.slide, currentScope)?.id
          : null;
        const next = deleteLayerCommand(snapshot, id);
        if (next === snapshot) return;
        apply(next);
        if (activeLayer === id)
          setSelection({
            elementIds: [],
            scopeId: next.deck.layers[0]?.id ?? null,
          });
        await flush();
      });
    },
    [apply, flush, run, setSelection, snapshotRef],
  );

  const changeLayer = useCallback(
    (id: string, patch: LayerPatch) =>
      run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const currentScope = selectionRef.current.scopeId;
        const activeLayer = currentScope
          ? getOwningLayer(snapshot.slide, currentScope)?.id
          : null;
        const next = changeLayerCommand(snapshot, id, patch);
        if (next === snapshot) return;
        apply(next);
        if ((patch.hidden || patch.locked) && activeLayer === id)
          setSelection(
            pruneCanvasSelection(next.slide, next.deck, {
              elementIds: [],
              scopeId: currentScope,
            }),
          );
        await flush();
      }),
    [apply, flush, run, setSelection, snapshotRef],
  );

  return useMemo(
    () => ({
      selectElement,
      enterScope,
      reparentHierarchy,
      addLayer,
      deleteLayer,
      changeLayer,
    }),
    [
      addLayer,
      changeLayer,
      deleteLayer,
      enterScope,
      reparentHierarchy,
      selectElement,
    ],
  );
}
