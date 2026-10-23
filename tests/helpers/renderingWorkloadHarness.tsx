import { mountMixedEffectsHarness } from "./mixedEffectsHarness";
import { createMotionRuntime } from "../../src/components/motionRuntime";
import {
  effectSurface,
  shaderRuntimeDiagnostics,
  flushEffectSurfaces,
} from "../../src/components/effectRuntime";
import { shaderOutputDiagnostics } from "../../src/components/shaderOutput";
import { sceneTextureDiagnostics } from "../../src/components/sceneTexture";
import { domRasterDiagnostics } from "../../src/components/domRaster";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import { createBasicShape } from "../../src/core/elementFactory";
import { createMediaElement } from "../../src/core/media";
import { createTextElement } from "../../src/core/text";
import { platform } from "../../src/platform";

export type RenderingWorkload = "native" | "generated" | "scene-texture";

const fixturePng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlYQAAAAASUVORK5CYII=";

function diagnostics() {
  return {
    dom: domRasterDiagnostics(),
    scene: sceneTextureDiagnostics(),
    shader: shaderRuntimeDiagnostics(),
    output: shaderOutputDiagnostics(),
  };
}

function delta(before: ReturnType<typeof diagnostics>, after: ReturnType<typeof diagnostics>) {
  return {
    domCaptures: after.dom.captures - before.dom.captures,
    domClones: after.dom.clones - before.dom.clones,
    domStyleReads: after.dom.styleReads - before.dom.styleReads,
    scenePreparations: after.scene.preparations - before.scene.preparations,
    sceneCacheHits: after.scene.cacheHits - before.scene.cacheHits,
    sceneRetainedReuses:
      after.scene.retainedReuses - before.scene.retainedReuses,
    sceneCaptures: after.scene.captures - before.scene.captures,
    scenePreparationMs: after.scene.preparationMs - before.scene.preparationMs,
    shaderCompilations:
      after.shader.shaderCompilations - before.shader.shaderCompilations,
    shaderContextsCreated:
      after.shader.contextsCreated - before.shader.contextsCreated,
    canvas2dPresentationCopies:
      after.shader.canvas2dPresentationCopies -
      before.shader.canvas2dPresentationCopies,
    gpuOutputAllocations:
      after.output.allocations - before.output.allocations,
  };
}

function asset() {
  return {
    version: 1 as const,
    id: "d".repeat(64),
    filename: "renderer-workload.png",
    names: ["renderer-workload.png"],
    type: "image" as const,
    mediaType: "image" as const,
    mime: "image/png" as const,
    bytes: 1,
    width: 1,
    height: 1,
    createdAt: "2026-10-23T00:00:00Z",
  };
}

function frameLoop(
  count: number,
  sample: (time: number) => void | Promise<void>,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const intervals: number[] = [];
    let last = 0;
    let frame = 0;
    const tick = async (at: number) => {
      try {
        if (last) intervals.push(at - last);
        last = at;
        await sample((frame / Math.max(1, count - 1)) * 900);
        frame++;
        if (frame >= count) resolve(intervals);
        else requestAnimationFrame(tick);
      } catch (error) {
        reject(error);
      }
    };
    requestAnimationFrame(tick);
  });
}

function instrumentDiscovery() {
  const nativeStyle = window.getComputedStyle.bind(window);
  const nativeQuery = Element.prototype.querySelectorAll;
  const nativeCreate = document.createElement.bind(document);
  let styleReads = 0;
  let queries = 0;
  let canvasAllocations = 0;
  window.getComputedStyle = ((...args: unknown[]) => {
    styleReads++;
    return nativeStyle(...(args as Parameters<typeof getComputedStyle>));
  }) as typeof getComputedStyle;
  (Element.prototype as unknown as { querySelectorAll: typeof nativeQuery })
    .querySelectorAll = function (selectors: string) {
    queries++;
    return nativeQuery.call(this, selectors);
  };
  (document as unknown as { createElement: typeof document.createElement })
    .createElement = ((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() === "canvas") canvasAllocations++;
    return nativeCreate(tagName, options);
  }) as typeof document.createElement;
  return {
    finish() {
      window.getComputedStyle = nativeStyle;
      (Element.prototype as unknown as { querySelectorAll: typeof nativeQuery })
        .querySelectorAll = nativeQuery;
      (document as unknown as { createElement: typeof document.createElement })
        .createElement = nativeCreate;
      return { styleReads, queries, canvasAllocations };
    },
  };
}

