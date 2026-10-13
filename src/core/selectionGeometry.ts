import { deriveGuides } from "./guides";
import type { Box, Point } from "./geometry";
import type { SnapTargetSources } from "./snapping";
import type { Deck, Slide } from "./document";
import {
  IDENTITY,
  inverse,
  localMatrix,
  multiply,
  transformPoint,
  type Matrix,
  type Element,
} from "./element";
import {
  findElement,
  getChildren,
  getWorldMatrix,
  locateElement,
  type ScopeId,
} from "./scene";

const EPSILON = 1e-7;

export interface OrientedGeometry extends Box {
  center: Point;
  rotation: number;
  orientedWidth: number;
  orientedHeight: number;
  corners: readonly [Point, Point, Point, Point];
}

export interface ScopeSnapTargets {
  x: SnapTargetSources;
  y: SnapTargetSources;
}

function boundsFromPoints(points: readonly Point[]): Box {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function rectangleCorners(
  matrix: Matrix,
  width: number,
  height: number,
): readonly [Point, Point, Point, Point] {
  return [
    transformPoint(matrix, { x: 0, y: 0 }),
    transformPoint(matrix, { x: width, y: 0 }),
    transformPoint(matrix, { x: width, y: height }),
    transformPoint(matrix, { x: 0, y: height }),
  ];
}

function rotationOf(corners: readonly [Point, Point, Point, Point]): number {
  const dx = corners[1].x - corners[0].x;
  const dy = corners[1].y - corners[0].y;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function centerOfCorners(corners: readonly [Point, Point, Point, Point]): Point {
  return {
    x: corners.reduce((sum, point) => sum + point.x, 0) / 4,
    y: corners.reduce((sum, point) => sum + point.y, 0) / 4,
  };
}

/** World/slide transform of a Layer root or container Element selection scope. */
export function getSelectionScopeWorldMatrix(
  slide: Slide,
  scopeId: ScopeId,
): Matrix {
  if (slide.nodes.some((root) => root.id === scopeId)) return IDENTITY;
  const scope = findElement(slide, scopeId);
  if (!scope?.container)
    throw new Error(`Unknown or non-container scope: ${scopeId}`);
  return getWorldMatrix(slide, scopeId);
}

/** Convert a slide/world point into the active selection scope. */
export function worldPointToScope(
  slide: Slide,
  scopeId: ScopeId,
  point: Point,
): Point {
  return transformPoint(inverse(getSelectionScopeWorldMatrix(slide, scopeId)), point);
}

/** Convert a point in the active selection scope into slide/world coordinates. */
export function scopePointToWorld(
  slide: Slide,
  scopeId: ScopeId,
  point: Point,
): Point {
  return transformPoint(getSelectionScopeWorldMatrix(slide, scopeId), point);
}

/** Convert a slide/world movement vector into the active selection scope. */
export function worldVectorToScope(
  slide: Slide,
  scopeId: ScopeId,
  vector: Point,
): Point {
  const matrix = inverse(getSelectionScopeWorldMatrix(slide, scopeId));
  return {
    x: matrix[0] * vector.x + matrix[2] * vector.y,
    y: matrix[1] * vector.x + matrix[3] * vector.y,
  };
}

/** Convert a movement vector in the active selection scope into slide/world coordinates. */
export function scopeVectorToWorld(
  slide: Slide,
  scopeId: ScopeId,
  vector: Point,
): Point {
  const matrix = getSelectionScopeWorldMatrix(slide, scopeId);
  return {
    x: matrix[0] * vector.x + matrix[2] * vector.y,
    y: matrix[1] * vector.x + matrix[3] * vector.y,
  };
}

/** Element rectangle corners expressed in the requested active selection scope. */
export function elementCornersInScope(
  slide: Slide,
  elementId: string,
  scopeId: ScopeId,
): readonly [Point, Point, Point, Point] {
  const location = locateElement(slide, elementId);
  if (!location) throw new Error(`Unknown Element: ${elementId}`);
  const scoped = multiply(
    inverse(getSelectionScopeWorldMatrix(slide, scopeId)),
    location.world,
  );
  return rectangleCorners(
    scoped,
    location.element.frame.width,
    location.element.frame.height,
  );
}

/** Axis-aligned visible bounds of one Element in the active selection scope. */
export function elementBoundsInScope(
  slide: Slide,
  elementId: string,
  scopeId: ScopeId,
): Box {
  return boundsFromPoints(elementCornersInScope(slide, elementId, scopeId));
}

/** Axis-aligned bounds of selected Elements in the active selection scope. */
export function selectionBoundsInScope(
  slide: Slide,
  elementIds: readonly string[],
  scopeId: ScopeId,
): Box {
  if (!elementIds.length) return { x: 0, y: 0, width: 0, height: 0 };
  return boundsFromPoints(
    elementIds.flatMap((id) => [
      ...elementCornersInScope(slide, id, scopeId),
    ]),
  );
}

export function selectionCenterInScope(
  slide: Slide,
  elementIds: readonly string[],
  scopeId: ScopeId,
): Point {
  const bounds = selectionBoundsInScope(slide, elementIds, scopeId);
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/** Oriented world geometry for a single Element, including inherited transforms. */
export function elementWorldGeometry(
  slide: Slide,
  elementId: string,
): OrientedGeometry {
  const location = locateElement(slide, elementId);
  if (!location) throw new Error(`Unknown Element: ${elementId}`);
  const corners = rectangleCorners(
    location.world,
    location.element.frame.width,
    location.element.frame.height,
  );
  const bounds = boundsFromPoints(corners);
  return {
    ...bounds,
    center: centerOfCorners(corners),
    rotation: rotationOf(corners),
    orientedWidth: Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y),
    orientedHeight: Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y),
    corners,
  };
}

/**
 * Slide-level selection overlay geometry. A single selection follows the
 * Element's inherited orientation. Multi-selection uses an AABB in the active
 * scope, then projects that rectangle into slide space.
 */
export function selectionWorldGeometry(
  slide: Slide,
  elementIds: readonly string[],
  scopeId: ScopeId,
): OrientedGeometry {
  if (!elementIds.length)
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      center: { x: 0, y: 0 },
      rotation: 0,
      orientedWidth: 0,
      orientedHeight: 0,
      corners: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    };
  if (elementIds.length === 1)
    return elementWorldGeometry(slide, elementIds[0]);

  const scoped = selectionBoundsInScope(slide, elementIds, scopeId);
  const scopeWorld = getSelectionScopeWorldMatrix(slide, scopeId);
  const translated: Matrix = [
    scopeWorld[0],
    scopeWorld[1],
    scopeWorld[2],
    scopeWorld[3],
    scopeWorld[4] + scopeWorld[0] * scoped.x + scopeWorld[2] * scoped.y,
    scopeWorld[5] + scopeWorld[1] * scoped.x + scopeWorld[3] * scoped.y,
  ];
  const corners = rectangleCorners(translated, scoped.width, scoped.height);
  const bounds = boundsFromPoints(corners);
  return {
    ...bounds,
    center: centerOfCorners(corners),
    rotation: rotationOf(corners),
    orientedWidth: scoped.width,
    orientedHeight: scoped.height,
    corners,
  };
}

