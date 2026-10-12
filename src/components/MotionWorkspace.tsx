import { addPresence, editPresenceSchedule } from "../core/presence";
import {
  motionTimelineLayout,
  motionTimelineSpans,
  timelineCursorAt,
  timelineSeekTime,
  resizeTimelineIntervalStart,
} from "./motionTimelineLayout";
import { resizeEffectTime } from "../core/effectSequence";
import { transitionDuration, isEffectTriggerBlock } from "../core/motionModel";
import { uid } from "../core/ids";
import {
  blockStateTimes,
  motionEditingSnapshot,
  animationStateChange,
} from "../core/motionStates";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ButtonHTMLAttributes,
  useId,
} from "react";
import {
  addMotionPreset,
  blockRange,
  editMotionBlock,
  deleteMotionBlock,
  mergeMotionStages,
  stageDuration,
  type MotionPreset,
} from "../core/motion";
import { COMMAND_IDS } from "../core/commandRegistry";
import { showContextMenuSelection } from "../platform/contextMenu";
import { setSlideMotion } from "../core/editorCommands";
import { findElement, isEditableScope, locateElement } from "../core/scene";
import type { SlideMotion } from "../core/motionModel";
import {
  enterMotion,
  motionTime,
  navigateMotion,
  type MotionPreviewState,
  withPreviewClock,
  previewTime,
  previewInterval,
} from "../core/motionPlayback";
import type { EditorController } from "./EditorCanvas";
import type { CanvasSelection } from "./editorCanvasCoordinator";
import "./MotionWorkspace.css";
import { MaterialIcon, type MaterialIconName } from "./MaterialIcon";

