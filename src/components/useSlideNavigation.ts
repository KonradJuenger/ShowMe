import { setTextStyle } from "../core/textStyleCommands";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createSlide,
  deleteSlide,
  duplicateSlide,
  moveSlidesToTarget,
  setDeckLayers,
  updateSlideMeta,
  type EditorSnapshot,
} from "../core/editorCommands";
import { DOCUMENT_VERSION, type Deck, type Slide } from "../core/document";
import type { DocumentProjection } from "../core/documentProjection";
import { uid } from "../core/ids";
import {
  expandSlideSubtrees,
  moveSlideSubtrees,
  normalizeSlideRoots,
  removeSlidesAndRepairHierarchy,
  slideDropAfter,
  slideHierarchyRows,
  type SlideDropTarget,
} from "../core/slideHierarchy";
import {
  resolveSlideSelection,
  type SlideSelectionOptions,
} from "../core/slideCommands";
import {
  createSlideTransferBundle,
  parseSlideTransferBundle,
  prepareSlideTransferImport,
  type SlideTransferBundle,
} from "../core/slideTransfer";
import {
  registerSlideCommandRuntime,
  unregisterSlideCommandRuntime,
  type SlideCommandRuntime,
} from "./contextMenuRuntime";
import {
  registerSlideNavigatorRuntime,
  unregisterSlideNavigatorRuntime,
  type SlideNavigatorRuntime,
} from "./slideNavigatorRuntime";
import type { useEditorSession } from "./useEditorSession";

type EditorController = Pick<
  ReturnType<typeof useEditorSession>,
  "snapshot" | "snapshotRef" | "apply" | "flush" | "loadProjection"
>;

interface SlideNavigationOptions {
  deckId: string;
  controller: EditorController;
  run(task: () => Promise<void>): Promise<void>;
  prepareCurrent(): Promise<void>;
  activateSlide(slideId: string): Promise<void>;
  projectSlide(slideId: string): Promise<DocumentProjection>;
  isBusy(): boolean;
}

let slideClipboard: SlideTransferBundle | null = null;

function newSlide(deck: Deck): Slide {
  return {
    version: DOCUMENT_VERSION,
    id: uid(),
    background: "#ffffff",
    notes: "",
    nodes: deck.layers.map((layer) => ({
      type: "layer" as const,
      id: layer.id,
      children: [],
    })),
  };
}

function selectedInDeck(
  deck: Deck,
  selected: readonly string[],
  fallback: string,
) {
  const set = new Set(selected);
  const ordered = deck.slideIds.filter((id) => set.has(id));
  return ordered.length ? ordered : [fallback];
}

