import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { prepareMediaAsset } from "../../core/media";
import {
  centerMedia,
  convertMediaRule,
  insertMediaAssets,
  isMediaContent,
  replaceMediaAsset,
  resetMedia,
  setMediaContent,
  mediaIntrinsic,
  type MediaIntrinsic,
  type MediaRule,
} from "../../core/media";
import type { MediaContent } from "../../core/element";
import type { EditorSnapshot } from "../../core/editorCommands";
import { findElement, isEditableScope, locateElement } from "../../core/scene";
import { uid } from "../../core/ids";
import { platform } from "../../platform";
import type { CanvasSelection } from "../editorCanvasCoordinator";

export interface FrameEditingState {
  elementId: string;
  intrinsic?: MediaIntrinsic;
}

interface MediaActionController {
  snapshotRef: RefObject<EditorSnapshot | null>;
  apply(value: EditorSnapshot, commit?: boolean): void;
  flush(): Promise<void>;
}

interface UseMediaActionsOptions {
  controller: MediaActionController;
  selection: CanvasSelection;
  setSelection: Dispatch<SetStateAction<CanvasSelection>>;
  getInsertionWorldPoint(): { x: number; y: number };
  getInsertionScopeId(): string | null;
  run(task: () => Promise<void>): Promise<void>;
  setMediaOpen: Dispatch<SetStateAction<boolean>>;
  setMediaRefresh: Dispatch<SetStateAction<number>>;
  frameEditing: FrameEditingState | null;
  setFrameEditing: Dispatch<SetStateAction<FrameEditingState | null>>;
  idFactory?: () => string;
}

function selectedMedia(snapshot: EditorSnapshot, selection: CanvasSelection) {
  if (selection.elementIds.length !== 1) return null;
  const id = selection.elementIds[0];
  const element = findElement(snapshot.slide, id);
  if (!element || !isMediaContent(element.content)) return null;
  return { id, element, location: locateElement(snapshot.slide, id)! };
}

async function loadIntrinsic(content: MediaContent) {
  const stored = mediaIntrinsic(content);
  if (stored) return stored;
  const asset = await prepareMediaAsset(
    await platform.getAsset(content.assetId),
  );
  return asset.width && asset.height
    ? { width: asset.width, height: asset.height }
    : undefined;
}

