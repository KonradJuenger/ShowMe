import { addEffectTrigger } from "./effectSequence";
import {
  effectParameters,
  consumedParameter,
  compatibleEffectValue,
  type EffectParameterValue,
  newEffectInstance,
  type EffectDefinition,
} from "./effects";
import { applyDocumentOperationsToProjection } from "./documentProjection";
import { cloneMotion, translateAbsoluteMotion } from "./motion";
import type { SlideMotion } from "./motionModel";
import {
  rotateTransformAround,
  scaleTransformToBox,
  type Box,
} from "./geometry";
import {
  frameFromMatrix,
  IDENTITY,
  inverse,
  localMatrix,
  walkElements,
  multiply,
  type Matrix,
  type Element,
} from "./element";
import { deckSchema, slideSchema, type Deck, type Slide } from "./document";
import {
  cloneSubtree,
  containsElement,
  findElement,
  isEditableScope,
  frameElements as frameSceneElements,
  getChildren,
  getWorldMatrix,
  insertElement as insertSceneElement,
  locateElement,
  removeElements as removeSceneElements,
  reorderElement as reorderSceneElement,
  reparentElements as reparentSceneElements,
  replaceElements as replaceSceneElements,
  unframeElement as unframeSceneElement,
  type ElementLocation,
  type ScopeId,
} from "./scene";
import { appendEditorOperations } from "./editorChange";
import {
  expandSlideSubtrees,
  moveSlideSubtrees,
  type SlideDropTarget,
} from "./slideHierarchy";
import { uid } from "./ids";
import { isMediaContent, preserveMediaAfterFrameChange } from "./media";
import {
  syncLayerRoots,
  applyDocumentOperationToSlide,
  type DocumentOperation,
} from "./documentOperations";

export interface EditorSnapshot {
  deck: Deck;
  slide: Slide;
  templates?: Record<string, import("./document").TemplatePage>;
}

export function setSlideEffects(
  snapshot: EditorSnapshot,
  edit: Omit<
    Extract<DocumentOperation, { type: "slide.effects.set" }>,
    "type" | "slideId"
  >,
): EditorSnapshot {
  const operation: DocumentOperation = {
    type: "slide.effects.set",
    slideId: snapshot.slide.id,
    ...edit,
  };
  return appendChange(
    snapshot,
    withSlide(
      snapshot,
      applyDocumentOperationToSlide(snapshot.slide, operation),
    ),
    [operation],
  );
}

/** Replace only the originating instance; the semantic operation prunes invalid parameter Motion. */
export function setElementEffectDefinition(
  snapshot: EditorSnapshot,
  elementId: string,
  definition: EffectDefinition,
  instanceId?: string,
  stageIndex = 0,
): EditorSnapshot {
  const target = findElement(snapshot.slide, elementId);
  if (!target || !isEditableScope(snapshot.slide, snapshot.deck, elementId))
    throw new Error("Select an editable Element");
  const instance = target.effects?.find((effect) => effect.id === instanceId);
  if (instanceId && !instance)
    throw new Error("The originating Effect is unavailable");
  const resourceId = uid();
  const created = newEffectInstance(
    resourceId,
    definition,
    definition.target === "text" ? "content" : definition.target,
  );
  const value = instance
    ? target.effects!.map((effect) =>
        effect.id === instance.id
          ? {
              ...created,
              id: effect.id,
              enabled: effect.enabled,
              resourceId,
              placement: created.placement,
              parameters: Object.fromEntries(
                effectParameters(definition).map((parameter) => {
                  const oldParameter = effectParameters(
                    snapshot.slide.effectResources?.[effect.resourceId],
                  ).find((p) => p.key === parameter.key);
                  const value = effect.parameters[parameter.key];
                  return [
                    parameter.key,
                    oldParameter?.type === parameter.type &&
                    compatibleEffectValue(value, parameter)
                      ? consumedParameter(value, parameter)
                      : parameter.default,
                  ];
                }),
              ),
            }
          : effect,
      )
    : [...(target.effects ?? []), created];
  const resources = {
    ...snapshot.slide.effectResources,
    [resourceId]: definition,
  };
  if (
    instance &&
    !walkElements(snapshot.slide.nodes.flatMap((root) => root.children)).some(
      (element) =>
        (element.id === elementId ? value : element.effects)?.some(
          (effect) => effect.resourceId === instance.resourceId,
        ),
    )
  )
    delete resources[instance.resourceId];
  const result = setSlideEffects(snapshot, {
    resources,
    changes: [{ elementId, value }],
  });
  return !instance &&
    !snapshot.deck.templateIds.includes(snapshot.slide.id) &&
    (definition.timeControl.start === "click" ||
      definition.timeControl.stop.mode === "after")
    ? setSlideMotion(
        result,
        addEffectTrigger(
          result.slide.motion,
          stageIndex,
          elementId,
          created,
          definition,
        ),
      )
    : result;
}

