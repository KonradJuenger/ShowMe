import { filterMotion } from "./motion";
import { filterEffectMotion } from "./effects";
import type { Box, Point } from "./geometry";
import type { Deck, LayerRoot, Slide } from "./document";
import {
  frameFromMatrix, IDENTITY, cloneElement, frameSiblingElements, inverse, localMatrix, multiply,
  transformPoint, unframeSiblingElement, validateElementForest,
  type Matrix, type Element,
} from "./element";

/** A scope is an explicit Layer root or a container Element. */
export type ScopeId = string;
export interface ElementLocation {
  element: Element;
  parentId: ScopeId;
  layerId: string;
  index: number;
  world: Matrix;
}

export function layerRoots(slide: Slide): readonly LayerRoot[] {
  return slide.nodes;
}

export function locateElement(slide: Slide, id: string): ElementLocation | null {
  const visit = (children: readonly Element[], parentId: string,
    layerId: string, parentWorld: Matrix): ElementLocation | null => {
    for (let index = 0; index < children.length; index++) {
      const element = children[index];
      const world = multiply(parentWorld, localMatrix(element.frame));
      if (element.id === id) return { element, parentId, layerId, index, world };
      const found = visit(element.children, element.id, layerId, world);
      if (found) return found;
    }
    return null;
  };
  for (const root of slide.nodes) {
    const found = visit(root.children, root.id, root.id, IDENTITY);
    if (found) return found;
  }
  return null;
}

export function findElement(slide: Slide, id: string): Element | null {
  return locateElement(slide, id)?.element ?? null;
}

export function getParentId(slide: Slide, id: string): string | null {
  return locateElement(slide, id)?.parentId ?? null;
}

export function getOwningLayer(slide: Slide, id: string): LayerRoot | null {
  const layerId = slide.nodes.some((root) => root.id === id)
    ? id : locateElement(slide, id)?.layerId;
  return slide.nodes.find((root) => root.id === layerId) ?? null;
}

export function getChildren(slide: Slide, scopeId: ScopeId): readonly Element[] | null {
  const root = slide.nodes.find((entry) => entry.id === scopeId);
  if (root) return root.children;
  const element = findElement(slide, scopeId);
  return element?.container ? element.children : null;
}

export function containsElement(slide: Slide, ancestorId: string, id: string): boolean {
  if (ancestorId === id) return !!findElement(slide, id);
  let current = locateElement(slide, id);
  while (current) {
    const parentId = current.parentId;
    if (parentId === ancestorId) return true;
    if (slide.nodes.some((root) => root.id === parentId)) break;
    current = locateElement(slide, parentId);
  }
  return false;
}

export function flattenSubtree(element: Element): Element[] {
  return [element, ...element.children.flatMap(flattenSubtree)];
}

export function flattenElements(slide: Slide): Element[] {
  return slide.nodes.flatMap((root) => root.children.flatMap(flattenSubtree));
}

export function visibleElements(slide: Slide, deck: Deck): Element[] {
  return slide.nodes.flatMap((root) =>
    deck.layers.find((layer) => layer.id === root.id)?.hidden
      ? [] : root.children.flatMap(flattenSubtree));
}

export function isEditableScope(slide: Slide, deck: Deck, scopeId: string): boolean {
  const root = getOwningLayer(slide, scopeId);
  if (!root) return false;
  const layer = deck.layers.find((entry) => entry.id === root.id);
  return !!layer && !layer.hidden && !layer.locked;
}

/** Resolve an insertion destination without silently targeting hidden/locked content. */
export function resolveEditableScope(
  slide: Slide,
  deck: Deck,
  requestedScopeId: ScopeId | null,
): ScopeId {
  if (
    requestedScopeId &&
    getChildren(slide, requestedScopeId) &&
    isEditableScope(slide, deck, requestedScopeId)
  )
    return requestedScopeId;

  if (requestedScopeId) {
    const layer = getOwningLayer(slide, requestedScopeId);
    if (layer && isEditableScope(slide, deck, layer.id)) return layer.id;
  }

  const fallback = deck.layers.find(
    (layer) =>
      !layer.hidden &&
      !layer.locked &&
      slide.nodes.some((root) => root.id === layer.id),
  );
  if (!fallback)
    throw new Error("Select an unlocked, visible layer to add objects");
  return fallback.id;
}

function childrenForEdit(slide: Slide, scopeId: string): Element[] {
  const children = getChildren(slide, scopeId);
  if (!children) throw new Error(`Unknown or non-container scope: ${scopeId}`);
  return children as Element[];
}

function checked(slide: Slide): Slide {
  const roots = slide.nodes.flatMap((root) => root.children);
  validateElementForest(roots);
  const ids = new Set(slide.nodes.map((root) => root.id));
  if (
    ids.size !== slide.nodes.length ||
    roots.flatMap(flattenSubtree).some((node) => ids.has(node.id))
  )
    throw new Error("Layer IDs must be distinct from Element IDs");
  return slide;
}