export function useMediaActions({
  controller,
  selection,
  setSelection,
  getInsertionWorldPoint,
  getInsertionScopeId,
  run,
  setMediaOpen,
  setMediaRefresh,
  frameEditing,
  setFrameEditing,
  idFactory = uid,
}: UseMediaActionsOptions) {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const frameEditingRef = useRef(frameEditing);
  frameEditingRef.current = frameEditing;
  const { snapshotRef, apply, flush } = controller;

  const insertPrepared = useCallback(
    async (assets: Awaited<ReturnType<typeof prepareMediaAsset>>[]) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || !assets.length) return;
      const result = insertMediaAssets(
        snapshot,
        getInsertionScopeId(),
        assets,
        getInsertionWorldPoint(),
        idFactory,
      );
      if (result.snapshot === snapshot) return;
      apply(result.snapshot);
      setSelection({
        elementIds: result.elementIds,
        scopeId: result.scopeId,
      });
      setFrameEditing(null);
      setMediaOpen(false);
      await flush();
    },
    [
      apply,
      flush,
      getInsertionWorldPoint,
      getInsertionScopeId,
      idFactory,
      setFrameEditing,
      setMediaOpen,
      setSelection,
      snapshotRef,
    ],
  );

  const insertAsset = useCallback(
    async (asset: Parameters<typeof prepareMediaAsset>[0]) => {
      await run(async () => {
        const prepared = await prepareMediaAsset(asset);
        await insertPrepared([prepared]);
      });
    },
    [insertPrepared, run],
  );

  const importFiles = useCallback(
    async (files?: File[]) => {
      await run(async () => {
        const assets = files?.length
          ? await platform.importDroppedFiles(files)
          : await platform.importAssets();
        const prepared = await Promise.all(assets.map(prepareMediaAsset));
        await insertPrepared(prepared);
        if (assets.length) setMediaRefresh((value) => value + 1);
      });
    },
    [insertPrepared, run, setMediaRefresh],
  );

  const replaceMedia = useCallback(
    async (files?: File[]) => {
      await run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const target = selectedMedia(snapshot, selectionRef.current);
        if (!target) throw new Error("Select one media Element to replace");
        if (!isEditableScope(snapshot.slide, snapshot.deck, target.id))
          throw new Error("Selected Layer is hidden or locked");
        const assets = files?.length
          ? await platform.importDroppedFiles(files.slice(0, 1))
          : await platform.importAssets();
        if (!assets[0]) return;
        const prepared = await prepareMediaAsset(assets[0]);
        const next = replaceMediaAsset(snapshot, target.id, prepared);
        apply(next);
        if (frameEditingRef.current?.elementId === target.id)
          setFrameEditing({
            elementId: target.id,
            intrinsic: {
              width: prepared.width!,
              height: prepared.height!,
            },
          });
        setMediaRefresh((value) => value + 1);
        await flush();
      });
    },
    [apply, flush, run, setFrameEditing, setMediaRefresh, snapshotRef],
  );

  const changeContent = useCallback(
    async (
      elementId: string,
      build: (
        content: MediaContent,
        intrinsic?: MediaIntrinsic,
      ) => MediaContent | Promise<MediaContent>,
      intrinsic?: MediaIntrinsic,
    ) => {
      await run(async () => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        if (!isEditableScope(snapshot.slide, snapshot.deck, elementId))
          throw new Error("Selected Layer is hidden or locked");
        const element = findElement(snapshot.slide, elementId);
        if (!element || !isMediaContent(element.content))
          throw new Error("Selected Element has no media content");
        const effectiveIntrinsic =
          intrinsic ??
          (frameEditingRef.current?.elementId === elementId
            ? frameEditingRef.current.intrinsic
            : undefined);
        const content = await build(element.content, effectiveIntrinsic);
        apply(setMediaContent(snapshot, elementId, content));
        await flush();
      });
    },
    [apply, flush, run, snapshotRef],
  );

  const setRule = useCallback(
    (elementId: string, rule: MediaRule, intrinsic?: MediaIntrinsic) =>
      changeContent(
        elementId,
        async (_content, effectiveIntrinsic) => {
          const snapshot = snapshotRef.current;
          const element = snapshot
            ? findElement(snapshot.slide, elementId)
            : null;
          if (!element || !isMediaContent(element.content))
            throw new Error("Unknown media Element");
          const requiredIntrinsic =
            effectiveIntrinsic ?? (await loadIntrinsic(element.content));
          return convertMediaRule(element, rule, requiredIntrinsic);
        },
        intrinsic,
      ),
    [changeContent, snapshotRef],
  );

  const center = useCallback(
    (elementId: string, intrinsic?: MediaIntrinsic) =>
      changeContent(
        elementId,
        async (_content, effectiveIntrinsic) => {
          const snapshot = snapshotRef.current;
          const element = snapshot
            ? findElement(snapshot.slide, elementId)
            : null;
          if (!element || !isMediaContent(element.content))
            throw new Error("Unknown media Element");
          const requiredIntrinsic =
            element.content.transform.rule === "free"
              ? (effectiveIntrinsic ?? (await loadIntrinsic(element.content)))
              : effectiveIntrinsic;
          return centerMedia(element, requiredIntrinsic);
        },
        intrinsic,
      ),
    [changeContent, snapshotRef],
  );

  const reset = useCallback(
    (elementId: string, intrinsic?: MediaIntrinsic) =>
      changeContent(
        elementId,
        async (_content, effectiveIntrinsic) => {
          const snapshot = snapshotRef.current;
          const element = snapshot
            ? findElement(snapshot.slide, elementId)
            : null;
          if (!element || !isMediaContent(element.content))
            throw new Error("Unknown media Element");
          const requiredIntrinsic =
            element.content.transform.rule === "free"
              ? (effectiveIntrinsic ?? (await loadIntrinsic(element.content)))
              : effectiveIntrinsic;
          return resetMedia(element, requiredIntrinsic);
        },
        intrinsic,
      ),
    [changeContent, snapshotRef],
  );

  const beginFrameEdit = useCallback(
    (elementId: string) => {
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      if (!isEditableScope(snapshot.slide, snapshot.deck, elementId)) return;
      const location = locateElement(snapshot.slide, elementId);
      if (!location || !isMediaContent(location.element.content)) return;
      const stored = mediaIntrinsic(location.element.content) ?? undefined;
      setSelection({
        elementIds: [elementId],
        scopeId: location.parentId,
      });
      setFrameEditing({ elementId, intrinsic: stored });
      if (!stored)
        void loadIntrinsic(location.element.content)
          .then((intrinsic) => {
            if (!intrinsic) return;
            setFrameEditing((current) =>
              current?.elementId === elementId
                ? { elementId, intrinsic }
                : current,
            );
          })
          .catch(() => undefined);
    },
    [setFrameEditing, setSelection, snapshotRef],
  );

  return {
    insertAsset,
    importFiles,
    replaceMedia,
    changeContent,
    setRule,
    center,
    reset,
    beginFrameEdit,
    exitFrameEdit: () => setFrameEditing(null),
  };
}
