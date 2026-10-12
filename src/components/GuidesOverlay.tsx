import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GuideAxis, ResolvedGuide } from "../core/guides";

export function GuidesOverlay({
  guides,
  preview,
  scale,
  onBeginMove,
  onPreviewMove,
  onCommitMove,
  onCancelMove,
  onDelete,
  onSnapGuide,
}: {
  guides: ResolvedGuide[];
  preview: { axis: GuideAxis; position: number } | null;
  scale: number;
  onBeginMove?: (id: string) => boolean | Promise<boolean>;
  onPreviewMove: (id: string, position: number) => void;
  onCommitMove: (id: string, position: number) => void;
  onCancelMove?: (id: string, position: number) => void;
  onDelete: (id: string) => void;
  onSnapGuide: (
    axis: GuideAxis,
    position: number,
    guideId: string,
  ) => number;
}) {
  const root = useRef<HTMLDivElement>(null),
    [dragging, setDragging] = useState<{
      id: string;
      axis: GuideAxis;
      position: number;
      outside: boolean;
    } | null>(null),
    inverseScale = 1 / Math.max(scale, 0.01),
    guideMetrics = {
      "--guide-stroke": `${inverseScale}px`,
      "--guide-hit": `${7 * inverseScale}px`,
      "--guide-hit-offset": `${-3.5 * inverseScale}px`,
    } as CSSProperties;

  const beginMove = async (
    guide: ResolvedGuide & { id: string },
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget,
      startX = event.clientX,
      startY = event.clientY,
      start = guide.position;
    target.setPointerCapture(event.pointerId);
    if (onBeginMove && !(await onBeginMove(guide.id))) {
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      return;
    }
    if (!target.hasPointerCapture(event.pointerId)) {
      onCancelMove?.(guide.id, start);
      return;
    }
    let last = start,
      outside = false;
    setDragging({
      id: guide.id,
      axis: guide.axis,
      position: start,
      outside: false,
    });
    const pointerOutsideSlide = (next: PointerEvent) => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return false;
      return guide.axis === "vertical"
        ? next.clientX < rect.left || next.clientX > rect.right
        : next.clientY < rect.top || next.clientY > rect.bottom;
    };
    const move = (next: PointerEvent) => {
      const raw =
        start +
        (guide.axis === "vertical"
          ? (next.clientX - startX) / scale
          : (next.clientY - startY) / scale);
      outside = pointerOutsideSlide(next);
      last =
        next.altKey || outside
          ? raw
          : onSnapGuide(guide.axis, raw, guide.id);
      setDragging({
        id: guide.id,
        axis: guide.axis,
        position: last,
        outside,
      });
      onPreviewMove(guide.id, last);
    };
    const finish = (next: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", cancel);
      outside = pointerOutsideSlide(next);
      setDragging(null);
      if (outside) onDelete(guide.id);
      else onCommitMove(guide.id, last);
    };
    const cancel = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", cancel);
      setDragging(null);
      if (onCancelMove) onCancelMove(guide.id, start);
      else onCommitMove(guide.id, start);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", cancel);
  };

  return (
    <div
      ref={root}
      className="persistent-guides-overlay"
      aria-label="Layout guides"
    >
      {guides.map((guide, index) => {
        const style =
          guide.axis === "vertical"
            ? ({ ...guideMetrics, left: guide.position } as CSSProperties)
            : ({ ...guideMetrics, top: guide.position } as CSSProperties);
        if (guide.source === "manual" && guide.id)
          return (
            <button
              type="button"
              key={guide.id}
              className={`persistent-guide manual ${guide.axis}${dragging?.id === guide.id ? " dragging" : ""}`}
              data-guide-kind="manual"
              data-context-target="guide"
              data-guide-id={guide.id}
              style={style}
              aria-label={`${guide.axis === "vertical" ? "Vertical" : "Horizontal"} guide ${Math.round(guide.position)}`}
              onPointerDown={(event) => {
                void beginMove(
                  guide as ResolvedGuide & { id: string },
                  event,
                );
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete(guide.id!);
              }}
              title="Drag to move · right-click to delete"
            />
          );
        return (
          <span
            key={`generated-${guide.axis}-${guide.position}-${index}`}
            className={`persistent-guide generated ${guide.axis}`}
            data-guide-kind="generated"
            style={style}
          />
        );
      })}
      {preview && (
        <span
          className={`persistent-guide preview ${preview.axis}`}
          style={
            preview.axis === "vertical"
              ? ({ ...guideMetrics, left: preview.position } as CSSProperties)
              : ({ ...guideMetrics, top: preview.position } as CSSProperties)
          }
        >
          <em>{Math.round(preview.position)}</em>
        </span>
      )}
      {dragging && (
        <span
          className={`guide-coordinate ${dragging.axis}${dragging?.outside ? " removing" : ""}`}
          style={
            dragging.axis === "vertical"
              ? { left: dragging.position }
              : { top: dragging.position }
          }
        >
          {dragging?.outside ? "Release to remove" : Math.round(dragging.position)}
        </span>
      )}
    </div>
  );
}