export function useSlideNavigation({
  deckId,
  controller,
  run,
  prepareCurrent,
  activateSlide,
  projectSlide,
  isBusy,
}: SlideNavigationOptions) {
  const [selectedSlides, setSelectedSlides] = useState<string[]>([]);
  const [hasSlideClipboard, setHasSlideClipboard] = useState(
    () => slideClipboard !== null,
  );
  const slideAnchor = useRef<string | null>(null);
  const navigating = useRef(false);
  const wantedSlide = useRef<string | null>(null);
  const selectedRef = useRef(selectedSlides);
  const preparedDrag = useRef<{
    ids: string[];
    bundle: SlideTransferBundle;
  } | null>(null);
  const dragPreparation = useRef(0);
  selectedRef.current = selectedSlides;

  const snapshot = controller.snapshot;
  const slideId = snapshot?.slide.id;
  const slideIds = snapshot?.deck.slideIds;
  useEffect(() => {
    if (!slideIds || !slideId) return;
    const ids = new Set(slideIds);
    setSelectedSlides((current) => {
      const valid = slideIds.filter((id) => current.includes(id));
      const next = valid.length ? valid : [slideId];
      selectedRef.current = next;
      return next;
    });
    if (!slideAnchor.current || !ids.has(slideAnchor.current))
      slideAnchor.current = slideId;
  }, [slideId, slideIds]);

  const selectSlide = useCallback(
    async (id: string, options: SlideSelectionOptions = {}) => {
      const current = controller.snapshotRef.current;
      if (!current || !current.deck.slideIds.includes(id)) return;
      const result = resolveSlideSelection(
        slideHierarchyRows(current.deck).map((row) => row.id),
        selectedRef.current,
        slideAnchor.current,
        id,
        options,
      );
      selectedRef.current = result.selected;
      setSelectedSlides(result.selected);
      slideAnchor.current = result.anchor;

      if (options.toggle && id !== current.slide.id) return;
      if (id === current.slide.id) {
        if (navigating.current) wantedSlide.current = id;
        return;
      }
      wantedSlide.current = id;
      if (navigating.current) return;
      navigating.current = true;
      try {
        await run(async () => {
          while (wantedSlide.current) {
            await prepareCurrent();
            const target = wantedSlide.current;
            const latest = controller.snapshotRef.current;
            if (!latest?.deck.slideIds.includes(target)) {
              wantedSlide.current = null;
              break;
            }
            await activateSlide(target);
            if (wantedSlide.current === target) wantedSlide.current = null;
          }
        });
      } finally {
        navigating.current = false;
      }
    },
    [activateSlide, controller.snapshotRef, prepareCurrent, run],
  );

  const addSlide = useCallback(async () => {
    await run(async () => {
      await prepareCurrent();
      const current = controller.snapshotRef.current;
      if (!current) return;
      const slide = newSlide(current.deck);
      controller.apply(
        createSlide(
          current,
          slide,
          {
            templateId: current.deck.defaultTemplateId,
            name: "",
            section: "",
            hidden: false,
          },
          current.deck.slideIds.includes(current.slide.id)
            ? current.slide.id
            : current.deck.slideIds.at(-1)!,
        ),
      );
      await controller.flush();
      selectedRef.current = [slide.id];
      setSelectedSlides([slide.id]);
      slideAnchor.current = slide.id;
      await activateSlide(slide.id);
    });
  }, [activateSlide, controller, prepareCurrent, run]);

  const loadSlides = useCallback(
    async (current: EditorSnapshot, ids: readonly string[]): Promise<Slide[]> =>
      Promise.all(
        ids.map(async (id) =>
          id === current.slide.id
            ? structuredClone(current.slide)
            : structuredClone((await projectSlide(id)).slide),
        ),
      ),
    [projectSlide],
  );

  const buildTransferBundle = useCallback(
    async (ids: readonly string[]) => {
      const current = controller.snapshotRef.current;
      if (!current) throw new Error("Presentation is not loaded");
      const selected = new Set(ids);
      const ordered = current.deck.slideIds.filter((id) => selected.has(id));
      if (ordered.length !== selected.size)
        throw new Error("Selected slides changed before transfer started");
      const slides = await loadSlides(current, ordered);
      return createSlideTransferBundle(
        deckId,
        current.deck,
        slides,
        current.templates,
      );
    },
    [controller.snapshotRef, deckId, loadSlides],
  );

  const warmPreparedDrag = useCallback(
    async (ids: readonly string[]) => {
      const current = controller.snapshotRef.current;
      if (!current || !ids.length) return;
      const request = ++dragPreparation.current;
      const ordered = expandSlideSubtrees(current.deck, ids);
      const bundle = await buildTransferBundle(ordered);
      if (request === dragPreparation.current)
        preparedDrag.current = { ids: ordered, bundle };
    },
    [buildTransferBundle, controller.snapshotRef],
  );

  useEffect(() => {
    const current = controller.snapshotRef.current;
    if (!current) return;
    const ids = selectedSlides.length ? selectedSlides : [current.slide.id];
    void warmPreparedDrag(ids).catch(() => {
      preparedDrag.current = null;
    });
  }, [controller.snapshotRef, selectedSlides, warmPreparedDrag]);

  const prepareSlideDrag = useCallback(
    async (id: string) => {
      const current = controller.snapshotRef.current;
      if (!current) return;
      const ids = selectedRef.current.includes(id) ? selectedRef.current : [id];
      preparedDrag.current = null;
      await prepareCurrent();
      await warmPreparedDrag(ids);
    },
    [controller.snapshotRef, prepareCurrent, warmPreparedDrag],
  );

  const activateSlideDragSelection = useCallback((id: string) => {
    if (selectedRef.current.includes(id)) return;
    selectedRef.current = [id];
    setSelectedSlides([id]);
    slideAnchor.current = id;
  }, []);

  const getPreparedSlideTransfer = useCallback((id: string) => {
    const prepared = preparedDrag.current;
    return prepared && prepared.ids.includes(id) ? prepared.bundle : null;
  }, []);

  const copySlides = useCallback(async () => {
    await run(async () => {
      await prepareCurrent();
      const current = controller.snapshotRef.current;
      if (!current) return;
      const ids = selectedInDeck(
        current.deck,
        selectedRef.current,
        current.slide.id,
      );
      slideClipboard = await buildTransferBundle(ids);
      setHasSlideClipboard(true);
    });
  }, [buildTransferBundle, controller.snapshotRef, prepareCurrent, run]);

  const duplicateSlides = useCallback(async () => {
    await run(async () => {
      await prepareCurrent();
      const current = controller.snapshotRef.current;
      if (!current) return;
      const ids = selectedInDeck(
        current.deck,
        selectedRef.current,
        current.slide.id,
      );
      const sources = await loadSlides(current, ids);
      const copyIds = ids.map(() => uid());
      const sourceToCopy = new Map(
        ids.map((id, index) => [id, copyIds[index]]),
      );
      const lastSourceIndex = Math.max(
        ...ids.map((id) => current.deck.slideIds.indexOf(id)),
      );
      let afterId = current.deck.slideIds[lastSourceIndex] ?? current.slide.id;
      let next: EditorSnapshot = current;

      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        const meta = current.deck.slideMeta[source.id];
        const copyId = copyIds[index];
        next = duplicateSlide(
          next,
          source,
          copyId,
          {
            ...structuredClone(meta),
            section: meta.section
              ? (sourceToCopy.get(meta.section) ?? meta.section)
              : "",
          },
          afterId,
        );
        afterId = copyId;
      }

      controller.apply(next);
      await controller.flush();
      selectedRef.current = copyIds;
      setSelectedSlides(copyIds);
      slideAnchor.current = copyIds[0] ?? null;
      if (copyIds[0]) await activateSlide(copyIds[0]);
    });
  }, [activateSlide, controller, loadSlides, prepareCurrent, run]);

  const importBundle = useCallback(
    async (input: unknown, target: SlideDropTarget) => {
      const bundle = parseSlideTransferBundle(input);
      await prepareCurrent();
      const current = controller.snapshotRef.current;
      if (!current) return;

      const prepared = prepareSlideTransferImport(bundle, current.deck);
      let next: EditorSnapshot = setDeckLayers(current, prepared.layers);
      for (const style of prepared.textStyles)
        if (!next.deck.textStyles.some((s) => s.id === style.id))
          next = setTextStyle(next, { styleId: style.id, value: style });
      const stagingDeck: Deck = {
        ...next.deck,
        slideIds: [...next.deck.slideIds, ...prepared.importedSlideIds],
        slideMeta: {
          ...next.deck.slideMeta,
          ...prepared.slideMeta,
        },
      };
      const placed = moveSlideSubtrees(
        stagingDeck,
        prepared.importedSlideIds,
        target,
      );
      const imported = new Set(prepared.importedSlideIds);
      const byId = new Map(prepared.slides.map((slide) => [slide.id, slide]));

      for (const id of placed.slideIds) {
        if (!imported.has(id)) continue;
        const index = placed.slideIds.indexOf(id);
        const slide = byId.get(id);
        if (!slide) throw new Error("Missing prepared slide");
        next = createSlide(
          next,
          slide,
          placed.slideMeta[id],
          index > 0 ? placed.slideIds[index - 1] : null,
        );
      }

      controller.apply(next);
      await controller.flush();
      const roots = normalizeSlideRoots(placed, prepared.importedSlideIds);
      const selected = roots.length ? roots : prepared.importedSlideIds;
      selectedRef.current = selected;
      setSelectedSlides(selected);
      slideAnchor.current = selected[0] ?? null;
      const active = selected[0] ?? prepared.importedSlideIds[0];
      if (active) await activateSlide(active);
    },
    [activateSlide, controller, prepareCurrent],
  );

  const pasteSlides = useCallback(async () => {
    const current = controller.snapshotRef.current;
    const clipboard = slideClipboard;
    if (!current || !clipboard) return;
    await run(() =>
      importBundle(clipboard, slideDropAfter(current.deck, current.slide.id)),
    );
  }, [controller.snapshotRef, importBundle, run]);

  const moveSlides = useCallback(
    async (ids: readonly string[], target: SlideDropTarget) => {
      await run(async () => {
        await prepareCurrent();
        const current = controller.snapshotRef.current;
        if (!current) return;
        const movingIds = expandSlideSubtrees(current.deck, ids);
        if (!movingIds.length) return;
        const next = moveSlidesToTarget(current, movingIds, target);
        if (next !== current) {
          controller.apply(next);
          await controller.flush();
        }
        const selected = normalizeSlideRoots(next.deck, movingIds);
        selectedRef.current = selected;
        setSelectedSlides(selected);
        slideAnchor.current = selected[0] ?? null;
      });
    },
    [controller, prepareCurrent, run],
  );

  const dropSlideTransfer = useCallback(
    async (input: unknown, target: SlideDropTarget) => {
      const bundle = parseSlideTransferBundle(input);
      if (bundle.source.documentId === deckId) {
        const current = controller.snapshotRef.current;
        if (!current) return;
        const sourceIds = bundle.slides.map((entry) => entry.slide.id);
        if (sourceIds.some((id) => !current.deck.slideIds.includes(id)))
          throw new Error("Source slides changed during drag");
        await moveSlides(sourceIds, target);
        return;
      }
      await run(() => importBundle(bundle, target));
    },
    [controller.snapshotRef, deckId, importBundle, moveSlides, run],
  );

  const setSlidesHidden = useCallback(
    async (hidden: boolean) => {
      await run(async () => {
        await prepareCurrent();
        const current = controller.snapshotRef.current;
        if (!current) return;
        const ids = expandSlideSubtrees(
          current.deck,
          selectedInDeck(current.deck, selectedRef.current, current.slide.id),
        );
        let next: EditorSnapshot = current;
        for (const id of ids) next = updateSlideMeta(next, id, { hidden });
        if (next === current) return;
        controller.apply(next);
        await controller.flush();
      });
    },
    [controller, prepareCurrent, run],
  );

  const deleteSlides = useCallback(async () => {
    await run(async () => {
      await prepareCurrent();
      const current = controller.snapshotRef.current;
      if (!current || current.deck.slideIds.length <= 1) return;

      const remove = new Set(
        selectedInDeck(current.deck, selectedRef.current, current.slide.id),
      );
      if (remove.size >= current.deck.slideIds.length)
        remove.delete(current.slide.id);
      if (!remove.size) return;

      const finalDeck = removeSlidesAndRepairHierarchy(current.deck, remove);
      const oldIndex = current.deck.slideIds.indexOf(current.slide.id);
      const nextId =
        finalDeck.slideIds[
          Math.min(Math.max(0, oldIndex), finalDeck.slideIds.length - 1)
        ];
      // Project a surviving slide before submitting deletion. A draft must keep
      // the accepted projection's slide ID, even for structural deck commands.
      if (remove.has(current.slide.id)) await activateSlide(nextId);
      const latest = controller.snapshotRef.current;
      if (!latest) return;
      let next: EditorSnapshot = latest;
      for (const id of latest.deck.slideIds) {
        if (!remove.has(id)) continue;
        next = deleteSlide(next, id);
      }
      for (const id of finalDeck.slideIds) {
        const section = finalDeck.slideMeta[id]?.section ?? "";
        if ((next.deck.slideMeta[id]?.section ?? "") !== section)
          next = updateSlideMeta(next, id, { section });
      }

      controller.apply(next);
      await controller.flush();
      selectedRef.current = [nextId];
      setSelectedSlides([nextId]);
      slideAnchor.current = nextId;
      await activateSlide(nextId);
    });
  }, [activateSlide, controller, prepareCurrent, run]);

  useLayoutEffect(() => {
    const runtime: SlideCommandRuntime = {
      getSnapshot: () => controller.snapshotRef.current,
      isBusy,
      getSelectedSlides: () => [...selectedRef.current],
      hasSlideClipboard: () => slideClipboard !== null,
      selectSlide,
      addSlide,
      duplicateSlides,
      copySlides,
      pasteSlides,
      deleteSlides,
      hideSlides: () => setSlidesHidden(true),
      unhideSlides: () => setSlidesHidden(false),
    };
    registerSlideCommandRuntime(runtime);
    return () => unregisterSlideCommandRuntime(runtime);
  }, [
    addSlide,
    controller.snapshotRef,
    copySlides,
    deleteSlides,
    duplicateSlides,
    isBusy,
    pasteSlides,
    selectSlide,
    setSlidesHidden,
  ]);

  useLayoutEffect(() => {
    const runtime: SlideNavigatorRuntime = {
      deckId,
      getSnapshot: () => controller.snapshotRef.current,
      getSelectedSlides: () => [...selectedRef.current],
      selectSlide,
      prepareSlideDrag,
      activateSlideDragSelection,
      getPreparedSlideTransfer,
      moveSlides,
      dropSlideTransfer,
    };
    registerSlideNavigatorRuntime(runtime);
    return () => unregisterSlideNavigatorRuntime(runtime);
  }, [
    activateSlideDragSelection,
    controller.snapshotRef,
    deckId,
    dropSlideTransfer,
    getPreparedSlideTransfer,
    moveSlides,
    prepareSlideDrag,
    selectSlide,
  ]);

  return {
    selectedSlides,
    hasSlideClipboard,
    selectSlide,
    addSlide,
    duplicateSlides,
    copySlides,
    pasteSlides,
    deleteSlides,
    hideSlides: () => setSlidesHidden(true),
    unhideSlides: () => setSlidesHidden(false),
    prepareSlideDrag,
    activateSlideDragSelection,
    getPreparedSlideTransfer,
    moveSlides,
    dropSlideTransfer,
  };
}
