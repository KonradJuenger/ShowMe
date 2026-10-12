import { useEffect } from "react";
import {
  COMMAND_IDS,
  resolveContextMenuItems,
  type CommandContext,
  type HiddenState,
} from "../core/commandRegistry";
import {
  showContextMenu,
  closeContextMenu,
  isContextMenuOpen,
  isContextMenuSuppressed,
} from "../platform/contextMenu";
import {
  executeCommand,
  getSlideCommandRuntime,
} from "./contextMenuRuntime";

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function hiddenState(ids: string[]): HiddenState {
  const runtime = getSlideCommandRuntime();
  const snapshot = runtime?.getSnapshot();
  if (!snapshot || !ids.length) return "none";
  const hidden = ids.filter(
    (id) => snapshot.deck.slideMeta[id]?.hidden ?? false,
  ).length;
  return hidden === 0 ? "none" : hidden === ids.length ? "all" : "some";
}

function baseContext(
  kind: "slide-selection" | "slide-rail-empty",
): CommandContext | null {
  const runtime = getSlideCommandRuntime();
  const snapshot = runtime?.getSnapshot();
  if (!runtime || !snapshot) return null;
  return {
    kind,
    deckId: snapshot.deck.id,
    currentSlideId: snapshot.slide.id,
    objectIds: [],
    slideIds: [],
    hasObjectClipboard: false,
    hasSlideClipboard: runtime.hasSlideClipboard(),
    canGroup: false,
    canUngroup: false,
    canDeleteSlides: snapshot.deck.slideIds.length > 1,
    hiddenState: "none",
    frameHasContent: false,
  };
}

async function slideContext(button: HTMLButtonElement) {
  let runtime = getSlideCommandRuntime();
  const id = button.dataset.slideId;
  if (!runtime || !runtime.getSnapshot() || !id) return null;
  if (!runtime.getSelectedSlides().includes(id)) {
    await runtime.selectSlide(id);
    await nextFrame();
    runtime = getSlideCommandRuntime();
    if (!runtime) return null;
  }
  const base = baseContext("slide-selection");
  if (!base) return null;
  const ids = runtime.getSelectedSlides();
  return {
    ...base,
    slideIds: [...ids],
    primarySlideId: id,
    hiddenState: hiddenState(ids),
    canDeleteSlides: (runtime.getSnapshot()?.deck.slideIds.length ?? 0) > 1,
  } satisfies CommandContext;
}

async function resolvePointerContext(target: HTMLElement) {
  const slideButton = target.closest<HTMLButtonElement>(
    '[data-context-target="slide"]',
  );
  if (slideButton) return slideContext(slideButton);

  const rail = target.closest<HTMLElement>(
    '[data-context-target="slide-rail-empty"]',
  );
  if (rail && !target.closest("button, input, select, textarea"))
    return baseContext("slide-rail-empty");
  return null;
}

export async function dispatchSlideCommand(
  command: (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS],
) {
  const runtime = getSlideCommandRuntime();
  const snapshot = runtime?.getSnapshot();
  if (!runtime || !snapshot) return false;
  const ids = runtime.getSelectedSlides();
  const context: CommandContext = {
    ...(baseContext(
      command === COMMAND_IDS.slideNew || !ids.length
        ? "slide-rail-empty"
        : "slide-selection",
    )!),
    slideIds: [...ids],
    hiddenState: hiddenState(ids),
  };
  return executeCommand(command, context);
}

export function ContextMenuController({
  onError,
}: {
  onError: (error: unknown) => void;
  slidesOnly?: boolean;
}) {
  useEffect(() => {
    let request = 0;

    const open = async (target: HTMLElement, x: number, y: number) => {
      const token = ++request;
      closeContextMenu();
      const context = await resolvePointerContext(target);
      if (!context || token !== request || isContextMenuSuppressed()) return;
      const items = resolveContextMenuItems(context);
      if (!items.some((item) => item.type === "command")) return;
      const command = await showContextMenu({ items, x, y });
      if (command && token === request) await executeCommand(command, context);
    };

    const contextmenu = (event: MouseEvent) => {
      if (isContextMenuSuppressed()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target =
        event.target instanceof Element ? (event.target as HTMLElement) : null;
      if (target?.closest(".template-rail")) return;
      if (
        !target?.closest(
          '[data-context-target="slide"], [data-context-target="slide-rail-empty"]',
        )
      )
        return;
      if (getSlideCommandRuntime()?.isBusy()) return;
      event.preventDefault();
      event.stopPropagation();
      void open(target, event.clientX, event.clientY).catch(onError);
    };

    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".template-rail, [role=dialog]")) return;
      const slideTarget = target?.closest(
        '[data-context-target="slide"], [data-context-target="slide-rail-empty"]',
      );
      if (!slideTarget || isContextMenuOpen() || getSlideCommandRuntime()?.isBusy())
        return;

      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        const anchor = target?.closest<HTMLElement>(
          '[data-context-target="slide"]',
        ) ?? target?.closest<HTMLElement>('[data-context-target="slide-rail-empty"]');
        if (anchor) {
          event.preventDefault();
          event.stopPropagation();
          const rect = anchor.getBoundingClientRect();
          void open(anchor, rect.left + 12, rect.top + 12).catch(onError);
        }
        return;
      }

      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable)
      )
        return;

      const modifier = event.ctrlKey || event.metaKey;
      const lower = event.key.toLowerCase();
      let command: (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS] | null = null;
      if (modifier && lower === "c") command = COMMAND_IDS.slideCopy;
      else if (modifier && lower === "v") command = COMMAND_IDS.slidePaste;
      else if (modifier && lower === "d") command = COMMAND_IDS.slideDuplicate;
      else if (event.key === "Delete" || event.key === "Backspace")
        command = COMMAND_IDS.slideDelete;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void dispatchSlideCommand(command).catch(onError);
    };

    document.addEventListener("contextmenu", contextmenu, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      request++;
      closeContextMenu();
      document.removeEventListener("contextmenu", contextmenu, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [onError]);
  return null;
}
