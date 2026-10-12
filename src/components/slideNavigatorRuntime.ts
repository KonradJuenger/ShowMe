import type { SlideSelectionOptions } from "../core/slideCommands";
import type {
  SlideDropTarget,
  SlideHierarchyDeck,
} from "../core/slideHierarchy";

export interface SlideNavigatorSnapshot {
  deck: SlideHierarchyDeck;
  slide: { id: string };
}

export interface SlideNavigatorRuntime {
  deckId: string;
  getSnapshot: () => SlideNavigatorSnapshot | null;
  getSelectedSlides: () => string[];
  selectSlide: (id: string, options?: SlideSelectionOptions) => Promise<void>;
  prepareSlideDrag: (id: string) => Promise<void>;
  activateSlideDragSelection: (id: string) => void;
  getPreparedSlideTransfer: (id: string) => unknown | null;
  moveSlides: (
    ids: readonly string[],
    target: SlideDropTarget,
  ) => void | Promise<void>;
  dropSlideTransfer: (
    input: unknown,
    target: SlideDropTarget,
  ) => Promise<void>;
}

let runtime: SlideNavigatorRuntime | null = null;

export function registerSlideNavigatorRuntime(value: SlideNavigatorRuntime) {
  runtime = value;
}

export function unregisterSlideNavigatorRuntime(value: SlideNavigatorRuntime) {
  if (runtime === value) runtime = null;
}

export function getSlideNavigatorRuntime() {
  return runtime;
}
