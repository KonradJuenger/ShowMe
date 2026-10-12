import type { SlideMeta } from "./slideMetadata";

export interface SlideHierarchyDeck {
  slideIds: string[];
  slideMeta: Record<string, SlideMeta>;
}

export interface SlideDropTarget {
  parentId: string | null;
  beforeId: string | null;
}

export type SlideDropMode = "before" | "after" | "inside";

export interface SlideHierarchyRow {
  id: string;
  depth: number;
  hasChildren: boolean;
}

interface HierarchyIndex {
  parentById: Map<string, string | null>;
  childrenByParent: Map<string | null, string[]>;
}

function hierarchyIndex(deck: SlideHierarchyDeck): HierarchyIndex {
  const ids = new Set(deck.slideIds),
    parentById = new Map<string, string | null>(),
    childrenByParent = new Map<string | null, string[]>();
  for (const id of deck.slideIds) {
    const raw = deck.slideMeta[id]?.section ?? "";
    const parentId = raw && raw !== id && ids.has(raw) ? raw : null;
    parentById.set(id, parentId);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(id);
    childrenByParent.set(parentId, children);
  }
  return { parentById, childrenByParent };
}

export function slideParentId(deck: SlideHierarchyDeck, id: string): string | null {
  return hierarchyIndex(deck).parentById.get(id) ?? null;
}

export function slideChildren(deck: SlideHierarchyDeck, parentId: string | null): string[] {
  return [...(hierarchyIndex(deck).childrenByParent.get(parentId) ?? [])];
}

function ancestors(index: HierarchyIndex, id: string): string[] {
  const result: string[] = [],
    seen = new Set<string>([id]);
  let parentId = index.parentById.get(id) ?? null;
  while (parentId && !seen.has(parentId)) {
    result.push(parentId);
    seen.add(parentId);
    parentId = index.parentById.get(parentId) ?? null;
  }
  return result;
}

export function slideDepth(deck: SlideHierarchyDeck, id: string): number {
  return ancestors(hierarchyIndex(deck), id).length;
}

export function normalizeSlideRoots(
  deck: SlideHierarchyDeck,
  slideIds: readonly string[],
): string[] {
  const index = hierarchyIndex(deck),
    selected = new Set(slideIds.filter((id) => index.parentById.has(id)));
  return deck.slideIds.filter(
    (id) =>
      selected.has(id) &&
      !ancestors(index, id).some((parent) => selected.has(parent)),
  );
}

function collectSubtree(
  index: HierarchyIndex,
  rootId: string,
  output: Set<string>,
) {
  if (output.has(rootId)) return;
  output.add(rootId);
  for (const child of index.childrenByParent.get(rootId) ?? [])
    collectSubtree(index, child, output);
}

export function slideSubtreeIds(deck: SlideHierarchyDeck, rootId: string): string[] {
  const index = hierarchyIndex(deck);
  if (!index.parentById.has(rootId)) return [];
  const selected = new Set<string>();
  collectSubtree(index, rootId, selected);
  return deck.slideIds.filter((id) => selected.has(id));
}

export function expandSlideSubtrees(
  deck: SlideHierarchyDeck,
  slideIds: readonly string[],
): string[] {
  const index = hierarchyIndex(deck),
    selected = new Set<string>();
  for (const rootId of normalizeSlideRoots(deck, slideIds))
    collectSubtree(index, rootId, selected);
  return deck.slideIds.filter((id) => selected.has(id));
}

export function slideDropBefore(deck: SlideHierarchyDeck, id: string): SlideDropTarget {
  const index = hierarchyIndex(deck);
  return {
    parentId: index.parentById.get(id) ?? null,
    beforeId: index.parentById.has(id) ? id : null,
  };
}

export function slideDropAfter(deck: SlideHierarchyDeck, id: string): SlideDropTarget {
  const index = hierarchyIndex(deck),
    parentId = index.parentById.get(id) ?? null,
    siblings = index.childrenByParent.get(parentId) ?? [],
    position = siblings.indexOf(id);
  return {
    parentId,
    beforeId: position >= 0 ? (siblings[position + 1] ?? null) : null,
  };
}

export function slideDropTarget(
  deck: SlideHierarchyDeck,
  id: string,
  mode: SlideDropMode,
): SlideDropTarget {
  return mode === "inside"
    ? { parentId: id, beforeId: null }
    : mode === "before"
      ? slideDropBefore(deck, id)
      : slideDropAfter(deck, id);
}

