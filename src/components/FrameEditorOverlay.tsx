import { resizeHandleCursor } from "../core/handleGeometry";
import { type PointerEvent as ReactPointerEvent } from "react";
import type { ResizeHandle } from "../core/geometry";
import {
  localMatrix,
  multiply,
  frameCssTransform,
  frameCssOrigin,
  resolveMediaFrame,
  type Matrix,
  type Element,
} from "../core/element";
import type { MediaIntrinsic } from "../core/media";

const resizeHandles: ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function FrameEditorOverlay({
  element,
  world,
  intrinsic,
  scale,
  onMovePointerDown,
  onResizePointerDown,
  onRotatePointerDown,
  onExit,
}: {
  element: Element;
  world: Matrix;
  intrinsic?: MediaIntrinsic;
  scale: number;
  onMovePointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onResizePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    handle: ResizeHandle,
  ): void;
  onRotatePointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onExit(): void;
}) {
  const content = element.content;
  if (!content || content.type === "text") return null;
  const resolved = resolveMediaFrame(element, intrinsic);
  if (!resolved) return null;
  const resizable = content.transform.rule !== "fit";
  return (
    <div
      data-frame-editor={element.id}
      data-element-id={element.id}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: element.frame.width,
        height: element.frame.height,
        transform: `matrix(${world.join(",")})`,
        transformOrigin: "0 0",
        zIndex: 1250,
        pointerEvents: "none",
        ["--feedback-inverse-scale" as string]: 1 / Math.max(scale, 1e-9),
      }}
    >
      <div
        data-frame-edit-border="true"
        style={{
          position: "absolute",
          inset: 0,
          border: `${1 / scale}px solid black`,
          boxSizing: "border-box",
          pointerEvents: "none",
        }}
      />
      <div
        className="frame-content-interaction-surface"
        aria-label="Media inside frame"
        data-context-target="frame-content"
        data-id={element.id}
        style={{ pointerEvents: "auto" }}
        onPointerDown={onMovePointerDown}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onExit();
        }}
      >
        <div
          className="frame-content-bounds"
          style={{
            left: resolved.x,
            top: resolved.y,
            width: resolved.width,
            height: resolved.height,
            transform: frameCssTransform(resolved),
            transformOrigin: frameCssOrigin(resolved),
          }}
        >
          {resizable &&
            resizeHandles.map((handle) => (
              <button
                key={handle}
                type="button"
                className={`frame-content-handle frame-content-handle-${handle}`}
                data-frame-content-handle={handle}
                aria-label={`Resize media ${handle}`}
                style={{
                  width: 11 / scale,
                  height: 11 / scale,
                  cursor: resizeHandleCursor(
                    handle,
                    multiply(world, localMatrix(resolved)),
                  ),
                }}
                onPointerDown={(event) => onResizePointerDown(event, handle)}
              />
            ))}
          <button
            type="button"
            className="frame-content-handle frame-content-rotate"
            data-frame-content-rotate="true"
            aria-label="Rotate media inside frame"
            style={{ width: 11 / scale, height: 11 / scale }}
            onPointerDown={onRotatePointerDown}
          />
        </div>
      </div>
    </div>
  );
}
