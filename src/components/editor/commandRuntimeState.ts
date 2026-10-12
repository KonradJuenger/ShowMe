import type {
  CommandContext,
  HiddenState,
} from "../../core/commandRegistry";
import type { SlideMeta } from "../../core/slideMetadata";

export interface SlideCommandSnapshot {
  deck: {
    id: string;
    slideIds: string[];
    slideMeta: Record<string, SlideMeta>;
  };
  slide: { id: string };
}

export interface SlideCommandRuntime {
  getSnapshot(): SlideCommandSnapshot | null;
  isBusy(): boolean;
  getSelectedSlides(): string[];
  hasSlideClipboard(): boolean;
  selectSlide(id: string): Promise<void>;
  addSlide(): Promise<void>;
  duplicateSlides(): Promise<void>;
  copySlides(): Promise<void>;
  pasteSlides(): Promise<void>;
  deleteSlides(): Promise<void>;
  hideSlides(): void | Promise<void>;
  unhideSlides(): void | Promise<void>;
}

let slideRuntime: SlideCommandRuntime | null = null;

export function registerSlideCommandRuntime(runtime: SlideCommandRuntime) {
  slideRuntime = runtime;
}

export function unregisterSlideCommandRuntime(runtime: SlideCommandRuntime) {
  if (slideRuntime === runtime) slideRuntime = null;
}

export function getSlideCommandRuntime() {
  return slideRuntime;
}

function currentHiddenState(
  slideIds: string[],
  snapshot: SlideCommandSnapshot,
): HiddenState {
  if (!slideIds.length) return "none";
  const hidden = slideIds.filter(
    (id) => snapshot.deck.slideMeta[id]?.hidden ?? false,
  ).length;
  return hidden === 0 ? "none" : hidden === slideIds.length ? "all" : "some";
}

export function revalidateCommandContext(
  context: CommandContext,
): CommandContext | null {
  if (
    context.kind !== "slide-selection" &&
    context.kind !== "slide-rail-empty"
  )
    return null;

  const runtime = slideRuntime;
  const snapshot = runtime?.getSnapshot() ?? null;
  if (
    !runtime ||
    !snapshot ||
    runtime.isBusy() ||
    context.deckId !== snapshot.deck.id ||
    context.currentSlideId !== snapshot.slide.id
  )
    return null;

  const validSlideIds = context.slideIds.filter((id) =>
    snapshot.deck.slideIds.includes(id),
  );
  if (
    context.kind === "slide-selection" &&
    validSlideIds.length !== context.slideIds.length
  )
    return null;

  if (context.kind === "slide-selection") {
    const live = runtime.getSelectedSlides();
    if (
      live.length !== context.slideIds.length ||
      live.some((id, index) => id !== context.slideIds[index])
    )
      return null;
  }

  return {
    ...context,
    slideIds: validSlideIds,
    hasObjectClipboard: false,
    hasSlideClipboard: runtime.hasSlideClipboard(),
    canGroup: false,
    canUngroup: false,
    canDeleteSlides: snapshot.deck.slideIds.length > 1,
    hiddenState: currentHiddenState(validSlideIds, snapshot),
    frameHasContent: false,
  };
}
