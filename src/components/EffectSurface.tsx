import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EffectErrorCopyContext,
  EffectErrorMessage,
} from "./EffectErrorMessage";
import type { Deck, Slide } from "../core/document";
import type { TextContent } from "../core/text";
import type { EffectDefinition, ElementEffect } from "../core/effects";
import type { EffectResources } from "../core/effects";
import type { Element } from "../core/element";
import { effectSurface, mountEffectSurface } from "./effectRuntime";
import { EffectRenderContext } from "./EffectRenderContext";
import { useDisplayDensity } from "./useDisplayDensity";

export function EffectSurface({
  definition,
  instance,
  width,
  height,
  children,
  previewTiming,
  textContent,
  sceneTextureSource,
  samplingEnvelope,
  nativeOpacity,
}: {
  definition: EffectDefinition;
  instance: ElementEffect;
  width: number;
  height: number;
  samplingEnvelope?: number;
  nativeOpacity?: string;
  children?: ReactNode;
  textContent?: TextContent;
  sceneTextureSource?: {
    element: Element;
    resources: EffectResources;
    scene?: () => { slide: Slide; deck: Deck };
  };
  previewTiming?: {
    progress: number;
    time: number;
    duration: number;
    slideTime?: number;
    presentationTime?: number;
    stepTime?: number;
    stepIndex?: number;
    slideIndex?: number;
    slideCount?: number;
    slideSeed?: number;
    previousSlideIndex?: number;
    previousSlideSeed?: number;
    active?: boolean;
    started?: boolean;
  };
}) {
  const root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const copyErrors = useContext(EffectErrorCopyContext);
  const render = useContext(EffectRenderContext);
  const pixelRatio = useDisplayDensity();
  const [standaloneScale, setStandaloneScale] = useState({ x: 0, y: 0 });
  const standalone = !render;
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !standalone) return;
    const resize = () =>
      setStandaloneScale({
        x: node.clientWidth / width,
        y: node.clientHeight / height,
      });
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [standalone, width, height]);
  const densityX = render?.density.x ?? standaloneScale.x * pixelRatio;
  const densityY = render?.density.y ?? standaloneScale.y * pixelRatio;
  const mode = render?.density.mode ?? "live";
  const renderRoot = render?.root;
  const retain = render?.retain ?? false;
  const envelope =
    samplingEnvelope === undefined
      ? undefined
      : samplingEnvelope * Math.max(densityX, densityY);
  // Authority updates may clone unchanged definitions/instances. A backdrop's
  // mounted source depends on the frame and effect, not its own children or
  // higher scene objects. The scene getter continues to read accepted updates.
  const mountInput = useRef({
    key: "",
    definition,
    instance,
    sceneTextureSource,
  });
  const backdropKey =
    definition.input === "backdrop"
      ? JSON.stringify([
          definition,
          instance,
          width,
          height,
          sceneTextureSource?.element.id,
        ])
      : "";
  if (!backdropKey || mountInput.current.key !== backdropKey)
    mountInput.current = {
      key: backdropKey,
      definition,
      instance,
      sceneTextureSource,
    };
  const {
    definition: mountedDefinition,
    instance: mountedInstance,
    sceneTextureSource: mountedContent,
  } = mountInput.current;
  useLayoutEffect(() => {
    if (!root.current) return;
    return mountEffectSurface(
      root.current,
      canvas.current,
      mountedDefinition,
      mountedInstance,
      { width, height },
      setError,
      mountedContent,
      undefined,
    );
  }, [
    mountedDefinition,
    mountedInstance,
    width,
    height,
    textContent,
    mountedContent,
  ]);
  useLayoutEffect(() => {
    if (root.current)
      effectSurface(root.current)?.setSampling({
        x: densityX,
        y: densityY,
        mode,
        root: renderRoot?.current,
        retain,
        envelope,
      });
  }, [
    densityX,
    densityY,
    mode,
    renderRoot,
    retain,
    envelope,
    mountedDefinition,
    mountedInstance,
    width,
    height,
    mountedContent,
    textContent,
  ]);
  useLayoutEffect(() => {
    if (!root.current || !previewTiming) return;
    const surface = effectSurface(root.current);
    surface?.setTiming(previewTiming);
    void surface?.flush();
  }, [definition, instance, previewTiming]);
  return (
    <div
      ref={root}
      data-effect-id={instance.id}
      data-effect-ready="false"
      style={{
        position: "absolute",
        inset: 0,
        opacity: nativeOpacity,
        pointerEvents: instance.placement === "content" ? undefined : "none",
      }}
    >
      {definition.kind === "fragment-glsl" && (
        <canvas
          ref={canvas}
          aria-hidden="true"
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}
      {definition.input === "content" ? (
        <div
          data-effect-source="true"
          style={{ position: "absolute", inset: 0 }}
        >
          {children}
        </div>
      ) : (
        children
      )}
      {error && (
        <span
          role="status"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            padding: 4,
            background: "#fff1f2",
            color: "#9f1239",
            border: "1px solid #fecdd3",
            borderRadius: 4,
            fontSize: 12,
            pointerEvents: copyErrors ? "auto" : undefined,
          }}
        >
          {copyErrors ? <EffectErrorMessage message={error} /> : error}
        </span>
      )}
    </div>
  );
}
