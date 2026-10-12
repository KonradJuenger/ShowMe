import { useEffect, useRef, type RefObject } from "react";
import {
  COMMAND_IDS,
  resolveContextMenuItems,
  type CommandContext,
  type CommandId,
  type ContextMenuItemDescriptor,
} from "../core/commandRegistry";
import type { EditorSnapshot } from "../core/editorCommands";
import {
  findElement,
  isEditableScope,
  locateElement,
} from "../core/scene";
import { isMediaContent } from "../core/media";
import {
  closeContextMenu,
  isContextMenuOpen,
  isContextMenuSuppressed,
  showContextMenu,
} from "../platform/contextMenu";
import {
  resolveCanvasHitTarget,
  type CanvasSelection,
} from "./editorCanvasCoordinator";
import type { useSelectionActions } from "./editor/useSelectionActions";
import type {
  TextCommandContext,
  TextEditingController,
} from "./editor/useTextEditing";

type SelectionActions = ReturnType<typeof useSelectionActions>;

const supportedObjectCommands = new Set<CommandId>([
  COMMAND_IDS.objectCut,
  COMMAND_IDS.objectCopy,
  COMMAND_IDS.objectPaste,
  COMMAND_IDS.objectDuplicate,
  COMMAND_IDS.objectGroup,
  COMMAND_IDS.objectUngroup,
  COMMAND_IDS.objectBringFront,
  COMMAND_IDS.objectBringForward,
  COMMAND_IDS.objectSendBackward,
  COMMAND_IDS.objectSendBack,
  COMMAND_IDS.objectDelete,
]);

const supportedCanvasCommands = new Set<CommandId>([
  COMMAND_IDS.objectPaste,
  COMMAND_IDS.canvasSelectAll,
  COMMAND_IDS.rulersShow,
  COMMAND_IDS.rulersHide,
  COMMAND_IDS.guidesClear,
]);

const supportedTextCommands = new Set<CommandId>([
  COMMAND_IDS.textCut,
  COMMAND_IDS.textCopy,
  COMMAND_IDS.textPaste,
  COMMAND_IDS.textSelectAll,
]);

const supportedMediaCommands = new Set<CommandId>([
  COMMAND_IDS.mediaReplace,
  COMMAND_IDS.mediaFit,
  COMMAND_IDS.mediaFill,
  COMMAND_IDS.mediaEditCrop,
  COMMAND_IDS.mediaResetCrop,
]);

export interface MediaCommandActions {
  replace(): void | Promise<void>;
  setRule(elementId: string, rule: "fit" | "fill"): void | Promise<void>;
  editFrame(elementId: string): void | Promise<void>;
  reset(elementId: string): void | Promise<void>;
}

function sameSelection(
  left: CanvasSelection,
  right: CanvasSelection,
) {
  return (
    left.scopeId === right.scopeId &&
    left.elementIds.length === right.elementIds.length &&
    left.elementIds.every((id, index) => id === right.elementIds[index])
  );
}

function objectCommandContext(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  actions: SelectionActions,
  hasObjectClipboard: boolean,
): CommandContext {
  const editable =
    !!selection.scopeId &&
    isEditableScope(snapshot.slide, snapshot.deck, selection.scopeId);
  const objectIds = editable ? [...selection.elementIds] : [];
  const single =
    objectIds.length === 1 ? findElement(snapshot.slide, objectIds[0]) : null;
  const media =
    single && isMediaContent(single.content) ? single.content : null;
  return {
    kind: media ? (media.type === "video" ? "video" : "image") : "object",
    deckId: snapshot.deck.id,
    currentSlideId: snapshot.slide.id,
    objectIds,
    primaryObjectId: objectIds[0],
    scopeId: selection.scopeId ?? undefined,
    slideIds: [],
    hasObjectClipboard,
    hasSlideClipboard: false,
    canGroup: editable && actions.canFrame(selection),
    canUngroup: editable && actions.canUnframe(selection),
    canDeleteSlides: false,
    hiddenState: "none",
    frameHasContent: false,
  };
}

function canvasCommandContext(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  hasObjectClipboard: boolean,
): CommandContext {
  return {
    kind: "canvas",
    deckId: snapshot.deck.id,
    currentSlideId: snapshot.slide.id,
    objectIds: [],
    scopeId: selection.scopeId ?? undefined,
    slideIds: [],
    hasObjectClipboard,
    hasSlideClipboard: false,
    canGroup: false,
    canUngroup: false,
    canDeleteSlides: false,
    hiddenState: "none",
    frameHasContent: false,
  };
}

