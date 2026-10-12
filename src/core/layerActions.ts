import type { Deck } from "./document";
import {
  reparentElements,
  setDeckLayers,
  type EditorSnapshot,
} from "./editorCommands";
import { getChildren, isEditableScope, locateElement } from "./scene";

type Layer = Deck["layers"][number];
export type LayerPatch = Partial<Omit<Layer, "id">>;

const LAYER_PALETTE = [
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#14b8a6",
  "#6366f1",
  "#84cc16",
  "#2563eb",
] as const;

export function addLayer(
  snapshot: EditorSnapshot,
  id: string,
): { snapshot: EditorSnapshot; id: string } {
  const layers = snapshot.deck.layers;
  const number =
    Math.max(
      layers.length,
      ...layers.map((layer) =>
        Number(layer.name.match(/^Layer (\d+)$/i)?.[1] ?? 0),
      ),
    ) + 1;
  const usedColors = new Set(
    layers.map((layer) => layer.color.toLowerCase()),
  );
  const layer: Layer = {
    id,
    name: "Layer " + number,
    hidden: false,
    locked: false,
    color:
      LAYER_PALETTE.find(
        (color) => !usedColors.has(color.toLowerCase()),
      ) ?? LAYER_PALETTE[layers.length % LAYER_PALETTE.length],
  };
  return {
    snapshot: setDeckLayers(snapshot, [...layers, layer]),
    id,
  };
}

export function changeLayer(
  snapshot: EditorSnapshot,
  id: string,
  patch: LayerPatch,
): EditorSnapshot {
  if (!snapshot.deck.layers.some((layer) => layer.id === id))
    throw new Error("Unknown Layer: " + id);
  return setDeckLayers(
    snapshot,
    snapshot.deck.layers.map((layer) =>
      layer.id === id ? { ...layer, ...patch } : layer,
    ),
  );
}

export function deleteLayer(
  snapshot: EditorSnapshot,
  id: string,
): EditorSnapshot {
  const layers = snapshot.deck.layers;
  if (layers.length <= 1 || !layers.some((layer) => layer.id === id))
    return snapshot;
  return setDeckLayers(
    snapshot,
    layers.filter((layer) => layer.id !== id),
  );
}

export function reorderLayers(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  index: number,
): EditorSnapshot {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("Layer reorder requires distinct Layer IDs");
  const selected = new Set(ids);
  const ordered = snapshot.deck.layers.filter((layer) =>
    selected.has(layer.id),
  );
  if (ordered.length !== selected.size)
    throw new Error("Unknown Layer in reorder");
  const remaining = snapshot.deck.layers.filter(
    (layer) => !selected.has(layer.id),
  );
  if (!Number.isInteger(index) || index < 0 || index > remaining.length)
    throw new Error("Invalid Layer insertion index");
  const layers = [...remaining];
  layers.splice(index, 0, ...ordered);
  return setDeckLayers(snapshot, layers);
}

export function reparentHierarchy(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  from: string | null,
  to: string | null,
  index: number,
): EditorSnapshot {
  if (from === null && to === null)
    return reorderLayers(snapshot, ids, index);
  if (from === null || to === null)
    throw new Error("Layers and Elements cannot share one hierarchy scope");
  if (
    !isEditableScope(snapshot.slide, snapshot.deck, from) ||
    !isEditableScope(snapshot.slide, snapshot.deck, to)
  )
    throw new Error("Layer is hidden or locked");
  if (!getChildren(snapshot.slide, from) || !getChildren(snapshot.slide, to))
    throw new Error("Unknown hierarchy scope");
  for (const id of ids) {
    const location = locateElement(snapshot.slide, id);
    if (!location || location.parentId !== from)
      throw new Error("Moved Elements must be direct siblings");
  }
  return reparentElements(snapshot, ids, to, index);
}