/** Numeric entry extends only this instance's definition, in the same transaction. */
export function setElementEffectParameterValue(
  snapshot: EditorSnapshot,
  elementId: string,
  instanceId: string,
  key: string,
  value: EffectParameterValue,
): EditorSnapshot {
  const target = findElement(snapshot.slide, elementId);
  const instance = target?.effects?.find((effect) => effect.id === instanceId);
  const definition =
    snapshot.slide.effectResources?.[instance?.resourceId ?? ""];
  const parameter =
    definition && effectParameters(definition).find((p) => p.key === key);
  if (!instance || !definition || !parameter)
    throw new Error("Effect parameter unavailable");
  if (!compatibleEffectValue(value, parameter))
    throw new Error("Incompatible effect parameter value");
  const expanded =
    parameter.type === "number" &&
    typeof value === "number" &&
    parameter.max !== undefined &&
    value > parameter.max;
  const next = expanded
    ? setElementEffectDefinition(
        snapshot,
        elementId,
        {
          ...definition,
          parameters: effectParameters(definition).map((p) =>
            p.key === key && p.type === "number" && typeof value === "number"
              ? { ...p, max: value }
              : p,
          ),
        },
        instanceId,
      )
    : snapshot;
  const effects = findElement(next.slide, elementId)!.effects!;
  return setSlideEffects(next, {
    changes: [
      {
        elementId,
        value: effects.map((effect) =>
          effect.id === instanceId
            ? {
                ...effect,
                parameters: {
                  ...effect.parameters,
                  [key]: consumedParameter(
                    value,
                    expanded &&
                      parameter.type === "number" &&
                      typeof value === "number"
                      ? { ...parameter, max: value }
                      : parameter,
                  ),
                },
              }
            : effect,
        ),
      },
    ],
  });
}

export type ReorderMode = "backward" | "forward" | "back" | "front";

function withSlide(snapshot: EditorSnapshot, slide: Slide): EditorSnapshot {
  return slide === snapshot.slide ? snapshot : { ...snapshot, slide };
}

function withDeck(snapshot: EditorSnapshot, deck: Deck): EditorSnapshot {
  return deck === snapshot.deck ? snapshot : { ...snapshot, deck };
}

function distinctElementIds(
  ids: Iterable<string>,
  label = "Selection",
): string[] {
  const values = [...ids];
  if (new Set(values).size !== values.length)
    throw new Error(`${label} requires distinct Element IDs`);
  return values;
}

function assertDistinctElementChanges(
  changes: readonly { elementId: string }[],
) {
  distinctElementIds(
    changes.map(({ elementId }) => elementId),
    "Element changes",
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireElement(slide: Slide, id: string): Element {
  const element = findElement(slide, id);
  if (!element) throw new Error(`Unknown Element: ${id}`);
  return element;
}

function appendChange(
  source: EditorSnapshot,
  value: EditorSnapshot,
  operations: readonly DocumentOperation[],
) {
  if (!operations.length) return source;
  return appendEditorOperations(source, value, operations);
}

export function insertElements(
  snapshot: EditorSnapshot,
  elements: readonly Element[],
  parentId: ScopeId,
  index?: number,
): EditorSnapshot {
  if (!elements.length) return snapshot;
  let slide = snapshot.slide;
  for (let offset = 0; offset < elements.length; offset++)
    slide = insertSceneElement(
      slide,
      parentId,
      elements[offset],
      index === undefined ? undefined : index + offset,
    );
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.insert",
      slideId: snapshot.slide.id,
      parentId,
      ...(index === undefined ? {} : { index }),
      elements: elements.map((element) => structuredClone(element)),
    },
  ]);
}

export function removeElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
): EditorSnapshot {
  const elementIds = distinctElementIds(ids);
  if (!elementIds.length) return snapshot;
  const slide = removeSceneElements(snapshot.slide, elementIds);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    { type: "elements.remove", slideId: snapshot.slide.id, elementIds },
  ]);
}

export function replaceElements(
  snapshot: EditorSnapshot,
  elements: readonly Element[],
): EditorSnapshot {
  if (!elements.length) return snapshot;
  distinctElementIds(
    elements.map(({ id }) => id),
    "Replacement selection",
  );
  const changed = elements.filter((element) => {
    const current = requireElement(snapshot.slide, element.id);
    return !sameValue(current, element);
  });
  if (!changed.length) return snapshot;
  const slide = replaceSceneElements(snapshot.slide, changed);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.replace",
      slideId: snapshot.slide.id,
      elements: changed.map((element) => structuredClone(element)),
    },
  ]);
}