function edit(slide: Slide, change: (copy: Slide) => void): Slide {
  const copy = structuredClone(slide);
  change(copy);
  if (copy.motion)
    copy.motion = filterMotion(
      copy.motion,
      new Set(
        copy.nodes
          .flatMap((r) => r.children)
          .flatMap(flattenSubtree)
          .map((e) => e.id),
      ),
    );
  if (copy.motion)
    copy.motion = filterEffectMotion(
      copy.motion,
      flattenElements(copy),
      copy.effectResources ?? {},
    );
  return checked(copy);
}

function insertionIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  if (!Number.isInteger(index) || index < 0 || index > length)
    throw new Error("Invalid insertion index");
  return index;
}

function structuralSelection(
  slide: Slide,
  ids: readonly string[],
): ElementLocation[] {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("Structural selection requires distinct Elements");
  const locations = ids.map((id) => locateElement(slide, id));
  if (locations.some((entry) => !entry))
    throw new Error("Unknown Element in structural selection");
  const selected = locations as ElementLocation[];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const a = selected[i].element.id;
      const b = selected[j].element.id;
      if (containsElement(slide, a, b) || containsElement(slide, b, a))
        throw new Error(
          "Structural selection cannot include both an ancestor and descendant",
        );
    }
  }
  return selected;
}

function oneSourceScope(
  locations: readonly ElementLocation[],
  operation: string,
): string {
  const parentId = locations[0].parentId;
  if (locations.some((entry) => entry.parentId !== parentId))
    throw new Error(`${operation} selection requires one source scope`);
  return parentId;
}

export function insertElement(slide: Slide, scopeId: string,
  element: Element, index?: number): Slide {
  return edit(slide, (copy) => {
    const children = childrenForEdit(copy, scopeId);
    children.splice(insertionIndex(index, children.length), 0, structuredClone(element));
  });
}

export function removeElements(
  slide: Slide,
  ids: readonly string[],
): Slide {
  structuralSelection(slide, ids);
  const selectedIds = new Set(ids);
  return edit(slide, (copy) => {
    const removeSelected = (children: Element[]) => {
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (selectedIds.has(child.id)) children.splice(index, 1);
        else removeSelected(child.children);
      }
    };
    for (const root of copy.nodes) removeSelected(root.children);
  });
}

export function removeElement(slide: Slide, id: string): Slide {
  return removeElements(slide, [id]);
}

export function replaceElements(
  slide: Slide,
  elements: readonly Element[],
): Slide {
  const ids = elements.map(({ id }) => id);
  structuralSelection(slide, ids);
  const replacements = new Map(
    elements.map((element) => [element.id, structuredClone(element)]),
  );
  return edit(slide, (copy) => {
    const replaceSelected = (children: Element[]) => {
      for (let index = 0; index < children.length; index++) {
        const replacement = replacements.get(children[index].id);
        if (replacement) children[index] = structuredClone(replacement);
        else replaceSelected(children[index].children);
      }
    };
    for (const root of copy.nodes) replaceSelected(root.children);
  });
}

export function replaceElement(slide: Slide, id: string,
  element: Element): Slide {
  if (element.id !== id) throw new Error("Element identity cannot change");
  return replaceElements(slide, [element]);
}

export function cloneSubtree(element: Element, newId: () => string): Element {
  return cloneElement(element, newId);
}

/** Index is measured in the sibling list after removing the moved Element. */
export function reorderElement(slide: Slide, id: string, index: number): Slide {
  return edit(slide, (copy) => {
    const found = locateElement(copy, id);
    if (!found) throw new Error(`Unknown Element: ${id}`);
    const siblings = childrenForEdit(copy, found.parentId);
    insertionIndex(index, siblings.length - 1);
    siblings.splice(found.index, 1);
    siblings.splice(index, 0, found.element);
  });
}

function parentWorld(slide: Slide, scopeId: string): Matrix {
  if (slide.nodes.some((root) => root.id === scopeId)) return IDENTITY;
  const found = locateElement(slide, scopeId);
  if (!found || !found.element.container) throw new Error(`Unknown or non-container scope: ${scopeId}`);
  return found.world;
}

export function getScopeWorldMatrix(
  slide: Slide,
  scopeId: ScopeId,
): Matrix {
  return parentWorld(slide, scopeId);
}

export function worldPointToScope(
  slide: Slide,
  scopeId: ScopeId,
  point: Point,
): Point {
  return transformPoint(inverse(parentWorld(slide, scopeId)), point);
}

/** The inherited matrix remains rigid; container size never scales descendants. */
export function getWorldMatrix(slide: Slide, id: string): Matrix {
  const found = locateElement(slide, id);
  if (!found) throw new Error(`Unknown Element: ${id}`);
  return found.world;
}

