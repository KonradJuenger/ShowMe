import { snapRotation } from "./handleGeometry";
import { centerOf, resizeBox, resizeTransform, type Box, type Point, type ResizeHandle } from "./geometry";
import { snap } from "./history";
import {
  setElementFrames, setElementContents,
  duplicateElementsWithResult,
  resizeElements,
  rotateElements,
  translateElements,
  type EditorSnapshot,
} from "./editorCommands";
import { preserveMediaAfterFrameChange } from "./media";
import { findElement } from "./scene";
import { inverse, localMatrix, transformPoint } from "./element";
import type { EditorChange } from "./editorChange";
import type { ScopeId } from "./scene";
import {
  isDirectChildSelection,
  elementFrameInScope,
  scopeSnapTargets,
  selectionBoundsInScope,
  selectionWorldGeometry,
  worldPointToScope,
  worldVectorToScope,
  getSelectionScopeWorldMatrix,
} from "./selectionGeometry";
import { resolveResizeSnapAxis } from "./snapping";
import {
  createDragSnapAxis,
  type DragSnapSettings,
  type DragAxisResult,
} from "./dragSnapping";
import { measurePerformance } from "./performance";

export type TransformSnapshot = EditorSnapshot | EditorChange;
export type GestureMeasurement = Box & { rotation?: number };

export interface TransformPreview {
  snapshot: TransformSnapshot;
  changed: boolean;
  scopeGuides: { x?: number; y?: number };
  measurement: GestureMeasurement;
}

export interface TransformSnapOptions {
  enabled: boolean;
  toObjects: boolean;
  toGuides: boolean;
  toSlide: boolean;
  scale: number;
  disableSmartSnap?: boolean;
}

const emptySnap: TransformSnapOptions = {
  enabled: false,
  toObjects: false,
  toGuides: false,
  toSlide: false,
  scale: 1,
};

function changed(source: TransformSnapshot, next: TransformSnapshot) {
  return next !== source;
}

function measurement(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
  rotation?: number,
): GestureMeasurement {
  const geometry = selectionWorldGeometry(snapshot.slide, ids, scopeId);
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    ...(rotation === undefined ? {} : { rotation }),
  };
}

function requireDirectSelection(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
) {
  if (!isDirectChildSelection(snapshot.slide, ids, scopeId))
    throw new Error("Normal transform selection must be direct children of one scope");
}