function descendantOf(
  id: string,
  ancestorId: string,
  slideMeta: SlideHierarchyDeck["slideMeta"],
  validIds: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>([id]);
  let parentId = slideMeta[id]?.section ?? "";
  while (parentId && validIds.has(parentId) && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = slideMeta[parentId]?.section ?? "";
  }
  return false;
}

export function moveSlideSubtrees<T extends SlideHierarchyDeck>(
  deck: T,
  movingIds: readonly string[],
  target: SlideDropTarget,
): T {
  const index = hierarchyIndex(deck),
    roots = normalizeSlideRoots(deck, movingIds);
  if (!roots.length) return deck;
  const moving = new Set<string>();
  for (const rootId of roots) collectSubtree(index, rootId, moving);
  if (target.parentId && moving.has(target.parentId)) return deck;
  if (target.beforeId && moving.has(target.beforeId)) return deck;
  if (target.parentId !== null && !index.parentById.has(target.parentId))
    return deck;
  if (target.beforeId) {
    if (!index.parentById.has(target.beforeId)) return deck;
    if ((index.parentById.get(target.beforeId) ?? null) !== target.parentId)
      return deck;
  }

  const movingOrder = deck.slideIds.filter((id) => moving.has(id)),
    remaining = deck.slideIds.filter((id) => !moving.has(id)),
    slideMeta = { ...deck.slideMeta };
  for (const rootId of roots)
    slideMeta[rootId] = {
      ...slideMeta[rootId],
      section: target.parentId ?? "",
    };

  let insertAt = remaining.length;
  if (target.beforeId) {
    insertAt = remaining.indexOf(target.beforeId);
    if (insertAt < 0) return deck;
  } else if (target.parentId) {
    const parentIndex = remaining.indexOf(target.parentId);
    if (parentIndex < 0) return deck;
    const remainingIds = new Set(remaining);
    insertAt = parentIndex + 1;
    while (
      insertAt < remaining.length &&
      descendantOf(remaining[insertAt], target.parentId, slideMeta, remainingIds)
    )
      insertAt++;
  }

  const slideIds = [...remaining];
  slideIds.splice(insertAt, 0, ...movingOrder);
  const sameOrder =
    slideIds.length === deck.slideIds.length &&
    slideIds.every((id, position) => id === deck.slideIds[position]);
  const sameParents = roots.every(
    (id) =>
      (deck.slideMeta[id]?.section ?? "") === (slideMeta[id]?.section ?? ""),
  );
  return sameOrder && sameParents
    ? deck
    : ({ ...deck, slideIds, slideMeta } as T);
}

export function removeSlidesAndRepairHierarchy<T extends SlideHierarchyDeck>(
  deck: T,
  removeIds: ReadonlySet<string>,
): T {
  if (!removeIds.size) return deck;
  const index = hierarchyIndex(deck),
    slideIds = deck.slideIds.filter((id) => !removeIds.has(id)),
    remaining = new Set(slideIds),
    slideMeta = { ...deck.slideMeta };
  for (const id of removeIds) delete slideMeta[id];
  for (const id of slideIds) {
    let parentId = index.parentById.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (parentId && removeIds.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      parentId = index.parentById.get(parentId) ?? null;
    }
    if (parentId && !remaining.has(parentId)) parentId = null;
    const current = slideMeta[id]?.section ?? "";
    const next = parentId ?? "";
    if (current !== next) slideMeta[id] = { ...slideMeta[id], section: next };
  }
  return { ...deck, slideIds, slideMeta } as T;
}

export function slideHierarchyRows(
  deck: SlideHierarchyDeck,
  collapsed: ReadonlySet<string> = new Set(),
): SlideHierarchyRow[] {
  const index = hierarchyIndex(deck),
    rows: SlideHierarchyRow[] = [],
    visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const children = index.childrenByParent.get(id) ?? [];
    rows.push({ id, depth, hasChildren: children.length > 0 });
    if (collapsed.has(id)) {
      const hide = (childId: string) => {
        if (visited.has(childId)) return;
        visited.add(childId);
        for (const nested of index.childrenByParent.get(childId) ?? [])
          hide(nested);
      };
      for (const child of children) hide(child);
      return;
    }
    for (const child of children) visit(child, depth + 1);
  };
  for (const id of index.childrenByParent.get(null) ?? []) visit(id, 0);
  // Malformed cyclic metadata should never hide slides from the navigator.
  for (const id of deck.slideIds) if (!visited.has(id)) visit(id, 0);
  return rows;
}
