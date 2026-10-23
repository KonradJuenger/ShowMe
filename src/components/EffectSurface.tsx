import {
  createContext,
  useCallback,
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
import {
  createShaderChain,
  effectSurface,
  mountEffectSurface,
  type ShaderChain,
} from "./effectRuntime";
import { EffectRenderContext } from "./EffectRenderContext";
import { useDisplayDensity } from "./useDisplayDensity";

const ShaderChainContext = createContext<ShaderChain | null>(null);

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
  directShaderInput = false,
  ownedMediaInput = false,
}: {
  definition: EffectDefinition;
  instance: ElementEffect;
  width: number;
  height: number;
  samplingEnvelope?: number;
  nativeOpacity?: string;
  directShaderInput?: boolean;
  ownedMediaInput?: boolean;
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
  const inheritedShaderChain = useContext(ShaderChainContext);
  const ownedShaderChain = useRef<ShaderChain | null>(null);
  if (!ownedShaderChain.current) ownedShaderChain.current = createShaderChain();
  const shaderChain =
    definition.kind === "fragment-glsl"
      ? (inheritedShaderChain ?? ownedShaderChain.current)
      : null;
  const ownsShaderChain =
    definition.kind === "fragment-glsl" && inheritedShaderChain === null;
  const setCanvas = useCallback(
    (value: HTMLCanvasElement | null) => {
      canvas.current = value;
      if (ownsShaderChain && shaderChain) shaderChain.canvas = value;
    },
    [ownsShaderChain, shaderChain],
  );
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
      shaderChain ?? undefined,
      !!inheritedShaderChain,
      directShaderInput,
      ownsShaderChain,
      ownedMediaInput,
    );
  }, [
    mountedDefinition,
    mountedInstance,
    width,
    height,
    textContent,
    mountedContent,
    shaderChain,
    inheritedShaderChain,
    directShaderInput,
    ownsShaderChain,
    ownedMediaInput,
  ]);
  useLayoutEffect(() => {
    if (root.current)
      effectSurface(root.current)?.setVisualSuspended(
        render?.staticFrame ?? false,
      );
  }, [
    render?.staticFrame,
    mountedDefinition,
    mountedInstance,
    width,
    height,
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
    render?.sceneRevision,
    render?.deckRevision,
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
  useLayoutEffect(() => {
    if (!render?.staticFrame) return;
    const refresh = () => { if (root.current) effectSurface(root.current)?.refreshVisual(); };
    document.fonts.addEventListener("loadingdone", refresh);
    return () => document.fonts.removeEventListener("loadingdone", refresh);
  }, [render?.staticFrame]);
  const effectChildren = directShaderInput && shaderChain ? (
    <ShaderChainContext.Provider value={shaderChain}>
      {children}
    </ShaderChainContext.Provider>
  ) : (
    children
  );
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
          ref={setCanvas}
          aria-hidden="true"
          data-shader-stage={inheritedShaderChain ? "intermediate" : "terminal"}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}
      {definition.input === "content" ? (
        <div
          data-effect-source="true"
          style={{ position: "absolute", inset: 0 }}
        >
          {effectChildren}
        </div>
      ) : (
        effectChildren
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
