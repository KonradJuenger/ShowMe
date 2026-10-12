import { useCallback, useEffect, type RefObject } from "react";
import type { EditorChange } from "../core/editorChange";
import type { EditorSnapshot } from "../core/editorCommands";
import { platform } from "../platform";
import { formatExportWarnings } from "../export/shared";

interface Options {
  deckId: string;
  snapshotRef: RefObject<EditorSnapshot | EditorChange | null>;
  refreshProjection(slideId?: string): Promise<unknown>;
  onError(error: unknown): void;
  flush(): Promise<void>;
}

/**
 * Persistence coordinates explicit file commands only.
 * Transaction durability remains owned by the document authority.
 */
export function useDocumentPersistence({
  deckId,
  snapshotRef,
  refreshProjection,
  onError,
  flush,
}: Options) {
  const refreshSavedProjection = useCallback(async () => {
    const slideId = snapshotRef.current?.slide.id;
    try {
      await refreshProjection(slideId);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Unknown slide:")
      )
        throw error;
      await refreshProjection();
    }
  }, [refreshProjection, snapshotRef]);

  const save = useCallback(async () => {
    await flush();
    const result = await platform.saveDocument?.(deckId);
    if (result) await refreshSavedProjection();
    return result ?? null;
  }, [deckId, flush, refreshSavedProjection]);

  const saveAs = useCallback(async () => {
    await flush();
    const result = await platform.saveDocumentAs?.(deckId);
    if (result) await refreshSavedProjection();
    return result ?? null;
  }, [deckId, flush, refreshSavedProjection]);
  const moveToPresentationsFolder = useCallback(async () => {
    await flush();
    const result = await platform.moveDocumentToPresentationsFolder?.(deckId);
    if (result) await refreshSavedProjection();
    return result ?? null;
  }, [deckId, flush, refreshSavedProjection]);
  const savePortable = useCallback(async () => {
    await flush();
    const result = await platform.saveDocumentAsPortable?.(deckId);
    if (result) await refreshSavedProjection();
    return result ?? null;
  }, [deckId, flush, refreshSavedProjection]);

  useEffect(() => {
    if (!platform.onFileCommand) return;
    return platform.onFileCommand((command) => {
      const effectSave = document.querySelector<HTMLButtonElement>(
        "[data-effect-editor-save]",
      );
      if (command === "save" && effectSave) {
        effectSave.click();
        return;
      }
      void (async () => {
        if (command === "save") await save();
        else if (command === "save-as") await saveAs();
        else if (command === "prepare-close") {
          await flush();
          await platform.requestClose?.(deckId);
        } else if (command === "package") {
          await flush();
          await platform.packageDocument?.(deckId);
        } else if (command === "export-pdf" || command === "export-pptx") {
          await flush();
          const result = await platform.exportPresentation?.(
            deckId,
            command === "export-pdf" ? "pdf" : "pptx",
          );
          if (result?.warnings.length)
            window.alert(formatExportWarnings(result.warnings));
        }
      })().catch(onError);
    });
  }, [deckId, flush, onError, save, saveAs]);

  return { save, saveAs, moveToPresentationsFolder, savePortable, flush };
}