function textCommandContext(
  captured: TextCommandContext,
): CommandContext {
  return {
    kind: "text-edit",
    deckId: captured.documentId,
    currentSlideId: captured.slideId,
    objectIds: [captured.elementId],
    primaryObjectId: captured.elementId,
    scopeId: captured.scopeId,
    slideIds: [],
    hasObjectClipboard: false,
    hasSlideClipboard: false,
    canGroup: false,
    canUngroup: false,
    canDeleteSlides: false,
    hiddenState: "none",
    frameHasContent: false,
    textValue: captured.text,
    textSelection: { ...captured.selection },
  };
}

function cleanMenu(
  items: ContextMenuItemDescriptor[],
  allowed: ReadonlySet<CommandId>,
) {
  return items
    .filter(
      (item) =>
        item.type === "separator" || allowed.has(item.commandId),
    )
    .map((item) => {
      if (item.type === "separator") return item;
      if (item.commandId === COMMAND_IDS.objectGroup)
        return { ...item, label: "Frame" };
      if (item.commandId === COMMAND_IDS.objectUngroup)
        return { ...item, label: "Unframe" };
      if (item.commandId === COMMAND_IDS.mediaEditCrop)
        return { ...item, label: "Edit Frame" };
      if (item.commandId === COMMAND_IDS.mediaResetCrop)
        return { ...item, label: "Reset Media" };
      return item;
    })
    .filter(
      (item, index, all) =>
        item.type !== "separator" ||
        (index > 0 &&
          index < all.length - 1 &&
          all[index - 1]?.type !== "separator" &&
          all[index + 1]?.type !== "separator"),
    );
}

export function structuralMenuItems(
  snapshot: EditorSnapshot,
  selection: CanvasSelection,
  actions: SelectionActions,
  hasObjectClipboard = false,
): ContextMenuItemDescriptor[] {
  const context = objectCommandContext(
    snapshot,
    selection,
    actions,
    hasObjectClipboard,
  );
  return cleanMenu(
    resolveContextMenuItems(context),
    new Set([...supportedObjectCommands, ...supportedMediaCommands]),
  );
}

function selectionForTarget(
  snapshot: EditorSnapshot,
  current: CanvasSelection,
  targetId: string,
): CanvasSelection | null {
  const activeScope = current.scopeId ?? snapshot.slide.nodes[0]?.id ?? null;
  if (!activeScope) return null;
  const target = resolveCanvasHitTarget(
    snapshot.slide,
    activeScope,
    targetId,
  );
  if (!target || !isEditableScope(snapshot.slide, snapshot.deck, target))
    return null;
  if (current.scopeId === activeScope && current.elementIds.includes(target))
    return current;
  const location = locateElement(snapshot.slide, target);
  if (!location) return null;
  return { elementIds: [target], scopeId: location.parentId };
}

async function executeObjectCommand(
  command: CommandId,
  actions: SelectionActions,
  selection: CanvasSelection,
) {
  switch (command) {
    case COMMAND_IDS.objectCut:
      await actions.cutSelection(selection);
      return;
    case COMMAND_IDS.objectCopy:
      await actions.copySelection(selection);
      return;
    case COMMAND_IDS.objectPaste:
      await actions.pasteSelection();
      return;
    case COMMAND_IDS.objectDuplicate:
      await actions.duplicateSelection(selection);
      return;
    case COMMAND_IDS.objectGroup:
      await actions.frameSelection(selection);
      return;
    case COMMAND_IDS.objectUngroup:
      await actions.unframeSelection(selection);
      return;
    case COMMAND_IDS.objectBringFront:
      await actions.reorderSelection("front", selection);
      return;
    case COMMAND_IDS.objectBringForward:
      await actions.reorderSelection("forward", selection);
      return;
    case COMMAND_IDS.objectSendBackward:
      await actions.reorderSelection("backward", selection);
      return;
    case COMMAND_IDS.objectSendBack:
      await actions.reorderSelection("back", selection);
      return;
    case COMMAND_IDS.objectDelete:
      await actions.deleteSelection(selection);
      return;
    case COMMAND_IDS.canvasSelectAll:
      actions.selectAll(selection);
      return;
  }
}

async function executeCommand(
  command: CommandId,
  actions: SelectionActions,
  mediaActions: MediaCommandActions | undefined,
  selection: CanvasSelection,
) {
  if (
    supportedObjectCommands.has(command) ||
    supportedCanvasCommands.has(command)
  ) {
    await executeObjectCommand(command, actions, selection);
    return;
  }
  const id = selection.elementIds.length === 1 ? selection.elementIds[0] : null;
  if (!id || !mediaActions) return;
  switch (command) {
    case COMMAND_IDS.mediaReplace:
      await mediaActions.replace();
      return;
    case COMMAND_IDS.mediaFit:
      await mediaActions.setRule(id, "fit");
      return;
    case COMMAND_IDS.mediaFill:
      await mediaActions.setRule(id, "fill");
      return;
    case COMMAND_IDS.mediaEditCrop:
      await mediaActions.editFrame(id);
      return;
    case COMMAND_IDS.mediaResetCrop:
      await mediaActions.reset(id);
      return;
  }
}

