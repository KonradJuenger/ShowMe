import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Point } from "../../core/geometry";
import type { EditorChange } from "../../core/editorChange";
import type { EditorSnapshot } from "../../core/editorCommands";
import { uid } from "../../core/ids";
import { isEditableScope } from "../../core/scene";
import {
  insertText as insertTextCommand,
  type TextPatch,
} from "../../core/text";
import type { CanvasSelection } from "../editorCanvasCoordinator";
import { updateTextWithLayout } from "./textLayout";

interface TextActionController {
  snapshotRef: RefObject<EditorSnapshot | EditorChange | null>;
  apply(value: EditorSnapshot | EditorChange, commit?: boolean): void;
  flush(): Promise<void>;
}

export function useTextActions({
  controller,
  setSelection,
  getInsertionWorldPoint,
  getInsertionScopeId,
  run,
  idFactory = uid,
}: {
  controller: TextActionController;
  setSelection: Dispatch<SetStateAction<CanvasSelection>>;
  getInsertionWorldPoint(): Point;
  getInsertionScopeId(): string | null;
  run(task: () => Promise<void>): Promise<void>;
  idFactory?: () => string;
}) {
  const insertText = useCallback(async () => {
    let inserted: string | null = null;
    await run(async () => {
      const snapshot = controller.snapshotRef.current;
      if (!snapshot) return;
      const id = idFactory();
      const result = insertTextCommand(
        snapshot,
        getInsertionScopeId(),
        getInsertionWorldPoint(),
        id,
      );
      controller.apply(
        updateTextWithLayout(result.snapshot, result.elementId, {}),
      );
      setSelection({
        elementIds: [result.elementId],
        scopeId: result.scopeId,
      });
      await controller.flush();
      inserted = result.elementId;
    });
    return inserted;
  }, [
    controller,
    getInsertionScopeId,
    getInsertionWorldPoint,
    idFactory,
    run,
    setSelection,
  ]);

  const patchText = useCallback(
    async (elementId: string, patch: TextPatch) => {
      const snapshot = controller.snapshotRef.current;
      if (!snapshot) return;
      if (!isEditableScope(snapshot.slide, snapshot.deck, elementId))
        throw new Error("Selected Layer is hidden or locked");
      const next = updateTextWithLayout(snapshot, elementId, patch);
      if (next === snapshot) return;
      controller.apply(next);
      await controller.flush();
    },
    [controller],
  );

  return { insertText, patchText };
}
