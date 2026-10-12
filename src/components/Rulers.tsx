import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { GuideAxis } from "../core/guides";

const RULER_SIZE = 16;

function niceStep(scale: number, minimumPixels = 52) {
  const raw = minimumPixels / Math.max(scale, 1e-9),
    exponent = 10 ** Math.floor(Math.log10(raw)),
    normalized = raw / exponent,
    multiplier =
      normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * exponent;
}

function ticks(min: number, max: number, step: number) {
  const values: number[] = [],
    start = Math.floor(min / step) * step;
  for (let value = start; value <= max + step; value += step)
    values.push(Math.round(value * 1e9) / 1e9);
  if (!values.includes(0)) values.push(0);
  return values.sort((a, b) => a - b);
}

export function Rulers({
  scale,
  pan,
  slideWidth,
  slideHeight,
  onPreviewGuide,
  onBeginGuide,
  onCancelGuide,
  onCreateGuide,
  onSnapGuide,
}: {
  scale: number;
  pan: { x: number; y: number };
  slideWidth: number;
  slideHeight: number;
  onPreviewGuide: (guide: { axis: GuideAxis; position: number } | null) => void;
  onBeginGuide?: (axis: GuideAxis) => boolean | Promise<boolean>;
  onCancelGuide?: () => void | Promise<void>;
  onCreateGuide: (axis: GuideAxis, position: number) => void | Promise<void>;
  onSnapGuide: (axis: GuideAxis, position: number) => number;
}) {
  const root = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const stage = root.current?.parentElement;
    if (!stage) return;
    const update = () =>
        setSize({ width: stage.clientWidth, height: stage.clientHeight }),
      observer = new ResizeObserver(update);
    observer.observe(stage);
    update();
    return () => observer.disconnect();
  }, []);

  const xOrigin = size.width / 2 + pan.x - (slideWidth * scale) / 2,
    yOrigin = size.height / 2 + pan.y - (slideHeight * scale) / 2,
    step = niceStep(scale),
    horizontalTicks = useMemo(
      () =>
        ticks(
          (RULER_SIZE - xOrigin) / scale,
          (size.width - xOrigin) / scale + step * 2,
          step,
        ),
      [size.width, xOrigin, scale, step],
    ),
    verticalTicks = useMemo(
      () =>
        ticks(
          (RULER_SIZE - yOrigin) / scale,
          (size.height - yOrigin) / scale + step * 2,
          step,
        ),
      [size.height, yOrigin, scale, step],
    );

  const pointToSlide = (clientX: number, clientY: number) => {
    const stage = root.current?.parentElement;
    if (!stage) return { x: 0, y: 0, inside: false };
    const rect = stage.getBoundingClientRect();
    const x =
        (clientX - rect.left - rect.width / 2 - pan.x) / scale + slideWidth / 2,
      y =
        (clientY - rect.top - rect.height / 2 - pan.y) / scale +
        slideHeight / 2;
    return {
      x,
      y,
      inside: x >= 0 && x <= slideWidth && y >= 0 && y <= slideHeight,
    };
  };

  const beginGuide = async (
    axis: GuideAxis,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget,
      pointerId = event.pointerId,
      clientX = event.clientX,
      clientY = event.clientY,
      altKey = event.altKey;
    if (onBeginGuide && !(await onBeginGuide(axis))) return;
    if (!target.isConnected) {
      await onCancelGuide?.();
      return;
    }
    try {
      target.setPointerCapture(pointerId);
    } catch {
      await onCancelGuide?.();
      return;
    }
    let last = 0,
      moved = false;
    const update = (
      clientX: number,
      clientY: number,
      bypassSnap = false,
    ) => {
      const point = pointToSlide(clientX, clientY),
        raw = axis === "vertical" ? point.x : point.y;
      last = bypassSnap ? raw : onSnapGuide(axis, raw);
      moved = true;
      onPreviewGuide({ axis, position: last });
      return point.inside;
    };
    update(clientX, clientY, altKey);
    const move = (next: PointerEvent) =>
      update(next.clientX, next.clientY, next.altKey);
    const end = (next: PointerEvent) => {
      const point = pointToSlide(next.clientX, next.clientY);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", cancel);
      onPreviewGuide(null);
      const withinReasonableRange =
        axis === "vertical"
          ? last >= -200 && last <= slideWidth + 200
          : last >= -200 && last <= slideHeight + 200;
      if (moved && point.inside && withinReasonableRange)
        void onCreateGuide(axis, last);
      else void onCancelGuide?.();
    };
    const cancel = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", cancel);
      onPreviewGuide(null);
      void onCancelGuide?.();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", cancel);
  };

  return (
    <div ref={root} className="editor-rulers" aria-label="Rulers">
      <div className="ruler-corner" />
      <div
        className="ruler horizontal"
        aria-label="Horizontal ruler"
        onPointerDown={(event) => void beginGuide("horizontal", event)}
      >
        {horizontalTicks.map((value) => {
          const leftPos = xOrigin + value * scale - RULER_SIZE;
          const isNearRight = leftPos > size.width - RULER_SIZE - 45;
          return (
            <span
              key={value}
              className="ruler-tick"
              data-value={value}
              style={{ left: leftPos }}
            >
              <i />
              <b
                style={isNearRight ? { left: "auto", right: "3px" } : undefined}
              >
                {Math.round(value)}
              </b>
            </span>
          );
        })}
      </div>
      <div
        className="ruler vertical"
        aria-label="Vertical ruler"
        onPointerDown={(event) => void beginGuide("vertical", event)}
      >
        {verticalTicks.map((value) => (
          <span
            key={value}
            className="ruler-tick"
            data-value={value}
            style={{ top: yOrigin + value * scale - RULER_SIZE }}
          >
            <i />
            <b>{Math.round(value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
