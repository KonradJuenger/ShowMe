import { slidePreview, storeSlidePreview } from "./slidePreviewCache";
import { flushEffectSurfaces } from "./effectRuntime";
import { waitForSlideImages } from "./audienceImagePreparation";
import { useImageGeneration } from "./useImageGeneration";
import { useDisplayDensity } from "./useDisplayDensity";
import { MotionSidebar } from "./MotionSidebar";
import { EffectsPanel } from "./EffectsPanel";
import { TemplateRail, TemplatePageControls } from "./editor/TemplateControls";
import { ImageReadinessStatus } from "./ImageReadinessStatus";
import { useMotionWorkspace, MotionDock } from "./MotionWorkspace";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { findElement, getChildren, resolveEditableScope } from "../core/scene";
import { isMediaContent } from "../core/media";
import { defaultDragSnapSettings } from "../core/dragSnapping";
import {
  frameCssTransform,
  frameCssOrigin,
  type Element,
} from "../core/element";
import type { EditorSnapshot } from "../core/editorCommands";
import type { DocumentProjection } from "../core/documentProjection";
import type { InteractionPreview } from "../core/collaboration/protocol";
import { reconcilePresentationSequence } from "../core/presentationSequence";
import { slideHierarchyRows } from "../core/slideHierarchy";
import {
  readSelectionMode,
  saveSelectionMode,
} from "../core/editorPreferences";
import { platform } from "../platform";
import {
  clearContextMenuSuppression,
  isContextMenuOpen,
  suppressContextMenuTemporarily,
} from "../platform/contextMenu";
import { editorTransport } from "../platform/editorTransport";
import { EditorCanvasSurface } from "./EditorCanvas";
import { EditorCommandController } from "./EditorCommandController";
import { ContextMenuController } from "./ContextMenuController";
import { LayersPanel } from "./LayersPanel";
import { AssetLibrary } from "./AssetLibrary";
import type { CanvasSelection } from "./editorCanvasCoordinator";
import { SlideRenderer } from "./SlideRenderer";
import { useEditorSession } from "./useEditorSession";
import { useDocumentPersistence } from "./useDocumentPersistence";
import {
  EditorSlideOverview,
  EditorSlideRail,
  type SlideRailRow,
} from "./editor/EditorSlideRail";
import { EditorToolbar } from "./editor/EditorToolbar";
import { DisplacedPresentationNotice } from "./DisplacedPresentationNotice";
import { useSelectionActions } from "./editor/useSelectionActions";
import { useLayerActions } from "./editor/useLayerActions";
import {
  useMediaActions,
  type FrameEditingState,
} from "./editor/useMediaActions";
import { useTextEditing } from "./editor/useTextEditing";
import { useTextActions } from "./editor/useTextActions";
import { resolveGuideSet, resolveGuides, type GuideAxis } from "../core/guides";
import { useGuideEditing } from "./editor/useGuideEditing";
import { useSpeakerNotes } from "./editor/useSpeakerNotes";
import { useSlideNavigation } from "./useSlideNavigation";
import { Rulers } from "./Rulers";
import { LayoutGuidesDialog } from "./LayoutGuidesDialog";
import { usePresenterController } from "./usePresenterController";
import { PresentationDisplaySetup } from "./PresentationDisplaySetup";
import { EditorPresenterDock } from "./editor/EditorPresenterDock";
import { EditorSettings } from "./EditorSettings";
import { RightSidebar } from "./RightSidebar";
import { VideoTrimOverlay } from "./VideoTrimOverlay";
import { EffectErrorMessage } from "./EffectErrorMessage";