function normalizeRotation(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

/** Gesture-local move solver; document writes still go through the existing commit path. */
export function createMoveGesture(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
  options: TransformSnapOptions,
  settings: DragSnapSettings,
  startedAt: number,
) {
  requireDirectSelection(snapshot, ids, scopeId);
  const matrix = getSelectionScopeWorldMatrix(snapshot.slide, scopeId);
  const toScope = inverse(matrix);
  const pixelsX = options.scale * Math.hypot(matrix[0], matrix[1]);
  const pixelsY = options.scale * Math.hypot(matrix[2], matrix[3]);
  const initialMeasurement = measurement(snapshot, ids, scopeId);
  const { moving, xAxis, yAxis } = measurePerformance(
    "interaction.snap.prepare",
    () => {
      const moving = selectionBoundsInScope(snapshot.slide, ids, scopeId);
      const targets = scopeSnapTargets(snapshot.slide, snapshot.deck, scopeId, ids, {
        objects: options.enabled && options.toObjects,
        guides: options.enabled && options.toGuides,
        slide: options.enabled && options.toSlide,
        drag: true,
      });
      return {
        moving,
        xAxis: createDragSnapAxis(moving.width, targets.x.features!, pixelsX, settings),
        yAxis: createDragSnapAxis(moving.height, targets.y.features!, pixelsY, settings),
      };
    },
  );
  let previous = { x: 0, y: 0, time: startedAt };
  let speedX = 0;
  let speedY = 0;

  return (worldDelta: Point, time: number, bypass = false): TransformPreview => {
    const raw = {
      x: toScope[0] * worldDelta.x + toScope[2] * worldDelta.y,
      y: toScope[1] * worldDelta.x + toScope[3] * worldDelta.y,
    };
    const elapsed = time - previous.time;
    let currentSpeedX = speedX;
    let currentSpeedY = speedY;
    if (elapsed > 0) {
      const instantaneousX =
        (Math.abs(raw.x - previous.x) * pixelsX * 1000) / elapsed;
      const instantaneousY =
        (Math.abs(raw.y - previous.y) * pixelsY * 1000) / elapsed;
      const blend = 1 - Math.exp(-elapsed / 32);
      speedX += (instantaneousX - speedX) * blend;
      speedY += (instantaneousY - speedY) * blend;
      // React immediately to fast movement; decay smoothly when slowing down.
      currentSpeedX = Math.max(instantaneousX, speedX);
      currentSpeedY = Math.max(instantaneousY, speedY);
      previous = { ...raw, time };
    }
    const snapped = measurePerformance(
      "interaction.snap.query",
      (): { x: DragAxisResult; y: DragAxisResult } => {
        if (!options.enabled || bypass) {
          xAxis.reset();
          yAxis.reset();
          return { x: { value: moving.x + raw.x }, y: { value: moving.y + raw.y } };
        }
        return {
          x: xAxis.resolve(moving.x + raw.x, currentSpeedX, {
            start: moving.y + raw.y,
            end: moving.y + raw.y + moving.height,
            pixelsPerUnit: pixelsY,
          }),
          y: yAxis.resolve(moving.y + raw.y, currentSpeedY, {
            start: moving.x + raw.x,
            end: moving.x + raw.x + moving.width,
            pixelsPerUnit: pixelsX,
          }),
        };
      },
    );
    const dx = snapped.x.value - moving.x;
    const dy = snapped.y.value - moving.y;
    const next = translateElements(snapshot, ids, dx, dy, scopeId);
    const worldX = matrix[0] * dx + matrix[2] * dy;
    const worldY = matrix[1] * dx + matrix[3] * dy;
    return {
      snapshot: next,
      changed: changed(snapshot, next),
      scopeGuides: {
        x: snapped.x.source === "persistent" ? undefined : snapped.x.guide,
        y: snapped.y.source === "persistent" ? undefined : snapped.y.guide,
      },
      measurement: {
        ...initialMeasurement,
        x: initialMeasurement.x + worldX,
        y: initialMeasurement.y + worldY,
      },
    };
  };
}

function resizeGuideFeedback(
  box: Box,
  handle: ResizeHandle,
  candidate: {
    x?: { guide?: number; source?: "persistent" | "slide" | "objects" };
    y?: { guide?: number; source?: "persistent" | "slide" | "objects" };
  },
) {
  const result: { x?: number; y?: number } = {};
  const epsilon = 0.01;
  if (candidate.x?.guide !== undefined && candidate.x.source !== "persistent") {
    const edge = handle.includes("w") ? box.x : box.x + box.width;
    const center = box.x + box.width / 2;
    if (
      Math.min(
        Math.abs(edge - candidate.x.guide),
        Math.abs(center - candidate.x.guide),
      ) <= epsilon
    )
      result.x = candidate.x.guide;
  }
  if (candidate.y?.guide !== undefined && candidate.y.source !== "persistent") {
    const edge = handle.includes("n") ? box.y : box.y + box.height;
    const center = box.y + box.height / 2;
    if (
      Math.min(
        Math.abs(edge - candidate.y.guide),
        Math.abs(center - candidate.y.guide),
      ) <= epsilon
    )
      result.y = candidate.y.guide;
  }
  return result;
}

export function previewResize(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
  handle: ResizeHandle,
  worldDelta: Point,
  shiftKey: boolean,
  options: TransformSnapOptions = emptySnap,
): TransformPreview {
  requireDirectSelection(snapshot, ids, scopeId);
  const localDelta = worldVectorToScope(snapshot.slide, scopeId, worldDelta);
  let dx = localDelta.x;
  let dy = localDelta.y;
  const horizontal = handle.includes("w") || handle.includes("e");
  const vertical = handle.includes("n") || handle.includes("s");
  // The media aspect lock applies to its content, not the enclosing frame.
  const selectedElement = ids.length === 1 ? findElement(snapshot.slide, ids[0]) : null;
  const scaleGroup = !!selectedElement?.children.length;
  const keepRatio = scaleGroup ? !shiftKey : shiftKey;
  const targets = scopeSnapTargets(
    snapshot.slide,
    snapshot.deck,
    scopeId,
    ids,
    {
      objects: options.enabled && options.toObjects,
      guides: options.enabled && options.toGuides,
      slide: options.enabled && options.toSlide,
    },
  );
  const tolerance = 8 / Math.max(1e-9, options.scale);
  const candidate: {
    x?: ReturnType<typeof resolveResizeSnapAxis>;
    y?: ReturnType<typeof resolveResizeSnapAxis>;
  } = {};
  const minSize = 10;

  if (options.enabled) {
    dx = snap(dx, true);
    dy = snap(dy, true);
  }

  if (ids.length === 1) {
    const frame = elementFrameInScope(snapshot.slide, ids[0], scopeId);
    if (scaleGroup || frame.flipX || frame.flipY || frame.scaleX !== 1 || frame.scaleY !== 1 || frame.originX !== 0.5 || frame.originY !== 0.5) {
      const matrix = localMatrix(frame);
      const local = inverse(matrix);
      const delta = { x: local[0] * dx + local[2] * dy, y: local[1] * dx + local[3] * dy };
      const box = resizeBox({ x: 0, y: 0, width: frame.width, height: frame.height }, handle, delta.x, delta.y, { keepRatio, minSize });
      const fixedPoint = (width: number, height: number) => ({
        x: handle.includes("w") ? width : handle.includes("e") ? 0 : width / 2,
        y: handle.includes("n") ? height : handle.includes("s") ? 0 : height / 2,
      });
      const oldFixed = fixedPoint(frame.width, frame.height);
      const value = scaleGroup
        ? { ...frame, scaleX: frame.scaleX * box.width / frame.width, scaleY: frame.scaleY * box.height / frame.height }
        : { ...frame, width: box.width, height: box.height };
      const newFixed = fixedPoint(value.width, value.height);
      const before = transformPoint(matrix, oldFixed);
      const after = transformPoint(localMatrix(value), newFixed);
      value.x += before.x - after.x;
      value.y += before.y - after.y;
      let next = setElementFrames(snapshot, [{ elementId: ids[0], value }]);
      const element = findElement(snapshot.slide, ids[0]);
      if (!scaleGroup && element?.content?.type === "text" && element.content.autoSize !== "none" && (value.width !== frame.width || value.height !== frame.height))
        next = setElementContents(next, [{ elementId: element.id, value: { ...element.content, autoSize: "none" } }]);
      if (!scaleGroup && element?.content && element.content.type !== "text" && element.content.transform.rule === "free") {
        const content = preserveMediaAfterFrameChange(element, value);
        if (content) next = setElementContents(next, [{ elementId: element.id, value: content }]);
      }
      return { snapshot: next, changed: changed(snapshot, next), scopeGuides: {}, measurement: measurement(next, ids, scopeId) };
    }
    const start: Box = {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
    const smart =
      options.enabled &&
      !options.disableSmartSnap &&
      Math.min(
        normalizeRotation(frame.rotation),
        360 - normalizeRotation(frame.rotation),
      ) < 0.001;

    if (smart) {
      const raw = resizeBox(start, handle, dx, dy, { keepRatio, minSize });
      if (horizontal) {
        candidate.x = resolveResizeSnapAxis(
          raw.x,
          raw.width,
          handle.includes("w") ? "start" : "end",
          targets.x,
          tolerance,
          minSize,
        );
        if (candidate.x.guide !== undefined)
          dx = handle.includes("w")
            ? candidate.x.position - start.x
            : candidate.x.position + candidate.x.size - (start.x + start.width);
      }
      if (vertical) {
        candidate.y = resolveResizeSnapAxis(
          raw.y,
          raw.height,
          handle.includes("n") ? "start" : "end",
          targets.y,
          tolerance,
          minSize,
        );
        if (candidate.y.guide !== undefined)
          dy = handle.includes("n")
            ? candidate.y.position - start.y
            : candidate.y.position + candidate.y.size - (start.y + start.height);
      }
    }

    const resized = resizeTransform(
      { ...start, rotation: frame.rotation },
      handle,
      dx,
      dy,
      { keepRatio, minSize },
    );
    const nextBox: Box = {
      x: resized.x,
      y: resized.y,
      width: resized.width,
      height: resized.height,
    };
    const next = resizeElements(snapshot, ids, start, nextBox, scopeId);
    return {
      snapshot: next,
      changed: changed(snapshot, next),
      scopeGuides: resizeGuideFeedback(nextBox, handle, candidate),
      measurement: measurement(next, ids, scopeId),
    };
  }

  const start = selectionBoundsInScope(snapshot.slide, ids, scopeId);
  if (options.enabled && !options.disableSmartSnap) {
    const raw = resizeBox(start, handle, dx, dy, { keepRatio, minSize });
    if (horizontal) {
      candidate.x = resolveResizeSnapAxis(
        raw.x,
        raw.width,
        handle.includes("w") ? "start" : "end",
        targets.x,
        tolerance,
        minSize,
      );
      if (candidate.x.guide !== undefined)
        dx = handle.includes("w")
          ? candidate.x.position - start.x
          : candidate.x.position + candidate.x.size - (start.x + start.width);
    }
    if (vertical) {
      candidate.y = resolveResizeSnapAxis(
        raw.y,
        raw.height,
        handle.includes("n") ? "start" : "end",
        targets.y,
        tolerance,
        minSize,
      );
      if (candidate.y.guide !== undefined)
        dy = handle.includes("n")
          ? candidate.y.position - start.y
          : candidate.y.position + candidate.y.size - (start.y + start.height);
    }
  }

  const rawNext = resizeBox(start, handle, dx, dy, { keepRatio, minSize });
  const nextBox = options.enabled
    ? {
        x: candidate.x?.guide !== undefined ? rawNext.x : snap(rawNext.x),
        y: candidate.y?.guide !== undefined ? rawNext.y : snap(rawNext.y),
        width:
          candidate.x?.guide !== undefined
            ? rawNext.width
            : Math.max(minSize, snap(rawNext.width)),
        height:
          candidate.y?.guide !== undefined
            ? rawNext.height
            : Math.max(minSize, snap(rawNext.height)),
      }
    : rawNext;
  const next = resizeElements(snapshot, ids, start, nextBox, scopeId);
  return {
    snapshot: next,
    changed: changed(snapshot, next),
    scopeGuides: resizeGuideFeedback(nextBox, handle, candidate),
    measurement: measurement(next, ids, scopeId),
  };
}

export function previewRotation(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
  startWorld: Point,
  currentWorld: Point,
  shiftKey: boolean,
): TransformPreview {
  requireDirectSelection(snapshot, ids, scopeId);
  const group = selectionBoundsInScope(snapshot.slide, ids, scopeId);
  const center = centerOf(group);
  const start = worldPointToScope(snapshot.slide, scopeId, startWorld);
  const current = worldPointToScope(snapshot.slide, scopeId, currentWorld);
  // Rotation is inside the signed scale in S R. Measure pointer angles after
  // removing that scale, otherwise reflected/asymmetric frames rotate incorrectly.
  const frame = ids.length === 1 ? elementFrameInScope(snapshot.slide, ids[0], scopeId) : null;
  const sx = frame ? frame.scaleX * (frame.flipX ? -1 : 1) : 1;
  const sy = frame ? frame.scaleY * (frame.flipY ? -1 : 1) : 1;
  const startAngle = Math.atan2((start.y - center.y) / sy, (start.x - center.x) / sx);
  const angle = Math.atan2((current.y - center.y) / sy, (current.x - center.x) / sx);
  let delta = ((angle - startAngle) * 180) / Math.PI;
  const baseRotation = frame?.rotation ?? 0;
  delta = snapRotation(baseRotation + delta, shiftKey) - baseRotation;
  const next = rotateElements(snapshot, ids, center, delta, scopeId);
  return {
    snapshot: next,
    changed: changed(snapshot, next),
    scopeGuides: {},
    measurement: measurement(next, ids, scopeId, delta),
  };
}

export function duplicateForAltDrag(
  snapshot: TransformSnapshot,
  ids: readonly string[],
  scopeId: ScopeId,
  newId: () => string,
): { snapshot: TransformSnapshot; elementIds: string[] } {
  requireDirectSelection(snapshot, ids, scopeId);
  const result = duplicateElementsWithResult(snapshot, ids, newId, {
    x: 0,
    y: 0,
  });
  if (result.elementIds.length !== ids.length)
    throw new Error("Alt duplicate root count mismatch");
  return result;
}

export interface OptimisticLease {
  readonly granted: boolean;
  wait(): Promise<boolean>;
  finish(commit: () => void, rollback: () => void): Promise<boolean>;
  cancel(rollback: () => void): void;
}

/**
 * Gesture-local lease coordinator. `release` is invoked immediately on cancel,
 * which fences an outstanding EditorSession request before a later
 * gesture can reuse ownership.
 */
export function createOptimisticLease(
  acquire: () => Promise<boolean>,
  release: () => Promise<void>,
): OptimisticLease {
  let active = true;
  let granted = false;
  const request = acquire()
    .then((value) => {
      if (active) granted = value;
      return active && value;
    })
    .catch(() => false);

  return {
    get granted() {
      return granted;
    },
    wait() {
      return request;
    },
    async finish(commit, rollback) {
      const approved = await request;
      if (!active) return false;
      active = false;
      if (approved) {
        commit();
        return true;
      }
      rollback();
      return false;
    },
    cancel(rollback) {
      if (!active) return;
      active = false;
      rollback();
      void release().catch(() => undefined);
    },
  };
}