async function executeTextCommand(
  command: CommandId,
  textEditing: TextEditingController,
  context: TextCommandContext,
) {
  switch (command) {
    case COMMAND_IDS.textCut:
    case COMMAND_IDS.textCopy:
    case COMMAND_IDS.textPaste:
    case COMMAND_IDS.textSelectAll:
      await textEditing.executeCommand(command, context);
      return;
  }
}

export function EditorCommandController({
  snapshotRef,
  selection,
  onSelectionChange,
  actions,
  mediaActions,
  textEditing,
  viewActions,
  busy,
  onError,
}: {
  snapshotRef: RefObject<EditorSnapshot | null>;
  selection: CanvasSelection;
  onSelectionChange(selection: CanvasSelection): void;
  actions: SelectionActions;
  mediaActions?: MediaCommandActions;
  textEditing?: TextEditingController;
  viewActions?: {
    showRulers: boolean;
    setShowRulers(show: boolean): void;
    clearGuides(): void | Promise<unknown>;
  };
  busy: boolean;
  onError(error: unknown): void;
}) {
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const mediaActionsRef = useRef(mediaActions);
  mediaActionsRef.current = mediaActions;
  const textEditingRef = useRef(textEditing);
  textEditingRef.current = textEditing;
  const viewActionsRef = useRef(viewActions);
  viewActionsRef.current = viewActions;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const requestRef = useRef(0);

  useEffect(() => {
    const pendingRequest = requestRef;

    const show = async (
      items: ContextMenuItemDescriptor[],
      x: number,
      y: number,
    ) => {
      closeContextMenu();
      if (!items.some((item) => item.type === "command")) return null;
      return showContextMenu({ items, x, y });
    };

    const openText = async (
      x: number,
      y: number,
    ) => {
      const activeTextEditing = textEditingRef.current;
      if (!activeTextEditing) return;
      const captured = activeTextEditing.captureCommandContext();
      if (!captured) return;
      const token = ++requestRef.current;
      const context = textCommandContext(captured);
      const items = cleanMenu(
        resolveContextMenuItems(context),
        supportedTextCommands,
      );
      const command = await show(items, x, y);
      if (!command || token !== requestRef.current) return;
      await executeTextCommand(command, activeTextEditing, captured);
    };

    const openObjects = async (
      target: HTMLElement,
      x: number,
      y: number,
      explicitSelection?: CanvasSelection,
    ) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || busyRef.current || isContextMenuSuppressed()) return;
      let captured = explicitSelection ?? selectionRef.current;

      if (!explicitSelection) {
        const overlay = target.closest("[data-selection-overlay]");
        if (!overlay) {
          const hit = target.closest<HTMLElement>("[data-element-id]");
          const id = hit?.dataset.elementId;
          if (!id) return;
          const resolved = selectionForTarget(snapshot, captured, id);
          if (!resolved) return;
          captured = resolved;
        }
      }

      if (!captured.elementIds.length || !captured.scopeId) return;
      if (!sameSelection(selectionRef.current, captured)) {
        selectionRef.current = captured;
        onSelectionChange(captured);
      }

      const token = ++requestRef.current;
      const hasClipboard = await actionsRef.current.hasClipboard();
      if (
        token !== requestRef.current ||
        !sameSelection(selectionRef.current, captured)
      )
        return;
      const context = objectCommandContext(
        snapshot,
        captured,
        actionsRef.current,
        hasClipboard,
      );
      const items = cleanMenu(
        resolveContextMenuItems(context),
        new Set([...supportedObjectCommands, ...supportedMediaCommands]),
      );
      const command = await show(items, x, y);
      if (
        !command ||
        token !== requestRef.current ||
        !sameSelection(selectionRef.current, captured)
      )
        return;
      await executeCommand(
        command,
        actionsRef.current,
        mediaActionsRef.current,
        captured,
      );
    };

    const openCanvas = async (x: number, y: number) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || busyRef.current || isContextMenuSuppressed()) return;
      const captured: CanvasSelection = {
        elementIds: [],
        scopeId: selectionRef.current.scopeId,
      };
      const token = ++requestRef.current;
      const hasClipboard = await actionsRef.current.hasClipboard();
      if (
        token !== requestRef.current ||
        selectionRef.current.scopeId !== captured.scopeId
      )
        return;
      const context = canvasCommandContext(
        snapshot,
        captured,
        hasClipboard,
      );
      context.showRulers = viewActionsRef.current?.showRulers ?? false;
      const items = cleanMenu(
        resolveContextMenuItems(context),
        supportedCanvasCommands,
      );
      const command = await show(items, x, y);
      if (
        !command ||
        token !== requestRef.current ||
        selectionRef.current.scopeId !== captured.scopeId
      )
        return;
      if (
        command === COMMAND_IDS.rulersShow ||
        command === COMMAND_IDS.rulersHide
      ) {
        viewActionsRef.current?.setShowRulers(
          command === COMMAND_IDS.rulersShow,
        );
        return;
      }
      if (command === COMMAND_IDS.guidesClear) {
        await viewActionsRef.current?.clearGuides();
        return;
      }
      await executeCommand(
        command,
        actionsRef.current,
        mediaActionsRef.current,
        captured,
      );
    };

    const contextmenu = (event: MouseEvent) => {
      if (busyRef.current || isContextMenuSuppressed()) return;
      const target =
        event.target instanceof Element ? (event.target as HTMLElement) : null;
      if (!target?.closest("[data-editor-canvas], .stage")) return;

      if (target.closest("[data-text-editor]")) {
        event.preventDefault();
        event.stopPropagation();
        void openText(event.clientX, event.clientY).catch(onErrorRef.current);
        return;
      }

      if (
        target.closest('input, select, textarea, [contenteditable="true"]')
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      const hit =
        target.closest("[data-selection-overlay]") ||
        target.closest("[data-element-id]");
      if (hit)
        void openObjects(target, event.clientX, event.clientY).catch(onErrorRef.current);
      else void openCanvas(event.clientX, event.clientY).catch(onErrorRef.current);
    };

    const keydown = (event: KeyboardEvent) => {
      if (busyRef.current || isContextMenuOpen()) return;
      const target = event.target as HTMLElement | null;
      const isContextKey =
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10");

      if (target?.closest("[data-text-editor]")) {
        if (isContextKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const rect = target.getBoundingClientRect();
          void openText(
            rect.left + 12,
            rect.top + 12,
          ).catch(onErrorRef.current);
        }
        return;
      }

      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable)
      )
        return;
      if (
        !target?.closest(".template-rail") &&
        target?.closest(
          '[data-context-target="slide"], [data-context-target="slide-rail-empty"]',
        )
      )
        return;

      if (isContextKey && target?.closest(".motion-block")) return;
      if (isContextKey) {
        const snapshot = snapshotRef.current;
        const current = selectionRef.current;
        if (!snapshot || !current.elementIds.length) return;
        const anchor = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-editor-canvas] [data-element-id]",
          ),
        ).find((node) => node.dataset.elementId === current.elementIds[0]);
        if (!anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const rect = anchor.getBoundingClientRect();
        void openObjects(
          anchor,
          rect.left + 12,
          rect.top + 12,
          current,
        ).catch(onErrorRef.current);
        return;
      }

      const modifier = event.ctrlKey || event.metaKey;
      const lower = event.key.toLowerCase();
      let command: CommandId | null = null;
      if (modifier && lower === "x")
        command = COMMAND_IDS.objectCut;
      else if (modifier && lower === "c")
        command = COMMAND_IDS.objectCopy;
      else if (modifier && lower === "v")
        command = COMMAND_IDS.objectPaste;
      else if (modifier && lower === "d")
        command = COMMAND_IDS.objectDuplicate;
      else if (modifier && lower === "a")
        command = COMMAND_IDS.canvasSelectAll;
      else if (modifier && lower === "g")
        command = event.shiftKey
          ? COMMAND_IDS.objectUngroup
          : COMMAND_IDS.objectGroup;
      else if (event.key === "Delete" || event.key === "Backspace")
        command = COMMAND_IDS.objectDelete;
      if (!command) return;

      const current = selectionRef.current;
      if (
        command !== COMMAND_IDS.objectPaste &&
        command !== COMMAND_IDS.canvasSelectAll &&
        !current.elementIds.length
      )
        return;
      if (!current.scopeId) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      void executeCommand(
        command,
        actionsRef.current,
        mediaActionsRef.current,
        current,
      ).catch(onErrorRef.current);
    };

    document.addEventListener("contextmenu", contextmenu, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      pendingRequest.current++;
      closeContextMenu();
      document.removeEventListener("contextmenu", contextmenu, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [
    onSelectionChange,
    snapshotRef,
  ]);

  return null;
}
