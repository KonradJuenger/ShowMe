import { useRef, type RefObject } from "react";
import type { EditScope } from "../../core/documentAuthority";
import {
  setDeckGuides,
  type EditorSnapshot,
} from "../../core/editorCommands";
import type { EditorChange } from "../../core/editorChange";
import {
  addManualGuide,
  clearGuides,
  createGuideSet,
  emptyGuideSetDraft,
  moveManualGuide,
  removeManualGuide,
  guideSnapTargets,
  updateGuideSet,
  type GuideAxis,
  type GuideSetDraft,
} from "../../core/guides";
import { snapCoordinate } from "../../core/snapping";

interface GuideController {
  snapshotRef: RefObject<EditorSnapshot | EditorChange | null>;
  apply(
    value: EditorSnapshot | EditorChange,
    commit?: boolean,
  ): void;
  commitPreview(): void;
  discardPreview(): void;
  flush(): Promise<void>;
  acquireEditScopes(scopes: EditScope[]): Promise<boolean>;
  beginLeaseHold(): void;
  endLeaseHold(): Promise<void>;
}

export function useGuideEditing({
  controller,
  onStatus,
  snapping,
  snapToGuides,
  snapToSlide,
  snapToObjects,
  scale,
}: {
  controller: GuideController;
  onStatus(message: string): void;
  snapping: boolean;
  snapToGuides: boolean;
  snapToSlide: boolean;
  snapToObjects: boolean;
  scale: number;
}) {
  const active = useRef(false);

  const applyDeck = (deck: EditorSnapshot["deck"], commit = true) => {
    const snapshot = controller.snapshotRef.current;
    if (!snapshot || deck === snapshot.deck) return;
    controller.apply(
      setDeckGuides(snapshot, deck.guideSets, deck.defaultGuideSetId),
      commit,
    );
  };

  const ensureDefault = () => {
    const snapshot = controller.snapshotRef.current;
    if (!snapshot) return null;
    const id = snapshot.deck.defaultGuideSetId;
    if (id) return { deck: snapshot.deck, id };
    const created = createGuideSet(
      snapshot.deck,
      emptyGuideSetDraft(),
      { makeDefault: true },
    );
    return { deck: created.deck, id: created.guideSet.id };
  };

  async function beginGuideEdit() {
    if (active.current) return true;
    await controller.flush();
    const granted = await controller.acquireEditScopes([{ kind: "guides" }]);
    if (!granted) {
      onStatus("Layout guides are being edited by a collaborator.");
      return false;
    }
    controller.beginLeaseHold();
    active.current = true;
    return true;
  }

  async function finishGuideEdit() {
    if (!active.current) return;
    active.current = false;
    await controller.endLeaseHold();
  }

  async function cancelGuideEdit() {
    if (!active.current) return;
    controller.discardPreview();
    await finishGuideEdit();
  }

  function snapGuidePosition(
    axis: GuideAxis,
    position: number,
    excludeGuideId?: string,
  ) {
    const snapshot = controller.snapshotRef.current;
    if (!snapshot || !snapping) return position;
    return snapCoordinate(
      position,
      guideSnapTargets(snapshot, axis, {
        guides: snapToGuides,
        slide: snapToSlide,
        objects: snapToObjects,
        excludeGuideId,
      }),
      8 / Math.max(scale, 0.01),
    ).value;
  }

  async function createManualGuide(axis: GuideAxis, position: number) {
    if (!active.current && !(await beginGuideEdit())) return;
    const current = ensureDefault();
    if (!current) return void (await cancelGuideEdit());
    applyDeck(
      addManualGuide(current.deck, current.id, axis, position).deck,
    );
    await finishGuideEdit();
  }

  function previewManualGuide(guideId: string, position: number) {
    const snapshot = controller.snapshotRef.current;
    const guideSetId = snapshot?.deck.defaultGuideSetId;
    if (!snapshot || !guideSetId) return;
    applyDeck(
      moveManualGuide(snapshot.deck, guideSetId, guideId, position),
      false,
    );
  }

  async function commitManualGuide(guideId: string, position: number) {
    const snapshot = controller.snapshotRef.current;
    const guideSetId = snapshot?.deck.defaultGuideSetId;
    if (!snapshot || !guideSetId) return void (await cancelGuideEdit());
    applyDeck(
      moveManualGuide(snapshot.deck, guideSetId, guideId, position),
      false,
    );
    controller.commitPreview();
    await finishGuideEdit();
  }

  async function deleteManualGuide(guideId: string) {
    if (!active.current && !(await beginGuideEdit())) return;
    const snapshot = controller.snapshotRef.current;
    const guideSetId = snapshot?.deck.defaultGuideSetId;
    if (!snapshot || !guideSetId) return void (await cancelGuideEdit());
    applyDeck(removeManualGuide(snapshot.deck, guideSetId, guideId));
    await finishGuideEdit();
  }

  async function applyDefaultGuideSet(draft: GuideSetDraft) {
    if (!(await beginGuideEdit())) return false;
    const snapshot = controller.snapshotRef.current;
    if (!snapshot) {
      await cancelGuideEdit();
      return false;
    }
    const id = snapshot.deck.defaultGuideSetId;
    const deck = id
      ? updateGuideSet(snapshot.deck, id, draft)
      : createGuideSet(snapshot.deck, draft, { makeDefault: true }).deck;
    applyDeck(deck);
    await finishGuideEdit();
    return true;
  }

  async function clearAllGuides() {
    if (!(await beginGuideEdit())) return false;
    const snapshot = controller.snapshotRef.current;
    if (!snapshot) {
      await cancelGuideEdit();
      return false;
    }
    applyDeck(clearGuides(snapshot.deck));
    await finishGuideEdit();
    return true;
  }

  return {
    snapGuidePosition,
    beginGuideEdit,
    cancelGuideEdit,
    createManualGuide,
    previewManualGuide,
    commitManualGuide,
    deleteManualGuide,
    applyDefaultGuideSet,
    clearAllGuides,
  };
}