export function useMotionWorkspace(
  controller: EditorController,
  selection: CanvasSelection,
  onError: (error: unknown) => void,
  onSelectElement: (elementId: string, parentId: string) => void,
) {
  const [editingStates, setEditingStates] = useState(false);
  const [canvasMode, setCanvasMode] = useState<"edit" | "playback">("edit");
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [preview, commitPreview] = useState<MotionPreviewState | null>(null),
    [draft, setDraft] = useState<SlideMotion | null>(null);
  const [cursor, setCursor] = useState({ stageIndex: 0, time: 0 });
  const hiddenPlaybackEnd = useRef<{ stageIndex: number; time: number } | null>(
    null,
  );
  const openRef = useRef(open);
  openRef.current = open;
  const slide = controller.snapshot?.slide;
  const motion = draft ?? slide?.motion;
  const previewStages = useRef<{ id: string; duration: number }[]>([]);
  previewStages.current =
    motion?.stages.map((s) => ({ id: s.id, duration: stageDuration(s) })) ?? [];
  const setPreview = useCallback(
    (value: MotionPreviewState | null, resetClock = false) => {
      const now = Date.now();
      commitPreview((previous) =>
        withPreviewClock(
          resetClock ? null : previous,
          value,
          previewStages.current,
          now,
        ),
      );
    },
    [],
  );
  const stage = Math.min(active, (motion?.stages.length ?? 1) - 1);
  const queue = useRef(Promise.resolve());
  const slideId = slide?.id;
  useEffect(() => {
    setPreview(null);
    setDraft(null);
    setActive(0);
    setCursor({ stageIndex: 0, time: 0 });
    setSelected(null);
    setEditingStates(false);
    hiddenPlaybackEnd.current = null;
    setCanvasMode("edit");
  }, [slideId, setPreview]);
  useEffect(() => {
    // A hidden one-shot is only valid while the timeline remains closed.
    // Opening the timeline exposes Playback normally; closing it returns to Edit.
    hiddenPlaybackEnd.current = null;
    if (!open) {
      setPreview(null);
      setDraft(null);
      setEditingStates(false);
      setCanvasMode("edit");
    }
  }, [open, setPreview]);
  function change(fn: (motion: SlideMotion | undefined) => SlideMotion) {
    const expectedId = controller.snapshotRef.current?.slide.id,
      epoch = controller.epochRef.current;
    queue.current = queue.current
      .then(async () => {
        if (!expectedId) return;
        await controller.flush();
        if (
          !(await controller.acquireEditScopes([
            { kind: "slide", slideId: expectedId },
          ]))
        )
          throw new Error(
            "This slide is being edited by another collaborator.",
          );
        try {
          const snapshot = controller.snapshotRef.current;
          if (
            !snapshot ||
            snapshot.slide.id !== expectedId ||
            controller.epochRef.current !== epoch
          )
            return;
          const next = fn(snapshot.slide.motion);
          controller.apply(setSlideMotion(snapshot, next));
          await controller.flush();
        } finally {
          await controller.releaseLeases();
        }
      })
      .catch(onError);
  }
  function previewBlock(input: SlideMotion, index: number, blockId: string) {
    const range = blockRange(input, index, blockId);
    setEditingStates(false);
    hiddenPlaybackEnd.current = openRef.current
      ? null
      : { stageIndex: index, time: range.end };
    setCanvasMode("playback");
    setActive(index);
    setCursor({ stageIndex: index, time: range.start });
    setPreview(
      {
        stageIndex: index,
        stageId: input.stages[index].id,
        time: range.start,
        startedAt: Date.now(),
        running: true,
      },
      true,
    );
  }
  function moveBlockToClick(
    source: number,
    blockId: string,
    destination: number,
    atStart = true,
  ) {
    if (destination < 0) return;
    change((m) => {
      const current = blockRange(m!, source, blockId);
      const next = structuredClone(m!);
      if (destination === next.stages.length)
        next.stages.push({ id: uid(), tracks: [] });
      const time = atStart ? 0 : current.start;
      const moved = editMotionBlock(
        next,
        source,
        blockId,
        destination,
        time,
        current.end - current.start,
      );
      setActive(destination);
      setSelected(blockId);
      setCursor({ stageIndex: destination, time });
      setEditingStates(false);
      setPreview(null);
      return moved;
    });
  }
  function blockOwner(input: SlideMotion, index: number, blockId: string) {
    const stage = input.stages[index];
    const block = stage?.blocks?.find((candidate) => candidate.id === blockId);
    if (!stage || !block) return null;
    const elementId =
      block.binding?.elementId ??
      stage.tracks.find((track) =>
        block.members.some((member) => member.trackId === track.id),
      )?.elementId;
    return elementId ? { stage, block, elementId } : null;
  }
  function selectOwner(input: SlideMotion, index: number, blockId: string) {
    const owner = blockOwner(input, index, blockId);
    if (!owner) return null;
    const current = controller.snapshotRef.current;
    const location = current && locateElement(current.slide, owner.elementId);
    if (location) onSelectElement(owner.elementId, location.parentId);
    return owner;
  }
  function openBlockInspector(
    input: SlideMotion,
    index: number,
    blockId: string,
  ) {
    const owner = selectOwner(input, index, blockId);
    if (!owner) return;
    const effect = isEffectTriggerBlock(owner.stage, owner.block);
    setActive(index);
    setSelected(blockId);
    setEditingStates(false);
    document.dispatchEvent(
      new CustomEvent("showme-sidebar-mode", {
        detail: effect ? "Effects" : "Motion",
      }),
    );
    if (effect && owner.block.binding)
      requestAnimationFrame(() =>
        document.dispatchEvent(
          new CustomEvent("showme-effect-focus", {
            detail: {
              instanceId:
                owner.block.binding?.kind === "effect"
                  ? owner.block.binding.effectInstanceId
                  : "",
            },
          }),
        ),
      );
  }
  async function openBlockMenu(
    source: number,
    blockId: string,
    x: number,
    y: number,
  ) {
    const snapshot = controller.snapshotRef.current;
    const expectedSlide = snapshot?.slide.id;
    const input = snapshot?.slide.motion;
    const owner = input && blockOwner(input, source, blockId);
    if (!input || !owner) return;
    const effect = isEffectTriggerBlock(owner.stage, owner.block);
    try {
      const selection = await showContextMenuSelection({
        x,
        y,
        items: [
          {
            type: "command",
            commandId: COMMAND_IDS.motionPreviewBlock,
            label: "Play animation",
            enabled: true,
          },
          {
            type: "submenu",
            label: "Trigger",
            enabled: true,
            items: [
              ...input.stages.map((_stage, index) => ({
                type: "command" as const,
                commandId: COMMAND_IDS.motionSetTrigger,
                label: index === 0 ? "Slide start" : `Click ${index}`,
                enabled: index !== source,
                value: String(index),
              })),
              { type: "separator" as const },
              {
                type: "command" as const,
                commandId: COMMAND_IDS.motionSetTrigger,
                label: "New click",
                enabled: true,
                value: "new",
              },
            ],
          },
          {
            type: "command",
            commandId: COMMAND_IDS.motionMovePreviousClick,
            label: "Move to previous click",
            enabled: source > 0,
          },
          {
            type: "command",
            commandId: COMMAND_IDS.motionMoveNextClick,
            label: "Move to next click",
            enabled: true,
          },
          ...(!effect && owner.block.binding?.kind !== "presence"
            ? [
                {
                  type: "command" as const,
                  commandId: COMMAND_IDS.motionDuplicateBlock,
                  label: "Duplicate",
                  enabled: true,
                },
              ]
            : []),
          { type: "separator" },
          {
            type: "command",
            commandId: COMMAND_IDS.motionSelectElement,
            label: "Select Element",
            enabled: true,
          },
          {
            type: "command",
            commandId: COMMAND_IDS.motionOpenBlock,
            label: effect ? "Open Effect" : "Open in Motion",
            enabled: true,
          },
          { type: "separator" },
          {
            type: "command",
            commandId: COMMAND_IDS.motionRemoveBlock,
            label: "Remove from Click Timeline",
            enabled: true,
          },
        ],
      });
      if (
        !selection ||
        controller.snapshotRef.current?.slide.id !== expectedSlide
      )
        return;
      const current = controller.snapshotRef.current?.slide.motion;
      if (!current) return;
      if (selection.commandId === COMMAND_IDS.motionPreviewBlock) {
        previewBlock(current, source, blockId);
      } else if (selection.commandId === COMMAND_IDS.motionSetTrigger) {
        const destination =
          selection.value === "new"
            ? current.stages.length
            : Number(selection.value);
        if (Number.isInteger(destination))
          moveBlockToClick(source, blockId, destination, false);
      } else if (selection.commandId === COMMAND_IDS.motionMoveNextClick) {
        moveBlockToClick(source, blockId, source + 1);
      } else if (selection.commandId === COMMAND_IDS.motionMovePreviousClick) {
        moveBlockToClick(source, blockId, source - 1);
      } else if (
        selection.commandId === COMMAND_IDS.motionDuplicateBlock &&
        !effect &&
        owner.block.binding?.kind !== "presence"
      ) {
        change((motion) => {
          const range = blockRange(motion!, source, blockId);
          const oldIds = new Set(
            (motion!.stages[source].blocks ?? []).map((block) => block.id),
          );
          const next = editMotionBlock(
            motion!,
            source,
            blockId,
            source,
            stageDuration(motion!.stages[source]) + 1,
            range.end - range.start,
            true,
          );
          const created = next.stages[source].blocks?.find(
            (block) => !oldIds.has(block.id),
          );
          if (created) setSelected(created.id);
          return next;
        });
      } else if (selection.commandId === COMMAND_IDS.motionSelectElement) {
        selectOwner(current, source, blockId);
      } else if (selection.commandId === COMMAND_IDS.motionOpenBlock) {
        openBlockInspector(current, source, blockId);
      } else if (selection.commandId === COMMAND_IDS.motionRemoveBlock) {
        change((motion) => deleteMotionBlock(motion!, source, blockId));
        setSelected(null);
        setPreview(null);
        setEditingStates(false);
      }
    } catch (error) {
      onError(error);
    }
  }
  const timings =
    motion?.stages.map((s) => ({ id: s.id, duration: stageDuration(s) })) ?? [];
  const start = (only: boolean) => {
    const index = only ? stage : 0;
    const entry = enterMotion(timings, Date.now());
    if (entry) {
      setEditingStates(false);
      hiddenPlaybackEnd.current = null;
      setCanvasMode("playback");
      setPreview({
        ...entry,
        stageIndex: index,
        stageId: timings[index].id,
        time: 0,
        running:
          timings[index].duration > 0 ||
          !!motion?.stages[index].blocks?.some(
            (b) => b.effectSchedule || b.presenceSchedule,
          ),
      });
      setActive(index);
    }
  };
  function seek(stageIndex: number, time: number) {
    time = timelineSeekTime(motion!, stageIndex, time);
    hiddenPlaybackEnd.current = null;
    setCanvasMode("playback");
    setCursor({ stageIndex, time });
    setActive(stageIndex);
    if (timings[stageIndex])
      setPreview(
        {
          stageIndex,
          stageId: timings[stageIndex].id,
          time,
          startedAt: Date.now(),
          running: false,
        },
        true,
      );
  }
  const interval =
    motion && preview
      ? previewInterval(motion, preview, Date.now())
      : { waits: false, duration: 0 };
  const previewWaits = interval.waits;
  const previewDuration = interval.duration;
  const showEdit = () => {
    if (preview) {
      const time = !preview.running
        ? preview.time
        : previewWaits
          ? previewTime(preview, Date.now())
          : motionTime(preview, previewDuration, Date.now());
      setCursor({ stageIndex: preview.stageIndex, time });
      setActive(preview.stageIndex);
    }
    setEditingStates(false);
    hiddenPlaybackEnd.current = null;
    setCanvasMode("edit");
    setPreview(null);
  };
  const showPlayback = () => {
    setEditingStates(false);
    hiddenPlaybackEnd.current = null;
    if (!timings[cursor.stageIndex]) return;
    seek(cursor.stageIndex, cursor.time);
  };
  useEffect(() => {
    if (!preview?.running) return;
    const update = () => {
      const current = motion
        ? previewInterval(motion, preview, Date.now())
        : { waits: false, duration: 0 };
      const time = current.waits
        ? previewTime(preview, Date.now())
        : motionTime(preview, current.duration, Date.now());
      const hiddenEnd = hiddenPlaybackEnd.current;
      if (
        hiddenEnd &&
        !openRef.current &&
        hiddenEnd.stageIndex === preview.stageIndex &&
        time >= hiddenEnd.time
      ) {
        hiddenPlaybackEnd.current = null;
        setCursor(hiddenEnd);
        setCanvasMode("edit");
        setPreview(null);
        return;
      }
      setCursor({ stageIndex: preview.stageIndex, time });
      if (time >= current.duration && !current.waits) {
        setPreview({ ...preview, time, running: false });
      }
    };
    update();
    // Informational dock clock; Motion advances the canvas independently.
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [preview, previewDuration, previewWaits, setPreview, motion]);
  const next = () => {
    const index = Math.min(cursor.stageIndex, timings.length - 1);
    if (!timings[index]) return;
    setEditingStates(false);
    hiddenPlaybackEnd.current = null;
    setCanvasMode("playback");
    const current = preview ?? {
      stageIndex: index,
      stageId: timings[index].id,
      time: cursor.time,
      startedAt: Date.now(),
      running: false,
    };
    const value = navigateMotion(current, timings, "next", Date.now());
    if (!value) return;
    setPreview({ ...value, running: true });
    setCursor({ stageIndex: value.stageIndex, time: value.time });
    setActive(Math.max(0, value.stageIndex));
  };
  const pause = () => {
    if (preview) {
      const time = previewWaits
        ? previewTime(preview, Date.now())
        : motionTime(preview, previewDuration, Date.now());
      setCursor({ stageIndex: preview.stageIndex, time });
      setPreview({
        ...preview,
        time,
        startedAt: Date.now(),
        running: !preview.running,
      });
    }
  };
  const play = () => {
    if (!timings.length) return;
    if (preview?.running) {
      pause();
      return;
    }
    setEditingStates(false);
    hiddenPlaybackEnd.current = null;
    setCanvasMode("playback");
    const index = Math.min(
      preview?.stageIndex ?? cursor.stageIndex,
      timings.length - 1,
    );
    let time = previewWaits
      ? (preview?.time ?? cursor.time)
      : Math.min(preview?.time ?? cursor.time, timings[index].duration);
    if (time >= timings[index].duration && !previewWaits) time = 0;
    setActive(index);
    setCursor({ stageIndex: index, time });
    setPreview({
      stageIndex: index,
      stageId: timings[index].id,
      time,
      startedAt: Date.now(),
      running: true,
    });
  };
  const add = (preset: MotionPreset | "Presence") => {
    setEditingStates(false);
    const index = open ? stage : 0;
    const ids = [...selection.elementIds];
    change((input) => {
      const snapshot = controller.snapshotRef.current!;
      if (
        !ids.length ||
        ids.some((id) => !isEditableScope(snapshot.slide, snapshot.deck, id))
      )
        throw new Error("Select editable Elements to animate.");
      const next =
        preset === "Presence"
          ? addPresence(input, index, ids)
          : addMotionPreset(input, index, ids, preset);
      const created = next.stages[index].blocks!.at(-1)!;
      const range = blockRange(next, index, created.id);
      hiddenPlaybackEnd.current = openRef.current
        ? null
        : { stageIndex: index, time: range.end };
      setCanvasMode("playback");
      setActive(index);
      setSelected(created.id);
      setPreview({
        stageIndex: index,
        stageId: next.stages[index].id,
        time: range.start,
        startedAt: Date.now(),
        running: true,
      });
      setCursor({ stageIndex: index, time: range.start });
      return next;
    });
  };
  const selectedRange =
    selected && motion?.stages[stage]?.blocks?.some((b) => b.id === selected)
      ? blockRange(motion, stage, selected)
      : null;
  const selectionKey = selection.elementIds.join("\0");
  const previousSelection = useRef(selectionKey);
  useEffect(() => {
    if (previousSelection.current === selectionKey) return;
    previousSelection.current = selectionKey;
    if (
      selectedRange &&
      !selection.elementIds.every(
        (id) =>
          selectedRange.block.binding?.elementId === id ||
          selectedRange.block.members.some(
            (member) =>
              motion!.stages[stage].tracks.find(
                (track) => track.id === member.trackId,
              )?.elementId === id,
          ),
      )
    ) {
      setSelected(null);
      setPreview(null);
    } else if (selectedRange && !selection.elementIds.length) {
      setSelected(null);
      setPreview(null);
    }
  }, [
    selectionKey,
    selectedRange,
    selection.elementIds,
    motion,
    stage,
    setPreview,
  ]);
  const authoring =
    editingStates &&
    selectedRange &&
    !selectedRange.block.binding &&
    cursor.stageIndex === stage;
  const displayed =
    controller.snapshot && authoring && preview
      ? motionEditingSnapshot(controller.snapshot, stage, cursor.time)
      : controller.snapshot;
  const editingRef = useRef(displayed);
  editingRef.current = displayed;
  const editingController: EditorController = authoring
    ? {
        ...controller,
        snapshot: displayed,
        snapshotRef: editingRef,
        acquireEditScopes: async (scopes) => {
          if (preview?.running) seek(stage, cursor.time);
          return controller.acquireEditScopes([
            ...scopes,
            {
              kind: "slide",
              slideId: controller.snapshotRef.current!.slide.id,
            },
          ]);
        },
        acquireElementScopes: async (slideId, ids, parents = [], signal) => {
          if (preview?.running) seek(stage, cursor.time);
          await controller.flush();
          return controller.session.acquireScopes(
            [
              { kind: "slide", slideId },
              ...ids.map((elementId) => ({
                kind: "element" as const,
                slideId,
                elementId,
              })),
              ...parents.map((parentId) => ({
                kind: "structure" as const,
                slideId,
                parentId,
              })),
            ],
            signal,
          );
        },
        apply(value, commit = true) {
          const base = controller.snapshotRef.current;
          if (!base || !displayed || !selected) return;
          try {
            controller.apply(
              animationStateChange(
                base,
                displayed,
                value,
                stage,
                selected,
                cursor.time,
              ),
              commit,
            );
          } catch (error) {
            onError(error);
            throw error;
          }
          if (!preview)
            setPreview({
              stageIndex: stage,
              stageId: timings[stage].id,
              time: cursor.time,
              startedAt: Date.now(),
              running: false,
            });
        },
      }
    : controller;
  const motionState =
    canvasMode === "playback" && timings[cursor.stageIndex]
      ? (preview ?? {
          stageIndex: cursor.stageIndex,
          stageId: timings[cursor.stageIndex].id,
          time: cursor.time,
          startedAt: 0,
          running: false,
        })
      : null;
  return {
    editingController,
    moveBlockToClick,
    previewBlock,
    openBlockMenu,
    editingStates,
    setEditingStates,
    canvasMode,
    showEdit,
    showPlayback,
    selectBlock(index: number, id: string, navigate = true) {
      const current = controller.snapshotRef.current;
      if (!current?.slide.motion) return;
      const range = blockRange(current.slide.motion, index, id);
      selectOwner(current.slide.motion, index, id);
      setEditingStates(false);
      setSelected(id);
      if (navigate) openBlockInspector(current.slide.motion, index, id);
      seek(index, range.end);
    },
    localSeek(time: number) {
      seek(stage, time);
      setPreview({
        stageIndex: stage,
        stageId: timings[stage].id,
        time,
        startedAt: Date.now(),
        running: false,
      });
    },
    open,
    setOpen,
    active: stage,
    setActive,
    selected,
    setSelected,
    preview,
    motionState,
    cursor,
    setCursor,
    seek,
    setPreview,
    motion,
    draft,
    setDraft,
    slide,
    selection,
    change,
    start,
    next,
    pause,
    play,
    add,
  };
}
export type MotionWorkspace = ReturnType<typeof useMotionWorkspace>;
type Workspace = MotionWorkspace;
function MotionTool({
  label,
  icon,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: MaterialIconName;
}) {
  return (
    <button
      type="button"
      className="motion-tool"
      aria-label={label}
      title={label}
      {...props}
    >
      <MaterialIcon name={icon} />
    </button>
  );
}

const emptyDockMotion: SlideMotion = { stages: [{ id: "enter", tracks: [] }] };
export function MotionDock({ workspace: w }: { workspace: Workspace }) {
  const [height, setHeight] = useState(240);
  const menuId = useId();
  const timeline = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const [viewport, setViewport] = useState(800),
    [zoom, setZoom] = useState(1);
  useEffect(() => {
    const node = timeline.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport(node.clientWidth));
    observer.observe(node);
    setViewport(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  const [drop, setDrop] = useState<{
    destination: number;
    valid: boolean;
  } | null>(null);
  const gesture = useRef<{
    source: number;
    id: string;
    start: number;
    duration: number;
    x: number;
    edge: "left" | "right" | null;
    width: number;
    widths: number[];
    offsets: number[];
    spans: number[];
    scroll: number;
    motion: SlideMotion;
    latest: SlideMotion | null;
  } | null>(null);
  const motion = w.motion ?? emptyDockMotion;
  const dragged = drop && gesture.current;
  const draggedBlock = dragged
    ? blockRange(dragged.motion, dragged.source, dragged.id).block
    : null;
  const draggedElements = new Set(
    draggedBlock?.members.map(
      (member) =>
        dragged!.motion.stages[dragged!.source].tracks.find(
          (track) => track.id === member.trackId,
        )!.elementId,
    ),
  );
  if (draggedBlock?.binding)
    draggedElements.add(draggedBlock.binding.elementId);
  const rows = [
    ...new Set(
      motion.stages.flatMap((s) => [
        ...s.tracks.map((t) => t.elementId),
        ...(s.blocks ?? []).flatMap((b) =>
          b.binding ? [b.binding.elementId] : [],
        ),
      ]),
    ),
  ];
  const durations = motionTimelineSpans(motion);
  const emptyWidth = 192;
  // The handle is 24 px wide and sits 11 px left of the playhead, so it
  // extends 13 px past the exact interval end. Reserve that space instead of
  // letting it enlarge the timeline's scrollable overflow at the final frame.
  const playheadEndGutter = 13;
  const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const pixelsPerMs =
    Math.max(
      0.04,
      (viewport -
        120 -
        playheadEndGutter -
        durations.filter((d) => !d).length * emptyWidth) /
        Math.max(1, totalDuration),
    ) * zoom;
  const widths =
    gesture.current?.widths ??
    durations.map((duration) =>
      duration ? Math.max(80, duration * pixelsPerMs) : emptyWidth,
    );
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((sum, width) => sum + width, 0),
  );
  const layouts = motionTimelineLayout(
    motion,
    widths,
    gesture.current?.spans ?? durations.map((d) => d || 1000),
  );
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  const cursorIndex = Math.min(w.cursor.stageIndex, motion.stages.length - 1);
  const cursorSpan = durations[cursorIndex];
  useLayoutEffect(() => {
    const node = playhead.current,
      preview = w.preview;
    if (!node || !preview?.running) return;
    const index = preview.stageIndex;
    const stage = motion.stages[index];
    if (!stage) return;
    const span = Math.max(1, durations[index]);
    let frame = 0;
    const update = () => {
      const time = Math.min(span, previewTime(preview, Date.now()));
      node.style.left = `${offsets[index] + (widths[index] * time) / span}px`;
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [w.preview, motion, totalWidth, offsets, widths, durations]);
  useLayoutEffect(() => {
    if (playhead.current && !w.preview?.running)
      playhead.current.style.left = `${offsets[cursorIndex] + (widths[cursorIndex] * Math.min(cursorSpan, w.cursor.time)) / Math.max(1, cursorSpan)}px`;
  }, [
    w.preview,
    cursorIndex,
    cursorSpan,
    w.cursor.time,
    totalWidth,
    offsets,
    widths,
  ]);
  function begin(
    event: PointerEvent<HTMLButtonElement>,
    source: number,
    id: string,
    edge: "left" | "right" | null,
  ) {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    setDrop(null);
    w.setActive(source);
    w.setSelected(id);
    if (!w.motion) return;
    const range = blockRange(w.motion, source, id);
    gesture.current = {
      source,
      id,
      start: range.start,
      duration: range.end - range.start,
      x: event.clientX,
      edge,
      width: widths[source],
      widths,
      offsets,
      spans: motionTimelineSpans(w.motion).map((d) => d || 1000),
      scroll: timeline.current?.scrollLeft ?? 0,
      motion: structuredClone(w.motion),
      latest: null,
    };
    // Capture on the stable viewport: moving a block across a gate remounts its lane.
    // Keep the original scale for the entire gesture, including live duration changes.
    timeline.current?.setPointerCapture(event.pointerId);
  }
  function scrub(clientX: number) {
    const node = timeline.current!;
    const position = Math.max(
      0,
      Math.min(
        totalWidth,
        clientX - node.getBoundingClientRect().left + node.scrollLeft - 120,
      ),
    );
    const cursor = timelineCursorAt(position, widths, durations);
    w.seek(cursor.stageIndex, cursor.time);
  }
  function beginScrub(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    scrubbing.current = true;
    timeline.current?.setPointerCapture(event.pointerId);
    scrub(event.clientX);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (scrubbing.current) {
      scrub(event.clientX);
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const delta =
      event.clientX - g.x + (timeline.current!.scrollLeft - g.scroll);
    const position =
      g.offsets[g.source] +
      (g.start / Math.max(1, g.spans[g.source])) * g.width +
      delta;
    const bounds = timeline.current!.getBoundingClientRect();
    const pointerPosition =
      event.clientX - bounds.left + timeline.current!.scrollLeft - 120;
    if (
      !g.edge &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom ||
        pointerPosition < 0 ||
        pointerPosition >= g.widths.reduce((sum, width) => sum + width, 0))
    ) {
      g.latest = null;
      setDrop(null);
      w.setDraft(null);
      return;
    }
    const destination = g.edge
      ? g.source
      : Math.max(
          0,
          g.offsets.reduce(
            (result, offset, index) =>
              pointerPosition >= offset ? index : result,
            0,
          ),
        );
    if (destination !== g.source) {
      // Cross-click transfers use the whole column, regardless of grab offset or row.
      // Keep the source intact while the ghost shows the proposed destination.
      w.setDraft(null);
      try {
        g.latest = editMotionBlock(
          g.motion,
          g.source,
          g.id,
          destination,
          0,
          g.duration,
        );
        setDrop({ destination, valid: true });
      } catch {
        g.latest = null;
        setDrop({ destination, valid: false });
      }
      return;
    }
    setDrop(null);
    const intervalBlock = blockRange(g.motion, g.source, g.id).block;
    const schedule = intervalBlock.presenceSchedule
      ? { stop: intervalBlock.presenceSchedule.end }
      : intervalBlock.effectSchedule;
    if (schedule) {
      if (g.edge === "left") {
        try {
          g.latest = resizeTimelineIntervalStart(
            g.motion,
            g.source,
            g.id,
            position,
            g.widths,
            g.spans,
            !event.altKey,
          );
          w.setDraft(g.latest);
        } catch {
          g.latest = null;
          w.setDraft(null);
        }
        return;
      }
      const span = g.spans[g.source];
      const shift = Math.round((delta / g.width) * span);
      const start = g.edge === "right" ? g.start : Math.max(0, g.start + shift);
      let stop = schedule.stop;
      if (g.edge === "right") {
        const original = motionTimelineLayout(g.motion, g.widths, g.spans).get(
          g.id,
        )!;
        const endPosition =
          g.offsets[g.source] +
          original.left +
          (original.triggerOffset ??
            original.width -
              (intervalBlock.presenceSchedule && schedule.stop.mode === "after"
                ? (transitionDuration(
                    intervalBlock.presenceSchedule.exitTransition,
                  ) /
                    span) *
                  g.width
                : 0)) +
          delta;
        const candidates = g.offsets.flatMap((offset, index) =>
          index > g.source ? [{ offset, index }] : [],
        );
        const nearest = candidates.sort(
          (a, b) =>
            Math.abs(a.offset - endPosition) - Math.abs(b.offset - endPosition),
        )[0];
        if (
          !event.altKey &&
          nearest &&
          (original.end === "click" ||
            Math.abs(nearest.offset - endPosition) <= 12)
        ) {
          stop =
            nearest.index === g.source + 1
              ? { mode: "next-click" }
              : { mode: "click", stageId: g.motion.stages[nearest.index].id };
        } else {
          stop = {
            mode: "after",
            durationMs: Math.max(
              1,
              Math.min(
                86400000,
                Math.round(
                  (((g.source === g.widths.length - 1
                    ? endPosition
                    : Math.min(g.offsets[g.source] + g.width, endPosition)) -
                    g.offsets[g.source]) /
                    g.width) *
                    span,
                ) - start,
              ),
            ),
          };
        }
      }
      try {
        const next = g.edge
          ? intervalBlock.presenceSchedule
            ? editPresenceSchedule(g.motion, g.source, g.id, (s) => {
                s.startOffsetMs = start;
                s.end = stop;
              })
            : resizeEffectTime(g.motion, g.source, g.id, start, stop)
          : editMotionBlock(
              g.motion,
              g.source,
              g.id,
              g.source,
              start,
              g.duration,
            );
        g.latest = next;
        w.setDraft(next);
      } catch {
        g.latest = null;
        w.setDraft(null);
      }
      return;
    }
    const span = g.spans[destination] || g.duration;
    const destinationWidth = g.widths[destination];
    let start =
      g.edge === "right"
        ? g.start
        : g.edge === "left"
          ? Math.max(
              0,
              Math.min(
                g.start + g.duration - 1,
                g.start + Math.round((delta / g.width) * span),
              ),
            )
          : Math.max(
              0,
              Math.round(
                ((position - g.offsets[destination]) / destinationWidth) *
                  (g.spans[destination] || 0),
              ),
            );
    let end =
      g.edge === "left"
        ? g.start + g.duration
        : g.edge === "right"
          ? Math.max(
              g.start + 1,
              g.start + g.duration + Math.round((delta / g.width) * span),
            )
          : start + g.duration;
    const snaps = [
      0,
      ...(g.motion.stages[destination].blocks ?? [])
        .filter((b) => b.id !== g.id)
        .flatMap((b) => {
          const r = blockRange(g.motion, destination, b.id);
          return [r.start, r.end];
        }),
    ];
    if (!event.altKey) {
      const value = g.edge === "right" ? end : start;
      const snap = snaps.find(
        (t) => Math.abs(t - value) <= (span / g.width) * 8,
      );
      if (snap !== undefined) {
        if (g.edge === "right") end = Math.max(start + 1, snap);
        else if (g.edge === "left") start = Math.min(end - 1, snap);
        else {
          start = snap;
          end = start + g.duration;
        }
      }
    }
    try {
      const next = editMotionBlock(
        g.motion,
        g.source,
        g.id,
        destination,
        start,
        end - start,
      );
      g.latest = next;
      w.setDraft(next);
    } catch {
      g.latest = null;
      w.setDraft(null);
    }
  }
  function finish(cancel = false) {
    const g = gesture.current;
    gesture.current = null;
    setDrop(null);
    w.setDraft(null);
    if (g?.latest && !cancel) {
      const destination = g.latest.stages.findIndex((stage) =>
        stage.blocks?.some((b) => b.id === g.id),
      );
      if (destination >= 0) w.setActive(destination);
      if (destination !== g.source) {
        w.setCursor({ stageIndex: destination, time: 0 });
        w.setEditingStates(false);
        w.setPreview(null);
      }
      const expected = JSON.stringify(g.motion);
      w.change((m) => {
        if (JSON.stringify(m) !== expected)
          throw new Error("Motion changed during the gesture. Try again.");
        return g.latest!;
      });
    }
  }
  const addClick = () =>
    w.change((m) => {
      const next = structuredClone(
        m ?? { stages: [{ id: uid(), tracks: [] }] },
      );
      next.stages.splice(w.active + 1, 0, { id: uid(), tracks: [] });
      return next;
    });
  const secondaryControls = (
    <>
      <div
        className="motion-control-group"
        role="group"
        aria-label="Click controls"
      >
        <MotionTool
          label="Add Click"
          icon="timeline-plus-outline"
          onClick={addClick}
        />
      </div>
      <div
        className="motion-control-group motion-zoom"
        role="group"
        aria-label="Timeline scale"
      >
        <MotionTool
          label="Fit timeline"
          icon="arrow-expand-horizontal"
          onClick={() => setZoom(1)}
        />
        <input
          aria-label="Timeline zoom"
          title="Timeline zoom"
          type="range"
          min="1"
          max="5"
          step="0.1"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </div>
    </>
  );
  return (
    <section
      className="motion-dock"
      aria-label="Click Timeline"
      data-mode={w.canvasMode}
      style={{ height }}
    >
      <div
        className="motion-resize"
        role="separator"
        aria-label="Resize Click Timeline"
        aria-orientation="horizontal"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setHeight((h) => Math.min(600, h + 20));
          if (e.key === "ArrowDown") setHeight((h) => Math.max(150, h - 20));
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setHeight((h) => Math.max(150, Math.min(600, h - e.movementY)));
        }}
      />
      <header
        className="motion-header"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            const menu = event.currentTarget.querySelector<HTMLElement>(
              ".motion-overflow-menu:popover-open",
            );
            if (menu) {
              event.preventDefault();
              event.stopPropagation();
              menu.hidePopover();
              event.currentTarget
                .querySelector<HTMLButtonElement>("[popovertarget]")
                ?.focus();
            }
          }
          if (
            (event.key === " " || event.key === "Enter") &&
            (event.target as HTMLElement).closest("button")
          )
            event.stopPropagation();
        }}
      >
        <div className="motion-controls">
          <div
            className="motion-control-group motion-view"
            role="group"
            aria-label="Canvas mode"
          >
            <strong>Click Timeline</strong>
            <div className="motion-view-switch">
              <button
                type="button"
                className="motion-mode-toggle"
                aria-pressed={w.canvasMode === "edit"}
                onClick={w.showEdit}
              >
                Edit
              </button>
              <button
                type="button"
                className="motion-mode-toggle"
                aria-pressed={w.canvasMode === "playback"}
                onClick={w.showPlayback}
                disabled={!w.motion}
              >
                Playback
              </button>
            </div>
          </div>
          <div
            className="motion-control-group"
            role="group"
            aria-label="Playback controls"
          >
            <MotionTool
              label={w.preview?.running ? "Pause playback" : "Play"}
              icon={w.preview?.running ? "pause" : "play"}
              onClick={w.play}
              disabled={!w.motion}
            />
            <MotionTool
              label="Advance to next click (Space)"
              icon="skip-next"
              onClick={w.next}
              disabled={!w.motion}
            />
          </div>
          {viewport < 650 ? (
            <>
              <MotionTool
                label="More Click Timeline controls"
                icon="dots-horizontal"
                popoverTarget={menuId}
              />
              <div
                id={menuId}
                popover="auto"
                className="motion-overflow-menu"
                aria-label="More Click Timeline controls"
              >
                {secondaryControls}
              </div>
            </>
          ) : (
            secondaryControls
          )}
        </div>
        <MotionTool
          label="Close Click Timeline"
          icon="close"
          onClick={() => w.setOpen(false)}
        />
      </header>
      <div
        ref={timeline}
        className="motion-timeline"
        onPointerMove={move}
        onPointerUp={() => {
          scrubbing.current = false;
          finish();
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
          finish(true);
        }}
        onLostPointerCapture={() => {
          scrubbing.current = false;
          if (gesture.current) finish(true);
        }}
      >
        <div
          className="motion-timeline-content"
          style={{ width: totalWidth + playheadEndGutter }}
        >
          {drop && (
            <div
              className={`motion-drop-target ${drop.valid ? "" : "invalid"}`}
              data-drop-stage={drop.destination}
              data-drop-valid={drop.valid}
              aria-hidden="true"
              style={{
                left: offsets[drop.destination],
                width: widths[drop.destination],
              }}
            />
          )}
          <div className="motion-stage-headings">
            {motion.stages.map((s, i) => (
              <button
                key={s.id}
                style={{ width: widths[i] }}
                aria-pressed={w.active === i}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (i > 0 && window.confirm(`Remove Click ${i}?`))
                    w.change((m) => mergeMotionStages(m!, i));
                }}
                onClick={() => {
                  w.seek(i, 0);
                  w.setSelected(null);
                }}
              >
                {i === 0 ? "Slide start" : `Click ${i}`}
              </button>
            ))}
          </div>
          <div
            className="motion-ruler"
            aria-label="Click Timeline time ruler"
            onPointerDown={beginScrub}
          >
            {motion.stages.map((stage, i) => (
              <div key={stage.id} style={{ width: widths[i] }}>
                {!durations[i] ? (
                  <small>No timed animations</small>
                ) : (
                  (widths[i] >= 240
                    ? [0, 0.25, 0.5, 0.75]
                    : widths[i] >= 120
                      ? [0, 0.5]
                      : [0]
                  ).map((fraction) => (
                    <span key={fraction} style={{ left: fraction * 100 + "%" }}>
                      {((fraction * durations[i]) / 1000).toFixed(2)} s
                    </span>
                  ))
                )}
              </div>
            ))}
          </div>
          <div ref={playhead} className="motion-playhead">
            <div
              className="motion-playhead-handle"
              role="slider"
              tabIndex={0}
              aria-label="Click Timeline playhead"
              aria-valuemin={0}
              aria-valuemax={durations[cursorIndex]}
              aria-valuenow={w.cursor.time}
              onPointerDown={beginScrub}
              onKeyDown={(event) => {
                const index = Math.min(
                    w.cursor.stageIndex,
                    motion.stages.length - 1,
                  ),
                  duration = durations[index];
                const time =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? duration
                      : event.key === "ArrowLeft"
                        ? Math.max(
                            0,
                            w.cursor.time - (event.shiftKey ? 100 : 10),
                          )
                        : event.key === "ArrowRight"
                          ? Math.min(
                              duration,
                              w.cursor.time + (event.shiftKey ? 100 : 10),
                            )
                          : null;
                if (time !== null) {
                  event.preventDefault();
                  w.seek(index, time);
                }
              }}
            />
          </div>
          {rows.map((id) => (
            <div className="motion-row" key={id}>
              <span className="motion-row-name">
                {w.slide
                  ? findElement(w.slide, id)?.content?.type === "text"
                    ? (findElement(w.slide, id)?.name ?? "Text")
                    : (findElement(w.slide, id)?.name ?? "Element")
                  : "Element"}
              </span>
              {motion.stages.map((s, i) => (
                <div
                  key={s.id}
                  className="motion-stage-cell"
                  onPointerDown={beginScrub}
                  style={{
                    width: widths[i],
                    height:
                      Math.max(
                        1,
                        ...motion.stages.flatMap((stage) =>
                          (stage.blocks ?? [])
                            .filter(
                              (b) =>
                                b.binding?.elementId === id ||
                                b.members.some(
                                  (m) =>
                                    stage.tracks.find((t) => t.id === m.trackId)
                                      ?.elementId === id,
                                ),
                            )
                            .map((b) => layouts.get(b.id)!.lane + 1),
                        ),
                      ) *
                        36 +
                      6,
                  }}
                >
                  {(s.blocks ?? [])
                    .filter(
                      (b) =>
                        b.binding?.elementId === id ||
                        b.members.some(
                          (m) =>
                            s.tracks.find((t) => t.id === m.trackId)
                              ?.elementId === id,
                        ),
                    )
                    .map((b) => {
                      const layout = layouts.get(b.id)!;
                      const r = blockRange(motion, i, b.id),
                        effectBlock = isEffectTriggerBlock(s, b);
                      return (
                        <div
                          key={b.id}
                          data-effect={b.label}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            w.selectBlock(i, b.id, false);
                            void w.openBlockMenu(
                              i,
                              b.id,
                              event.clientX,
                              event.clientY,
                            );
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ContextMenu" ||
                              (event.shiftKey && event.key === "F10")
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              w.selectBlock(i, b.id, false);
                              void w.openBlockMenu(
                                i,
                                b.id,
                                rect.left + 12,
                                rect.top + 12,
                              );
                            }
                          }}
                          data-end-style={
                            layout.triggerOffset !== undefined
                              ? "timed"
                              : layout.end
                          }
                          className={`motion-block ${w.selected === b.id ? "selected" : ""} ${drop && gesture.current?.id === b.id ? "drag-source" : ""}`}
                          style={{
                            top: 5 + layout.lane * 36,
                            left: layout.left,
                            width: layout.width,
                            zIndex: 1,
                          }}
                        >
                          {layout.enterWidth !== undefined && (
                            <span
                              className="motion-transition-band"
                              style={{ left: 0, width: layout.enterWidth }}
                              title="Enter transition"
                            />
                          )}
                          {layout.exitWidth !== undefined && (
                            <span
                              className="motion-transition-band"
                              style={{ right: 0, width: layout.exitWidth }}
                              title="Exit transition"
                            />
                          )}
                          {
                            <button
                              className="motion-block-resize"
                              aria-label={`Resize start of ${b.label}`}
                              onPointerDown={(e) => begin(e, i, b.id, "left")}
                            />
                          }
                          <button
                            aria-label={`${b.label} animation`}
                            onClick={() => {
                              w.selectBlock(i, b.id, false);
                            }}
                            onPointerDown={(e) => begin(e, i, b.id, null)}
                          >
                            {effectBlock && (
                              <span
                                className="motion-block-kind"
                                aria-hidden="true"
                              >
                                fx
                              </span>
                            )}
                            {b.label}
                            {b.effectSchedule && (
                              <small>
                                {layout.end === "timed" &&
                                b.effectSchedule.stop.mode === "after"
                                  ? ` · ${b.effectSchedule.stop.durationMs / 1000}s`
                                  : layout.end === "continuous"
                                    ? " · continuous"
                                    : " · click-linked"}
                              </small>
                            )}
                            <span
                              className="motion-state-hints"
                              aria-label={
                                blockStateTimes(motion, i, b.id).length +
                                " states"
                              }
                            >
                              {blockStateTimes(motion, i, b.id)
                                .slice(1, -1)
                                .map((at) => (
                                  <span
                                    key={at}
                                    style={{
                                      left:
                                        ((at - r.start) / (r.end - r.start)) *
                                          100 +
                                        "%",
                                    }}
                                  >
                                    ·
                                  </span>
                                ))}
                            </span>
                          </button>
                          {layout.triggerOffset !== undefined && (
                            <span
                              className="motion-interval-trigger"
                              style={{ left: layout.triggerOffset }}
                              title="End event starts Exit"
                            />
                          )}
                          {
                            <button
                              className={`motion-block-resize motion-block-end-${layout.triggerOffset !== undefined ? "timed" : layout.end}`}
                              aria-label={`Resize end of ${b.label}`}
                              onPointerDown={(e) => begin(e, i, b.id, "right")}
                            ></button>
                          }
                        </div>
                      );
                    })}
                  {drop?.destination === i &&
                    dragged &&
                    draggedBlock &&
                    draggedElements.has(id) && (
                      <div
                        className={`motion-block motion-drop-ghost ${drop.valid ? "" : "invalid"}`}
                        data-drop-duration={dragged.duration}
                        aria-hidden="true"
                        style={{
                          left: 0,
                          top: 5,
                          width:
                            (draggedBlock.effectSchedule ||
                              draggedBlock.presenceSchedule) &&
                            dragged.latest
                              ? motionTimelineLayout(
                                  dragged.latest,
                                  widths,
                                  dragged.spans,
                                ).get(dragged.id)!.width
                              : Math.max(
                                  24,
                                  (widths[i] * dragged.duration) /
                                    Math.max(
                                      dragged.duration,
                                      dragged.spans[i],
                                    ),
                                ),
                        }}
                      >
                        {draggedBlock.label}
                      </div>
                    )}
                </div>
              ))}
            </div>
          ))}
          {!rows.length && (
            <p>
              Select an Element and add Motion, or schedule an Effect in the
              Effects sidebar.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
