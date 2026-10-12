import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditScope } from "../core/documentAuthority";
import type { EditorChange } from "../core/editorChange";
import type { EditorSnapshot } from "../core/editorCommands";
import { EditorSession, type EditorTransport } from "../core/editorSession";

export function useEditorSession(
  documentId: string,
  transport: EditorTransport,
) {
  const session = useMemo(
    () => new EditorSession(documentId, transport),
    [documentId, transport],
  );
  const [, rerender] = useState(0);
  const snapshotRef = useRef<EditorSnapshot | EditorChange | null>(null);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const epochRef = useRef("");

  useEffect(() => {
    const sync = () => rerender((value) => value + 1);
    const unsubscribe = session.subscribe(sync);
    void session.loadProjection().catch(() => sync());
    return () => {
      unsubscribe();
      session.dispose();
    };
  }, [session]);

  snapshotRef.current = session.snapshot;
  revisionRef.current = session.revision;
  savedRevisionRef.current = session.savedRevision;
  epochRef.current = session.epoch;

  const apply = useCallback(
    (value: EditorSnapshot | EditorChange, commit = true) => {
      session.apply(value, commit);
      snapshotRef.current = session.snapshot;
    },
    [session],
  );
  const commitPreview = useCallback(() => {
    session.commitPreview();
    snapshotRef.current = session.snapshot;
  }, [session]);
  const discardPreview = useCallback(() => {
    session.discardPreview();
    snapshotRef.current = session.snapshot;
  }, [session]);
  const flush = useCallback(() => session.flush(), [session]);
  const loadProjection = useCallback(
    (slideId?: string) => session.loadProjection(slideId),
    [session],
  );
  const refreshProjection = useCallback(
    (slideId?: string) => session.refreshProjection(slideId),
    [session],
  );
  const acquireEditScopes = useCallback(
    (scopes: EditScope[]) => session.acquireScopes(scopes),
    [session],
  );
  const acquireElementScopes = useCallback(
    (
      slideId: string,
      elementIds: readonly string[],
      structuralParentIds: readonly string[] = [],
      signal?: AbortSignal,
    ) =>
      session.acquireElementScopes(
        slideId,
        elementIds,
        structuralParentIds,
        signal,
      ),
    [session],
  );
  const releaseLeases = useCallback(() => session.releaseLeases(), [session]);
  const beginHistoryGroup = useCallback(
    (id?: string) => session.beginHistoryGroup(id),
    [session],
  );
  const endHistoryGroup = useCallback(
    () => session.endHistoryGroup(),
    [session],
  );
  const beginLeaseHold = useCallback(() => session.beginLeaseHold(), [session]);
  const endLeaseHold = useCallback(() => session.endLeaseHold(), [session]);
  const undo = useCallback((redo = false) => session.undo(redo), [session]);

  const status = session.lastError
    ? "Error: " +
      (session.lastError instanceof Error
        ? session.lastError.message
        : String(session.lastError))
    : session.draftConflict
      ? "Conflict"
      : !session.replica
        ? "Loading…"
        : session.isDirty
          ? "Unsaved"
          : "Saved";

  return {
    session,
    snapshot: session.snapshot,
    snapshotRef,
    acceptedSnapshot: session.acceptedSnapshot,
    status,
    apply,
    commitPreview,
    discardPreview,
    flush,
    loadProjection,
    refreshProjection,
    acquireEditScopes,
    acquireElementScopes,
    releaseLeases,
    renewLeasesNow: () => session.renewLeasesNow(),
    beginHistoryGroup,
    endHistoryGroup,
    beginLeaseHold,
    endLeaseHold,
    undo,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
    isDirty: () => session.isDirty,
    draftConflict: session.draftConflict,
    lastError: session.lastError,
    revisionRef,
    savedRevisionRef,
    epochRef,
  };
}