export function replaceElement(
  snapshot: EditorSnapshot,
  id: string,
  element: Element,
): EditorSnapshot {
  if (id !== element.id) throw new Error("Element identity cannot change");
  return replaceElements(snapshot, [element]);
}

export function setElementFrames(
  snapshot: EditorSnapshot,
  changes: readonly { elementId: string; value: Element["frame"] }[],
): EditorSnapshot {
  assertDistinctElementChanges(changes);
  const effective = changes.filter(
    ({ elementId, value }) =>
      !sameValue(requireElement(snapshot.slide, elementId).frame, value),
  );
  if (!effective.length) return snapshot;
  const replacements = effective.map(({ elementId, value }) => ({
    ...requireElement(snapshot.slide, elementId),
    frame: structuredClone(value),
  }));
  const slide = replaceSceneElements(snapshot.slide, replacements);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.frame.set",
      slideId: snapshot.slide.id,
      changes: effective.map(({ elementId, value }) => ({
        elementId,
        value: structuredClone(value),
      })),
    },
  ]);
}

export function setElementAppearances(
  snapshot: EditorSnapshot,
  changes: readonly { elementId: string; value: Element["appearance"] }[],
): EditorSnapshot {
  assertDistinctElementChanges(changes);
  const effective = changes.filter(
    ({ elementId, value }) =>
      !sameValue(requireElement(snapshot.slide, elementId).appearance, value),
  );
  if (!effective.length) return snapshot;
  const replacements = effective.map(({ elementId, value }) => ({
    ...requireElement(snapshot.slide, elementId),
    appearance: structuredClone(value),
  }));
  const slide = replaceSceneElements(snapshot.slide, replacements);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.appearance.set",
      slideId: snapshot.slide.id,
      changes: effective.map(({ elementId, value }) => ({
        elementId,
        value: structuredClone(value),
      })),
    },
  ]);
}

export function setElementGeometries(
  snapshot: EditorSnapshot,
  changes: readonly { elementId: string; value: Element["geometry"] }[],
): EditorSnapshot {
  assertDistinctElementChanges(changes);
  const effective = changes.filter(
    ({ elementId, value }) =>
      !sameValue(requireElement(snapshot.slide, elementId).geometry, value),
  );
  if (!effective.length) return snapshot;
  const replacements = effective.map(({ elementId, value }) => ({
    ...requireElement(snapshot.slide, elementId),
    geometry: structuredClone(value),
  }));
  const slide = replaceSceneElements(snapshot.slide, replacements);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.geometry.set",
      slideId: snapshot.slide.id,
      changes: effective.map(({ elementId, value }) => ({
        elementId,
        value: structuredClone(value),
      })),
    },
  ]);
}

export function setElementContents(
  snapshot: EditorSnapshot,
  changes: readonly { elementId: string; value: Element["content"] }[],
): EditorSnapshot {
  assertDistinctElementChanges(changes);
  const effective = changes.filter(
    ({ elementId, value }) =>
      !sameValue(requireElement(snapshot.slide, elementId).content, value),
  );
  if (!effective.length) return snapshot;
  const replacements = effective.map(({ elementId, value }) => ({
    ...requireElement(snapshot.slide, elementId),
    content: structuredClone(value),
  }));
  const slide = replaceSceneElements(snapshot.slide, replacements);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.content.set",
      slideId: snapshot.slide.id,
      changes: effective.map(({ elementId, value }) => ({
        elementId,
        value: structuredClone(value),
      })),
    },
  ]);
}

export function setElementContainerStates(
  snapshot: EditorSnapshot,
  changes: readonly {
    elementId: string;
    value: { container: boolean; clipChildren: boolean };
  }[],
): EditorSnapshot {
  assertDistinctElementChanges(changes);
  const effective = changes.filter(({ elementId, value }) => {
    const element = requireElement(snapshot.slide, elementId);
    return (
      element.container !== value.container ||
      element.clipChildren !== value.clipChildren
    );
  });
  if (!effective.length) return snapshot;
  const replacements = effective.map(({ elementId, value }) => ({
    ...requireElement(snapshot.slide, elementId),
    ...value,
  }));
  const slide = replaceSceneElements(snapshot.slide, replacements);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.container.set",
      slideId: snapshot.slide.id,
      changes: effective.map(({ elementId, value }) => ({
        elementId,
        value: { ...value },
      })),
    },
  ]);
}

function scopeWorldMatrix(slide: Slide, scopeId: ScopeId): Matrix {
  if (slide.nodes.some((root) => root.id === scopeId)) return IDENTITY;
  const scope = findElement(slide, scopeId);
  if (!scope?.container)
    throw new Error(`Unknown or non-container scope: ${scopeId}`);
  return getWorldMatrix(slide, scopeId);
}

