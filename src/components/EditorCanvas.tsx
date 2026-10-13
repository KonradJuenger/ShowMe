import { resizeHandleCursor, snapRotation } from "../core/handleGeometry";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { isContextMenuOpen } from "../platform/contextMenu";
import {
  resizeBox,
  resizeTransform,
  type ResizeHandle,
} from "../core/geometry";
import type { SelectionMode } from "../core/editorPreferences";
import {
  setElementContents,
  type EditorSnapshot,
} from "../core/editorCommands";
import type { EditorTransport } from "../core/editorSession";
import {
  createOptimisticLease,
  createMoveGesture,
  previewResize,
  previewRotation,
  type TransformPreview,
  type TransformSnapOptions,
  type TransformSnapshot,
} from "../core/transformInteraction";
import {
  findElement,
  getOwningLayer,
  isEditableScope,
  locateElement,
  resolveEditableScope,
  type ScopeId,
} from "../core/scene";
import {
  inverse,
  localMatrix,
  resolveMediaFrame,
  transformPoint,
  walkElements,
} from "../core/element";
import {
  isMediaContent,
  preserveMediaAfterFrameChange,
  updateMediaFromResolved,
  type MediaIntrinsic,
} from "../core/media";
import { resolveSnapAxis, resolveResizeSnapAxis } from "../core/snapping";
import {
  defaultDragSnapSettings,
  type DragSnapSettings,
} from "../core/dragSnapping";
import {
  selectionCssTransform,
  scopeGuidesToWorld,
  selectionWorldGeometry,
  mediaSnapTargets,
} from "../core/selectionGeometry";
import {
  createTransientTransformPreview,
  type GestureFeedback,
} from "./transientTransformPreview";
import {
  framePointerGesture,
  waitForPointerDragIntent,
} from "./framePointerGesture";
import {
  createCanvasMoveBase,
  createMarqueeBox,
  pruneCanvasSelection,
  resolveCanvasHitTarget,
  resolveCanvasSelection,
  resolveMarqueeSelection,
  type CanvasSelection,
} from "./editorCanvasCoordinator";
import { SlideRenderer } from "./SlideRenderer";
import { installCanvasInteractionDiagnostics } from "./canvasInteractionDiagnostics";
import { FrameEditorOverlay } from "./FrameEditorOverlay";
import { useEditorSession } from "./useEditorSession";
import { InlineTextEditor } from "./editor/InlineTextEditor";
import type { TextEditingController } from "./editor/useTextEditing";
import { isTextElement } from "../core/text";
import type { GuideAxis, ResolvedGuide } from "../core/guides";
import { GuidesOverlay } from "./GuidesOverlay";

export interface EditorCanvasSnapping {
  enabled: boolean;
  toObjects: boolean;
  toGuides: boolean;
  toSlide: boolean;
  drag: DragSnapSettings;
}

export type EditorController = ReturnType<typeof useEditorSession>;

export interface EditorCanvasProps {
  documentId: string;
  transport: EditorTransport;
  scale?: number;
  snapping?: Partial<EditorCanvasSnapping>;
  idFactory?: () => string;
  className?: string;
  style?: CSSProperties;
}

export interface EditorCanvasSurfaceProps {
  controller: EditorController;
  scale?: number;
  snapping?: Partial<EditorCanvasSnapping>;
  idFactory?: () => string;
  className?: string;
  style?: CSSProperties;
  selection?: CanvasSelection;
  onSelectionChange?: (selection: CanvasSelection) => void;
  onScopeEnter?: (scopeId: string) => void;
  keyboardHistory?: boolean;
  selectionMode?: SelectionMode;
  motionSourceSlide?: import("../core/document").Slide;
  motionState?: import("../core/motionPlayback").MotionPreviewState | null;
  previewMedia?: boolean;
  showFrameBorders?: boolean;
  trimMedia?: boolean;
  cropFrameId?: string | null;
  frameEditingId?: string | null;
  frameEditingIntrinsic?: MediaIntrinsic;
  onFrameEditRequest?(elementId: string | null): void;
  textEditing?: TextEditingController;
  remoteSelections?: Array<{
    id: string;
    displayName: string;
    color: string;
    activeSlideId: string | null;
    selectionScopeId: string | null;
    selection: string[];
  }>;
  onTransformPreview?(
    snapshot: EditorSnapshot,
    elementIds: readonly string[],
  ): void;
  onTransformPreviewClear?(): void;
  guides?: ResolvedGuide[];
  guidePreview?: { axis: GuideAxis; position: number } | null;
  onBeginGuideMove?(id: string): boolean | Promise<boolean>;
  onPreviewGuideMove?(id: string, position: number): void;
  onCommitGuideMove?(id: string, position: number): void;
  onCancelGuideMove?(id: string, position: number): void;
  onDeleteGuide?(id: string): void;
  onSnapGuide?(axis: GuideAxis, position: number, guideId?: string): number;
}

type GesturePreview = ReturnType<typeof createTransientTransformPreview>;

type ActiveGesture = {
  pointerId: number;
  cancel(): void;
};

const defaultSnapping: EditorCanvasSnapping = {
  enabled: true,
  toObjects: true,
  toGuides: true,
  toSlide: true,
  drag: defaultDragSnapSettings,
};

const resizeHandles: readonly ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

const handlePositions: Record<ResizeHandle, CSSProperties> = {
  nw: { left: 0, top: 0, cursor: "nwse-resize" },
  n: { left: "50%", top: 0, cursor: "ns-resize" },
  ne: { left: "100%", top: 0, cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: 0, top: "100%", cursor: "nesw-resize" },
  w: { left: 0, top: "50%", cursor: "ew-resize" },
};

function sameSelection(left: CanvasSelection, right: CanvasSelection) {
  return (
    left.scopeId === right.scopeId &&
    left.elementIds.length === right.elementIds.length &&
    left.elementIds.every((id, index) => id === right.elementIds[index])
  );
}

function selectionExistsInScope(
  snapshot: TransformSnapshot,
  elementIds: readonly string[],
  scopeId: ScopeId,
) {
  return (
    elementIds.length > 0 &&
    elementIds.every(
      (id) => locateElement(snapshot.slide, id)?.parentId === scopeId,
    )
  );
}

function feedbackFor(
  preview: TransformPreview,
  scopeId: ScopeId,
): GestureFeedback {
  return {
    guides: scopeGuidesToWorld(
      preview.snapshot.slide,
      scopeId,
      preview.scopeGuides,
    ),
    measurement: preview.measurement,
  };
}

export function EditorCanvas({
  documentId,
  transport,
  scale,
  snapping,
  idFactory,
  className,
  style,
}: EditorCanvasProps) {
  const controller = useEditorSession(documentId, transport);
  return (
    <EditorCanvasSurface
      controller={controller}
      scale={scale}
      snapping={snapping}
      idFactory={idFactory}
      className={className}
      style={style}
    />
  );
}

