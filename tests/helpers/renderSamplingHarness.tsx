import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import {
  createShaderChain,
  effectSurface,
  flushEffectSurfaces,
  shaderProgram,
} from "../../src/components/effectRuntime";
import { readWebGlPixel } from "./webglPixels";
import { newPresentationDocument } from "../../src/core/document";
import {
  createBasicShape,
  createContainerElement,
} from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import { pdfRenderProfile } from "../../src/core/renderProfile";
import type { MotionPreviewState } from "../../src/core/motionPlayback";
import type { Slide } from "../../src/core/document";

/** The production renderer, with fixed logical content and a paused logical clock. */
export async function mountRenderSamplingHarness() {
  const model = newPresentationDocument("Output detail");
  const slide = model.slides[model.deck.slideIds[0]];
  const element = createBasicShape("sample", "rectangle", { x: 0, y: 0 });
  element.frame.width = 1920;
  element.frame.height = 1080;
  element.appearance.fill = "#00ff00";
  const definition = {
    ...blankEffect("shader"),
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_size; uniform vec2 u_resolution;
uniform float u_t;
in vec2 v_uv; out vec4 outColor;
void main() {
  if (v_uv.x < 0.01) outColor = vec4(u_size.x / 1920.0, u_resolution.x / 4000.0, u_t / 10.0, 1.0);
  else outColor = texture(u_input, v_uv);
}`,
  };
  element.effects = [newEffectInstance("sample-effect", definition, "content")];
  const text = createTextElement("label", { x: 200, y: 100 });
  if (text.content?.type === "text") {
    text.content.text = "Display size preserves text wrapping and proportions";
    if (text.content.format.kind === "local")
      text.content.format.typography.fontSize = 48;
  }
  const parent = createContainerElement("parent", [element], { x: 0, y: 0 });
  parent.frame.width = 1920;
  parent.frame.height = 1080;
  slide.nodes[0].children = [parent, text];
  slide.effectResources = { "sample-effect": definition };
  const before = JSON.stringify(model);
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let scale = 1;
  let sampledSlide = slide;
  let motionSlide: Slide | null = null;
  let motionState: MotionPreviewState | undefined;
  const clock = {
    presentationStartedAt: 1000,
    slideStartedAt: 1000,
    pausedAt: 3000,
  };
  const render = (nextScale: number, pdf = false) => {
    scale = nextScale;
    host.style.transform = `scale(${scale})`;
    host.style.transformOrigin = "top left";
    flushSync(() =>
      root.render(
        <SlideRenderer
          deck={model.deck}
          slide={sampledSlide}
          staticVideo
          renderScale={scale}
          renderProfile={pdf ? pdfRenderProfile(model.deck) : undefined}
          effectClock={clock}
          motionState={motionState}
        />,
      ),
    );
  };
  const inspect = async () => {
    await flushEffectSurfaces(host);
    const surface = host.querySelector<HTMLElement>("[data-effect-id]")!;
    const canvas = surface.querySelector<HTMLCanvasElement>("canvas")!;
    const content = host.querySelector<HTMLElement>("[data-text-content]")!;
    const slideNode = host.querySelector<HTMLElement>(".slide-renderer")!;
    return {
      width: canvas.width,
      height: canvas.height,
      pixel: readWebGlPixel(
        canvas,
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
      ),
      uniforms: readWebGlPixel(canvas, 0, 0),
      font: getComputedStyle(content).fontSize,
      textFraction:
        content.getBoundingClientRect().height /
        slideNode.getBoundingClientRect().height,
      wrapHeight: content.offsetHeight,
      time: surface.style.getPropertyValue("--t"),
      error: surface.dataset.effectError ?? null,
      unchanged: JSON.stringify(model) === before,
    };
  };
  render(1);
  await inspect();
  const initialCanvas = host.querySelector("canvas");
  return {
    async resize(nextScale: number, pdf = false) {
      render(nextScale, pdf);
      return {
        ...(await inspect()),
        sameCanvas: host.querySelector("canvas") === initialCanvas,
      };
    },
    inspect,
    async transform(value: string) {
      const transformed = structuredClone(slide);
      const parent = transformed.nodes[0].children.find(
        (element) => element.id === "parent",
      )!;
      Object.assign(
        parent.frame,
        value.includes("scale(2, 1)")
          ? { x: 0, y: 0, rotation: 45, scaleX: 2, scaleY: 1 }
          : { x: 123, y: 45, rotation: 45, scaleX: 1, scaleY: 1 },
      );
      sampledSlide = transformed;
      render(1);
      return inspect();
    },
    async motion(time: number) {
      motionSlide ??= {
        ...slide,
        motion: {
          stages: [
            {
              id: "grow",
              tracks: [
                {
                  id: "parent-scale",
                  elementId: "parent",
                  property: "transform.scaleX",
                  keyframes: [
                    {
                      id: "from",
                      at: 0,
                      value: { type: "absolute", value: 1 },
                      easeToNext: "linear",
                    },
                    {
                      id: "to",
                      at: 1000,
                      value: { type: "absolute", value: 2 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      sampledSlide = motionSlide;
      motionState = {
        stageId: "grow",
        stageIndex: 0,
        time,
        startedAt: Date.now(),
        running: false,
      };
      render(1);
      return inspect();
    },
    async backdrop() {
      const background = createBasicShape("lower", "rectangle", { x: 0, y: 0 });
      background.frame.width = 1920;
      background.frame.height = 1080;
      background.appearance.fill = "#00ff00";
      const lens = {
        ...element,
        id: "lens",
        appearance: { ...element.appearance, fill: null },
      };
      const backdropDefinition = {
        ...definition,
        target: "background" as const,
        input: "backdrop" as const,
      };
      lens.effects = [
        newEffectInstance("backdrop", backdropDefinition, "background"),
      ];
      sampledSlide = {
        ...slide,
        nodes: [{ ...slide.nodes[0], children: [background, lens, text] }],
        effectResources: { backdrop: backdropDefinition },
      };
      render(2);
      return inspect();
    },
    async density(value: number) {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value,
      });
      // Exercise the density-only media-query subscription, without a resize event.
      const query = window.matchMedia("(resolution: 1dppx)");
      // matchMedia returns different objects; tracked listeners are supplied by the test shim.
      query.dispatchEvent(new Event("change"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return inspect();
    },
    async allocationFailure() {
      const output = document.createElement("canvas");
      const original = output.getContext.bind(output);
      Object.defineProperty(output, "getContext", {
        configurable: true,
        value: () => null,
      });
      const chain = createShaderChain();
      chain.canvas = output;
      let error = "";
      try {
        shaderProgram(definition.source, chain);
      } catch (value) {
        error = value instanceof Error ? value.message : String(value);
      } finally {
        Object.defineProperty(output, "getContext", {
          configurable: true,
          value: original,
        });
      }
      return { error };
    },
    async loseContext() {
      const surface = host.querySelector<HTMLElement>("[data-effect-id]")!;
      const gl = effectSurface(surface)!.gpuContext();
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("Test browser lacks WEBGL_lose_context");
      extension.loseContext();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      extension.restoreContext();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await effectSurface(surface)!.flush();
      return inspect();
    },
    dispose() {
      root.unmount();
      host.remove();
    },
  };
}