function parentWorldMatrix(slide: Slide, parentId: ScopeId): Matrix {
  return slide.nodes.some((root) => root.id === parentId)
    ? IDENTITY
    : getWorldMatrix(slide, parentId);
}

interface TransformSelection {
  ids: string[];
  scopeId: ScopeId;
  scopeWorld: Matrix;
  locations: ElementLocation[];
}

function transformSelection(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  requestedScopeId?: ScopeId,
): TransformSelection | null {
  const selected = distinctElementIds(ids);
  if (!selected.length) return null;
  const locations = selected.map((id) => locateElement(snapshot.slide, id));
  if (locations.some((location) => !location))
    throw new Error("Unknown Element in transform selection");
  const found = locations as ElementLocation[];
  for (let left = 0; left < selected.length; left++)
    for (let right = left + 1; right < selected.length; right++)
      if (
        containsElement(snapshot.slide, selected[left], selected[right]) ||
        containsElement(snapshot.slide, selected[right], selected[left])
      )
        throw new Error(
          "Transform selection cannot include both an ancestor and descendant",
        );

  const inferredParent = found[0].parentId;
  const oneParent = found.every(
    (location) => location.parentId === inferredParent,
  );
  const scopeId = requestedScopeId ?? (oneParent ? inferredParent : null);
  if (!scopeId)
    throw new Error(
      "Transform selection spanning multiple parents requires an explicit coordinate scope",
    );
  if (!getChildren(snapshot.slide, scopeId))
    throw new Error(`Unknown or non-container scope: ${scopeId}`);
  const isLayerScope = snapshot.slide.nodes.some((root) => root.id === scopeId);
  for (const location of found) {
    if (location.element.id === scopeId)
      throw new Error("A transform scope cannot also be a selected Element");
    const inside = isLayerScope
      ? location.layerId === scopeId
      : location.parentId === scopeId ||
        containsElement(snapshot.slide, scopeId, location.element.id);
    if (!inside)
      throw new Error(
        "Transform selection must be contained by its coordinate scope",
      );
  }
  return {
    ids: selected,
    scopeId,
    scopeWorld: scopeWorldMatrix(snapshot.slide, scopeId),
    locations: found,
  };
}

function frameInScope(
  selection: TransformSelection,
  location: ElementLocation,
): Element["frame"] {
  if (location.parentId === selection.scopeId) return location.element.frame;
  return frameFromMatrix(
    multiply(inverse(selection.scopeWorld), location.world),
    location.element.frame,
  );
}

function frameFromScope(
  slide: Slide,
  selection: TransformSelection,
  location: ElementLocation,
  frame: Element["frame"],
): Element["frame"] {
  if (location.parentId === selection.scopeId) return frame;
  const world = multiply(selection.scopeWorld, localMatrix(frame));
  const local = multiply(
    inverse(parentWorldMatrix(slide, location.parentId)),
    world,
  );
  return frameFromMatrix(local, frame);
}

function transformFrames(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  map: (frame: Element["frame"]) => Element["frame"],
  scopeId?: ScopeId,
): EditorSnapshot {
  const selection = transformSelection(snapshot, ids, scopeId);
  if (!selection) return snapshot;
  return setElementFrames(
    snapshot,
    selection.locations.map((location) => {
      const scoped = frameInScope(selection, location);
      return {
        elementId: location.element.id,
        value: frameFromScope(snapshot.slide, selection, location, map(scoped)),
      };
    }),
  );
}

/** dx/dy are expressed in the selected common parent or explicit scope. */
export function translateElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  dx: number,
  dy: number,
  scopeId?: ScopeId,
): EditorSnapshot {
  if (!dx && !dy) return snapshot;
  return transformFrames(
    snapshot,
    ids,
    (frame) => ({ ...frame, x: frame.x + dx, y: frame.y + dy }),
    scopeId,
  );
}

/** start/next are expressed in the selected common parent or explicit scope. */
export function resizeElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  start: Box,
  next: Box,
  scopeId?: ScopeId,
): EditorSnapshot {
  if (
    Math.abs(start.x - next.x) < 1e-9 &&
    Math.abs(start.y - next.y) < 1e-9 &&
    Math.abs(start.width - next.width) < 1e-9 &&
    Math.abs(start.height - next.height) < 1e-9
  )
    return snapshot;
  const selected = [...ids];
  const resized = transformFrames(
    snapshot,
    selected,
    (frame) => scaleTransformToBox(frame, start, next),
    scopeId,
  );
  return preserveResizedContents(snapshot, resized, selected);
}

/** Frame replacement with the same text/media preservation as native resizing. */
export function setElementFramesPreservingContent(
  snapshot: EditorSnapshot,
  changes: readonly { elementId: string; value: Element["frame"] }[],
): EditorSnapshot {
  return preserveResizedContents(
    snapshot,
    setElementFrames(snapshot, changes),
    changes.map((change) => change.elementId),
  );
}

