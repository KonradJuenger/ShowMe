/** Keep pointer-frequency work out of React while preserving the final position. */
import { measurePerformance } from "../core/performance";

export function framePointerGesture(
  target: Element,
  start: { pointerId: number; clientX: number; clientY: number },
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent) => void,
  category = "interaction.frame",
) {
  let pending: PointerEvent | null = null;
  let frame = 0;
  let lastX = start.clientX;
  let lastY = start.clientY;
  let moved = false;
  const flush = () => {
    frame = 0;
    const event = pending;
    pending = null;
    if (event) {
      lastX = event.clientX;
      lastY = event.clientY;
      measurePerformance(category, () => onMove(event));
    }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    if (event.clientX === lastX && event.clientY === lastY && !pending) return;
    moved = true;
    pending = event;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    target.removeEventListener("pointermove", move as EventListener);
    target.removeEventListener("pointerup", end as EventListener);
    target.removeEventListener("pointercancel", end as EventListener);
    target.removeEventListener("lostpointercapture", end as EventListener);
    if (frame) cancelAnimationFrame(frame);
    if (
      event.type === "pointerup" &&
      (moved ||
        Math.hypot(
          event.clientX - start.clientX,
          event.clientY - start.clientY,
        ) >= 3) &&
      (event.clientX !== lastX || event.clientY !== lastY)
    )
      pending = event;
    flush();
    onEnd(event);
  };
  target.addEventListener("pointermove", move as EventListener);
  target.addEventListener("pointerup", end as EventListener);
  target.addEventListener("pointercancel", end as EventListener);
  target.addEventListener("lostpointercapture", end as EventListener);
}


export interface PointerDragIntent {
  latest(): PointerEvent;
  active(): boolean;
  stop(): void;
}

/**
 * Wait until pointer movement becomes an actual drag without acquiring edit
 * ownership for a simple click. After resolution the tracker stays alive while
 * an async lease request is pending so callers can detect pointer-up/cancel and
 * use the latest pointer position once the lease is granted.
 */
export function waitForPointerDragIntent(
  target: Element,
  start: { pointerId: number; clientX: number; clientY: number },
  threshold = 3,
): Promise<PointerDragIntent | null> {
  return new Promise((resolve) => {
    let latest: PointerEvent | null = null;
    let active = true;
    let resolved = false;

    const stop = () => {
      target.removeEventListener("pointermove", move as EventListener);
      target.removeEventListener("pointerup", end as EventListener);
      target.removeEventListener("pointercancel", end as EventListener);
      target.removeEventListener("lostpointercapture", end as EventListener);
    };
    const intent: PointerDragIntent = {
      latest: () => latest!,
      active: () => active,
      stop,
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return;
      latest = event;
      if (
        !resolved &&
        Math.hypot(
          event.clientX - start.clientX,
          event.clientY - start.clientY,
        ) >= threshold
      ) {
        resolved = true;
        resolve(intent);
      }
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== start.pointerId) return;
      active = false;
      latest = event;
      stop();
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };

    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("pointerup", end as EventListener);
    target.addEventListener("pointercancel", end as EventListener);
    target.addEventListener("lostpointercapture", end as EventListener);
  });
}
