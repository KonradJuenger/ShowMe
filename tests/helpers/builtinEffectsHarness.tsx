import { readWebGlPixels } from "./webglPixels";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { flushEffectSurfaces } from "../../src/components/effectRuntime";
import { newPresentationDocument } from "../../src/core/document";
import { createBasicShape } from "../../src/core/elementFactory";
import { effectTemplates, newEffectInstance } from "../../src/core/effects";
import { dissolveEffect } from "../../src/core/dissolveEffect";

/** Exercise the shipped definitions through the production renderer and worker/GPU. */
export async function checkBuiltinEffects() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const results = [];
  try {
    for (const definition of [dissolveEffect, ...effectTemplates]) {
      const model = newPresentationDocument("Built-in Effects");
      const slide = model.slides[model.deck.slideIds[0]];
      const shape = createBasicShape("effect-check", "rectangle");
      shape.frame.width = 100;
      shape.frame.height = 100;
      shape.appearance.fill = "#245684";
      const child = createBasicShape("effect-child", "ellipse", {
        x: 25,
        y: 25,
      });
      child.frame.width = child.frame.height = 50;
      child.appearance.fill = "#ffbc53";
      shape.children = [child];
      if (definition.kind === "text-js") {
        shape.children = [];
        shape.content = {
          type: "text",
          text: "ShowMe text",
          placeholder: false,
          format: {
            kind: "local",
            typography: {
              fontFamily: "sans-serif",
              fontWeight: 400,
              fontSize: 20,
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
      const instance = newEffectInstance(
        "builtin",
        definition,
        definition.target === "text" ? "content" : definition.target,
      );
      shape.effects = [instance];
      slide.nodes[0].children = [shape];
      slide.effectResources = { builtin: definition };
      flushSync(() =>
        root.render(
          <SlideRenderer deck={model.deck} slide={slide} staticVideo />,
        ),
      );
      const node = host.querySelector<HTMLElement>("[data-effect-id]")!;
      const sample = async (time: number) => {
        flushSync(() =>
          root.render(
            <SlideRenderer
              deck={model.deck}
              slide={slide}
              staticVideo
              effectClock={{
                presentationStartedAt: 1000,
                slideStartedAt: 1000,
                stepStartedAt: 1000,
                pausedAt: 1000 + time * 1000,
              }}
            />,
          ),
        );
        await flushEffectSurfaces(host);
        if (definition.kind === "text-js")
          return node.querySelector("[data-effect-text-output]")!.textContent;
        if (definition.kind === "css") return getComputedStyle(node).opacity;
        const canvas = node.querySelector("canvas")!;
        return Array.from(readWebGlPixels(canvas)).join(",");
      };
      const start = await sample(0);
      const middle = await sample(1);
      const end = await sample(2);
      const restored =
        definition.kind === "text-js"
          ? shape.content?.type === "text" &&
            end === shape.content.text &&
            node.querySelector("[data-text-content]")!.textContent ===
              shape.content.text
          : definition.kind === "css"
            ? end === "1"
            : end !== start;
      results.push({
        name: definition.name,
        error: node.dataset.effectError,
        changed: start !== middle && middle !== end,
        restored,
      });
      flushSync(() => root.render(null));
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return results;
}