function preserveResizedContents(
  snapshot: EditorSnapshot,
  resized: EditorSnapshot,
  selected: string[],
) {
  // Free media is independent of the viewport boundary, including its origin.
  return setElementContents(
    resized,
    selected.flatMap<{ elementId: string; value: Element["content"] }>((id) => {
      const before = requireElement(snapshot.slide, id);
      const after = requireElement(resized.slide, id);
      if (before.content?.type === "text")
        return before.content.autoSize !== "none" &&
          (before.frame.width !== after.frame.width ||
            before.frame.height !== after.frame.height)
          ? [
              {
                elementId: id,
                value: { ...before.content, autoSize: "none" as const },
              },
            ]
          : [];
      if (
        !isMediaContent(before.content) ||
        before.content.transform.rule !== "free"
      )
        return [];
      const content = preserveMediaAfterFrameChange(before, after.frame);
      return content ? [{ elementId: id, value: content }] : [];
    }),
  );
}

/** center is expressed in the selected common parent or explicit scope. */
export function rotateElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  center: { x: number; y: number },
  deltaDegrees: number,
  scopeId?: ScopeId,
): EditorSnapshot {
  if (!deltaDegrees) return snapshot;
  return transformFrames(
    snapshot,
    ids,
    (frame) => {
      const origin = {
        x: frame.width * frame.originX,
        y: frame.height * frame.originY,
      };
      const pivot = { x: frame.x + origin.x, y: frame.y + origin.y };
      const rotated = rotateTransformAround(
        {
          x: pivot.x,
          y: pivot.y,
          width: 0,
          height: 0,
          rotation: frame.rotation,
        },
        center,
        deltaDegrees,
      );
      return {
        ...frame,
        x: rotated.x - origin.x,
        y: rotated.y - origin.y,
        rotation: rotated.rotation,
      };
    },
    scopeId,
  );
}

export function reorderElements(
  snapshot: EditorSnapshot,
  parentId: ScopeId,
  ids: Iterable<string>,
  mode: ReorderMode,
): EditorSnapshot {
  const selectedIds = distinctElementIds(ids);
  if (!selectedIds.length) return snapshot;
  const selected = new Set(selectedIds);
  const children = getChildren(snapshot.slide, parentId);
  if (
    !children ||
    children.filter(({ id }) => selected.has(id)).length !== selected.size
  )
    throw new Error("Reorder selection must be direct children of one scope");
  const ordered = children
    .filter(({ id }) => selected.has(id))
    .map(({ id }) => id);
  let slide = snapshot.slide;
  const operations: DocumentOperation[] = [];
  const move = (id: string, index: number) => {
    const current = getChildren(slide, parentId)!;
    const currentIndex = current.findIndex((element) => element.id === id);
    if (currentIndex === index) return;
    slide = reorderSceneElement(slide, id, index);
    operations.push({
      type: "elements.reorder",
      slideId: snapshot.slide.id,
      elementId: id,
      index,
    });
  };

  if (mode === "front") {
    for (const id of ordered)
      move(id, getChildren(slide, parentId)!.length - 1);
  } else if (mode === "back") {
    for (const id of [...ordered].reverse()) move(id, 0);
  } else if (mode === "forward") {
    for (const id of [...ordered].reverse()) {
      const current = getChildren(slide, parentId)!;
      const index = current.findIndex((element) => element.id === id);
      if (index < current.length - 1 && !selected.has(current[index + 1].id))
        move(id, index + 1);
    }
  } else {
    for (const id of ordered) {
      const current = getChildren(slide, parentId)!;
      const index = current.findIndex((element) => element.id === id);
      if (index > 0 && !selected.has(current[index - 1].id))
        move(id, index - 1);
    }
  }
  return appendChange(snapshot, withSlide(snapshot, slide), operations);
}

export function reparentElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  parentId: ScopeId,
  index?: number,
): EditorSnapshot {
  const elementIds = distinctElementIds(ids);
  if (!elementIds.length) return snapshot;
  const slide = reparentSceneElements(
    snapshot.slide,
    elementIds,
    parentId,
    index,
  );
  if (sameValue(slide, snapshot.slide)) return snapshot;
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.reparent",
      slideId: snapshot.slide.id,
      elementIds,
      parentId,
      ...(index === undefined ? {} : { index }),
    },
  ]);
}

export function frameElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  frameId: string,
): EditorSnapshot {
  const elementIds = distinctElementIds(ids);
  if (!elementIds.length) return snapshot;
  const slide = frameSceneElements(snapshot.slide, elementIds, frameId);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    {
      type: "elements.frame",
      slideId: snapshot.slide.id,
      elementIds,
      frameId,
    },
  ]);
}