async function nativeWorkload() {
  platform.assetUrl = async () => fixturePng;
  const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
    configure(model) {
      model.deck.stylesheet = "";
      const slide = model.slides[model.deck.slideIds[0]];
      const glassCss = {
        ...blankEffect("css-js"),
        source:
          ":scope { backdrop-filter: blur(18px) saturate(120%); background: rgba(255,255,255,.28); border-radius: 22px; }",
      };
      slide.effectResources = { glass: glassCss };
      const background = createBasicShape("background", "rectangle", {
        x: 0,
        y: 0,
      });
      Object.assign(background.frame, { width: 640, height: 360 });
      background.appearance.fill = "#31568d";
      const image = createMediaElement("image", asset(), { x: 24, y: 24 });
      Object.assign(image.frame, { width: 180, height: 100 });
      const texts = Array.from({ length: 12 }, (_, index) => {
        const text = createTextElement(`text-${index}`, {
          x: 24 + (index % 4) * 150,
          y: 150 + Math.floor(index / 4) * 54,
        });
        Object.assign(text.frame, { width: 135, height: 44 });
        if (text.content?.type === "text") text.content.text = `Native ${index}`;
        return text;
      });
      const glass = createBasicShape("glass", "rectangle", { x: 280, y: 32 });
      Object.assign(glass.frame, { width: 300, height: 120 });
      glass.appearance.fill = "#ffffff20";
      glass.appearance.radius = 22;
      glass.effects = [newEffectInstance("glass", glassCss, "content")];
      slide.nodes[0].children = [background, image, ...texts, glass];
      slide.motion = {
        stages: [
          {
            id: "native-motion",
            tracks: [
              {
                id: "move",
                elementId: "glass",
                property: "transform.x",
                keyframes: [
                  {
                    id: "move-a",
                    at: 0,
                    value: { type: "absolute", value: 280 },
                    easeToNext: "linear",
                  },
                  {
                    id: "move-b",
                    at: 1000,
                    value: { type: "absolute", value: 330 },
                  },
                ],
              },
              {
                id: "rotate",
                elementId: "glass",
                property: "transform.rotation",
                keyframes: [
                  {
                    id: "rotate-a",
                    at: 0,
                    value: { type: "absolute", value: -4 },
                    easeToNext: "linear",
                  },
                  {
                    id: "rotate-b",
                    at: 1000,
                    value: { type: "absolute", value: 6 },
                  },
                ],
              },
              {
                id: "fade",
                elementId: "glass",
                property: "appearance.opacity",
                keyframes: [
                  {
                    id: "fade-a",
                    at: 0,
                    value: { type: "absolute", value: 0.4 },
                    easeToNext: "linear",
                  },
                  {
                    id: "fade-b",
                    at: 1000,
                    value: { type: "absolute", value: 0.95 },
                  },
                ],
              },
            ],
            blocks: [
              {
                id: "presence",
                label: "Presence",
                members: [],
                binding: { kind: "presence", elementId: "glass" },
                presenceSchedule: {
                  version: 1,
                  startOffsetMs: 0,
                  end: { mode: "none" },
                  enterTransition: {
                    kind: "move",
                    durationMs: 200,
                    easing: [0, 0, 1, 1],
                    direction: "Up",
                    distance: 20,
                  },
                  exitTransition: {
                    kind: "none",
                    durationMs: 0,
                    easing: [0, 0, 1, 1],
                  },
                },
              },
            ],
          },
        ],
      };
    },
  });
  await Promise.all(
    Array.from(harness.host.querySelectorAll<HTMLImageElement>("img")).map(
      (image) => image.decode().catch(() => undefined),
    ),
  );
  const root = harness.host.querySelector<HTMLElement>(".slide-renderer")!;
  const runtime = createMotionRuntime(root, harness.slide, 0);
  runtime.sync({
    stageId: "native-motion",
    stageIndex: 0,
    time: 0,
    running: false,
    startedAt: 0,
  });
  const before = diagnostics();
  const discovery = instrumentDiscovery();
  const frames = await frameLoop(60, (time) =>
    runtime.sync({
      stageId: "native-motion",
      stageIndex: 0,
      time,
      running: false,
      startedAt: 0,
    }),
  );
  const discovered = discovery.finish();
  const after = diagnostics();
  runtime.cancel();
  harness.dispose();
  return {
    frames,
    discovered,
    diagnostics: delta(before, after),
  };
}

