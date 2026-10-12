import { resizeHandleCursor } from "../core/handleGeometry";
import type { ResizeHandle } from "../core/geometry";
import type { Matrix } from "../core/element";
import type { TransformSnapshot } from "../core/transformInteraction";
import {
  frameCssTransform,
  frameCssOrigin,
  resolveMediaFrame,
  type Element,
} from "../core/element";
import { findElement, type ScopeId } from "../core/scene";
import {
  selectionCssTransform,
  selectionWorldGeometry,
} from "../core/selectionGeometry";
import type { GestureMeasurement } from "../core/transformInteraction";

export interface GestureFeedback {
  guides?: { x?: number; y?: number };
  measurement?: GestureMeasurement;
}

function sameFrame(
  left: Element["frame"] | undefined,
  right: Element["frame"] | undefined,
) {
  return (
    !!left &&
    !!right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.scaleX === right.scaleX &&
    left.scaleY === right.scaleY &&
    left.originX === right.originX &&
    left.originY === right.originY &&
    left.flipX === right.flipX &&
    left.flipY === right.flipY
  );
}

function applyLocalFrame(target: HTMLElement, frame: Element["frame"]) {
  target.style.left = `${frame.x}px`;
  target.style.top = `${frame.y}px`;
  target.style.width = `${frame.width}px`;
  target.style.height = `${frame.height}px`;
  target.style.transformOrigin = frameCssOrigin(frame);
  target.style.transform = frameCssTransform(frame);
}

/**
 * Visual-only transform preview. Element DOM nodes keep parent-local frame
 * coordinates; only the selection overlay is projected into slide space.
 */
export function createTransientTransformPreview(
  stage: HTMLElement,
  initial: TransformSnapshot,
  selected: readonly string[],
  scopeId: ScopeId,
  scale: number,
) {
  const rendered = new Map<string, HTMLElement>();
  stage
    .querySelectorAll<HTMLElement>("[data-element-id]")
    .forEach((node) => rendered.set(node.dataset.elementId!, node));

  const lastFrames = new Map(
    selected.map((id) => [id, findElement(initial.slide, id)?.frame]),
  );
  const media = new Map<string, HTMLElement>();
  for (const [id, target] of rendered) {
    const content = [
      ...target.querySelectorAll<HTMLElement>("[data-media-asset-id]"),
    ].find((node) => node.closest("[data-element-id]") === target);
    if (content) media.set(id, content);
  }
  const selection = stage.querySelector<HTMLElement>(".selection-bounds");
  const xGuide = stage.querySelector<HTMLElement>("[data-gesture-guide-x]");
  const yGuide = stage.querySelector<HTMLElement>("[data-gesture-guide-y]");
  const badge = stage.querySelector<HTMLElement>("[data-gesture-measurement]");

  const originalStyles = selected.flatMap((id) =>
    [rendered.get(id), media.get(id)].flatMap((node) =>
      node ? [{ node, style: node.getAttribute("style") }] : [],
    ),
  );

  const preview = (next: TransformSnapshot, feedback: GestureFeedback = {}) => {
    for (const id of selected) {
      const element = findElement(next.slide, id);
      const frame = element?.frame;
      if (!frame || sameFrame(lastFrames.get(id), frame)) continue;
      const target = rendered.get(id);
      if (target) applyLocalFrame(target, frame);
      const content = media.get(id);
      if (content && element) {
        const image = content.querySelector("img");
        const video = content.querySelector("video");
        const resolved = resolveMediaFrame(element, {
          width:
            Number(image?.dataset.sourceWidth) ||
            image?.naturalWidth ||
            video?.videoWidth ||
            0,
          height:
            Number(image?.dataset.sourceHeight) ||
            image?.naturalHeight ||
            video?.videoHeight ||
            0,
        });
        if (resolved) applyLocalFrame(content, resolved);
      }
      lastFrames.set(id, frame);
    }

    if (selection) {
      const geometry = selectionWorldGeometry(next.slide, selected, scopeId);
      selection.style.left = `${geometry.center.x - geometry.orientedWidth / 2}px`;
      selection.style.top = `${geometry.center.y - geometry.orientedHeight / 2}px`;
      selection.style.width = `${geometry.orientedWidth}px`;
      selection.style.height = `${geometry.orientedHeight}px`;
      selection.style.transform = selectionCssTransform(geometry);
      const [a, b, , d] = geometry.corners;
      const matrix: Matrix = [
        (b.x - a.x) / geometry.orientedWidth,
        (b.y - a.y) / geometry.orientedWidth,
        (d.x - a.x) / geometry.orientedHeight,
        (d.y - a.y) / geometry.orientedHeight,
        0,
        0,
      ];
      selection
        .querySelectorAll<HTMLElement>("[data-selection-handle]")
        .forEach((handle) => {
          handle.style.cursor = resizeHandleCursor(
            handle.dataset.selectionHandle as ResizeHandle,
            matrix,
          );
        });
    }

    if (xGuide) {
      xGuide.style.display =
        feedback.guides?.x === undefined ? "none" : "block";
      if (feedback.guides?.x !== undefined)
        xGuide.style.left = `${feedback.guides.x}px`;
    }
    if (yGuide) {
      yGuide.style.display =
        feedback.guides?.y === undefined ? "none" : "block";
      if (feedback.guides?.y !== undefined)
        yGuide.style.top = `${feedback.guides.y}px`;
    }
    if (badge) {
      const value = feedback.measurement;
      badge.style.display = value ? "block" : "none";
      if (value) {
        badge.style.left = `${value.x}px`;
        badge.style.top = `${value.y - 28 / Math.max(scale, 1e-9)}px`;
        badge.textContent =
          `${Math.round(value.width)} × ${Math.round(value.height)}` +
          (value.rotation === undefined
            ? ""
            : ` · ${Math.round(value.rotation)}°`);
      }
    }
  };
  // React may keep the canonical frame unchanged when a gesture authors Motion
  // keys. Remove imperative preview coordinates before Motion composes its offset.
  preview.restoreElements = () => {
    for (const { node, style } of originalStyles) {
      if (style === null) node.removeAttribute("style");
      else node.setAttribute("style", style);
    }
  };
  return preview;
}