/** Rotation shown by a future slide-level selection overlay. */
export function selectionWorldRotation(
  slide: Slide,
  elementIds: readonly string[],
  scopeId: ScopeId,
): number {
  return selectionWorldGeometry(slide, elementIds, scopeId).rotation;
}

export function isDirectChildSelection(
  slide: Slide,
  elementIds: readonly string[],
  scopeId: ScopeId,
): boolean {
  return (
    elementIds.length > 0 &&
    elementIds.every((id) => locateElement(slide, id)?.parentId === scopeId)
  );
}

function projectWorldAxisLineToScope(
  slide: Slide,
  deck: Deck,
  scopeId: ScopeId,
  axis: "vertical" | "horizontal",
  position: number,
): { axis: "vertical" | "horizontal"; position: number } | null {
  const inverseScope = inverse(getSelectionScopeWorldMatrix(slide, scopeId));
  const first = transformPoint(
    inverseScope,
    axis === "vertical" ? { x: position, y: 0 } : { x: 0, y: position },
  );
  const second = transformPoint(
    inverseScope,
    axis === "vertical"
      ? { x: position, y: deck.height }
      : { x: deck.width, y: position },
  );
  if (Math.abs(first.x - second.x) <= EPSILON)
    return { axis: "vertical", position: (first.x + second.x) / 2 };
  if (Math.abs(first.y - second.y) <= EPSILON)
    return { axis: "horizontal", position: (first.y + second.y) / 2 };
  return null;
}