async function generatedWorkload() {
  const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
    configure(model) {
      model.deck.stylesheet = "";
      const slide = model.slides[model.deck.slideIds[0]];
      const shader = {
        ...blankEffect("shader"),
        input: "none" as const,
        target: "background" as const,
        source:
          "#version 300 es\nprecision highp float;uniform float u_t;in vec2 v_uv;out vec4 outColor;void main(){float p=.5+.5*sin(u_t+v_uv.x*12.);outColor=vec4(v_uv.x,p,v_uv.y,.9);}",
      };
      slide.effectResources = { shader };
      slide.nodes[0].children = Array.from({ length: 4 }, (_, index) => {
        const shape = createBasicShape(`shader-${index}`, "rectangle", {
          x: (index % 2) * 320,
          y: Math.floor(index / 2) * 180,
        });
        Object.assign(shape.frame, { width: 320, height: 180 });
        shape.appearance.fill = "";
        shape.effects = [
          newEffectInstance(`shader-${index}`, shader, "background"),
        ];
        return shape;
      });
    },
  });
  await harness.advance(0);
  const before = diagnostics();
  const frames = await frameLoop(60, async (time) => {
    for (const node of harness.host.querySelectorAll<HTMLElement>(
      "[data-effect-id]",
    )) {
      effectSurface(node)?.setTiming({
        time: time / 1000,
        duration: 1,
        progress: time / 900,
        running: false,
      });
    }
    await flushEffectSurfaces(harness.host);
  });
  const after = diagnostics();
  const contextCount = after.shader.activeContexts;
  harness.dispose();
  return {
    frames,
    contextCount,
    maxActiveContexts: after.shader.maxActiveContexts,
    diagnostics: delta(before, after),
  };
}

async function sceneTextureWorkload() {
  const first = await mountMixedEffectsHarness(undefined, 0, undefined, {
    configure(model) {
      model.deck.stylesheet = "";
      const slide = model.slides[model.deck.slideIds[0]];
      const shader = {
        ...blankEffect("shader"),
        input: "content" as const,
        target: "content" as const,
        source:
          "#version 300 es\nprecision highp float;uniform sampler2D u_input;in vec2 v_uv;out vec4 outColor;void main(){outColor=texture(u_input,v_uv);}",
      };
      const text = createTextElement("scene-text", { x: 40, y: 40 });
      Object.assign(text.frame, { width: 500, height: 220 });
      if (text.content?.type === "text")
        text.content.text = "Explicit flattened SceneTexture benchmark";
      text.effects = [newEffectInstance("scene", shader, "content")];
      slide.effectResources = { scene: shader };
      slide.nodes[0].children = [text];
      delete slide.motion;
    },
  });
  const before = diagnostics();
  await first.advance(0);
  const prepared = diagnostics();
  const model = first.model;
  first.dispose();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const revisitStart = performance.now();
  const second = await mountMixedEffectsHarness(model);
  await second.advance(0);
  const revisitReadyMs = performance.now() - revisitStart;
  const revisited = diagnostics();
  second.dispose();
  return {
    firstPreparation: delta(before, prepared),
    revisit: delta(prepared, revisited),
    revisitReadyMs,
    retainedTextureBytes: revisited.scene.retainedTextureBytes,
  };
}

export async function runRenderingWorkload(kind: RenderingWorkload) {
  if (kind === "native") return nativeWorkload();
  if (kind === "generated") return generatedWorkload();
  return sceneTextureWorkload();
}
