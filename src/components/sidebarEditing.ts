import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { EditorSnapshot } from "../core/editorCommands";
import { locateElement } from "../core/scene";
import type { EditScope } from "../core/documentAuthority";
import {
  setSelectionProperty,
  type ElementPropertyId,
  type PropertyValue,
} from "../core/elementProperties";

export interface SidebarController {
  epochRef: RefObject<string>;
  snapshotRef: RefObject<EditorSnapshot | null>;
  apply(snapshot: EditorSnapshot, commit?: boolean): void;
  flush(): Promise<void>;
  acquireEditScopes(scopes: readonly EditScope[]): Promise<boolean>;
  acquireElementScopes(
    slideId: string,
    elementIds: readonly string[],
    structuralParentIds?: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean>;
  releaseLeases(): Promise<void>;
  beginLeaseHold(): void;
  endLeaseHold(): Promise<void>;
  commitPreview(): void;
  discardPreview(): void;
}
export function useSidebarEditing(
  controller: SidebarController,
  ids: readonly string[],
  onError: (error: unknown) => void,
) {
  const gesture = useRef<{
    abort: AbortController;
    generation: number;
    property: ElementPropertyId;
    ids: string[];
    snapshot: EditorSnapshot;
    ready: Promise<boolean>;
    held: boolean;
    preview: EditorSnapshot | null;
    pending: ((snapshot: EditorSnapshot) => EditorSnapshot) | null;
  } | null>(null);
  const generation = useRef(0);
  const selectionKey = ids.join("|");
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const slideId = controller.snapshotRef.current?.slide.id;
  const { discardPreview, endLeaseHold } = controller;
  const cancel = useCallback(() => {
    generation.current++;
    const active = gesture.current;
    gesture.current = null;
    active?.abort.abort();
    if (active?.held) {
      if (active.preview && controller.snapshotRef.current === active.preview)
        discardPreview();
      void endLeaseHold().catch(onError);
    }
  }, [discardPreview, endLeaseHold, onError, controller.snapshotRef]);
  const epoch = controller.epochRef.current;
  useEffect(() => cancel, [selectionKey, slideId, epoch, cancel]); // Selection changes cancel local drafts.
  function enqueue(change: (snapshot: EditorSnapshot) => EditorSnapshot) {
    const snapshot = controller.snapshotRef.current;
    if (!snapshot) return;
    try {
      const next = change(snapshot);
      if (next !== snapshot) {
        controller.apply(next);
        void controller.flush().catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  }
  function begin(property: ElementPropertyId) {
    cancel();
    const snapshot = controller.snapshotRef.current;
    if (!snapshot || !ids.length) return Promise.resolve(false);
    const token = generation.current;
    const expectedEpoch = controller.epochRef.current;
    const parents = [
      ...new Set(
        ids.flatMap((id) => {
          const location = locateElement(snapshot.slide, id);
          return location ? [location.parentId] : [];
        }),
      ),
    ];
    const active = {
      abort: new AbortController(),
      generation: token,
      property,
      ids: [...ids],
      snapshot,
      held: false,
      preview: null as EditorSnapshot | null,
      pending: null as ((snapshot: EditorSnapshot) => EditorSnapshot) | null,
      ready: Promise.resolve(false),
    };
    gesture.current = active;
    active.ready = controller
      .flush()
      .then(() => {
        if (
          gesture.current !== active ||
          generation.current !== token ||
          currentSelection.current !== active.ids.join("|")
        )
          return false;
        return controller.acquireElementScopes(
          snapshot.slide.id,
          ids,
          parents,
          active.abort.signal,
        );
      })
      .then((granted) => {
        if (!granted) return false;
        if (
          currentSelection.current !== active.ids.join("|") ||
          generation.current !== token ||
          controller.epochRef.current !== expectedEpoch ||
          controller.snapshotRef.current?.slide.id !== snapshot.slide.id
        ) {
          // EditorSession invalidates stale scope requests; do not release another interaction's leases here.
          return false;
        }
        active.snapshot = controller.snapshotRef.current!;
        controller.beginLeaseHold();
        active.held = true;
        return true;
      })
      .catch((error) => {
        onError(error);
        return false;
      });
    return active.ready;
  }
  function preview<K extends ElementPropertyId>(
    property: K,
    value: PropertyValue<K>,
    preserveScaleRatio = false,
  ) {
    const active = gesture.current;
    if (!active || active.property !== property) return;
    active.pending = (snapshot) =>
      setSelectionProperty(
        snapshot,
        active.ids,
        property,
        value,
        preserveScaleRatio,
      );
    const applyPreview = (granted: boolean) => {
      if (
        !granted ||
        gesture.current !== active ||
        currentSelection.current !== active.ids.join("|")
      )
        return;
      if (
        controller.snapshotRef.current !== active.snapshot &&
        controller.snapshotRef.current !== active.preview
      )
        return;
      try {
        controller.apply(
          setSelectionProperty(
            active.snapshot,
            active.ids,
            property,
            value,
            preserveScaleRatio,
          ),
          false,
        );
        active.preview = controller.snapshotRef.current;
      } catch (error) {
        onError(error);
      }
    };
    if (active.held) applyPreview(true);
    else void active.ready.then(applyPreview);
  }
  function commit() {
    const active = gesture.current;
    if (!active) return;
    const finish = (granted: boolean) => {
      if (gesture.current !== active) return;
      gesture.current = null;
      if (granted) {
        controller.commitPreview();
        void controller.endLeaseHold().catch(onError);
      }
    };
    if (active.held) finish(true);
    else {
      generation.current++;
      active.abort.abort();
      gesture.current = null;
      if (active.pending) enqueue(active.pending);
    }
  }
  function set<K extends ElementPropertyId>(
    property: K,
    value: PropertyValue<K>,
    preserveScaleRatio = false,
  ) {
    enqueue((snapshot) =>
      setSelectionProperty(snapshot, ids, property, value, preserveScaleRatio),
    );
  }
  return { enqueue, begin, preview, commit, cancel, set };
}