function pushWorldAxisTargets(
  target: ScopeSnapTargets,
  source: keyof SnapTargetSources,
  slide: Slide,
  deck: Deck,
  scopeId: ScopeId,
  axis: "vertical" | "horizontal",
  positions: readonly number[],
) {
  for (const position of positions) {
    const projected = projectWorldAxisLineToScope(
      slide,
      deck,
      scopeId,
      axis,
      position,
    );
    if (!projected) continue;
    const destination = projected.axis === "vertical" ? target.x : target.y;
    (destination[source] ??= []).push(projected.position);
  }
}

/**
 * Snap targets expressed entirely in the active selection scope. Oblique
 * world guides are deliberately skipped because the existing snap utilities
 * are one-dimensional and cannot represent an oblique line faithfully.
 */
export function scopeSnapTargets(
  slide: Slide,
  deck: Deck,
  scopeId: ScopeId,
  selectedIds: readonly string[],
  options: {
    objects: boolean;
    guides: boolean;
    slide: boolean;
  },
): ScopeSnapTargets {
  const target: ScopeSnapTargets = { x: {}, y: {} };
  const selected = new Set(selectedIds);

  if (options.objects) {
    const children = getChildren(slide, scopeId);
    if (!children) throw new Error(`Unknown or non-container scope: ${scopeId}`);
    const boxes = children
      .filter(({ id }) => !selected.has(id))
      // Direct children already have frames in this scope. Avoid one full
      // scene lookup per sibling while preparing a large gesture target set.
      .map((element) =>
        boundsFromPoints(
          rectangleCorners(
            localMatrix(element.frame),
            element.frame.width,
            element.frame.height,
          ),
        ),
      );
    target.x.objects = boxes.flatMap((box) => [
      box.x,
      box.x + box.width / 2,
      box.x + box.width,
    ]);
    target.y.objects = boxes.flatMap((box) => [
      box.y,
      box.y + box.height / 2,
      box.y + box.height,
    ]);
  }

  if (options.guides && deck.defaultGuideSetId) {
    const guideSet = deck.guideSets[deck.defaultGuideSetId];
    if (guideSet) {
      const guides = deriveGuides(guideSet, deck.width, deck.height);
      pushWorldAxisTargets(
        target,
        "persistent",
        slide,
        deck,
        scopeId,
        "vertical",
        guides
          .filter((guide) => guide.axis === "vertical")
          .map((guide) => guide.position),
      );
      pushWorldAxisTargets(
        target,
        "persistent",
        slide,
        deck,
        scopeId,
        "horizontal",
        guides
          .filter((guide) => guide.axis === "horizontal")
          .map((guide) => guide.position),
      );
    }
  }

  if (options.slide) {
    pushWorldAxisTargets(
      target,
      "slide",
      slide,
      deck,
      scopeId,
      "vertical",
      [0, deck.width / 2, deck.width],
    );
    pushWorldAxisTargets(
      target,
      "slide",
      slide,
      deck,
      scopeId,
      "horizontal",
      [0, deck.height / 2, deck.height],
    );
  }

  return target;
}

