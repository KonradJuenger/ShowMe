import type { SlideMeta } from "./slideMetadata";

export interface Deck {
  slideIds: string[];
  slideMeta: Record<string, SlideMeta>;
  [key: string]: unknown;
}

export interface SlideSelectionOptions {
  shift?: boolean;
  toggle?: boolean;
}

export function resolveSlideSelection(
  slideIds: string[],
  selected: string[],
  anchor: string | null,
  id: string,
  options: SlideSelectionOptions = {},
) {
  if (options.shift && anchor) {
    const a = slideIds.indexOf(anchor),
      b = slideIds.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return { selected: slideIds.slice(lo, hi + 1), anchor };
    }
  }
  if (options.toggle) {
    const next = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id];
    return { selected: next.length ? next : [id], anchor: id };
  }
  return { selected: [id], anchor: id };
}

export interface SlideInsertion {
  id: string;
  meta?: SlideMeta;
}

export function insertSlidesAfter<T extends Deck>(
  deck: T,
  afterId: string,
  insertions: SlideInsertion[],
): T {
  if (!insertions.length) return deck;
  const ids = [...deck.slideIds],
    after = ids.indexOf(afterId),
    insertAt = after < 0 ? ids.length : after + 1;
  ids.splice(insertAt, 0, ...insertions.map((entry) => entry.id));
  const slideMeta = { ...deck.slideMeta };
  for (const entry of insertions)
    slideMeta[entry.id] = {
      ...(entry.meta ?? {
        templateId: null,
        name: "",
        section: "",
        hidden: false,
      }),
    };
  return { ...deck, slideIds: ids, slideMeta };
}

export function removeSlidesFromDeck<T extends Deck>(
  deck: T,
  removeIds: ReadonlySet<string>,
): T {
  if (!removeIds.size) return deck;
  const slideIds = deck.slideIds.filter((id) => !removeIds.has(id)),
    slideMeta = { ...deck.slideMeta };
  for (const id of removeIds) delete slideMeta[id];
  return { ...deck, slideIds, slideMeta };
}

export function reorderSlideSet<T extends Deck>(
  deck: T,
  movingIds: readonly string[],
  insertionIndex: number,
): T {
  if (!Number.isFinite(insertionIndex))
    throw new Error("Slide insertion index must be finite");
  const movingSet = new Set(movingIds),
    moving = deck.slideIds.filter((id) => movingSet.has(id));
  if (!moving.length) return deck;
  const rawIndex = Math.max(
      0,
      Math.min(deck.slideIds.length, Math.trunc(insertionIndex)),
    ),
    removedBefore = deck.slideIds
      .slice(0, rawIndex)
      .filter((id) => movingSet.has(id)).length,
    remaining = deck.slideIds.filter((id) => !movingSet.has(id)),
    insertAt = Math.max(
      0,
      Math.min(remaining.length, rawIndex - removedBefore),
    ),
    slideIds = [...remaining];
  slideIds.splice(insertAt, 0, ...moving);
  if (slideIds.every((id, index) => id === deck.slideIds[index])) return deck;
  return { ...deck, slideIds };
}

export function setSlidesHidden<T extends Deck>(
  deck: T,
  slideIds: Iterable<string>,
  hidden: boolean,
): T {
  const selected = new Set(slideIds);
  if (!selected.size) return deck;
  const slideMeta = { ...deck.slideMeta };
  let changed = false;
  for (const id of deck.slideIds) {
    if (!selected.has(id)) continue;
    const current = slideMeta[id];
    if (current.hidden === hidden) continue;
    slideMeta[id] = { ...current, hidden };
    changed = true;
  }
  return changed ? { ...deck, slideMeta } : deck;
}
