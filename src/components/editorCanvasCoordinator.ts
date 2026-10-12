import type { EditorSnapshot } from "../core/editorCommands";
import type { TransformSnapshot } from "../core/transformInteraction";
import { duplicateForAltDrag } from "../core/transformInteraction";
import type { Deck, Slide } from "../core/document";
import {
  getChildren,
  isEditableScope,
  locateElement,
  resolveEditableScope,
  type ScopeId,
} from "../core/scene";
import {
  transformContainedByBox,
  transformIntersectsBox,
  type Box,
  type Point,
} from "../core/geometry";
import type { SelectionMode } from "../core/editorPreferences";
import { elementWorldGeometry } from "../core/selectionGeometry";

export interface CanvasSelection {
  elementIds: string[];
  scopeId: ScopeId | null;
}

export interface CanvasMoveBase {
  snapshot: TransformSnapshot;
  originalElementIds: string[];
  movingElementIds: string[];
  scopeId: ScopeId;
  duplicated: boolean;
}

export interface MarqueeBox extends Box {
  crossing: boolean;
  touching: boolean;
}

export function createMarqueeBox(
  start: Point,
  end: Point,
  mode: SelectionMode,
): MarqueeBox {
  const touching =
    mode === "simple" ||
    (mode === "directional" ? end.x < start.x : end.x >= start.x);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    touching,
    crossing: mode !== "simple" && touching,
  };
}

export function resolveMarqueeSelection(
  slide: Slide,
  deck: Deck,
  scopeId: ScopeId,
  box: MarqueeBox,
): string[] {
  if (!isEditableScope(slide, deck, scopeId)) return [];
  const children = getChildren(slide, scopeId) ?? [];
  return children
    .filter(({ id }) => {
      const geometry = elementWorldGeometry(slide, id);
      const transform = {
        x: geometry.center.x - geometry.orientedWidth / 2,
        y: geometry.center.y - geometry.orientedHeight / 2,
        width: geometry.orientedWidth,
        height: geometry.orientedHeight,
        rotation: geometry.rotation,
      };
      return box.touching
        ? transformIntersectsBox(transform, box)
        : transformContainedByBox(transform, box);
    })
    .map(({ id }) => id);
}

/**
 * Resolve a DOM hit to a layer child or the active container's direct child.
 * Descendants remain selectable only after their container scope is entered.
 */
export function resolveCanvasHitTarget(
  slide: Slide,
  scopeId: ScopeId,
  targetId: string,
): string | null {
  let location = locateElement(slide, targetId);
  const layerScope = slide.nodes.some((root) => root.id === scopeId);
  while (location) {
    if (location.parentId === scopeId) return location.element.id;
    if (slide.nodes.some((root) => root.id === location!.parentId))
      return layerScope ? location.element.id : null;
    location = locateElement(slide, location.parentId);
  }
  return null;
}

export function resolveCanvasSelection(
  slide: Slide,
  current: CanvasSelection,
  targetId: string,
  additive: boolean,
): CanvasSelection {
  const location = locateElement(slide, targetId);
  if (!location) return current;
  const scopeId = location.parentId;

  if (current.scopeId !== scopeId)
    return { elementIds: [targetId], scopeId };

  if (additive) {
    return current.elementIds.includes(targetId)
      ? {
          elementIds: current.elementIds.filter((id) => id !== targetId),
          scopeId,
        }
      : { elementIds: [...current.elementIds, targetId], scopeId };
  }

  if (current.elementIds.includes(targetId)) return current;
  return { elementIds: [targetId], scopeId };
}

export function pruneCanvasSelection(
  slide: Slide,
  deck: Deck,
  current: CanvasSelection,
): CanvasSelection {
  const existing = current.elementIds.flatMap((id) => {
    const location = locateElement(slide, id);
    return location ? [location] : [];
  });

  if (
    current.scopeId &&
    getChildren(slide, current.scopeId) &&
    isEditableScope(slide, deck, current.scopeId)
  ) {
    return {
      elementIds: existing
        .filter(({ parentId }) => parentId === current.scopeId)
        .map(({ element }) => element.id),
      scopeId: current.scopeId,
    };
  }

  const first = existing.find(({ parentId }) =>
    isEditableScope(slide, deck, parentId),
  );
  if (first) {
    return {
      elementIds: existing
        .filter(
          ({ parentId }) =>
            parentId === first.parentId &&
            isEditableScope(slide, deck, parentId),
        )
        .map(({ element }) => element.id),
      scopeId: first.parentId,
    };
  }

  try {
    return {
      elementIds: [],
      scopeId: resolveEditableScope(slide, deck, current.scopeId),
    };
  } catch {
    return { elementIds: [], scopeId: null };
  }
}

export function createCanvasMoveBase(
  snapshot: EditorSnapshot,
  elementIds: readonly string[],
  scopeId: ScopeId,
  duplicate: boolean,
  newId: () => string,
): CanvasMoveBase {
  if (!duplicate)
    return {
      snapshot,
      originalElementIds: [...elementIds],
      movingElementIds: [...elementIds],
      scopeId,
      duplicated: false,
    };

  const result = duplicateForAltDrag(
    snapshot,
    elementIds,
    scopeId,
    newId,
  );
  return {
    snapshot: result.snapshot,
    originalElementIds: [...elementIds],
    movingElementIds: result.elementIds,
    scopeId,
    duplicated: true,
  };
}