/** Media gestures use the Element's local space even when it is not a container. */
export function mediaSnapTargets(
  slide: Slide,
    deck: Deck,
  elementId: string,
  options: { objects: boolean; guides: boolean; slide: boolean },
): ScopeSnapTargets {
  const location = locateElement(slide, elementId);
  if (!location) throw new Error(`Unknown Element: ${elementId}`);
  const target: ScopeSnapTargets = { x: {}, y: {} };
  const toLocal = inverse(location.world);
  if (options.objects) {
    const siblings = getChildren(slide, location.parentId) ?? [];
    const boxes = siblings
      .filter(({ id }) => id !== elementId)
      .map(({ id }) =>
        boundsFromPoints(
          elementWorldGeometry(slide, id).corners.map((point) =>
            transformPoint(toLocal, point),
          ),
        ),
      );
    target.x.objects = boxes.flatMap((box) => [
      box.x,
      box.x + box.width / 2,
      box.x + box.width,
    ]);
    target.y.objects = boxes.flatMap((box) => [
      box.y,
      box.y + box.height / 2,
      box.y + box.height,
    ]);
  }
  const addLine = (
    axis: "vertical" | "horizontal",
    position: number,
    source: "persistent" | "slide",
  ) => {
    const a = transformPoint(
      toLocal,
      axis === "vertical" ? { x: position, y: 0 } : { x: 0, y: position },
    );
    const b = transformPoint(
      toLocal,
      axis === "vertical"
        ? { x: position, y: deck.height }
        : { x: deck.width, y: position },
    );
    if (Math.abs(a.x - b.x) < EPSILON) (target.x[source] ??= []).push(a.x);
    else if (Math.abs(a.y - b.y) < EPSILON) (target.y[source] ??= []).push(a.y);
  };
  if (options.guides && deck.defaultGuideSetId) {
    const set = deck.guideSets[deck.defaultGuideSetId];
    if (set)
      for (const guide of deriveGuides(set, deck.width, deck.height))
        addLine(guide.axis, guide.position, "persistent");
  }
  if (options.slide) {
    // The frame boundary remains an editing target in addition to slide guides.
    target.x.slide = [
      0,
      location.element.frame.width / 2,
      location.element.frame.width,
    ];
    target.y.slide = [
      0,
      location.element.frame.height / 2,
      location.element.frame.height,
    ];
    for (const x of [0, deck.width / 2, deck.width])
      addLine("vertical", x, "slide");
    for (const y of [0, deck.height / 2, deck.height])
      addLine("horizontal", y, "slide");
  }

  return target;
}

export function elementFrameInScope(
  slide: Slide,
  elementId: string,
  scopeId: ScopeId,
): Element["frame"] {
  const location = locateElement(slide, elementId);
  if (!location) throw new Error(`Unknown Element: ${elementId}`);
  if (location.parentId !== scopeId)
    throw new Error("Normal transform selection must be a direct child of its scope");
  return location.element.frame;
}

/**
 * Convert axis-aligned gesture guides from selection-scope coordinates to
 * slide coordinates when the transformed line is still slide-axis-aligned.
 */
export function scopeGuidesToWorld(
  slide: Slide,
  scopeId: ScopeId,
  guides: { x?: number; y?: number },
): { x?: number; y?: number } {
  const matrix = getSelectionScopeWorldMatrix(slide, scopeId);
  const result: { x?: number; y?: number } = {};

  if (guides.x !== undefined) {
    const point = transformPoint(matrix, { x: guides.x, y: 0 });
    const direction = { x: matrix[2], y: matrix[3] };
    if (Math.abs(direction.x) <= EPSILON) result.x = point.x;
    else if (Math.abs(direction.y) <= EPSILON) result.y = point.y;
  }
  if (guides.y !== undefined) {
    const point = transformPoint(matrix, { x: 0, y: guides.y });
    const direction = { x: matrix[0], y: matrix[1] };
    if (Math.abs(direction.x) <= EPSILON) result.x = point.x;
    else if (Math.abs(direction.y) <= EPSILON) result.y = point.y;
  }

  return result;
}

/** Project the overlay rectangle onto the actual world corners, including oblique edges. */
export function selectionCssTransform(geometry: OrientedGeometry): string {
  const [a, b, , d] = geometry.corners;
  const w = geometry.orientedWidth || 1;
  const h = geometry.orientedHeight || 1;
  return `matrix(${(b.x - a.x) / w}, ${(b.y - a.y) / w}, ${(d.x - a.x) / h}, ${(d.y - a.y) / h}, 0, 0)`;
}
