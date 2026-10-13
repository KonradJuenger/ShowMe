import { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import type { CanvasPaintViewport } from "./framePaint";

/** Read one canvas origin, never a rectangle per object, on placement changes. */
export function useCanvasPaintViewport(
  stage: RefObject<HTMLDivElement | null>,
  scale: number,
) {
  const [viewport, setViewport] = useState<CanvasPaintViewport>();
  const measure = useCallback(() => {
    if (!stage.current) return;
    const { left: x, top: y } = stage.current.getBoundingClientRect();
    setViewport((current) =>
      current?.x === x && current.y === y && current.scale === scale
        ? current
        : { x, y, scale },
    );
  }, [stage, scale]);
  // Also runs when an asynchronously loaded document first mounts the stage.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const workspace = stage.current?.closest(".stage");
    const observer = new ResizeObserver(measure);
    if (workspace) observer.observe(workspace);
    if (stage.current) observer.observe(stage.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stage, measure, viewport?.scale]);
  return viewport;
}
