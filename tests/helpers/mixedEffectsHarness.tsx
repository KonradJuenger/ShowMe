import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import {
  effectSurface,
  flushEffectSurfaces,
} from "../../src/components/effectRuntime";
import { domRasterDiagnostics } from "../../src/components/domRaster";
import { readWebGlPixels } from "./webglPixels";
import {
  newPresentationDocument,
  type PresentationDocument,
} from "../../src/core/document";
import { createBasicShape } from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import type { MotionPreviewState } from "../../src/core/motionPlayback";

export async function mountMixedEffectsHarness(
  input?: PresentationDocument,
  slideIndex = 0,
  textStyleSource?: string,
  options: {
    liveMedia?: boolean;
    profileWidth?: number;
    configure?: (model: PresentationDocument) => void;
  } = {},
) {
  const model = input ?? newPresentationDocument("Mixed effects");
  const slide = model.slides[model.deck.slideIds[slideIndex]];
  if (!input) {
    model.deck.width = 640;
    model.deck.height = 360;
    slide.background = "#ffffff";
    const text = createTextElement("animated", { x: 20, y: 30 });
    text.frame.width = 500;
    text.frame.height = 200;
    if (text.content?.type === "text") {
      text.content.text = "Original";
      if (text.content.format.kind === "local")
        text.content.format.typography.fontSize = 56;
    }
    const js = {
      ...blankEffect("css-js"),
      kind: "text-js" as const,
      target: "text" as const,
      styleSource: textStyleSource,
      source:
        'function render({stepIndex}) { return stepIndex === 2 ? "" : stepIndex ? "SECOND" : "FIRST"; }',
    };
    const css = {
      ...blankEffect("css-js"),
      source:
        ":scope { color: rgb(255, 0, 0); opacity: var(--p); filter: blur(calc((1 - var(--p)) * 4px)); clip-path: inset(0 calc((1 - var(--p)) * 100%) 0 0); }",
    };
    const shader = {
      ...blankEffect("shader"),
      source:
        "#version 300 es\nprecision highp float; uniform sampler2D u_input; in vec2 v_uv; out vec4 outColor; void main(){ vec4 c=texture(u_input,v_uv); outColor=vec4(c.b,c.r,c.g,c.a); }",
    };
    slide.effectResources = { js, css, shader };
    text.effects = [
      newEffectInstance("js", js, "content"),
      newEffectInstance("css", css, "content"),
      newEffectInstance("shader", shader, "content"),
    ];
    const glass = createBasicShape("glass", "rectangle", { x: 0, y: 0 });
    glass.frame.width = 640;
    glass.frame.height = 360;
    glass.appearance.fill = "";
    const backdrop = {
      ...shader,
      input: "backdrop" as const,
      target: "background" as const,
      source:
        "#version 300 es\nprecision highp float; uniform sampler2D u_input; in vec2 v_uv; out vec4 outColor; void main(){ outColor=texture(u_input,v_uv); }",
    };
    slide.effectResources.backdrop = backdrop;
    glass.effects = [newEffectInstance("backdrop", backdrop, "background")];
    slide.nodes[0].children = [text, glass];
    model.deck.stylesheet =
      "[data-text-content], [data-effect-text-output] { color: rgb(255, 0, 0) !important; text-shadow: 3px 2px 1px rgb(0, 0, 255); }";
  }
  options.configure?.(model);
  const before = JSON.stringify(model);
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let zoom = 1;
  let motionState: MotionPreviewState | null = null;
  const render = () =>
    flushSync(() =>
      root.render(
        <SlideRenderer
          deck={model.deck}
          slide={slide}
          staticVideo={!options.liveMedia}
          presentation={options.liveMedia}
          preparedImages={false}
          renderProfile={
            options.profileWidth
              ? {
                  width: options.profileWidth,
                  height: Math.round(
                    (options.profileWidth * model.deck.height) /
                      model.deck.width,
                  ),
                  mode: "live",
                }
              : undefined
          }
          renderScale={zoom}
          motionState={motionState}
          effectClock={
            motionState
              ? {
                  presentationStartedAt: 1000,
                  slideStartedAt: 1000,
                  stepStartedAt: 1000,
                  pausedAt: 1000 + motionState.time,
                  stepIndex: motionState.stageIndex,
                }
              : {
                  presentationStartedAt: 1000,
                  slideStartedAt: 1000,
                  pausedAt: 2000,
                }
          }
        />,
      ),
    );
  render();
  const advance = async (time: number, stepIndex = 0, progress = 1) => {
    const nodes = Array.from(
      host.querySelectorAll<HTMLElement>("[data-effect-id]"),
    );
    nodes.forEach((node) =>
      effectSurface(node)?.setTiming({
        time,
        duration: 2,
        progress,
        stepIndex,
        stepTime: time,
        running: false,
      }),
    );
    await flushEffectSurfaces(host);
  };
  const stage = async (time: number, stepIndex = 0, progress = 1) => {
    await advance(time, stepIndex, progress);
    return inspect();
  };
  const inspect = () => ({
    unchanged: before === JSON.stringify(model),
    errors: Array.from(
      host.querySelectorAll<HTMLElement>("[data-effect-error]"),
    ).map((node) => node.dataset.effectError),
    text: Array.from(
      host.querySelectorAll<HTMLElement>("[data-effect-text-output]"),
    ).map((node) => node.textContent),
    surfaces: Array.from(host.querySelectorAll<HTMLElement>("[data-effect-id]"))
      .filter((node) =>
        node.querySelector(
          ':scope > canvas[data-shader-stage="terminal"]',
        ),
      )
      .map((node) => {
        const canvas = node.querySelector<HTMLCanvasElement>(
          ':scope > canvas[data-shader-stage="terminal"]',
        )!;
        const pixels = readWebGlPixels(canvas);
        let red = 0,
          green = 0,
          blue = 0,
          opaque = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 32) {
            opaque++;
            if (
              pixels[i] > pixels[i + 1] + 40 &&
              pixels[i] > pixels[i + 2] + 40
            )
              red++;
            if (
              pixels[i + 1] > pixels[i] + 40 &&
              pixels[i + 1] > pixels[i + 2] + 40
            )
              green++;
            if (
              pixels[i + 2] > pixels[i] + 40 &&
              pixels[i + 2] > pixels[i + 1] + 40
            )
              blue++;
          }
        }
        return {
          id: node.dataset.effectId,
          backend: node.dataset.effectSourceBackend,
          ready: node.dataset.effectReady,
          revision: node.dataset.effectSourceRevision,
          width: canvas.width,
          height: canvas.height,
          red,
          green,
          blue,
          opaque,
        };
      }),
    diagnostics: domRasterDiagnostics(),
  });
  // Motion applies its initial frame geometry in its render phase. Capture only
  // after those writes, just as the editor/presenter paint cycle does.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await stage(0);
  return {
    model,
    slide,
    stage,
    advance,
    inspect,
    host,
    async setMotion(value: MotionPreviewState | null) {
      motionState = value;
      render();
      await flushEffectSurfaces(host);
    },
    async setZoom(value: number) {
      zoom = value;
      host.style.transform = `scale(${value})`;
      host.style.transformOrigin = "top left";
      render();
      await flushEffectSurfaces(host);
    },
    setStylesheet(value: string) {
      model.deck.stylesheet = value;
      const style = host.querySelector(".slide-renderer > style");
      if (style) style.textContent = `@scope (.slide-renderer) { ${value} }`;
    },
    dispose() {
      root.unmount();
      host.remove();
    },
  };
}
