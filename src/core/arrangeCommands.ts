import { translateElements, type EditorSnapshot } from "./editorCommands";
import {
  elementBoundsInScope,
  selectionBoundsInScope,
} from "./selectionGeometry";
export function alignSelection(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  scopeId: string,
  axis: "left" | "center" | "right" | "top" | "middle" | "bottom",
) {
  if (!ids.length) return snapshot;
  const selectionBounds = selectionBoundsInScope(snapshot.slide, ids, scopeId);
  const entries = ids.map((id) => ({
    id,
    bounds: elementBoundsInScope(snapshot.slide, id, scopeId),
  }));
  let next = snapshot;
  for (const { id, bounds } of entries) {
    let dx = 0;
    let dy = 0;
    if (axis === "left")
      dx = (ids.length > 1 ? selectionBounds.x : 0) - bounds.x;
    else if (axis === "right")
      dx =
        (ids.length > 1
          ? selectionBounds.x + selectionBounds.width
          : snapshot.deck.width) -
        (bounds.x + bounds.width);
    else if (axis === "top")
      dy = (ids.length > 1 ? selectionBounds.y : 0) - bounds.y;
    else if (axis === "bottom")
      dy =
        (ids.length > 1
          ? selectionBounds.y + selectionBounds.height
          : snapshot.deck.height) -
        (bounds.y + bounds.height);
    else if (axis === "center")
      dx =
        (ids.length > 1
          ? selectionBounds.x + selectionBounds.width / 2
          : snapshot.deck.width / 2) -
        (bounds.x + bounds.width / 2);
    else
      dy =
        (ids.length > 1
          ? selectionBounds.y + selectionBounds.height / 2
          : snapshot.deck.height / 2) -
        (bounds.y + bounds.height / 2);
    next = translateElements(next, [id], dx, dy, scopeId);
  }
  return next;
}

export function distributeSelection(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  scopeId: string,
  axis: "evenly" | "horizontal" | "vertical",
) {
  if (ids.length < 3) return snapshot;
  const distribute = (
    current: EditorSnapshot,
    direction: "horizontal" | "vertical",
  ) => {
    const entries = ids
      .map((id) => ({
        id,
        bounds: elementBoundsInScope(snapshot.slide, id, scopeId),
      }))
      .sort((left, right) =>
        direction === "horizontal"
          ? left.bounds.x - right.bounds.x
          : left.bounds.y - right.bounds.y,
      );
    const first = entries[0]!.bounds;
    const last = entries[entries.length - 1]!.bounds;
    const extent =
      direction === "horizontal"
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
    const occupied = entries.reduce(
      (sum, entry) =>
        sum +
        (direction === "horizontal" ? entry.bounds.width : entry.bounds.height),
      0,
    );
    const gap = (extent - occupied) / (entries.length - 1);
    let cursor = direction === "horizontal" ? first.x : first.y;
    let next = current;
    for (const entry of entries) {
      const position =
        direction === "horizontal" ? entry.bounds.x : entry.bounds.y;
      const delta = cursor - position;
      next = translateElements(
        next,
        [entry.id],
        direction === "horizontal" ? delta : 0,
        direction === "vertical" ? delta : 0,
        scopeId,
      );
      cursor +=
        (direction === "horizontal"
          ? entry.bounds.width
          : entry.bounds.height) + gap;
    }
    return next;
  };

  let next = snapshot;
  if (axis !== "vertical") next = distribute(next, "horizontal");
  if (axis !== "horizontal") next = distribute(next, "vertical");
  return next;
}