export function EditorCanvasSurface({
  controller,
  scale = 1,
  snapping,
  idFactory,
  className,
  style,
  selection: controlledSelection,
  onSelectionChange,
  onScopeEnter,
  keyboardHistory = true,
  selectionMode = "simple",
  motionState,
  motionSourceSlide,
  previewMedia = false,
  showFrameBorders = false,
  trimMedia = false,
  cropFrameId = null,
  frameEditingId = null,
  frameEditingIntrinsic,
  onFrameEditRequest,
  textEditing,
  remoteSelections = [],
  onTransformPreview,
  onTransformPreviewClear,
  guides = [],
  guidePreview = null,
  onBeginGuideMove,
  onPreviewGuideMove,
  onCommitGuideMove,
  onCancelGuideMove,
  onDeleteGuide,
  onSnapGuide,
}: EditorCanvasSurfaceProps) {
  const {
    snapshot,
    snapshotRef,
    status,
    apply,
    commitPreview,
    acquireElementScopes,
    releaseLeases,
    undo,
  } = controller;
  const stage = useRef<HTMLDivElement>(null);
  const activeGesture = useRef<ActiveGesture | null>(null);
  const [deferImageUpdates, setDeferImageUpdates] = useState(false);
  const pendingMoveIntent = useRef(false);
  const marqueeCancel = useRef<(() => void) | null>(null);
  const [marquee, setMarquee] = useState<ReturnType<
    typeof createMarqueeBox
  > | null>(null);
  const [internalSelection, setInternalSelection] = useState<CanvasSelection>({
    elementIds: [],
    scopeId: null,
  });
  const selection = controlledSelection ?? internalSelection;
  const selectionRef = useRef(selection);
  const setSelection = useCallback<Dispatch<SetStateAction<CanvasSelection>>>(
    (value) => {
      const current = controlledSelection ?? selectionRef.current;
      const next =
        typeof value === "function"
          ? (value as (current: CanvasSelection) => CanvasSelection)(current)
          : value;
      if (controlledSelection === undefined) setInternalSelection(next);
      onSelectionChange?.(next);
    },
    [controlledSelection, onSelectionChange],
  );
  const [transientSnapshot, setTransientSnapshot] =
    useState<TransformSnapshot | null>(null);
  selectionRef.current = selection;

  const canvasScale = Math.max(scale, 1e-9);
  const snapConfig = useMemo(
    () => ({ ...defaultSnapping, ...snapping }),
    [snapping],
  );
  const renderedSnapshot = transientSnapshot ?? snapshot;
  const diagnosticsState = useRef(() => ({}));
  diagnosticsState.current = () => ({
    slideId: snapshotRef.current?.slide.id,
    selection: selectionRef.current,
    activeGesturePointerId: activeGesture.current?.pointerId ?? null,
    pendingMoveIntent: pendingMoveIntent.current,
    marqueeActive: !!marqueeCancel.current,
    frameEditingId,
    previewMedia,
    layers: snapshotRef.current?.deck.layers,
    frames:
      renderedSnapshot &&
      walkElements(
        renderedSnapshot.slide.nodes.flatMap((root) => root.children),
      ).map((element) => ({ id: element.id, frame: element.frame })),
    canonicalFrames:
      snapshotRef.current &&
      walkElements(
        snapshotRef.current.slide.nodes.flatMap((root) => root.children),
      ).map((element) => ({ id: element.id, frame: element.frame })),
  });
  useEffect(
    () =>
      installCanvasInteractionDiagnostics(
        () => stage.current,
        () => diagnosticsState.current(),
      ),
    [],
  );

  const nextElementId = useCallback(
    () => (idFactory ? idFactory() : crypto.randomUUID()),
    [idFactory],
  );

  useEffect(() => {
    if (!snapshot || transientSnapshot || activeGesture.current) return;
    setSelection((current) => {
      const next = pruneCanvasSelection(snapshot.slide, snapshot.deck, current);
      return sameSelection(current, next) ? current : next;
    });
  }, [setSelection, snapshot, transientSnapshot]);

  const selectionGeometry = useMemo(() => {
    if (
      !renderedSnapshot ||
      !selection.scopeId ||
      !selection.elementIds.length ||
      !selectionExistsInScope(
        renderedSnapshot,
        selection.elementIds,
        selection.scopeId,
      )
    )
      return null;
    return selectionWorldGeometry(
      renderedSnapshot.slide,
      selection.elementIds,
      selection.scopeId,
    );
  }, [renderedSnapshot, selection]);

  const pointToSlide = useCallback(
    (clientX: number, clientY: number) => {
      const node = stage.current;
      const current = transientSnapshot ?? snapshotRef.current;
      if (!node || !current) return { x: 0, y: 0 };
      const rect = node.getBoundingClientRect();
      const scaleX = rect.width / current.deck.width || canvasScale;
      const scaleY = rect.height / current.deck.height || canvasScale;
      return {
        x: (clientX - rect.left) / scaleX,
        y: (clientY - rect.top) / scaleY,
      };
    },
    [canvasScale, snapshotRef, transientSnapshot],
  );

  const transformSnapOptions = useCallback(
    (disableForAlt: boolean): TransformSnapOptions => ({
      enabled: snapConfig.enabled && !disableForAlt,
      toObjects: snapConfig.toObjects,
      toGuides: snapConfig.toGuides,
      toSlide: snapConfig.toSlide,
      scale: canvasScale,
    }),
    [
      canvasScale,
      snapConfig.enabled,
      snapConfig.toGuides,
      snapConfig.toObjects,
      snapConfig.toSlide,
    ],
  );

  const elementAtPoint = useCallback((clientX: number, clientY: number) => {
    const node = stage.current;
    if (!node) return null;
    for (const target of document.elementsFromPoint(clientX, clientY)) {
      if (!(target instanceof HTMLElement)) continue;
      const element = target.closest<HTMLElement>("[data-element-id]");
      if (element && node.contains(element))
        return element.dataset.elementId ?? null;
    }
    return null;
  }, []);

  const createLease = useCallback(
    (
      slideId: string,
      elementIds: readonly string[],
      structuralParentIds: readonly string[] = [],
    ) =>
      createOptimisticLease(
        () => acquireElementScopes(slideId, elementIds, structuralParentIds),
        releaseLeases,
      ),
    [acquireElementScopes, releaseLeases],
  );

  const installGesture = useCallback(
    (pointerId: number, cancel: () => void) => {
      const gesture = { pointerId, cancel };
      activeGesture.current = gesture;
      setDeferImageUpdates(true);
      return () => {
        if (activeGesture.current === gesture) {
          activeGesture.current = null;
          setDeferImageUpdates(false);
        }
      };
    },
    [],
  );

  const runCompletedGesture = useCallback(
    ({
      pointerId,
      target,
      start,
      initial,
      previewBase,
      scopeId,
      lease,
      renderPreview,
      applyPreview,
      rollback,
      finalChange,
      onCommitted,
      previewElementIds,
    }: {
      pointerId: number;
      target: HTMLElement;
      start: { clientX: number; clientY: number };
      initial: EditorSnapshot;
      previewBase: TransformSnapshot;
      scopeId: ScopeId;
      lease: ReturnType<typeof createOptimisticLease>;
      renderPreview: GesturePreview;
      applyPreview(event: PointerEvent): TransformPreview;
      rollback(): void;
      finalChange(): TransformSnapshot | null;
      onCommitted?(): void;
      previewElementIds?: readonly string[];
    }) => {
      let ended = false;

      let lastPreviewSnapshot: TransformSnapshot = previewBase;
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        const preview = applyPreview(event);
        lastPreviewSnapshot = preview.snapshot;
        renderPreview(preview.snapshot, feedbackFor(preview, scopeId));
        if (lease.granted && previewElementIds?.length)
          onTransformPreview?.(
            preview.snapshot as EditorSnapshot,
            previewElementIds,
          );
      };
      if (previewElementIds?.length)
        void lease.wait().then((granted) => {
          if (granted && !ended)
            onTransformPreview?.(
              lastPreviewSnapshot as EditorSnapshot,
              previewElementIds,
            );
        });

      let finishGesture: () => void = () => {};
      const clear = () => {
        finishGesture();
        pendingMoveIntent.current = false;
      };

      const cancel = () => {
        if (ended) return;
        ended = true;
        renderPreview(previewBase, {});
        if (motionSourceSlide) renderPreview.restoreElements();
        lease.cancel(() => {
          onTransformPreviewClear?.();
          rollback();
          clear();
        });
        if (target.hasPointerCapture(pointerId))
          target.releasePointerCapture(pointerId);
      };
      finishGesture = installGesture(pointerId, cancel);

      framePointerGesture(
        target,
        { pointerId, clientX: start.clientX, clientY: start.clientY },
        move,
        (event) => {
          if (ended) return;
          if (event.type !== "pointerup") {
            cancel();
            return;
          }
          ended = true;
          const completed = finalChange();
          if (!completed) {
            renderPreview(initial, {});
            if (motionSourceSlide) renderPreview.restoreElements();
            lease.cancel(() => {
              onTransformPreviewClear?.();
              clear();
            });
            return;
          }
          renderPreview(completed, {});
          void lease
            .finish(
              () => {
                if (motionSourceSlide) renderPreview.restoreElements();
                apply(completed, false);
                commitPreview();
                // Keep the remote preview visible until the host authority
                // broadcasts durable acceptance. Failure paths clear below.
                onCommitted?.();
                clear();
              },
              () => {
                onTransformPreviewClear?.();
                rollback();
                clear();
              },
            )
            .catch(() => {
              onTransformPreviewClear?.();
              rollback();
              void releaseLeases().catch(() => undefined);
              clear();
            });
        },
        "interaction.transform",
      );

      return { move, cancel };
    },
    [
      apply,
      commitPreview,
      installGesture,
      motionSourceSlide,
      onTransformPreview,
      onTransformPreviewClear,
      releaseLeases,
    ],
  );

  const preserveCropSnapshot = useCallback(
    (
      beforeSnapshot: EditorSnapshot,
      nextSnapshot: TransformSnapshot,
      elementIds: readonly string[],
    ): TransformSnapshot => {
      if (
        !cropFrameId ||
        elementIds.length !== 1 ||
        elementIds[0] !== cropFrameId
      )
        return nextSnapshot;
      const before = findElement(beforeSnapshot.slide, cropFrameId);
      const after = findElement(nextSnapshot.slide, cropFrameId);
      if (!before || !after || !isMediaContent(before.content))
        return nextSnapshot;
      const content = preserveMediaAfterFrameChange(before, after.frame);
      return content
        ? setElementContents(nextSnapshot, [
            { elementId: cropFrameId, value: content },
          ])
        : nextSnapshot;
    },
    [cropFrameId],
  );

  const beginMove = useCallback(
    async (
      event: ReactPointerEvent<HTMLElement>,
      elementIds: readonly string[],
      scopeId: ScopeId,
    ) => {
      const target = stage.current;
      if (
        !target ||
        event.button !== 0 ||
        activeGesture.current ||
        pendingMoveIntent.current ||
        !elementIds.length
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const pointerStart = {
        pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const duplicate = event.altKey;
      target.setPointerCapture(pointerId);
      pendingMoveIntent.current = true;
      const intent = duplicate
        ? null
        : await waitForPointerDragIntent(target, pointerStart);
      if (!duplicate && (!intent || !intent.active())) {
        intent?.stop();
        pendingMoveIntent.current = false;
        return;
      }

      const initial = snapshotRef.current;
      if (
        !initial ||
        !isEditableScope(initial.slide, initial.deck, scopeId) ||
        !selectionExistsInScope(initial, elementIds, scopeId) ||
        selectionRef.current.scopeId !== scopeId ||
        elementIds.some((id) => !selectionRef.current.elementIds.includes(id))
      ) {
        intent?.stop();
        pendingMoveIntent.current = false;
        return;
      }

      const base = createCanvasMoveBase(
        initial,
        elementIds,
        scopeId,
        duplicate,
        nextElementId,
      );
      const lease = createLease(
        initial.slide.id,
        duplicate
          ? [...base.originalElementIds, ...base.movingElementIds]
          : base.originalElementIds,
        duplicate ? [scopeId] : [],
      );
      if (duplicate) {
        flushSync(() => {
          setTransientSnapshot(base.snapshot);
          setSelection({ elementIds: base.movingElementIds, scopeId });
        });
      }
      const renderPreview = createTransientTransformPreview(
        target,
        base.snapshot,
        base.movingElementIds,
        scopeId,
        canvasScale,
      );
      const startWorld = pointToSlide(
        pointerStart.clientX,
        pointerStart.clientY,
      );
      const movePreview = createMoveGesture(
        base.snapshot,
        base.movingElementIds,
        scopeId,
        transformSnapOptions(false),
        snapConfig.drag,
      );
      let finalPreview: TransformSnapshot = base.snapshot;
      let moveChanged = false;
      const rollback = () => {
        renderPreview(base.snapshot, {});
        if (duplicate) {
          flushSync(() => {
            setTransientSnapshot(null);
            setSelection({ elementIds: base.originalElementIds, scopeId });
          });
        }
      };
      const gesture = runCompletedGesture({
        pointerId,
        target,
        start: pointerStart,
        initial,
        previewBase: base.snapshot,
        scopeId,
        lease,
        renderPreview,
        applyPreview: (pointer) => {
          const point = pointToSlide(pointer.clientX, pointer.clientY);
          const delta = { x: point.x - startWorld.x, y: point.y - startWorld.y };
          const preview = movePreview(delta, pointer.timeStamp, pointer.altKey);
          const cropSnapshot = duplicate
            ? preview.snapshot
            : preserveCropSnapshot(
                initial,
                preview.snapshot,
                base.movingElementIds,
              );
          finalPreview = cropSnapshot;
          moveChanged = preview.changed;
          return { ...preview, snapshot: cropSnapshot };
        },
        rollback,
        finalChange: () =>
          duplicate ? finalPreview : moveChanged ? finalPreview : null,
        previewElementIds: duplicate ? undefined : base.movingElementIds,
        onCommitted: duplicate
          ? () => {
              flushSync(() => setTransientSnapshot(null));
              setSelection({ elementIds: base.movingElementIds, scopeId });
            }
          : undefined,
      });
      if (intent) {
        gesture.move(intent.latest());
        intent.stop();
      }
    },
    [
      canvasScale,
      createLease,
      nextElementId,
      pointToSlide,
      preserveCropSnapshot,
      runCompletedGesture,
      setSelection,
      snapshotRef,
      snapConfig.drag,
      transformSnapOptions,
    ],
  );

  const updateSelectionForTarget = useCallback(
    (currentSnapshot: EditorSnapshot, targetId: string, additive: boolean) => {
      if (
        !isEditableScope(currentSnapshot.slide, currentSnapshot.deck, targetId)
      )
        return null;
      const current = selectionRef.current;
      const activeScope =
        current.scopeId ?? currentSnapshot.slide.nodes[0]?.id ?? null;
      if (!activeScope) return null;
      const scopedTarget = resolveCanvasHitTarget(
        currentSnapshot.slide,
        activeScope,
        targetId,
      );
      if (!scopedTarget) return null;
      const next = resolveCanvasSelection(
        currentSnapshot.slide,
        { ...current, scopeId: activeScope },
        scopedTarget,
        additive,
      );
      setSelection(next);
      return { current, next, targetId: scopedTarget };
    },
    [setSelection],
  );

  const elementPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, targetId: string) => {
      if (event.button !== 0 || activeGesture.current) return;
      const currentSnapshot = snapshotRef.current;
      if (!currentSnapshot) return;
      const result = updateSelectionForTarget(
        currentSnapshot,
        targetId,
        event.shiftKey,
      );
      if (!result) return;
      const toggledOff =
        event.shiftKey &&
        result.current.scopeId === result.next.scopeId &&
        result.current.elementIds.includes(result.targetId) &&
        !result.next.elementIds.includes(result.targetId);
      if (
        toggledOff ||
        !result.next.scopeId ||
        !result.next.elementIds.length
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      void beginMove(event, result.next.elementIds, result.next.scopeId);
    },
    [beginMove, snapshotRef, updateSelectionForTarget],
  );

  const canvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement> | PointerEvent) => {
      if (event.button !== 0 || activeGesture.current || marqueeCancel.current)
        return;
      if (!(event.currentTarget instanceof HTMLElement)) return;
      const targetNode = event.target;
      if (!(targetNode instanceof HTMLElement)) return;
      if (targetNode.closest("[data-selection-overlay]")) return;
      const element = targetNode.closest<HTMLElement>("[data-element-id]");
      if (element && event.currentTarget.contains(element)) {
        const id = element.dataset.elementId;
        if (id && "nativeEvent" in event) elementPointerDown(event, id);
        return;
      }

      const currentSnapshot = snapshotRef.current;
      const currentSelection = selectionRef.current;
      let scopeId = currentSelection.scopeId;
      if (!currentSnapshot || !scopeId) return;
      if (
        !isEditableScope(currentSnapshot.slide, currentSnapshot.deck, scopeId)
      ) {
        try {
          scopeId = resolveEditableScope(
            currentSnapshot.slide,
            currentSnapshot.deck,
            scopeId,
          );
          setSelection({ elementIds: [], scopeId });
        } catch {
          setSelection({ elementIds: [], scopeId: null });
          return;
        }
      }

      event.preventDefault();
      event.stopPropagation();
      onFrameEditRequest?.(null);
      void textEditing?.exit();

      const target: HTMLElement = event.currentTarget;
      const pointerId = event.pointerId;
      const startClient = { x: event.clientX, y: event.clientY };
      const start = pointToSlide(event.clientX, event.clientY);
      const additive = event.shiftKey;
      const original = {
        elementIds: [...currentSelection.elementIds],
        scopeId: currentSelection.scopeId,
      };
      let existing =
        additive && original.scopeId === scopeId
          ? [...original.elementIds]
          : [];
      let moved = false;
      target.setPointerCapture(pointerId);

      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        if (
          !moved &&
          Math.hypot(
            next.clientX - startClient.x,
            next.clientY - startClient.y,
          ) < 3
        )
          return;
        moved = true;
        const latestSnapshot = snapshotRef.current;
        if (!latestSnapshot) return;
        if (!scopeId) return;
        if (
          !isEditableScope(latestSnapshot.slide, latestSnapshot.deck, scopeId)
        ) {
          try {
            scopeId = resolveEditableScope(
              latestSnapshot.slide,
              latestSnapshot.deck,
              scopeId,
            );
            existing = [];
            setSelection({ elementIds: [], scopeId });
          } catch {
            setSelection({ elementIds: [], scopeId: null });
            setMarquee(null);
            finish(false);
            return;
          }
        }
        if (!scopeId) return;
        const point = pointToSlide(next.clientX, next.clientY);
        const box = createMarqueeBox(start, point, selectionMode);
        const hits = resolveMarqueeSelection(
          latestSnapshot.slide,
          latestSnapshot.deck,
          scopeId,
          box,
        );
        setMarquee(box);
        setSelection({
          scopeId,
          elementIds: [...new Set([...existing, ...hits])],
        });
      };

      const finish = (cancelled: boolean) => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        target.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", keyDown, true);
        if (target.hasPointerCapture(pointerId))
          target.releasePointerCapture(pointerId);
        marqueeCancel.current = null;
        setMarquee(null);

        if (cancelled) {
          const latestSnapshot = snapshotRef.current;
          setSelection(
            latestSnapshot
              ? pruneCanvasSelection(
                  latestSnapshot.slide,
                  latestSnapshot.deck,
                  original,
                )
              : original,
          );
          return;
        }
        if (!moved && !additive) {
          const latestSnapshot = snapshotRef.current ?? currentSnapshot;
          if (!scopeId) return;
          const location = locateElement(latestSnapshot.slide, scopeId);
          if (location)
            setSelection({
              elementIds: [scopeId],
              scopeId: location.parentId,
            });
          else setSelection({ elementIds: [], scopeId });
        }
      };
      const end = (next: PointerEvent) => {
        if (next.pointerId === pointerId) finish(false);
      };
      const cancel = () => finish(true);
      const keyDown = (keyboard: KeyboardEvent) => {
        if (keyboard.key !== "Escape") return;
        keyboard.preventDefault();
        keyboard.stopImmediatePropagation();
        cancel();
      };

      marqueeCancel.current = cancel;
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", end);
      target.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", keyDown, true);
    },
    [
      elementPointerDown,
      onFrameEditRequest,
      pointToSlide,
      selectionMode,
      setSelection,
      snapshotRef,
      textEditing,
    ],
  );

  useEffect(() => {
    const workspace = stage.current?.closest<HTMLElement>(".stage");
    if (!workspace || previewMedia) return;
    const startOutsideSlide = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest(
          "[data-editor-canvas], .ruler, button, input, textarea, select",
        )
      )
        return;
      canvasPointerDown(event);
    };
    workspace.addEventListener("pointerdown", startOutsideSlide);
    return () =>
      workspace.removeEventListener("pointerdown", startOutsideSlide);
  }, [canvasPointerDown, previewMedia]);

  const canvasDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (frameEditingId) {
        event.preventDefault();
        event.stopPropagation();
        onFrameEditRequest?.(null);
        return;
      }
      if (activeGesture.current) return;
      const target = event.target;
      const currentSnapshot = snapshotRef.current;
      const activeScope = selectionRef.current.scopeId;
      if (!(target instanceof HTMLElement) || !currentSnapshot || !activeScope)
        return;
      const element = target.closest<HTMLElement>("[data-element-id]");
      const rawId =
        element?.dataset.elementId ??
        elementAtPoint(event.clientX, event.clientY);
      if (!rawId) return;
      const targetId = resolveCanvasHitTarget(
        currentSnapshot.slide,
        activeScope,
        rawId,
      );
      if (!targetId) return;
      const hit = findElement(currentSnapshot.slide, targetId);
      if (
        hit?.content?.type === "text" &&
        isEditableScope(currentSnapshot.slide, currentSnapshot.deck, targetId)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onFrameEditRequest?.(null);
        void textEditing?.enter(targetId, "all");
        return;
      }
      if (
        hit &&
        isMediaContent(hit.content) &&
        isEditableScope(currentSnapshot.slide, currentSnapshot.deck, targetId)
      ) {
        const location = locateElement(currentSnapshot.slide, targetId);
        if (!location) return;
        event.preventDefault();
        event.stopPropagation();
        setSelection({ elementIds: [targetId], scopeId: location.parentId });
        onFrameEditRequest?.(targetId);
        return;
      }
      if (!hit?.container) return;
      event.preventDefault();
      event.stopPropagation();
      setSelection({ elementIds: [], scopeId: targetId });
      onScopeEnter?.(targetId);
    },
    [
      elementAtPoint,
      onScopeEnter,
      frameEditingId,
      onFrameEditRequest,
      setSelection,
      snapshotRef,
      textEditing,
    ],
  );

  const selectionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || activeGesture.current) return;
      const underlying = elementAtPoint(event.clientX, event.clientY);
      if (underlying) {
        elementPointerDown(event, underlying);
        return;
      }
      const current = selectionRef.current;
      if (current.scopeId && current.elementIds.length)
        void beginMove(event, current.elementIds, current.scopeId);
    },
    [beginMove, elementAtPoint, elementPointerDown],
  );

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>, handle: ResizeHandle) => {
      const target = stage.current;
      const initial = snapshotRef.current;
      const current = selectionRef.current;
      if (
        !target ||
        !initial ||
        event.button !== 0 ||
        activeGesture.current ||
        !current.scopeId ||
        !isEditableScope(initial.slide, initial.deck, current.scopeId) ||
        !selectionExistsInScope(initial, current.elementIds, current.scopeId)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const start = { clientX: event.clientX, clientY: event.clientY };
      const startWorld = pointToSlide(event.clientX, event.clientY);
      target.setPointerCapture(pointerId);
      const lease = createLease(initial.slide.id, current.elementIds);
      const renderPreview = createTransientTransformPreview(
        target,
        initial,
        current.elementIds,
        current.scopeId,
        canvasScale,
      );
      let finalPreview: TransformSnapshot = initial;
      let changed = false;
      let resizeBase = initial;
      let resizeOrigin = startWorld;
      let previousPoint = startWorld;
      let constrained = event.shiftKey;
      runCompletedGesture({
        pointerId,
        target,
        start,
        initial,
        previewBase: initial,
        scopeId: current.scopeId,
        lease,
        renderPreview,
        applyPreview: (pointer) => {
          const point = pointToSlide(pointer.clientX, pointer.clientY);
          if (pointer.shiftKey !== constrained) {
            resizeBase = finalPreview;
            resizeOrigin = previousPoint;
            constrained = pointer.shiftKey;
          }
          const preview = previewResize(
            resizeBase,
            current.elementIds,
            current.scopeId!,
            handle,
            { x: point.x - resizeOrigin.x, y: point.y - resizeOrigin.y },
            pointer.shiftKey,
            transformSnapOptions(pointer.altKey),
          );
          const cropSnapshot = preserveCropSnapshot(
            initial,
            preview.snapshot,
            current.elementIds,
          );
          finalPreview = cropSnapshot;
          changed ||= preview.changed;
          previousPoint = point;
          return { ...preview, snapshot: cropSnapshot };
        },
        rollback: () => renderPreview(initial, {}),
        finalChange: () => (changed ? finalPreview : null),
        previewElementIds: current.elementIds,
      });
    },
    [
      canvasScale,
      createLease,
      pointToSlide,
      preserveCropSnapshot,
      runCompletedGesture,
      snapshotRef,
      transformSnapOptions,
    ],
  );

  const beginRotation = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const target = stage.current;
      const initial = snapshotRef.current;
      const current = selectionRef.current;
      if (
        !target ||
        !initial ||
        event.button !== 0 ||
        activeGesture.current ||
        !current.scopeId ||
        !isEditableScope(initial.slide, initial.deck, current.scopeId) ||
        !selectionExistsInScope(initial, current.elementIds, current.scopeId)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const start = { clientX: event.clientX, clientY: event.clientY };
      const startWorld = pointToSlide(event.clientX, event.clientY);
      target.setPointerCapture(pointerId);
      const lease = createLease(initial.slide.id, current.elementIds);
      const renderPreview = createTransientTransformPreview(
        target,
        initial,
        current.elementIds,
        current.scopeId,
        canvasScale,
      );
      let finalPreview: TransformSnapshot = initial;
      let changed = false;
      runCompletedGesture({
        pointerId,
        target,
        start,
        initial,
        previewBase: initial,
        scopeId: current.scopeId,
        lease,
        renderPreview,
        applyPreview: (pointer) => {
          const preview = previewRotation(
            initial,
            current.elementIds,
            current.scopeId!,
            startWorld,
            pointToSlide(pointer.clientX, pointer.clientY),
            pointer.shiftKey,
          );
          finalPreview = preview.snapshot;
          changed = preview.changed;
          return preview;
        },
        rollback: () => renderPreview(initial, {}),
        finalChange: () => (changed ? finalPreview : null),
        previewElementIds: current.elementIds,
      });
    },
    [canvasScale, createLease, pointToSlide, runCompletedGesture, snapshotRef],
  );

  const beginMediaContentGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      mode: "move" | "resize" | "rotate",
      handle?: ResizeHandle,
    ) => {
      const target = stage.current;
      const initial = snapshotRef.current;
      if (
        !target ||
        !initial ||
        !frameEditingId ||
        event.button !== 0 ||
        event.ctrlKey ||
        activeGesture.current
      )
        return;
      const location = locateElement(initial.slide, frameEditingId);
      if (
        !location ||
        !isEditableScope(initial.slide, initial.deck, frameEditingId) ||
        !isMediaContent(location.element.content)
      )
        return;
      const resolved = resolveMediaFrame(
        location.element,
        frameEditingIntrinsic,
      );
      if (!resolved) return;
      if (
        mode === "resize" &&
        location.element.content.transform.rule === "fit"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      target.setPointerCapture(pointerId);
      const startSlide = pointToSlide(event.clientX, event.clientY);
      const toLocal = inverse(location.world);
      const startLocal = transformPoint(toLocal, startSlide);
      const initialContent = location.element.content;
      const snapTargets = mediaSnapTargets(
        initial.slide,
        initial.deck,
        frameEditingId,
        {
          objects: snapConfig.toObjects,
          guides: snapConfig.toGuides,
          slide: snapConfig.toSlide,
        },
      );
      const lease = createLease(initial.slide.id, [frameEditingId]);
      let changed = false;
      let finalSnapshot = initial;
      let active = true;
      const startAngle =
        Math.atan2(
          (startLocal.y - (resolved.y + resolved.height * resolved.originY)) /
            (resolved.scaleY * (resolved.flipY ? -1 : 1)),
          (startLocal.x - (resolved.x + resolved.width * resolved.originX)) /
            (resolved.scaleX * (resolved.flipX ? -1 : 1)),
        ) *
        (180 / Math.PI);

      const preview = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        const point = transformPoint(
          toLocal,
          pointToSlide(pointer.clientX, pointer.clientY),
        );
        let nextResolved = resolved;
        if (mode === "move") {
          let x = resolved.x + point.x - startLocal.x;
          let y = resolved.y + point.y - startLocal.y;
          if (snapConfig.enabled && !pointer.altKey) {
            const sourcesX = snapTargets.x;
            const sourcesY = snapTargets.y;
            const tolerance = 8 / canvasScale;
            x = resolveSnapAxis(x, resolved.width, sourcesX, tolerance).value;
            y = resolveSnapAxis(y, resolved.height, sourcesY, tolerance).value;
          }
          nextResolved = { ...resolved, x, y };
        } else if (
          mode === "resize" &&
          handle &&
          (resolved.flipX ||
            resolved.flipY ||
            resolved.scaleX !== 1 ||
            resolved.scaleY !== 1 ||
            resolved.originX !== 0.5 ||
            resolved.originY !== 0.5)
        ) {
          const matrix = localMatrix(resolved);
          const toContent = inverse(matrix);
          const dx = point.x - startLocal.x,
            dy = point.y - startLocal.y;
          const box = resizeBox(
            { x: 0, y: 0, width: resolved.width, height: resolved.height },
            handle,
            toContent[0] * dx + toContent[2] * dy,
            toContent[1] * dx + toContent[3] * dy,
            { keepRatio: !pointer.shiftKey, minSize: 1 },
          );
          const oldFixed = {
            x: handle.includes("w")
              ? resolved.width
              : handle.includes("e")
                ? 0
                : resolved.width / 2,
            y: handle.includes("n")
              ? resolved.height
              : handle.includes("s")
                ? 0
                : resolved.height / 2,
          };
          const newFixed = {
            x: handle.includes("w")
              ? box.width
              : handle.includes("e")
                ? 0
                : box.width / 2,
            y: handle.includes("n")
              ? box.height
              : handle.includes("s")
                ? 0
                : box.height / 2,
          };
          nextResolved = { ...resolved, width: box.width, height: box.height };
          const before = transformPoint(matrix, oldFixed),
            after = transformPoint(localMatrix(nextResolved), newFixed);
          nextResolved.x += before.x - after.x;
          nextResolved.y += before.y - after.y;
        } else if (mode === "resize" && handle) {
          let dx = point.x - startLocal.x;
          let dy = point.y - startLocal.y;
          if (
            snapConfig.enabled &&
            !pointer.altKey &&
            Math.abs(resolved.rotation % 360) < 0.001
          ) {
            const tolerance = 8 / canvasScale;
            const raw = resizeTransform(resolved, handle, dx, dy, {
              keepRatio: !pointer.shiftKey,
              minSize: 1,
            });
            if (handle.includes("e") || handle.includes("w")) {
              const sx = resolveResizeSnapAxis(
                raw.x,
                raw.width,
                handle.includes("w") ? "start" : "end",
                snapTargets.x,
                tolerance,
                1,
              );
              if (sx.guide !== undefined)
                dx = handle.includes("w")
                  ? sx.position - resolved.x
                  : sx.position + sx.size - (resolved.x + resolved.width);
            }
            if (handle.includes("n") || handle.includes("s")) {
              const sy = resolveResizeSnapAxis(
                raw.y,
                raw.height,
                handle.includes("n") ? "start" : "end",
                snapTargets.y,
                tolerance,
                1,
              );
              if (sy.guide !== undefined)
                dy = handle.includes("n")
                  ? sy.position - resolved.y
                  : sy.position + sy.size - (resolved.y + resolved.height);
            }
          }
          const resized = resizeTransform(resolved, handle, dx, dy, {
            keepRatio: !pointer.shiftKey,
            minSize: 1,
          });
          nextResolved = {
            ...resolved,
            x: resized.x,
            y: resized.y,
            width: resized.width,
            height: resized.height,
          };
        } else if (mode === "rotate") {
          const angle =
            Math.atan2(
              (point.y - (resolved.y + resolved.height * resolved.originY)) /
                (resolved.scaleY * (resolved.flipY ? -1 : 1)),
              (point.x - (resolved.x + resolved.width * resolved.originX)) /
                (resolved.scaleX * (resolved.flipX ? -1 : 1)),
            ) *
            (180 / Math.PI);
          let rotation = resolved.rotation + angle - startAngle;
          rotation = snapRotation(rotation, pointer.shiftKey);
          nextResolved = { ...resolved, rotation };
        }

        // Fit/Fill cannot persist distortion. Store an actual stretch as Free;
        // pressing Shift without changing the aspect must not change the rule.
        const stretched =
          mode === "resize" &&
          pointer.shiftKey &&
          Math.abs(
            nextResolved.width / resolved.width -
              nextResolved.height / resolved.height,
          ) > 1e-8;
        const nextContent = updateMediaFromResolved(
          stretched
            ? {
                ...location.element,
                content: {
                  ...initialContent,
                  transform: { rule: "free", local: resolved },
                },
              }
            : location.element,
          nextResolved,
          frameEditingIntrinsic,
        );
        changed =
          JSON.stringify(nextContent.transform) !==
          JSON.stringify(initialContent.transform);
        finalSnapshot = setElementContents(initial, [
          { elementId: frameEditingId, value: nextContent },
        ]);
        setTransientSnapshot(changed ? finalSnapshot : null);
      };

      const rollback = () => {
        setTransientSnapshot(null);
      };
      const cancel = () => {
        if (!active) return;
        active = false;
        rollback();
        lease.cancel(() => undefined);
        if (target.hasPointerCapture(pointerId))
          target.releasePointerCapture(pointerId);
        if (activeGesture.current?.pointerId === pointerId) {
          activeGesture.current = null;
          setDeferImageUpdates(false);
        }
      };
      activeGesture.current = { pointerId, cancel };
      setDeferImageUpdates(true);

      framePointerGesture(
        target,
        {
          pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        },
        preview,
        (endEvent) => {
          if (!active) return;
          if (endEvent.type !== "pointerup") {
            cancel();
            return;
          }
          const clearActiveGesture = () => {
            if (activeGesture.current?.pointerId === pointerId) {
              activeGesture.current = null;
              setDeferImageUpdates(false);
            }
          };
          if (!changed) {
            active = false;
            clearActiveGesture();
            rollback();
            lease.cancel(() => undefined);
            return;
          }
          void lease
            .finish(
              () => {
                if (!active) return;
                active = false;
                clearActiveGesture();
                apply(finalSnapshot, false);
                commitPreview();
                setTransientSnapshot(null);
              },
              () => {
                if (!active) return;
                active = false;
                clearActiveGesture();
                rollback();
              },
            )
            .catch(() => {
              if (!active) return;
              active = false;
              clearActiveGesture();
              rollback();
              void releaseLeases().catch(() => undefined);
            });
        },
        "interaction.mediaContent",
      );
    },
    [
      apply,
      canvasScale,
      commitPreview,
      createLease,
      frameEditingId,
      frameEditingIntrinsic,
      pointToSlide,
      releaseLeases,
      snapConfig,
      snapshotRef,
    ],
  );

  useEffect(() => {
    if (!frameEditingId) return;
    const current = renderedSnapshot;
    const selected = selectionRef.current;
    const location = current
      ? locateElement(current.slide, frameEditingId)
      : null;
    if (
      !current ||
      !location ||
      selected.elementIds.length !== 1 ||
      selected.elementIds[0] !== frameEditingId ||
      selected.scopeId !== location.parentId ||
      !isEditableScope(current.slide, current.deck, frameEditingId)
    )
      onFrameEditRequest?.(null);
  }, [
    frameEditingId,
    onFrameEditRequest,
    renderedSnapshot,
    selection.elementIds,
    selection.scopeId,
  ]);

  useEffect(() => {
    if (!keyboardHistory || previewMedia) return;
    const keyDown = (event: KeyboardEvent) => {
      if (isContextMenuOpen()) return;
      // An open native popover owns Escape before canvas selection or scope navigation.
      if (
        event.key === "Escape" &&
        document.querySelector("[popover]:popover-open")
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable)
      )
        return;
      if (event.key === "Escape" && marqueeCancel.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        marqueeCancel.current();
        return;
      }
      if (event.key === "Escape" && activeGesture.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        activeGesture.current.cancel();
        return;
      }
      if (activeGesture.current) return;
      if (event.key === "Escape" && frameEditingId) {
        event.preventDefault();
        onFrameEditRequest?.(null);
        return;
      }
      if (event.key === "Escape") {
        const currentSnapshot = snapshotRef.current;
        const currentScope = selectionRef.current.scopeId;
        const location =
          currentSnapshot && currentScope
            ? locateElement(currentSnapshot.slide, currentScope)
            : null;
        if (location) {
          event.preventDefault();
          setSelection({
            elementIds: [currentScope!],
            scopeId: location.parentId,
          });
          onScopeEnter?.(location.parentId);
          return;
        }
        event.preventDefault();
        setSelection({ elementIds: [], scopeId: currentScope });
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "z") {
        event.preventDefault();
        undo(event.shiftKey);
      } else if (modifier && key === "y") {
        event.preventDefault();
        undo(true);
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [
    frameEditingId,
    keyboardHistory,
    onScopeEnter,
    previewMedia,
    onFrameEditRequest,
    setSelection,
    snapshotRef,
    undo,
  ]);

  useEffect(() => {
    if (!previewMedia) return;
    activeGesture.current?.cancel();
    marqueeCancel.current?.();
    setMarquee(null);
  }, [previewMedia]);

  useEffect(
    () => () => {
      activeGesture.current?.cancel();
      marqueeCancel.current?.();
    },
    [],
  );

  if (!renderedSnapshot)
    return (
      <div className={className} data-editor-canvas-status={status}>
        {status}
      </div>
    );

  const { deck, slide } = renderedSnapshot;
  const editingLocation = frameEditingId
    ? locateElement(slide, frameEditingId)
    : null;
  const editingElement =
    editingLocation && isEditableScope(slide, deck, frameEditingId!)
      ? editingLocation.element
      : null;
  const textEditingLocation = textEditing?.editingId
    ? locateElement(slide, textEditing.editingId)
    : null;
  const textEditingElement =
    textEditingLocation &&
    isEditableScope(slide, deck, textEditing!.editingId!) &&
    isTextElement(textEditingLocation.element)
      ? textEditingLocation.element
      : null;
  const geometry =
    previewMedia || frameEditingId || textEditing?.editingId
      ? null
      : selectionGeometry;
  const isCropping =
    !!cropFrameId &&
    selection.elementIds.length === 1 &&
    selection.elementIds[0] === cropFrameId;
  const overlayStyle: CSSProperties | undefined = geometry
    ? {
        position: "absolute",
        left: geometry.center.x - geometry.orientedWidth / 2,
        top: geometry.center.y - geometry.orientedHeight / 2,
        width: geometry.orientedWidth,
        height: geometry.orientedHeight,
        transform: selectionCssTransform(geometry),
        transformOrigin: "center",
        border: `${(isCropping ? 2 : 1) / canvasScale}px solid currentColor`,
        boxSizing: "border-box",
        color: isCropping
          ? "#111111"
          : (deck.layers.find(
              (layer) =>
                layer.id === getOwningLayer(slide, selection.scopeId!)?.id,
            )?.color ?? "#246bfe"),
        cursor: "move",
        zIndex: 1000,
        touchAction: "none",
        ["--feedback-inverse-scale" as string]: 1 / canvasScale,
      }
    : undefined;
  const handleSize = 11 / canvasScale;
  const handleStyle: CSSProperties = {
    position: "absolute",
    width: handleSize,
    height: handleSize,
    borderWidth: 1 / canvasScale,
    borderStyle: "solid",
    background: "white",
    boxSizing: "border-box",
    pointerEvents: "auto",
  };

  return (
    <div
      className={className}
      data-editor-canvas="true"
      tabIndex={-1}
      onPointerDownCapture={
        previewMedia
          ? undefined
          : (event) => {
              if (event.button !== 0 || !(event.target instanceof HTMLElement))
                return;
              if (
                event.target.closest(
                  'input, textarea, select, button, [contenteditable="true"], [data-text-editor]',
                )
              )
                return;
              event.currentTarget.focus({ preventScroll: true });
            }
      }
      data-editor-canvas-status={status}
      data-preview-media={previewMedia ? "true" : "false"}
      data-show-frame-borders={
        showFrameBorders && !previewMedia ? "true" : undefined
      }
      data-editor-scope={selection.scopeId ?? ""}
      data-selection-count={selection.elementIds.length}
      style={{
        position: "relative",
        width: deck.width * canvasScale,
        height: deck.height * canvasScale,
        overflow: previewMedia ? "hidden" : "visible",
        ["--frame-border-width" as string]: `${1 / canvasScale}px`,
        ...style,
      }}
    >
      <div
        ref={stage}
        data-editor-stage="true"
        onPointerDown={previewMedia ? undefined : canvasPointerDown}
        onDoubleClick={previewMedia ? undefined : canvasDoubleClick}
        onDragStart={(event) => event.preventDefault()}
        style={{
          position: "relative",
          width: deck.width,
          height: deck.height,
          transform: `scale(${canvasScale})`,
          transformOrigin: "top left",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <SlideRenderer
          slide={motionSourceSlide ?? slide}
          templates={renderedSnapshot.templates}
          deck={deck}
          preparedImages
          renderScale={canvasScale}
          canvasImageSampling
          deferImageUpdates={deferImageUpdates}
          editingTextId={textEditing?.editingId}
          editingMediaId={frameEditingId}
          editorOverflow={!previewMedia}
          motionState={motionState}
          editorPlayback={
            trimMedia ? "trim" : previewMedia ? "preview" : "inactive"
          }
        />
        {!previewMedia && (
          <div
            data-canvas-outside-overlay="true"
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              boxShadow: "0 0 0 100000px rgba(221, 221, 218, 0.6)",
              zIndex: 800,
            }}
          />
        )}
        {!previewMedia &&
          (guides.length > 0 || guidePreview) &&
          onPreviewGuideMove &&
          onCommitGuideMove &&
          onDeleteGuide &&
          onSnapGuide && (
            <GuidesOverlay
              guides={guides}
              preview={guidePreview}
              scale={canvasScale}
              onBeginMove={onBeginGuideMove}
              onPreviewMove={onPreviewGuideMove}
              onCommitMove={onCommitGuideMove}
              onCancelMove={onCancelGuideMove}
              onDelete={onDeleteGuide}
              onSnapGuide={onSnapGuide}
            />
          )}
        {!previewMedia &&
          textEditing &&
          textEditingElement &&
          textEditingLocation && (
            <InlineTextEditor
              deck={snapshot!.deck}
              element={textEditingElement}
              world={textEditingLocation.world}
              controller={textEditing}
            />
          )}
        {!previewMedia && editingElement && editingLocation && (
          <FrameEditorOverlay
            element={editingElement}
            world={editingLocation.world}
            intrinsic={frameEditingIntrinsic}
            scale={canvasScale}
            onMovePointerDown={(event) =>
              beginMediaContentGesture(event, "move")
            }
            onResizePointerDown={(event, handle) =>
              beginMediaContentGesture(event, "resize", handle)
            }
            onRotatePointerDown={(event) =>
              beginMediaContentGesture(event, "rotate")
            }
            onExit={() => onFrameEditRequest?.(null)}
          />
        )}
        {!previewMedia &&
          remoteSelections.map((peer) => {
            if (!peer.selectionScopeId) return null;
            let remoteGeometry;
            try {
              remoteGeometry = selectionWorldGeometry(
                slide,
                peer.selection,
                peer.selectionScopeId,
              );
            } catch {
              return null;
            }
            return (
              <div
                key={peer.id}
                data-remote-selection={peer.id}
                style={{
                  position: "absolute",
                  left:
                    remoteGeometry.center.x - remoteGeometry.orientedWidth / 2,
                  top:
                    remoteGeometry.center.y - remoteGeometry.orientedHeight / 2,
                  width: remoteGeometry.orientedWidth,
                  height: remoteGeometry.orientedHeight,
                  transform: selectionCssTransform(remoteGeometry),
                  transformOrigin: "center",
                  border: `${1 / canvasScale}px solid ${peer.color}`,
                  boxSizing: "border-box",
                  pointerEvents: "none",
                  zIndex: 950,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: -22 / canvasScale,
                    padding: `${2 / canvasScale}px ${5 / canvasScale}px`,
                    background: peer.color,
                    color: "white",
                    fontSize: 10 / canvasScale,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                  }}
                >
                  {peer.displayName}
                </span>
              </div>
            );
          })}
        {!previewMedia && marquee && (
          <div
            className={`marquee${marquee.crossing ? " crossing" : ""}`}
            data-selection-mode={marquee.touching ? "touching" : "contained"}
            style={{
              position: "absolute",
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
              pointerEvents: "none",
              zIndex: 900,
            }}
          >
            {marquee.crossing && (
              <svg width="100%" height="100%" aria-hidden="true">
                <rect
                  width="100%"
                  height="100%"
                  fill="none"
                  stroke="white"
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  className="marquee-ants"
                  width="100%"
                  height="100%"
                  fill="none"
                  stroke="#25364a"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        )}
        {geometry && overlayStyle && (
          <div
            className={`selection-bounds ${isCropping ? "crop-selection" : ""}`}
            data-selection-overlay="true"
            onPointerDown={selectionPointerDown}
            style={overlayStyle}
          >
            {resizeHandles.map((handle) => (
              <div
                key={handle}
                className={`handle resize handle-${handle}`}
                data-selection-handle={handle}
                onPointerDown={(event) => beginResize(event, handle)}
                style={{
                  ...handleStyle,
                  ...(!isCropping ? handlePositions[handle] : {}),
                  ...(isCropping
                    ? {
                        width:
                          (handle.length === 2
                            ? 16
                            : handle === "n" || handle === "s"
                              ? 28
                              : 6) / canvasScale,
                        height:
                          (handle.length === 2
                            ? 16
                            : handle === "n" || handle === "s"
                              ? 6
                              : 28) / canvasScale,
                      }
                    : {}),
                  cursor: resizeHandleCursor(handle, [
                    (geometry.corners[1].x - geometry.corners[0].x) /
                      geometry.orientedWidth,
                    (geometry.corners[1].y - geometry.corners[0].y) /
                      geometry.orientedWidth,
                    (geometry.corners[3].x - geometry.corners[0].x) /
                      geometry.orientedHeight,
                    (geometry.corners[3].y - geometry.corners[0].y) /
                      geometry.orientedHeight,
                    0,
                    0,
                  ]),
                  transform: "translate(-50%, -50%)",
                }}
              />
            ))}
            {!isCropping && (
              <>
                <div
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: -28 / canvasScale,
                    width: 0,
                    height: 20 / canvasScale,
                    borderLeft: `${1 / canvasScale}px solid currentColor`,
                    pointerEvents: "none",
                  }}
                />
                <div
                  data-rotation-handle="true"
                  onPointerDown={beginRotation}
                  style={{
                    ...handleStyle,
                    left: "50%",
                    top: -32 / canvasScale,
                    borderRadius: "50%",
                    cursor: "grab",
                    transform: "translate(-50%, -50%)",
                  }}
                />
              </>
            )}
          </div>
        )}
        <div
          data-gesture-guide-x="true"
          style={{
            display: "none",
            position: "absolute",
            top: 0,
            bottom: 0,
            width: 0,
            borderLeft: `${1 / canvasScale}px solid #246bfe`,
            pointerEvents: "none",
            zIndex: 1100,
          }}
        />
        <div
          data-gesture-guide-y="true"
          style={{
            display: "none",
            position: "absolute",
            left: 0,
            right: 0,
            height: 0,
            borderTop: `${1 / canvasScale}px solid #246bfe`,
            pointerEvents: "none",
            zIndex: 1100,
          }}
        />
        <div
          data-gesture-measurement="true"
          style={{
            display: "none",
            position: "absolute",
            transform: "translate(-50%, -100%)",
            padding: `${3 / canvasScale}px ${6 / canvasScale}px`,
            borderRadius: 4 / canvasScale,
            background: "var(--km-bg-surface, #fff)",
            color: "var(--km-text-primary, #0f172a)",
            border: `${1 / canvasScale}px solid var(--km-border-default, #cbd5e1)`,
            boxShadow: "var(--km-shadow-sm)",
            fontSize: 11 / canvasScale,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 1200,
          }}
        />
      </div>
    </div>
  );
}