const productionTransport = editorTransport(platform);
const EMPTY_SELECTION: CanvasSelection = {
  elementIds: [],
  scopeId: null,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function EditorSlideThumbnail({
  documentId,
  slideId,
  suspended,
}: {
  documentId: string;
  slideId: string;
  suspended: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const generation = useImageGeneration(documentId);
  const density = useDisplayDensity();
  const [fontRevision, setFontRevision] = useState(0);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [composed, setComposed] = useState<{ key: string; url: string } | null>(
    null,
  );
  const [projection, setProjection] = useState<DocumentProjection | null>(null);
  const [thumbnailScale, setThumbnailScale] = useState({ x: 0.08, y: 0.08 });

  useEffect(() => {
    if (suspended || !platform.renderProjection) return;
    let live = true;
    let serial = 0;
    let templateId: string | null = null;
    const reload = () => {
      const request = ++serial;
      void platform.renderProjection!(documentId, slideId)
        .then((value) => {
          if (live && request === serial) {
            templateId = value.deck.slideMeta[slideId]?.templateId ?? null;
            setProjection(value);
          }
        })
        .catch(() => {
          if (live && request === serial) setProjection(null);
        });
    };
    const unsubscribe = platform.onDocumentAccepted?.((event) => {
      if (event.documentId !== documentId) return;
      if (
        event.accepted.operations.some(
          (operation) =>
            !("slideId" in operation) ||
            ("slideId" in operation &&
              (operation.slideId === slideId ||
                operation.slideId === templateId) &&
              !["slide.notes.set", "slide.reorder"].includes(operation.type)),
        )
      )
        reload();
    });
    const invalidated = platform.onDocumentInvalidated?.((event) => {
      if (event.documentId !== documentId) return;
      // Asset bytes can change while the slide document stays identical. Force
      // cached thumbnails to recapture when external Library content arrives.
      setResourceRevision((value) => value + 1);
      reload();
    });
    reload();
    return () => {
      live = false;
      unsubscribe?.();
      invalidated?.();
    };
  }, [documentId, slideId, suspended]);

  const thumbnailWidth = projection?.deck.width;
  const thumbnailHeight = projection?.deck.height;
  useLayoutEffect(() => {
    const node = frame.current;
    if (!node || !thumbnailWidth || !thumbnailHeight) return;
    const resize = () =>
      setThumbnailScale({
        x: Math.max(0.001, node.clientWidth / thumbnailWidth),
        y: Math.max(0.001, node.clientHeight / thumbnailHeight),
      });
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [thumbnailWidth, thumbnailHeight]);

  const previewKey = projection
    ? JSON.stringify([
        "native-canonical-v1",
        documentId,
        projection.deck,
        projection.slide,
        projection.templates,
        thumbnailScale,
        density,
        fontRevision,
        resourceRevision,
        generation.slice(generation.lastIndexOf(":") + 1),
      ])
    : "";
  const cached =
    composed?.key === previewKey ? composed.url : slidePreview(previewKey);
  const lastThumbnail = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (cached) lastThumbnail.current = cached;
  }, [cached]);
  const displayedThumbnail = cached ?? lastThumbnail.current ?? composed?.url;
  useEffect(() => {
    const loaded = () => setFontRevision((value) => value + 1);
    document.fonts.addEventListener("loadingdone", loaded);
    return () => document.fonts.removeEventListener("loadingdone", loaded);
  }, []);
  useEffect(() => {
    const node = frame.current;
    if (!node || !projection || !platform.capturePreview || cached || suspended)
      return;
    let live = true;
    let running = false;
    const abort = new AbortController();
    const capture = async () => {
      if (running || !live) return;
      const rect = node.getBoundingClientRect();
      if (
        rect.width < 1 ||
        rect.height < 1 ||
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > innerWidth ||
        rect.bottom > innerHeight
      )
        return;
      running = true;
      try {
        await Promise.race([
          waitForSlideImages(node, abort.signal),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        await document.fonts.ready;
        if (!live || !(await flushEffectSurfaces(node))) return;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (!live) return;
        const current = node.getBoundingClientRect();
        if (
          current.left < 0 ||
          current.top < 0 ||
          current.right > innerWidth ||
          current.bottom > innerHeight
        )
          return;
        const url = await platform.capturePreview!(
          projection,
          Math.ceil(current.width * density),
          Math.ceil(current.height * density),
        );
        if (url && live) {
          const image = new Image();
          image.src = url;
          await image.decode();
          if (!live) return;
          storeSlidePreview(previewKey, url);
          setComposed({ key: previewKey, url });
        }
      } catch {
        /* Canonical live rendering is the optional-capture fallback. */
      } finally {
        running = false;
      }
    };
    const observer = new IntersectionObserver(() => {
      void capture();
    });
    observer.observe(node);
    void capture();
    return () => {
      live = false;
      abort.abort();
      observer.disconnect();
    };
  }, [projection, previewKey, cached, suspended, density]);

  return (
    <div
      ref={frame}
      className="empty-thumb"
      style={{
        position: "relative",
        aspectRatio: projection
          ? `${projection.deck.width} / ${projection.deck.height}`
          : undefined,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {displayedThumbnail ? (
        <img
          src={displayedThumbnail}
          alt=""
          draggable={false}
          style={{ display: "block", width: "100%", height: "100%" }}
        />
      ) : (
        projection && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: projection.deck.width,
              height: projection.deck.height,
              transform: `scale(${thumbnailScale.x}, ${thumbnailScale.y})`,
              transformOrigin: "top left",
              pointerEvents: "none",
            }}
          >
            <SlideRenderer
              slide={projection.slide}
              deck={projection.deck}
              templates={projection.templates}
              staticVideo
              preparedImages
              renderScale={thumbnailScale}
            />
          </div>
        )
      )}
    </div>
  );
}

export function Editor({
  deckId,
  onHome,
  onNewPresentation,
  onPresentationOpened,
  initialStatus = "",
}: {
  deckId: string;
  onHome: () => void;
  onNewPresentation?: (name?: string) => Promise<void>;
  onPresentationOpened?: (
    document: import("../core/documentSummary").DocumentSummary,
    notice?: string,
  ) => void;
  initialStatus?: string;
}) {
  const controller = useEditorSession(deckId, productionTransport);
  const [selection, setSelection] = useState<CanvasSelection>(EMPTY_SELECTION);
  const [insertionScopeId, setInsertionScopeId] = useState<string | null>(null);
  const insertionScopeRef = useRef(insertionScopeId);
  insertionScopeRef.current = insertionScopeId;
  const getInsertionScopeId = useCallback(() => insertionScopeRef.current, []);
  const [collaborationStatus, setCollaborationStatus] = useState<
    import("../platform/api").CollaborationStatus | null
  >(null);
  const remotePreviewElements = useRef(new Map<string, Set<string>>());
  const lastPreviewAt = useRef(0);
  const [localPreviewFrames, setLocalPreviewFrames] = useState<
    Record<string, Element["frame"]>
  >({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [localError, setLocalError] = useState(initialStatus);
  const stage = useRef<HTMLDivElement>(null);
  const mediaButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [navWidth, setNavWidth] = useState(194);
  const [railContentWidth, setRailContentWidth] = useState(178);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const [overview, setOverview] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collaborationEnabled, setCollaborationEnabled] = useState(() => {
    try {
      return localStorage.getItem("showme.collaboration-enabled") === "true";
    } catch {
      return false;
    }
  });
  const [notesOpen, setNotesOpen] = useState(false);
  const [fitScale, setFitScale] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panGesture = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const spaceHeld = useRef(false);
  const [selectionMode, setSelectionMode] = useState(readSelectionMode);
  const [snapping, setSnapping] = useState(true);
  const [dragSnapping, setDragSnapping] = useState(defaultDragSnapSettings);
  const [snapToObjects, setSnapToObjects] = useState(true);
  const [snapToGuides, setSnapToGuides] = useState(true);
  const [snapToSlide, setSnapToSlide] = useState(true);
  const [showRulers, setShowRulers] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showFrameBorders, setShowFrameBorders] = useState(false);
  const [layoutGuidesOpen, setLayoutGuidesOpen] = useState(false);
  const [guidePreview, setGuidePreview] = useState<{
    axis: GuideAxis;
    position: number;
  } | null>(null);
  const [play, setPlay] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [frameEditing, setFrameEditing] = useState<FrameEditingState | null>(
    null,
  );
  const [cropping, setCropping] = useState<string | null>(null);
  const [trimVideoId, setTrimVideoId] = useState<string | null>(null);

  const reportError = useCallback((cause: unknown) => {
    setLocalError(
      `Error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }, []);

  const textEditing = useTextEditing({
    controller,
    selection,
    setSelection,
    setFrameEditing,
    onError: reportError,
  });

  const persistence = useDocumentPersistence({
    deckId,
    snapshotRef: controller.snapshotRef,
    refreshProjection: controller.refreshProjection,
    onError: reportError,
    flush: controller.flush,
  });

  const notesEditing = useSpeakerNotes({
    controller,
    onStatus: setLocalError,
  });

  const presenter = usePresenterController();

  const snapshot = controller.snapshot;
  const motionWorkspace = useMotionWorkspace(
    controller,
    selection,
    reportError,
    (elementId, parentId) =>
      setSelection({ elementIds: [elementId], scopeId: parentId }),
  );
  const flushSpeakerNotes = notesEditing.flush;
  useEffect(() => {
    if (motionWorkspace.open && notesOpen) {
      setNotesOpen(false);
      void flushSpeakerNotes().catch(reportError);
    }
  }, [motionWorkspace.open, notesOpen, flushSpeakerNotes, reportError]);
  const scale = fitScale * zoom;
  const status = localError || controller.status;
  const defaultScopeId = snapshot?.slide.nodes[0]?.id ?? null;

  useEffect(() => {
    if (!platform.onCollaborationStatus) return;
    const update = (value: import("../platform/api").CollaborationStatus) =>
      setCollaborationStatus(value);
    const unsubscribe = platform.onCollaborationStatus(update);
    void platform
      .collaborationStatus?.()
      .then(update)
      .catch(() => {});
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!platform.collaborationSelection) return;
    const publishSelection = platform.collaborationSelection;
    const timer = setTimeout(() => {
      void publishSelection(
        snapshot?.slide.id ?? null,
        selection.scopeId,
        selection.elementIds,
      ).catch(() => {});
    }, 30);
    return () => clearTimeout(timer);
  }, [selection.elementIds, selection.scopeId, snapshot?.slide.id]);

  useEffect(() => {
    if (!platform.onCollaborationPreview) return;
    const restoreActor = (actorId: string) => {
      const ids = remotePreviewElements.current.get(actorId);
      if (!ids) return;
      const current = controller.snapshotRef.current;
      const root = stage.current;
      if (current && root)
        for (const id of ids) {
          const frame = findElement(current.slide, id)?.frame;
          const target = root.querySelector<HTMLElement>(
            `[data-element-id="${CSS.escape(id)}"]`,
          );
          if (!frame || !target) continue;
          target.style.left = `${frame.x}px`;
          target.style.top = `${frame.y}px`;
          target.style.width = `${frame.width}px`;
          target.style.height = `${frame.height}px`;
          target.style.transformOrigin = frameCssOrigin(frame);
          target.style.transform = frameCssTransform(frame);
        }
      remotePreviewElements.current.delete(actorId);
    };
    return platform.onCollaborationPreview(({ actorId, preview }) => {
      restoreActor(actorId);
      if (
        !preview ||
        preview.slideId !== controller.snapshotRef.current?.slide.id
      )
        return;
      const root = stage.current;
      if (!root) return;
      const ids = new Set<string>();
      for (const item of preview.elements) {
        const target = root.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(item.id)}"]`,
        );
        if (!target) continue;
        const { frame } = item;
        target.style.left = `${frame.x}px`;
        target.style.top = `${frame.y}px`;
        target.style.width = `${frame.width}px`;
        target.style.height = `${frame.height}px`;
        target.style.transformOrigin = frameCssOrigin(frame);
        target.style.transform = frameCssTransform(frame);
        ids.add(item.id);
      }
      if (ids.size) remotePreviewElements.current.set(actorId, ids);
    });
  }, [controller.snapshotRef]);

  const sendTransformPreview = useCallback(
    (next: EditorSnapshot, elementIds: readonly string[]) => {
      const elements = elementIds.flatMap((id) => {
        const element = findElement(next.slide, id);
        return element ? [{ id, frame: element.frame }] : [];
      });
      if (elements.length)
        setLocalPreviewFrames(
          Object.fromEntries(
            elements.map(({ id, frame }) => [id, structuredClone(frame)]),
          ),
        );
      if (!platform.collaborationPreview || !elements.length) return;
      const now = performance.now();
      if (now - lastPreviewAt.current < 40) return;
      lastPreviewAt.current = now;
      const preview: InteractionPreview = {
        slideId: next.slide.id,
        elements: elements.slice(0, 100),
      };
      void platform.collaborationPreview(preview).catch(() => {});
    },
    [],
  );
  const clearTransformPreview = useCallback(() => {
    setLocalPreviewFrames({});
    void platform.collaborationClearPreview?.().catch(() => {});
  }, []);

  useEffect(() => {
    if (controller.lastError) clearTransformPreview();
  }, [clearTransformPreview, controller.lastError]);

  useEffect(() => {
    setLocalPreviewFrames({});
  }, [snapshot]);

  useEffect(() => {
    const slideId = snapshot?.slide.id;
    if (!slideId) return;
    setSelection({ elementIds: [], scopeId: defaultScopeId });
    setInsertionScopeId(defaultScopeId);
    setFrameEditing(null);
    setCropping(null);
    setTrimVideoId(null);
    setMediaOpen(false);
    setPlay(false);
  }, [snapshot?.slide.id, defaultScopeId]);

  useEffect(() => {
    if (!snapshot) return;
    setInsertionScopeId((current) => {
      if (!snapshot.deck.layers.some((layer) => !layer.hidden && !layer.locked))
        return null;
      return resolveEditableScope(
        snapshot.slide,
        snapshot.deck,
        current && getChildren(snapshot.slide, current) ? current : null,
      );
    });
  }, [snapshot]);

  useEffect(() => {
    if (!frameEditing) return;
    if (
      selection.elementIds.length !== 1 ||
      selection.elementIds[0] !== frameEditing.elementId
    )
      setFrameEditing(null);
  }, [frameEditing, selection.elementIds]);

  useEffect(() => {
    if (!cropping) return;
    if (
      selection.elementIds.length !== 1 ||
      selection.elementIds[0] !== cropping
    )
      setCropping(null);
  }, [cropping, selection.elementIds]);

  useLayoutEffect(() => {
    if (!snapshot) return;
    const resize = () => {
      const node = stage.current;
      if (node)
        setFitScale(
          Math.max(
            0.08,
            Math.min(
              (node.clientWidth - 72) / snapshot.deck.width,
              (node.clientHeight - 72) / snapshot.deck.height,
            ),
          ),
        );
      const list = node
        ?.closest(".editor")
        ?.querySelector<HTMLElement>(".slide-rail .virtual-list");
      if (list) setRailContentWidth(list.clientWidth);
    };
    const observer = new ResizeObserver(resize);
    if (stage.current) observer.observe(stage.current);
    const list = stage.current
      ?.closest(".editor")
      ?.querySelector<HTMLElement>(".slide-rail .virtual-list");
    if (list) observer.observe(list);
    resize();
    return () => observer.disconnect();
  }, [navOpen, snapshot]);

  useEffect(() => {
    if (platform.isTest || window.desktop) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (!controller.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [controller]);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setLocalError("");
      try {
        await task();
      } catch (cause) {
        reportError(cause);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [reportError],
  );

  const prepareSlideChange = useCallback(async () => {
    await textEditing.exit();
    await notesEditing.flush();
    await controller.flush();
  }, [controller, notesEditing, textEditing]);

  const activateSlide = useCallback(
    async (slideId: string) => {
      setSelection(EMPTY_SELECTION);
      await controller.loadProjection(slideId);
    },
    [controller],
  );

  const projectSlide = useCallback(
    (slideId: string) => productionTransport.projection(deckId, slideId),
    [deckId],
  );

  const { selectedSlides, selectSlide, addSlide } = useSlideNavigation({
    deckId,
    controller,
    run,
    prepareCurrent: prepareSlideChange,
    activateSlide,
    projectSlide,
    isBusy: () => busyRef.current,
  });

  const getInsertionWorldPoint = useCallback(() => {
    const current = controller.snapshotRef.current;
    const currentScale = Math.max(scale, 1e-9);
    return {
      x: (current?.deck.width ?? 1920) / 2 - pan.x / currentScale,
      y: (current?.deck.height ?? 1080) / 2 - pan.y / currentScale,
    };
  }, [controller.snapshotRef, pan.x, pan.y, scale]);

  const structuralActions = useSelectionActions({
    controller,
    selection,
    getInsertionScopeId,
    setSelection,
    getInsertionWorldPoint,
    run,
  });
  const layerActions = useLayerActions({
    controller,
    selection,
    setInsertionScopeId,
    setSelection,
    run,
  });
  const textActions = useTextActions({
    controller,
    getInsertionScopeId,
    setSelection,
    getInsertionWorldPoint,
    run,
  });
  const mediaActions = useMediaActions({
    controller,
    selection,
    getInsertionScopeId,
    setSelection,
    getInsertionWorldPoint,
    run,
    setMediaOpen,
    setMediaRefresh,
    frameEditing,
    setFrameEditing,
  });

  const guideEditing = useGuideEditing({
    controller,
    onStatus: setLocalError,
    snapping,
    snapToGuides,
    snapToSlide,
    snapToObjects,
    scale,
  });

  const selectedElement =
    snapshot && selection.elementIds.length === 1
      ? findElement(snapshot.slide, selection.elementIds[0])
      : null;
  const selectedMedia =
    selectedElement && isMediaContent(selectedElement.content)
      ? { ...selectedElement, content: selectedElement.content }
      : null;
  const selectedMediaFrame = selectedMedia
    ? (localPreviewFrames[selectedMedia.id] ?? selectedMedia.frame)
    : null;
  const trimElement =
    snapshot && trimVideoId ? findElement(snapshot.slide, trimVideoId) : null;
  const trimVideo =
    trimElement?.content?.type === "video" ? trimElement.content : null;

  const fitCanvas = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const setActualSize = useCallback(() => {
    setZoom(1 / Math.max(fitScale, 1e-9));
    setPan({ x: 0, y: 0 });
  }, [fitScale]);

  const zoomAt = useCallback(
    (nextZoom: number, clientX?: number, clientY?: number) => {
      const next = clamp(nextZoom, 0.1, 8);
      if (clientX === undefined || clientY === undefined || !stage.current) {
        setZoom(next);
        return;
      }
      const rect = stage.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const currentScale = Math.max(scale, 1e-9);
      const nextScale = fitScale * next;
      const worldX = (clientX - centerX - pan.x) / currentScale;
      const worldY = (clientY - centerY - pan.y) / currentScale;
      setPan({
        x: clientX - centerX - worldX * nextScale,
        y: clientY - centerY - worldY * nextScale,
      });
      setZoom(next);
    },
    [fitScale, pan.x, pan.y, scale],
  );

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) clearContextMenuSuppression();
    if (
      event.button !== 1 &&
      event.button !== 2 &&
      !(event.button === 0 && spaceHeld.current)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    panGesture.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
      moved: false,
    };
    setPanning(true);
  };

  const updatePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - gesture.clientX;
    const dy = event.clientY - gesture.clientY;
    if (Math.hypot(dx, dy) > 3) gesture.moved = true;
    setPan({
      x: gesture.panX + dx,
      y: gesture.panY + dy,
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    panGesture.current = null;
    if (gesture.moved) suppressContextMenuTemporarily();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPanning(false);
  };

  useEffect(() => {
    const sequenceSpace = (event: KeyboardEvent) => {
      if (
        !motionWorkspace.open ||
        isContextMenuOpen() ||
        event.code !== "Space" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest(
          "input, textarea, select, [role='dialog'], [role='menu'], [popover]:popover-open",
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      spaceHeld.current = false;
      if (!event.repeat && motionWorkspace.motion) motionWorkspace.next();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = true;
      const target = event.target as HTMLElement | null;

      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "s") {
        event.preventDefault();
        // Finish Inspector/text drafts before taking the saved snapshot.
        target?.blur();
        void (event.shiftKey ? persistence.saveAs() : persistence.save()).catch(
          reportError,
        );
        return;
      }
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable)
      )
        return;
      if (modifier && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        zoomAt(zoom * 1.15);
      } else if (modifier && event.key === "-") {
        event.preventDefault();
        zoomAt(zoom / 1.15);
      } else if (modifier && event.key === "0") {
        event.preventDefault();
        fitCanvas();
      } else if (modifier && event.key === "1") {
        event.preventDefault();
        setActualSize();
      } else if (!modifier && key === "r") {
        event.preventDefault();
        setShowRulers((value) => !value);
      } else if (
        !modifier &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        const current = controller.snapshotRef.current;
        if (!current) return;
        const orderedIds = slideHierarchyRows(current.deck).map(
          (row) => row.id,
        );
        const index = orderedIds.indexOf(current.slide.id);
        const nextIndex = clamp(
          index + (event.key === "ArrowDown" ? 1 : -1),
          0,
          orderedIds.length - 1,
        );
        const nextId = orderedIds[nextIndex];
        if (nextId && nextId !== current.slide.id) {
          event.preventDefault();
          void selectSlide(nextId);
        }
      } else if (event.code === "Space") {
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keydown", sequenceSpace, true);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", sequenceSpace, true);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [
    controller.snapshotRef,
    fitCanvas,
    motionWorkspace,
    persistence,
    reportError,
    selectSlide,
    setActualSize,
    zoom,
    zoomAt,
  ]);

  const toggleMedia = useCallback(() => {
    setInspectorOpen(true);
    setMediaOpen(true);
  }, []);

  const closeMediaBrowser = useCallback(() => {
    setMediaOpen(false);
    requestAnimationFrame(() => mediaButton.current?.focus());
  }, []);

  useEffect(() => {
    if (!mediaOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeMediaBrowser();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [closeMediaBrowser, mediaOpen]);

  if (!snapshot)
    return (
      <main className="welcome">
        <p role={status.startsWith("Error:") ? "alert" : "status"}>
          {status.startsWith("Error:") ? (
            <EffectErrorMessage message={status} />
          ) : (
            status
          )}
        </p>
        {!!controller.lastError && (
          <button
            onClick={() => {
              setLocalError("");
              void controller.loadProjection().catch(reportError);
            }}
          >
            Retry
          </button>
        )}
        <button onClick={onHome}>Back</button>
      </main>
    );

  const { deck, slide } = snapshot;
  const editingTemplate = deck.templateIds.includes(slide.id);
  const applyTemplateChange = async (
    change: (current: EditorSnapshot) => EditorSnapshot,
  ) => {
    await run(async () => {
      await prepareSlideChange();
      const current = controller.snapshotRef.current;
      if (current) controller.apply(change(current));
      await controller.flush();
    });
  };
  const activateTemplatePage = async (id: string) => {
    await prepareSlideChange();
    setNotesOpen(false);
    motionWorkspace.setOpen(false);
    await activateSlide(id);
  };
  const orderedSlideIds = slideHierarchyRows(deck).map((row) => row.id);
  const slideNumbers = new Map<string, number>();
  let slideNumber = 0;
  for (const id of orderedSlideIds) {
    if (!deck.slideMeta[id].hidden) slideNumber++;
    slideNumbers.set(id, slideNumber);
  }
  const localActorId = collaborationStatus?.hosted
    ? "host"
    : (collaborationStatus?.actorId ?? null);
  const presencePeers = (collaborationStatus?.peers ?? []).filter(
    (peer) => peer.id !== localActorId,
  );
  const remoteSelections = presencePeers.filter(
    (peer) =>
      peer.activeSlideId === slide.id &&
      peer.selectionScopeId &&
      peer.selection.length > 0,
  );
  const railRows: SlideRailRow[] = [];
  let previousSection = "";
  deck.slideIds.forEach((id, index) => {
    const section = deck.slideMeta[id]?.section ?? "";
    if (section && section !== previousSection) {
      let count = 0;
      for (
        let cursor = index;
        cursor < deck.slideIds.length &&
        deck.slideMeta[deck.slideIds[cursor]]?.section === section;
        cursor++
      )
        count++;
      railRows.push({ kind: "section", section, key: id, count });
    }
    if (!section || !collapsedSections.has(section))
      railRows.push({ kind: "slide", id });
    previousSection = section;
  });

  const slideButton = (id: string, grid = false) => {
    const index = orderedSlideIds.indexOf(id);
    const meta = deck.slideMeta[id] ?? {
      templateId: null,
      name: "",
      section: "",
      hidden: false,
    };
    return (
      <button
        key={id}
        type="button"
        data-context-target="slide"
        data-slide-id={id}
        className={`${grid ? "overview-thumb" : "slide-thumb"} ${id === slide.id ? "active" : ""} ${selectedSlides.includes(id) ? "multi-selected" : ""} ${meta.hidden ? "hidden-slide" : ""}`}
        aria-label={
          meta.hidden
            ? `Skipped slide ${index + 1}`
            : `Slide ${slideNumbers.get(id)}`
        }
        onClick={(event) => {
          void selectSlide(id, {
            shift: event.shiftKey,
            toggle: event.ctrlKey || event.metaKey,
          });
          if (grid && !(event.shiftKey || event.ctrlKey || event.metaKey))
            setOverview(false);
        }}
        onDoubleClick={(event) => {
          if (grid) return;
          event.preventDefault();
          event.stopPropagation();
          void selectSlide(id)
            .then(() => fitCanvas())
            .catch(reportError);
        }}
      >
        {meta.templateId && (
          <small className="slide-template-label">
            {deck.templateMeta[meta.templateId]?.label}
          </small>
        )}
        <EditorSlideThumbnail
          documentId={deckId}
          slideId={id}
          suspended={busy}
        />
        {presencePeers
          .filter((peer) => peer.activeSlideId === id)
          .map((peer, position) => (
            <span
              key={peer.id}
              title={`${peer.displayName} is on this slide`}
              style={{
                position: "absolute",
                top: 5,
                right: 6 + position * 12,
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: "1px solid #fff",
                background: peer.color,
                zIndex: 3,
              }}
            />
          ))}
        <span className="slide-index">{slideNumbers.get(id)}</span>
      </button>
    );
  };

  const editorClass = `editor ${navOpen ? "" : "nav-collapsed"} ${inspectorOpen ? "" : "inspector-collapsed"} ${panning ? "is-panning" : ""}`;

  return (
    <main
      className={editorClass}
      data-editor="true"
      data-document-id={deckId}
      data-editor-busy={busy}
      data-active-slide={slide.id}
      data-selection-count={selection.elementIds.length}
      inert={busy}
      style={
        { "--nav-width": navOpen ? `${navWidth}px` : "0px" } as CSSProperties
      }
    >
      <ContextMenuController onError={reportError} slidesOnly />
      <EditorCommandController
        snapshotRef={controller.snapshotRef}
        selection={selection}
        onSelectionChange={setSelection}
        actions={structuralActions}
        mediaActions={{
          replace: () => mediaActions.replaceMedia(),
          setRule: (id, rule) => mediaActions.setRule(id, rule),
          editFrame: (id) => mediaActions.beginFrameEdit(id),
          reset: (id) => mediaActions.reset(id),
        }}
        textEditing={textEditing}
        viewActions={{
          showRulers,
          setShowRulers,
          clearGuides: guideEditing.clearAllGuides,
        }}
        busy={busy}
        onError={reportError}
      />

      <DisplacedPresentationNotice
        documentId={deckId}
        settingsOpen={settingsOpen}
        onMove={persistence.moveToPresentationsFolder}
        onSavePortable={persistence.savePortable}
        onError={reportError}
      />
      <EditorToolbar
        onNewPresentation={onNewPresentation}
        onPresentationOpened={onPresentationOpened}
        deckId={deckId}
        deckName={deck.name}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        flushTransactions={controller.flush}
        onError={reportError}
        presentationSetup={
          <PresentationDisplaySetup
            displays={presenter.displays}
            onAssign={presenter.assignDisplays}
            disabled={busy || !!presenter.state}
          />
        }
        navOpen={navOpen}
        onToggleNav={() => setNavOpen((value) => !value)}
        canUndo={controller.canUndo}
        canRedo={controller.canRedo}
        onUndo={() => controller.undo(false)}
        onRedo={() => controller.undo(true)}
        onInsert={(type) => {
          if (type === "text") {
            void textEditing.exit().then(() => textActions.insertText());
            return;
          }
          if (type === "frame")
            void textEditing.exit().then(() => structuralActions.insertFrame());
        }}
        mediaButton={mediaButton}
        mediaOpen={mediaOpen}
        frameEditing={!!frameEditing}
        onToggleMedia={toggleMedia}
        fileInput={fileInput}
        replaceInput={replaceInput}
        onImportFiles={(files) => void mediaActions.importFiles(files)}
        onReplaceMedia={(files) => void mediaActions.replaceMedia(files)}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        busy={busy}
        onPresent={() =>
          run(async () => {
            await textEditing.exit();
            await notesEditing.flush();
            await controller.flush();
            const current = controller.snapshotRef.current;
            if (!current) return;
            if (current.deck.templateIds.includes(current.slide.id)) return;
            const sequence = reconcilePresentationSequence(
              current.deck,
              current.slide.id,
            );
            await presenter.start({
              deckId,
              slideIds: sequence.slideIds,
              index: sequence.index,
            });
          })
        }
        onSave={async () => {
          await persistence.save();
        }}
        onSaveAs={async () => {
          await persistence.saveAs();
        }}
        editingEnabled
        collaborationEnabled={collaborationEnabled}
        onCollaborationEnabledChange={(enabled) => {
          localStorage.setItem("showme.collaboration-enabled", String(enabled));
          setCollaborationEnabled(enabled);
        }}
        inspectorEnabled
        presentEnabled={!editingTemplate}
      />

      <EditorSlideRail
        templates={
          <TemplateRail
            snapshot={snapshot}
            busy={busy}
            thumbnail={(id) => (
              <EditorSlideThumbnail
                documentId={deckId}
                slideId={id}
                suspended={busy}
              />
            )}
            apply={applyTemplateChange}
            activate={activateTemplatePage}
            onError={reportError}
          />
        }
        rows={railRows}
        slideMeta={deck.slideMeta}
        contentWidth={railContentWidth}
        slideAspectRatio={deck.width / deck.height}
        renderSlide={(id) => slideButton(id)}
        collapsedSections={collapsedSections}
        setCollapsedSections={setCollapsedSections}
        navWidth={navWidth}
        setNavWidth={setNavWidth}
        busy={busy}
        onAddSlide={() => void addSlide()}
        onOpenOverview={() => setOverview(true)}
      />

      <section className="workspace">
        <div
          ref={stage}
          className="stage"
          data-testid="stage"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files);
            if (!files.length) return;
            event.preventDefault();
            event.stopPropagation();
            void mediaActions.importFiles(files).catch(reportError);
          }}
          onPointerDownCapture={beginPan}
          onPointerMove={updatePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onContextMenu={(event) => event.preventDefault()}
          onWheelCapture={(event) => {
            if (event.deltaY === 0) return;
            event.preventDefault();
            zoomAt(
              zoom * Math.exp(-event.deltaY * 0.0015),
              event.clientX,
              event.clientY,
            );
          }}
        >
          {!play && showRulers && (
            <Rulers
              scale={scale}
              pan={pan}
              slideWidth={deck.width}
              slideHeight={deck.height}
              onPreviewGuide={setGuidePreview}
              onBeginGuide={() => guideEditing.beginGuideEdit()}
              onCancelGuide={() => guideEditing.cancelGuideEdit()}
              onCreateGuide={(axis, position) =>
                guideEditing.createManualGuide(axis, position)
              }
              onSnapGuide={guideEditing.snapGuidePosition}
            />
          )}
          {motionWorkspace.editingStates && (
            <div className="motion-state-edit-banner" role="status">
              Editing Motion states ·{" "}
              {
                motionWorkspace.motion?.stages[
                  motionWorkspace.active
                ]?.blocks?.find(
                  (block) => block.id === motionWorkspace.selected,
                )?.label
              }{" "}
              · {(motionWorkspace.cursor.time / 1000).toFixed(2)} s
              <button
                onClick={() => {
                  motionWorkspace.setEditingStates(false);
                  motionWorkspace.setPreview(null);
                }}
              >
                Done editing Motion states
              </button>
            </div>
          )}
          <EditorCanvasSurface
            controller={motionWorkspace.editingController}
            motionSourceSlide={
              motionWorkspace.editingController !== controller
                ? controller.snapshot?.slide
                : undefined
            }
            selection={selection}
            onSelectionChange={setSelection}
            onScopeEnter={setInsertionScopeId}
            selectionMode={selectionMode}
            previewMedia={play}
            showFrameBorders={showFrameBorders}
            motionState={motionWorkspace.preview}
            trimMedia={Boolean(trimVideoId)}
            scale={scale}
            snapping={{
              enabled: snapping,
              toObjects: snapToObjects,
              toGuides: snapToGuides,
              toSlide: snapToSlide,
              drag: dragSnapping,
            }}
            className="slide-scale"
            cropFrameId={cropping}
            frameEditingId={frameEditing?.elementId}
            frameEditingIntrinsic={frameEditing?.intrinsic}
            textEditing={textEditing}
            remoteSelections={remoteSelections}
            onTransformPreview={sendTransformPreview}
            onTransformPreviewClear={clearTransformPreview}
            guides={showGuides ? resolveGuides(deck) : []}
            guidePreview={guidePreview}
            onBeginGuideMove={() => guideEditing.beginGuideEdit()}
            onPreviewGuideMove={guideEditing.previewManualGuide}
            onCommitGuideMove={(id, position) => {
              void guideEditing
                .commitManualGuide(id, position)
                .catch(reportError);
            }}
            onCancelGuideMove={() => {
              void guideEditing.cancelGuideEdit().catch(reportError);
            }}
            onDeleteGuide={(id) => {
              void guideEditing.deleteManualGuide(id).catch(reportError);
            }}
            onSnapGuide={guideEditing.snapGuidePosition}
            onFrameEditRequest={(id) => {
              if (id) {
                setCropping(null);
                void textEditing
                  .exit()
                  .then(() => mediaActions.beginFrameEdit(id));
              } else mediaActions.exitFrameEdit();
            }}
            style={{
              position: "absolute",
              left: `calc(50% + ${pan.x}px)`,
              top: `calc(50% + ${pan.y}px)`,
              transform: "translate(-50%, -50%)",
            }}
          />
          {trimVideoId && trimVideo && trimElement && (
            <VideoTrimOverlay
              video={trimVideo}
              elementId={trimVideoId}
              style={{
                left: `calc(50% + ${
                  pan.x +
                  (trimElement.frame.x +
                    trimElement.frame.width / 2 -
                    deck.width / 2) *
                    scale
                }px)`,
                top:
                  (stage.current?.clientHeight ?? 800) / 2 +
                  pan.y +
                  (trimElement.frame.y +
                    trimElement.frame.height -
                    deck.height / 2) *
                    scale +
                  12,
              }}
              onPatch={(patch) => {
                void mediaActions
                  .changeContent(trimVideoId, (content) =>
                    content.type === "video"
                      ? { ...content, ...patch }
                      : content,
                  )
                  .catch(reportError);
              }}
              onDone={() => {
                setTrimVideoId(null);
                setPlay(false);
              }}
              onSeek={(time) => {
                const element = stage.current?.querySelector<HTMLElement>(
                  `[data-element-id="${CSS.escape(trimVideoId)}"]`,
                );
                const video = element?.querySelector("video");
                if (!video || video.readyState < 1) return;
                video.pause();
                video.currentTime = clamp(
                  time,
                  0,
                  Math.max(0, video.duration - 0.01),
                );
              }}
              onControl={(command) => {
                const element = stage.current?.querySelector<HTMLElement>(
                  `[data-element-id="${CSS.escape(trimVideoId)}"]`,
                );
                const video = element?.querySelector("video");
                if (!video) return;
                if (command === "play") {
                  if (video.paused) void video.play().catch(() => {});
                  else video.pause();
                  return;
                }
                video.pause();
                video.currentTime = clamp(
                  video.currentTime + (command === "next" ? 1 : -1),
                  0,
                  Math.max(0, video.duration - 0.01),
                );
              }}
            />
          )}
          {selectedMedia && !frameEditing && !play && (
            <div
              className="mode-bar frame-mode-bar"
              role="toolbar"
              aria-label={cropping ? "Crop controls" : "Frame content controls"}
              style={{
                left: `calc(50% + ${
                  pan.x +
                  (selectedMediaFrame!.x +
                    selectedMediaFrame!.width / 2 -
                    deck.width / 2) *
                    scale
                }px)`,
                top: `calc(50% + ${
                  pan.y +
                  (selectedMediaFrame!.y +
                    selectedMediaFrame!.height -
                    deck.height / 2) *
                    scale +
                  12
                }px)`,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {cropping ? (
                <button
                  type="button"
                  aria-label="Finish crop"
                  onClick={() => setCropping(null)}
                >
                  Done
                </button>
              ) : (
                <>
                  {(["fill", "fit", "free"] as const).map((rule) => (
                    <button
                      key={rule}
                      type="button"
                      aria-pressed={
                        selectedMedia.content.transform.rule === rule
                      }
                      onClick={() =>
                        void mediaActions
                          .setRule(selectedMedia.id, rule)
                          .catch(reportError)
                      }
                    >
                      {rule[0].toUpperCase() + rule.slice(1)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCropping(selectedMedia.id)}
                  >
                    Crop
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void mediaActions
                        .reset(selectedMedia.id)
                        .catch(reportError)
                    }
                  >
                    Reset
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {!editingTemplate && motionWorkspace.open && (
          <MotionDock workspace={motionWorkspace} />
        )}
        {!editingTemplate && notesOpen && !motionWorkspace.open && (
          <section
            className="editor-notes-panel"
            aria-label="Presenter notes panel"
          >
            <textarea
              id="editor-presenter-notes"
              aria-label="Presenter notes"
              value={notesEditing.draft}
              readOnly={!notesEditing.ready}
              placeholder="Add presenter notes"
              autoFocus
              onFocus={(event) => {
                void notesEditing.onFocus(event).catch(reportError);
              }}
              onCompositionStart={notesEditing.onCompositionStart}
              onCompositionEnd={notesEditing.onCompositionEnd}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setNotesOpen(false);
                void notesEditing.flush().catch(reportError);
              }}
              onChange={(event) => notesEditing.onChange(event.target.value)}
              onBlur={() => {
                void notesEditing.flush().catch(reportError);
              }}
            />
          </section>
        )}

        <footer className="statusbar">
          <ImageReadinessStatus
            documentId={deckId}
            slideId={slide.id}
            slideIds={deck.slideIds}
          />
          <span
            role="status"
            className={status.startsWith("Error:") ? "error" : ""}
          >
            {status.startsWith("Error:") ? (
              <EffectErrorMessage message={status} />
            ) : (
              status
            )}
          </span>
          <div className="status-notes">
            <button
              type="button"
              className={`status-notes-toggle ${notesOpen ? "active" : ""}`}
              aria-expanded={notesOpen}
              aria-controls="editor-presenter-notes"
              disabled={editingTemplate}
              onClick={() => {
                if (notesOpen) {
                  void notesEditing.flush().catch(reportError);
                  setNotesOpen(false);
                } else {
                  motionWorkspace.setOpen(false);
                  setNotesOpen(true);
                }
              }}
            >
              Speaker Notes
            </button>
            <button
              type="button"
              disabled={editingTemplate}
              aria-expanded={motionWorkspace.open}
              onClick={() => {
                void notesEditing.flush().catch(reportError);
                setNotesOpen(false);
                motionWorkspace.setOpen(!motionWorkspace.open);
              }}
            >
              Click Timeline
            </button>
          </div>
          {controller.session.hasFailedIntent && (
            <>
              <button
                type="button"
                onClick={() => {
                  setLocalError("");
                  void controller.session
                    .retryFailedIntents()
                    .catch(reportError);
                }}
              >
                Retry failed edits
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocalError("");
                  void controller.session
                    .discardFailedIntents()
                    .catch(reportError);
                }}
              >
                Discard failed edits
              </button>
            </>
          )}
          {status.startsWith("Error:") &&
            !controller.session.hasFailedIntent && (
              <button
                type="button"
                onClick={() => {
                  setLocalError("");
                  void controller
                    .refreshProjection(slide.id)
                    .catch(reportError);
                }}
              >
                Refresh
              </button>
            )}
          <div className="zoom-controls">
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => zoomAt(zoom / 1.15)}
            >
              −
            </button>
            <button type="button" title="Fit slide" onClick={fitCanvas}>
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => zoomAt(zoom * 1.15)}
            >
              +
            </button>
          </div>
        </footer>
      </section>

      <RightSidebar
        settings={
          <EditorSettings
            onOpenAppSettings={() => setSettingsOpen(true)}
            selectionMode={selectionMode}
            onSelectionModeChange={(mode) => {
              setSelectionMode(mode);
              saveSelectionMode(mode);
            }}
            snapping={snapping}
            onToggleSnapping={() => setSnapping((value) => !value)}
            snapToObjects={snapToObjects}
            onToggleSnapToObjects={() => setSnapToObjects((value) => !value)}
            snapToGuides={snapToGuides}
            onToggleSnapToGuides={() => setSnapToGuides((value) => !value)}
            snapToSlide={snapToSlide}
            onToggleSnapToSlide={() => setSnapToSlide((value) => !value)}
            dragSnapping={dragSnapping}
            onDragSnappingChange={setDragSnapping}
            showRulers={showRulers}
            onToggleRulers={() => setShowRulers((value) => !value)}
            showGuides={showGuides}
            onToggleGuides={() => setShowGuides((value) => !value)}
            showFrameBorders={showFrameBorders}
            onToggleFrameBorders={() => setShowFrameBorders((value) => !value)}
            previewMedia={play}
            onTogglePreviewMedia={() => {
              const next = !play;
              setSettingsOpen(false);
              setPlay(next);
              if (next) {
                void textEditing.exit();
                setFrameEditing(null);
                setCropping(null);
                setMediaOpen(false);
              } else {
                setTrimVideoId(null);
              }
            }}
            onEditLayoutGuides={() => {
              setSettingsOpen(false);
              setLayoutGuidesOpen(true);
            }}
            onGenerateGrid={() => setLayoutGuidesOpen(true)}
            onDeleteGuides={() => {
              void guideEditing.clearAllGuides().catch(reportError);
            }}
          />
        }
        templateControls={
          <TemplatePageControls
            snapshot={snapshot}
            busy={busy}
            apply={applyTemplateChange}
            activate={activateTemplatePage}
            onError={reportError}
          />
        }
        motion={
          <MotionSidebar workspace={motionWorkspace} controller={controller} />
        }
        effectsEditor={
          <EffectsPanel
            workspace={motionWorkspace}
            key={snapshot.slide.id}
            snapshot={snapshot}
            element={
              selection.elementIds.length === 1
                ? (findElement(snapshot.slide, selection.elementIds[0]) ?? null)
                : null
            }
            controller={controller}
            onError={reportError}
          />
        }
        documentId={deckId}
        snapshot={motionWorkspace.editingController.snapshot ?? snapshot}
        selection={selection}
        controller={motionWorkspace.editingController}
        structuralActions={structuralActions}
        showMedia={mediaOpen}
        onMediaShown={closeMediaBrowser}
        onAddLayer={() => {
          void layerActions.addLayer();
        }}
        layers={(active) => (
          <LayersPanel
            key={deckId}
            active={active}
            slide={slide}
            deck={deck}
            selectionScope={selection.scopeId}
            insertionScope={insertionScopeId}
            selected={selection.elementIds}
            onSelect={layerActions.selectElement}
            onEnter={layerActions.enterScope}
            onReparent={(ids, from, to, index) => {
              void layerActions.reparentHierarchy(ids, from, to, index);
            }}
            onDeleteLayer={(id) => {
              void layerActions.deleteLayer(id);
            }}
            onLayerChange={(id, patch) => {
              void layerActions.changeLayer(id, patch);
            }}
          />
        )}
        media={
          <AssetLibrary
            snapshot={snapshot}
            refresh={mediaRefresh}
            onImport={() =>
              window.desktop
                ? void mediaActions.importFiles()
                : fileInput.current?.click()
            }
            onInsert={(asset) => void mediaActions.insertAsset(asset)}
          />
        }
        onReplaceMedia={() => {
          if (replaceInput.current)
            replaceInput.current.accept =
              selectedMedia?.content.type === "video"
                ? "video/*"
                : "image/*,.svg";
          replaceInput.current?.click();
        }}
        onEditFrame={(id) => {
          void mediaActions.beginFrameEdit(id);
        }}
        onMediaCenter={(id) => {
          void mediaActions.center(id);
        }}
        onMediaReset={(id) => {
          void mediaActions.reset(id);
        }}
        onReparent={(ids, from, to) => {
          void layerActions.reparentHierarchy(ids, from, to, 0);
        }}
        onMediaRule={(id, rule) => {
          void mediaActions.setRule(id, rule);
        }}
        onCropFrame={(id) => {
          mediaActions.exitFrameEdit();
          setTrimVideoId(null);
          void textEditing.exit();
          setCropping(id);
        }}
        onTrimVideo={(id) => {
          mediaActions.exitFrameEdit();
          setCropping(null);
          void textEditing.exit();
          setTrimVideoId(id);
          setPlay(true);
        }}
        onPreviewVideo={(id, command) => {
          const current = stage.current?.querySelector<HTMLVideoElement>(
            `[data-element-id="${CSS.escape(id)}"] video`,
          );
          const shouldPlay = !play || !current || current.paused;
          setPlay(true);
          requestAnimationFrame(() => {
            const root = stage.current;
            const element = root?.querySelector<HTMLElement>(
              `[data-element-id="${CSS.escape(id)}"]`,
            );
            const video = element?.querySelector("video");
            if (!video) return;
            const perform = () => {
              if (command === "previous")
                video.currentTime = Math.max(0, video.currentTime - 1);
              else if (command === "next")
                video.currentTime = Math.min(
                  Number.isFinite(video.duration) ? video.duration : Infinity,
                  video.currentTime + 1,
                );
              else if (shouldPlay) void video.play().catch(() => {});
              else video.pause();
            };
            if (video.readyState < 1)
              video.addEventListener("loadedmetadata", perform, {
                once: true,
              });
            else perform();
          });
        }}

        onGuides={() => setLayoutGuidesOpen(true)}
        onError={reportError}
      />

      {layoutGuidesOpen && (
        <LayoutGuidesDialog
          guideSet={resolveGuideSet(deck)}
          slideWidth={deck.width}
          slideHeight={deck.height}
          onApply={(draft) => {
            void guideEditing
              .applyDefaultGuideSet(draft)
              .then((applied) => applied && setLayoutGuidesOpen(false))
              .catch(reportError);
          }}
          onDelete={
            deck.defaultGuideSetId
              ? () => {
                  void guideEditing
                    .clearAllGuides()
                    .then((cleared) => cleared && setLayoutGuidesOpen(false))
                    .catch(reportError);
                }
              : null
          }
          onClose={() => setLayoutGuidesOpen(false)}
        />
      )}

      <EditorSlideOverview
        open={overview}
        slides={orderedSlideIds}
        slideAspectRatio={deck.width / deck.height}
        renderSlide={(id) => slideButton(id, true)}
        onClose={() => setOverview(false)}
      />

      <EditorPresenterDock controller={presenter} onError={reportError} />
    </main>
  );
}