export function getLocalMatrix(slide: Slide, id: string): Matrix {
  const element = findElement(slide, id);
  if (!element) throw new Error(`Unknown Element: ${id}`);
  return localMatrix(element.frame);
}

export function getWorldBounds(slide: Slide, id: string): Box {
  const element = findElement(slide, id);
  if (!element) throw new Error(`Unknown Element: ${id}`);
  const matrix = getWorldMatrix(slide, id);
  const points = [
    { x: 0, y: 0 },
    { x: element.frame.width, y: 0 },
    { x: element.frame.width, y: element.frame.height },
    { x: 0, y: element.frame.height },
  ].map((point) => transformPoint(matrix, point));
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Convert a world transform to a root frame local to the destination scope. */
export function frameFromWorldMatrix(
  slide: Slide,
  scopeId: ScopeId,
  world: Matrix,
  frame: Element["frame"],
): Element["frame"] {
  return frameFromMatrix(multiply(inverse(parentWorld(slide, scopeId)), world), frame);
}

/** Index is measured in the destination sibling list after removing the moved block. */
export function reparentElements(
  slide: Slide,
  ids: readonly string[],
  scopeId: string,
  index?: number,
): Slide {
  const locations = structuralSelection(slide, ids);
  const sourceParentId = oneSourceScope(locations, "Reparent");
  if (!getChildren(slide, scopeId))
    throw new Error(`Unknown or non-container scope: ${scopeId}`);
  for (const { element } of locations) {
    if (element.id === scopeId || containsElement(slide, element.id, scopeId))
      throw new Error("Cannot parent an Element into itself or a descendant");
  }

  const sameScope = sourceParentId === scopeId;
  if (!sameScope) assertMotionReparent(slide, ids);
  const destinationLength =
    getChildren(slide, scopeId)!.length - (sameScope ? locations.length : 0);
  const targetIndex = insertionIndex(index, destinationLength);
  const destinationWorld = parentWorld(slide, scopeId);
  const ordered = [...locations].sort((a, b) => a.index - b.index);
  const moved = ordered.map(({ element, world }) => {
    const copy = structuredClone(element);
    if (!sameScope) {
      const local = multiply(inverse(destinationWorld), world);
      copy.frame = frameFromMatrix(local, copy.frame);
    }
    return copy;
  });
  const selectedIds = new Set(ids);

  return edit(slide, (copy) => {
    const sourceChildren = childrenForEdit(copy, sourceParentId);
    for (let sourceIndex = sourceChildren.length - 1; sourceIndex >= 0; sourceIndex--)
      if (selectedIds.has(sourceChildren[sourceIndex].id))
        sourceChildren.splice(sourceIndex, 1);
    const destination = childrenForEdit(copy, scopeId);
    destination.splice(targetIndex, 0, ...moved);
  });
}

export function reparentElement(slide: Slide, id: string,
  scopeId: string, index?: number): Slide {
  return reparentElements(slide, [id], scopeId, index);
}

/** Frame selection must consist of siblings in one source scope. */
export function frameElements(
  slide: Slide,
  ids: readonly string[],
  frameId: string,
): Slide {
  const locations = structuralSelection(slide, ids);
  const sourceParentId = oneSourceScope(locations, "Frame");
  assertMotionReparent(slide, ids);
  if (
    slide.nodes.some((root) => root.id === frameId) ||
    findElement(slide, frameId)
  )
    throw new Error("Frame ID already exists");
  return edit(slide, (copy) => {
    const siblings = childrenForEdit(copy, sourceParentId);
    const framed = frameSiblingElements(siblings, ids, frameId);
    siblings.splice(0, siblings.length, ...framed);
  });
}

export function unframeElement(slide: Slide, frameId: string): Slide {
  const frame = findElement(slide, frameId);
  if (
    slide.motion?.stages.some((s) =>
      s.tracks.some((t) => t.elementId === frameId),
    )
  ) throw new Error("Remove Motion from this frame before unframing it.");
  assertMotionReparent(slide, frame?.children.map((e) => e.id) ?? []);
  return edit(slide, (copy) => {
    const found = locateElement(copy, frameId);
    if (!found) throw new Error(`Unknown Element: ${frameId}`);
    const siblings = childrenForEdit(copy, found.parentId);
    const unframed = unframeSiblingElement(siblings, frameId);
    siblings.splice(0, siblings.length, ...unframed);
  });
}

export function assertMotionReparent(slide: Slide, ids: readonly string[]) {
  if (
    slide.motion?.stages.some((s) =>
      s.tracks.some(
        (t) =>
          ids.includes(t.elementId) &&
          t.property.startsWith("transform.") &&
          [t.initial, ...t.keyframes.map((k) => k.value)].some(
            (v) => v?.type === "absolute",
          ),
      ),
    )
  ) throw new Error("Absolute Motion transforms cannot be reparented. Use relative values or remove the animation first.");
}
