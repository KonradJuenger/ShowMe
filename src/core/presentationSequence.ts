import { slideHierarchyRows } from "./slideHierarchy";
import type { SlideMeta } from "./slideMetadata";
import type { TransitionDefaults } from "./slideTransitions";

export interface PresentationDeckSequence {
  slideIds: string[];
  slideMeta: Record<string, SlideMeta>;
  transitionDefaults?: TransitionDefaults;
}

export interface PresentationSequence {
  slideIds: string[];
  index: number | null;
  activeSlideId: string | null;
}

export function getPresentationSlideIds(
  deck: PresentationDeckSequence,
): string[] {
  return slideHierarchyRows(deck)
    .map((row) => row.id)
    .filter((id) => !deck.slideMeta[id].hidden);
}

export function getPresentationIndex(
  deck: PresentationDeckSequence,
  slideId: string,
): number | null {
  const index = getPresentationSlideIds(deck).indexOf(slideId);
  return index < 0 ? null : index;
}

export function reconcilePresentationSequence(
  deck: PresentationDeckSequence,
  currentSlideId: string | null,
): PresentationSequence {
  const slideIds = getPresentationSlideIds(deck);
  if (!slideIds.length) return { slideIds, index: null, activeSlideId: null };

  if (currentSlideId) {
    const visibleIndex = slideIds.indexOf(currentSlideId);
    if (visibleIndex >= 0)
      return { slideIds, index: visibleIndex, activeSlideId: currentSlideId };

    const orderedIds = slideHierarchyRows(deck).map((row) => row.id);
    const currentIndex = orderedIds.indexOf(currentSlideId);
    if (currentIndex >= 0) {
      const visible = new Set(slideIds);
      for (let index = currentIndex + 1; index < orderedIds.length; index++) {
        const id = orderedIds[index];
        if (visible.has(id))
          return { slideIds, index: slideIds.indexOf(id), activeSlideId: id };
      }
      for (let index = currentIndex - 1; index >= 0; index--) {
        const id = orderedIds[index];
        if (visible.has(id))
          return { slideIds, index: slideIds.indexOf(id), activeSlideId: id };
      }
    }
  }

  return { slideIds, index: 0, activeSlideId: slideIds[0] };
}