export function unframeElement(
  snapshot: EditorSnapshot,
  frameId: string,
): EditorSnapshot {
  const slide = unframeSceneElement(snapshot.slide, frameId);
  return appendChange(snapshot, withSlide(snapshot, slide), [
    { type: "elements.unframe", slideId: snapshot.slide.id, frameId },
  ]);
}

export interface DuplicateElementsResult {
  snapshot: EditorSnapshot;
  elementIds: string[];
}

export function duplicateElementsWithResult(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  newId: () => string,
  offset: { x: number; y: number } = { x: 20, y: 20 },
): DuplicateElementsResult {
  const selected = distinctElementIds(ids, "Duplicate selection");
  if (!selected.length) return { snapshot, elementIds: [] };
  const locations = selected.map((id) => locateElement(snapshot.slide, id));
  if (locations.some((location) => !location))
    throw new Error("Unknown Element in duplicate selection");
  const found = locations as ElementLocation[];
  const parentId = found[0].parentId;
  if (found.some((location) => location.parentId !== parentId))
    throw new Error("Duplicate selection requires one source scope");
  const elementMap = new Map<string, string>();
  const cloneId = (old: string) => {
    const id = newId();
    elementMap.set(old, id);
    return id;
  };
  const copies = [...found]
    .sort((left, right) => left.index - right.index)
    .map(({ element }) => {
      const before = [element, ...flattenDescendants(element)];
      let cursor = 0;
      const copy = cloneSubtree(element, () => cloneId(before[cursor++].id));
      copy.frame = {
        ...copy.frame,
        x: copy.frame.x + offset.x,
        y: copy.frame.y + offset.y,
      };
      return copy;
    });
  let next = insertElements(snapshot, copies, parentId);
  const fragment = cloneMotion(snapshot.slide.motion, elementMap);
  if (fragment)
    next = setSlideMotion(
      next,
      combineMotion(
        next.slide.motion,
        translateAbsoluteMotion(
          fragment,
          new Map(copies.map((copy) => [copy.id, offset])),
        ),
      ),
    );
  return { snapshot: next, elementIds: copies.map(({ id }) => id) };
}

export function duplicateElements(
  snapshot: EditorSnapshot,
  ids: Iterable<string>,
  newId: () => string,
  offset: { x: number; y: number } = { x: 20, y: 20 },
): EditorSnapshot {
  return duplicateElementsWithResult(snapshot, ids, newId, offset).snapshot;
}

type DeckLayersSetOperation = Extract<
  DocumentOperation,
  { type: "deck.layers.set" }
>;

function insertSlideAfter(
  slideIds: readonly string[],
  slideId: string,
  afterId: string | null,
) {
  const index = afterId === null ? -1 : slideIds.indexOf(afterId);
  if (afterId !== null && index < 0) throw new Error("Unknown slide anchor");
  return [
    ...slideIds.slice(0, index + 1),
    slideId,
    ...slideIds.slice(index + 1),
  ];
}

function validateSlideForDeck(snapshot: EditorSnapshot, slide: Slide): Slide {
  const parsed = slideSchema.parse(structuredClone(slide));
  const synced = syncLayerRoots(parsed, snapshot.deck.layers);
  if (!sameValue(parsed.nodes, synced.nodes))
    throw new Error("Slide layer roots must match deck Layers");
  return parsed;
}

export function createSlide(
  snapshot: EditorSnapshot,
  slide: Slide,
  meta: Deck["slideMeta"][string],
  afterId: string | null,
): EditorSnapshot {
  const nextSlide = validateSlideForDeck(snapshot, slide);
  if (snapshot.deck.slideIds.includes(nextSlide.id))
    throw new Error("Duplicate slide");
  const deck = deckSchema.parse({
    ...snapshot.deck,
    slideIds: insertSlideAfter(snapshot.deck.slideIds, nextSlide.id, afterId),
    slideMeta: {
      ...snapshot.deck.slideMeta,
      [nextSlide.id]: structuredClone(meta),
    },
  });
  return appendChange(snapshot, withDeck(snapshot, deck), [
    {
      type: "slide.create",
      slide: nextSlide,
      meta: structuredClone(meta),
      afterId,
    },
  ]);
}

