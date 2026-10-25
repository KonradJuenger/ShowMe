import { readPresentedPixel, readWebGlPixel } from "./webglPixels";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { flushEffectSurfaces } from "../../src/components/effectRuntime";
import { newPresentationDocument } from "../../src/core/document";
import { createBasicShape } from "../../src/core/elementFactory";
import {
  blankEffect,
  changeEffectAffects,
} from "../../src/core/effectAuthoring";
import {
  newEffectInstance,
  type EffectDefinition,
} from "../../src/core/effects";
import type { ElementEffect } from "../../src/core/effects";

const generated = {
  ...changeEffectAffects(blankEffect("shader"), "generated", true),
  source:
    "#version 300 es\nprecision highp float; out vec4 outColor; void main(){outColor=vec4(0,0,1,1);}",
};
const content = {
  ...blankEffect("shader"),
  source:
    "#version 300 es\nprecision highp float; uniform sampler2D u_input; in vec2 v_uv; out vec4 outColor; void main(){vec4 c=texture(u_input,v_uv);outColor=vec4(c.b,c.r,c.g,c.a);}",
};

/** Production renderer, logical clock transport and compositing stages. */
export async function checkEffectBypass() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const results = [];
  try {
    for (const kind of [
      "css",
      "text",
      "content",
      "background",
      "overlay",
      "backdrop",
      "stack",
      "text-stack",
    ] as const) {
      const model = newPresentationDocument("Bypass");
      const slide = model.slides[model.deck.slideIds[0]];
      const shape = createBasicShape("target", "rectangle");
      shape.frame.width = shape.frame.height = 40;
      shape.appearance.fill = "#ff0000";
      let definition: EffectDefinition = content;
      let placement: ElementEffect["placement"] = "content";
      if (kind === "css")
        definition = {
          ...blankEffect("css-js"),
          source: ":scope { opacity: 0.25; }",
        };
      if (kind === "text" || kind === "text-stack") {
        definition = {
          ...changeEffectAffects(blankEffect("css-js"), "text", false),
          source:
            'function render({text,t,p}) { return text + ":" + t + ":" + p; }',
        };
        shape.content = {
          type: "text",
          text: "Original",
          placeholder: false,
          format: {
            kind: "local",
            typography: {
              fontFamily: "sans-serif",
              fontWeight: 400,
              fontSize: 16,
              bold: false,
              italic: false,
              color: "#ffffff",
              align: "left",
              verticalAlign: "top",
              lineHeight: 1.2,
              letterSpacing: 0,
            },
          },
          autoSize: "none",
        };
      }
      if (kind === "background" || kind === "overlay") {
        definition = { ...generated, speed: kind === "background" ? 2 : 1 };
        placement = kind;
        shape.appearance.fill = null;
      }
      if (kind === "backdrop") {
        definition = { ...content, input: "backdrop", target: "background" };
        placement = "background";
        const behind = structuredClone(shape);
        behind.id = "behind";
        slide.nodes[0].children.push(behind);
        shape.appearance.fill = null;
      }
      const instance = {
        ...newEffectInstance("b", definition, placement),
        id: "b",
      };
      shape.effects = [instance];
      slide.effectResources = { b: definition };
      if (kind === "stack") {
        const first = {
          ...newEffectInstance("a", content, "content"),
          id: "a",
        };
        shape.effects.unshift(first);
        slide.effectResources.a = content;
      }
      if (kind === "text-stack") {
        const firstDefinition = {
          ...definition,
          source: 'function render({text}) { return "A(" + text + ")"; }',
        };
        shape.effects.unshift({
          ...newEffectInstance("a", firstDefinition, "content"),
          id: "a",
        });
        slide.effectResources.a = firstDefinition;
      }
      slide.nodes[0].children.push(shape);
      slide.motion = {
        stages: [
          { id: "entry", tracks: [] },
          {
            id: "click-one",
            tracks: [],
            blocks: [
              {
                id: "b-block",
                label: "B",
                members: [],
                binding: {
                  kind: "effect",
                  elementId: shape.id,
                  effectInstanceId: instance.id,
                },
                effectSchedule: {
                  version: 1,
                  start: "click",
                  startOffsetMs: 500,
                  stop: { mode: "next-click" },
                },
              },
            ],
          },
          { id: "click-two", tracks: [] },
        ],
      };
      const sample = async (index: number, seconds: number) => {
        const starts = [0, 1, 4];
        const logical = starts[index] + seconds;
        flushSync(() =>
          root.render(
            <SlideRenderer
              slide={slide}
              deck={model.deck}
              staticVideo
              motionState={{
                stageIndex: index,
                stageId: slide.motion!.stages[index].id,
                time: seconds * 1000,
                startedAt: 1000 + logical * 1000,
                running: false,
              }}
              effectClock={{
                presentationStartedAt: 1000,
                slideStartedAt: 1000,
                stepStartedAt: 1000 + starts[index] * 1000,
                pausedAt: 1000 + logical * 1000,
                stageStartedOffsets: starts
                  .slice(0, index + 1)
                  .map((t) => t * 1000),
              }}
            />,
          ),
        );
        await flushEffectSurfaces(host);
        const node = host.querySelector<HTMLElement>('[data-effect-id="b"]')!;
        const canvas = node.querySelector<HTMLCanvasElement>(":scope > canvas");
        const pixel = canvas
          ? readPresentedPixel(canvas, 0, 0)
          : null;
        const firstCanvas = host.querySelector<HTMLCanvasElement>(
          '[data-effect-id="a"] > canvas',
        );
        return {
          firstText: host.querySelector(
            '[data-effect-id="a"] > [data-effect-text-output]',
          )?.textContent,
          firstTextOpacity: host.querySelector<HTMLElement>(
            '[data-effect-id="a"] > [data-effect-text-output]',
          )?.style.opacity,
          started: node.dataset.effectStarted,
          opacity: getComputedStyle(node).opacity,
          pixel,
          canvasVisibility: canvas?.style.visibility,
          sourceOpacity: node.querySelector<HTMLElement>(
            ":scope > [data-effect-source]",
          )?.style.opacity,
          originalOpacity: node.querySelector<HTMLElement>(
            "[data-text-content]",
          )?.style.opacity,
          text: node.querySelector(":scope > [data-effect-text-output]")
            ?.textContent,
          outputVisibility: node.querySelector<HTMLElement>(
            ":scope > [data-effect-text-output]",
          )?.style.visibility,
          t: node.style.getPropertyValue("--t"),
          p: node.style.getPropertyValue("--p"),
          firstPixel: firstCanvas
            ? readWebGlPixel(firstCanvas, 0, 0)
            : null,
          error: node.dataset.effectError,
        };
      };
      const before = await sample(0, 0.2);
      const delayed = await sample(1, 0.3);
      const waiting = await sample(1, 1.5);
      const final = await sample(2, 5);
      const backward = await sample(0, 0.2);
      results.push({ kind, before, delayed, waiting, final, backward });
      flushSync(() => root.render(null));
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return results;
}
