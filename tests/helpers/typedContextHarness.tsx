import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { flushEffectSurfaces } from "../../src/components/effectRuntime";
import { newPresentationDocument } from "../../src/core/document";
import { createTextElement } from "../../src/core/text";
import {
  effectDefinitionSchema,
  newEffectInstance,
  type EffectDefinition,
} from "../../src/core/effects";
import exampleJson from "../fixtures/effects/multi-state-scramble.json";

/** Sample the real renderer with shared logical clocks, then reconstruct earlier stages. */
export async function mountTypedContextHarness(
  mode: "scramble" | "step-only" | "typed",
) {
  const model = newPresentationDocument("Context");
  const slide = model.slides[model.deck.slideIds[0]];
  let definition: EffectDefinition = effectDefinitionSchema.parse(exampleJson);
  if (mode === "step-only")
    definition = {
      ...definition,
      source: "function render({ stepIndex }) { return String(stepIndex); }",
    };
  if (mode === "typed")
    definition = {
      ...definition,
      source:
        "function render({ text, parameters }) { return (parameters.uppercase ? parameters.textB.toUpperCase() : parameters.textB) + text; }",
      styleSource: ":scope { color: #123456; }",
    };
  const text = createTextElement("text");
  if (text.content?.type === "text") text.content.text = "Alpha";
  const instance = {
    ...newEffectInstance("effect", definition, "content"),
    id: "effect",
  };
  text.effects = [instance];
  slide.nodes[0].children = [text];
  slide.effectResources = { effect: definition };
  slide.motion = {
    stages: [
      { id: "entry", tracks: [] },
      { id: "one", tracks: [] },
      { id: "two", tracks: [] },
      { id: "three", tracks: [] },
    ],
  };
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sample = async (
    stepIndex: number,
    seconds: number,
    preview = false,
    uppercase = false,
  ) => {
    if (mode === "typed") {
      slide.nodes[0].children[0].effects![0].parameters = {
        ...instance.parameters,
        uppercase,
        textB: "Hello ",
        textC: "x; background: red; } body { color: red",
      };
      // Authority revisions replace props; reuse no renderer-local instance cache.
      slide.effectResources = { effect: { ...definition } };
    }
    flushSync(() =>
      root.render(
        <SlideRenderer
          deck={model.deck}
          slide={{ ...slide }}
          presentation
          staticVideo
          motionState={{
            stageId: slide.motion!.stages[stepIndex].id,
            stageIndex: stepIndex,
            time: seconds * 1000,
            startedAt: 1000,
            running: false,
          }}
          effectClock={
            preview
              ? undefined
              : {
                  presentationStartedAt: 1000,
                  slideStartedAt: 1000,
                  stepStartedAt: 1000 + stepIndex * 1000,
                  stepIndex,
                  pausedAt:
                    mode === "step-only"
                      ? undefined
                      : 1000 + stepIndex * 1000 + seconds * 1000,
                }
          }
        />,
      ),
    );
    await flushEffectSurfaces(host);
    const surface = host.querySelector<HTMLElement>("[data-effect-id]")!;
    return {
      text: host.querySelector("[data-effect-text-output]")!.textContent,
      stepIndex: surface.style.getPropertyValue("--stepIndex"),
      stepTime: surface.style.getPropertyValue("--stepTime"),
      uppercase: surface.style.getPropertyValue("--uppercase"),
      textC: surface.style.getPropertyValue("--textC"),
      color: getComputedStyle(
        host.querySelector<HTMLElement>("[data-effect-text-output]")!,
      ).color,
      error: surface.dataset.effectError ?? null,
    };
  };
  await sample(0, 0);
  return sample;
}