export function duplicateSlide(
  snapshot: EditorSnapshot,
  sourceSlide: Slide,
  newSlideId: string,
  meta: Deck["slideMeta"][string],
  afterId: string | null = sourceSlide.id,
  newElementId: () => string = uid,
): EditorSnapshot {
  if (!snapshot.deck.slideIds.includes(sourceSlide.id))
    throw new Error("Unknown source slide");
  if (snapshot.deck.slideIds.includes(newSlideId))
    throw new Error("Duplicate slide");
  const elementMap = new Map<string, string>();
  const nodes = sourceSlide.nodes.map((root) => ({
    ...structuredClone(root),
    children: root.children.map((element) => {
      const before = [element, ...flattenDescendants(element)];
      let cursor = 0;
      return cloneSubtree(element, () => {
        const id = newElementId();
        elementMap.set(before[cursor++].id, id);
        return id;
      });
    }),
  }));
  const motion = cloneMotion(sourceSlide.motion, elementMap);
  const slide = validateSlideForDeck(snapshot, {
    ...structuredClone(sourceSlide),
    id: newSlideId,
    nodes,
    ...(motion ? { motion } : {}),
  });
  const deck = deckSchema.parse({
    ...snapshot.deck,
    slideIds: insertSlideAfter(snapshot.deck.slideIds, newSlideId, afterId),
    slideMeta: {
      ...snapshot.deck.slideMeta,
      [newSlideId]: structuredClone(meta),
    },
  });
  return appendChange(snapshot, withDeck(snapshot, deck), [
    {
      type: "slide.duplicate",
      sourceSlideId: sourceSlide.id,
      slide,
      meta: structuredClone(meta),
      afterId,
    },
  ]);
}

export function deleteSlide(
  snapshot: EditorSnapshot,
  slideId: string,
  replacementSlide?: Slide,
): EditorSnapshot {
  if (!snapshot.deck.slideIds.includes(slideId))
    throw new Error("Unknown slide");
  if (snapshot.deck.slideIds.length <= 1)
    throw new Error("Cannot remove final slide");
  const slideIds = snapshot.deck.slideIds.filter((id) => id !== slideId);
  const slideMeta = { ...snapshot.deck.slideMeta };
  delete slideMeta[slideId];
  const deck = deckSchema.parse({
    ...snapshot.deck,
    slideIds,
    slideMeta,
  });
  let slide = snapshot.slide;
  if (slideId === snapshot.slide.id) {
    if (!replacementSlide)
      throw new Error("Deleting the active slide requires a replacement slide");
    const replacement = validateSlideForDeck(snapshot, replacementSlide);
    if (!slideIds.includes(replacement.id))
      throw new Error("Replacement slide must remain in the deck");
    slide = replacement;
  }
  return appendChange(snapshot, { ...snapshot, deck, slide }, [
    { type: "slide.delete", slideId },
  ]);
}

export function setDeckLayers(
  snapshot: EditorSnapshot,
  layers: Deck["layers"],
  restoreRoots?: DeckLayersSetOperation["restoreRoots"],
): EditorSnapshot {
  const nextLayers = structuredClone(layers);
  const deck = deckSchema.parse({ ...snapshot.deck, layers: nextLayers });
  const slide = syncLayerRoots(
    snapshot.slide,
    deck.layers,
    restoreRoots?.[snapshot.slide.id],
  );
  if (sameValue(deck, snapshot.deck) && sameValue(slide, snapshot.slide))
    return snapshot;
  const operation: DocumentOperation = {
    type: "deck.layers.set",
    layers: nextLayers,
    ...(restoreRoots ? { restoreRoots: structuredClone(restoreRoots) } : {}),
  };
  return appendChange(
    snapshot,
    applyDocumentOperationsToProjection(snapshot, [operation])!,
    [operation],
  );
}

export function setDeckGuides(
  snapshot: EditorSnapshot,
  guideSets: Deck["guideSets"],
  defaultGuideSetId: string | null,
): EditorSnapshot {
  const nextGuideSets = structuredClone(guideSets);
  const deck = deckSchema.parse({
    ...snapshot.deck,
    guideSets: nextGuideSets,
    defaultGuideSetId,
  });
  if (sameValue(deck, snapshot.deck)) return snapshot;
  return appendChange(snapshot, withDeck(snapshot, deck), [
    {
      type: "deck.guides.set",
      guideSets: nextGuideSets,
      defaultGuideSetId,
    },
  ]);
}

export function setSlideBackground(
  snapshot: EditorSnapshot,
  background: string,
): EditorSnapshot {
  if (snapshot.slide.background === background) return snapshot;
  const next = withSlide(snapshot, { ...snapshot.slide, background });
  return appendChange(snapshot, next, [
    {
      type: "slide.background.set",
      slideId: snapshot.slide.id,
      background,
    },
  ]);
}

export function setSlideNotes(
  snapshot: EditorSnapshot,
  notes: string,
): EditorSnapshot {
  if (snapshot.slide.notes === notes) return snapshot;
  const next = withSlide(snapshot, { ...snapshot.slide, notes });
  return appendChange(snapshot, next, [
    { type: "slide.notes.set", slideId: snapshot.slide.id, notes },
  ]);
}

export function updateSlideMeta(
  snapshot: EditorSnapshot,
  slideId: string,
  patch: Partial<Deck["slideMeta"][string]>,
): EditorSnapshot {
  const current = snapshot.deck.slideMeta[slideId];
  if (!current) throw new Error(`Unknown slide metadata: ${slideId}`);
  const meta = { ...current, ...patch };
  if (sameValue(current, meta)) return snapshot;
  const deck = {
    ...snapshot.deck,
    slideMeta: { ...snapshot.deck.slideMeta, [slideId]: meta },
  };
  return appendChange(snapshot, withDeck(snapshot, deck), [
    { type: "slide.meta.set", slideId, meta },
  ]);
}

export function setDeckProperties(
  snapshot: EditorSnapshot,
  changes: Partial<
    Pick<Deck, "name" | "width" | "height" | "transitionDefaults">
  >,
): EditorSnapshot {
  if (
    Object.entries(changes).every(
      ([key, value]) => snapshot.deck[key as keyof Deck] === value,
    )
  )
    return snapshot;
  const deck = { ...snapshot.deck, ...changes };
  return appendChange(snapshot, withDeck(snapshot, deck), [
    { type: "deck.properties.set", changes },
  ]);
}

export function reorderSlides(
  snapshot: EditorSnapshot,
  slideId: string,
  afterId: string | null,
): EditorSnapshot {
  if (slideId === afterId) throw new Error("Invalid slide anchor");
  if (!snapshot.deck.slideIds.includes(slideId))
    throw new Error("Unknown slide");
  if (afterId !== null && !snapshot.deck.slideIds.includes(afterId))
    throw new Error("Unknown slide anchor");
  const remaining = snapshot.deck.slideIds.filter((id) => id !== slideId);
  const anchor = afterId === null ? -1 : remaining.indexOf(afterId);
  const slideIds = [...remaining];
  slideIds.splice(anchor + 1, 0, slideId);
  if (sameValue(snapshot.deck.slideIds, slideIds)) return snapshot;
  const deck = { ...snapshot.deck, slideIds };
  return appendChange(snapshot, withDeck(snapshot, deck), [
    { type: "slide.reorder", slideId, afterId },
  ]);
}

export function moveSlidesToTarget(
  snapshot: EditorSnapshot,
  slideIds: readonly string[],
  target: SlideDropTarget,
): EditorSnapshot {
  const movingIds = expandSlideSubtrees(snapshot.deck, slideIds);
  if (!movingIds.length) return snapshot;
  const destination = moveSlideSubtrees(snapshot.deck, movingIds, target);
  if (destination === snapshot.deck) return snapshot;

  const moving = new Set(movingIds);
  let next = snapshot;
  for (let index = 0; index < destination.slideIds.length; index++) {
    const id = destination.slideIds[index];
    if (!moving.has(id)) continue;
    next = reorderSlides(
      next,
      id,
      index > 0 ? destination.slideIds[index - 1] : null,
    );
  }
  for (const id of destination.slideIds) {
    const section = destination.slideMeta[id]?.section ?? "";
    if ((next.deck.slideMeta[id]?.section ?? "") !== section)
      next = updateSlideMeta(next, id, { section });
  }

  if (!sameValue(next.deck.slideIds, destination.slideIds))
    throw new Error("Slide move operation did not reach the requested order");
  return next;
}

export function setSlideMotion(
  snapshot: EditorSnapshot,
  motion: SlideMotion | null,
): EditorSnapshot {
  const slide = { ...snapshot.slide };
  if (motion) slide.motion = motion;
  else delete slide.motion;
  return appendChange(snapshot, withSlide(snapshot, slideSchema.parse(slide)), [
    { type: "slide.motion.set", slideId: slide.id, motion },
  ]);
}

function flattenDescendants(element: Element): Element[] {
  return element.children.flatMap((e) => [e, ...flattenDescendants(e)]);
}
export function combineMotion(
  current: SlideMotion | undefined,
  fragment: SlideMotion,
): SlideMotion {
  const motion = structuredClone(current ?? { stages: [] });
  for (let i = 0; i < fragment.stages.length; i++) {
    const source = fragment.stages[i];
    if (!motion.stages[i]) motion.stages.push({ id: uid(), tracks: [] });
    const stage = motion.stages[i];
    stage.tracks.push(...source.tracks);
    stage.blocks = [
      ...(stage.blocks ?? []),
      ...structuredClone(source.blocks ?? []).map((block) => {
        const end = block.presenceSchedule?.end ?? block.effectSchedule?.stop;
        if (end?.mode === "click") {
          const index = fragment.stages.findIndex((s) => s.id === end.stageId);
          while (motion.stages.length <= index)
            motion.stages.push({ id: uid(), tracks: [] });
          end.stageId = motion.stages[index].id;
        }
        return block;
      }),
    ];
  }
  return motion;
}
