import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PresentationDocument } from "../../../src/core/document";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";
import type { createMotionRuntime } from "../../../src/components/motionRuntime";
import type { SlideMotion } from "../../../src/core/motionModel";

let server: ViteDevServer, app: ElectronApplication, page: Page;
const port = 5183;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async () => {
  const directory = path.resolve("test-results-native-composition");
  await mkdir(directory, { recursive: true });
  const main = path.join(directory, "main.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement');app.whenReady().then(()=>{const w=new BrowserWindow({width:640,height:360,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:${port}/tests/helpers/effects-harness.html');});`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  app = await electron.launch({ args: [main], env });
  page = await app.firstWindow();
});
test.afterEach(async () => {
  await app?.close();
});

type ProbeWindow = Window & {
  native: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
  runtime?: ReturnType<typeof createMotionRuntime>;
  model: PresentationDocument;
  motion: SlideMotion;
  disposeScene?: () => void;
  compositor?: import("../../../src/components/compositionRuntime").CompositionRuntime;
  sceneErrors?: string[];
};

async function mount(
  page: Page,
  mode:
    | "native"
    | "parent"
    | "rounded"
    | "fill"
    | "glass"
    | "browser-native" = "native",
  count = 1,
  disjoint = false,
  imageBackground = false,
  mixedPrefix = false,
) {
  await page.goto(
    `http://127.0.0.1:${port}/tests/helpers/effects-harness.html`,
  );
  const options = { mode, count, disjoint, imageBackground, mixedPrefix };
  await page.evaluate(async (options) => {
    const { mode, count, disjoint, imageBackground, mixedPrefix } = options;
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      factoryPath = "/src/core/elementFactory.ts",
      authoringPath = "/src/core/effectAuthoring.ts",
      effectsPath = "/src/core/effects.ts",
      textPath = "/src/core/text.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const {
      createBasicShape,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const { blankEffect }: typeof import("../../../src/core/effectAuthoring") =
      await import(/* @vite-ignore */ authoringPath);
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const { createTextElement }: typeof import("../../../src/core/text") =
      await import(/* @vite-ignore */ textPath);
    if (imageBackground || mixedPrefix) {
      const platformPath = "/src/platform/index.ts";
      const { platform }: typeof import("../../../src/platform") = await import(
        /* @vite-ignore */ platformPath
      );
      const source = document.createElement("canvas");
      source.width = 300;
      source.height = 200;
      const ctx = source.getContext("2d")!;
      const gradient = ctx.createLinearGradient(0, 0, 300, 200);
      gradient.addColorStop(0, "#0630a0");
      gradient.addColorStop(1, "#ff7200");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 300, 200);
      const url = source.toDataURL();
      platform.assetUrl = async () => url;
    }
    (window as unknown as ProbeWindow).native = await mountMixedEffectsHarness(
      undefined,
      0,
      undefined,
      {
        configure(model: PresentationDocument) {
          (window as unknown as ProbeWindow).model = model;
          model.deck.stylesheet = "";
          const slide = model.slides[model.deck.slideIds[0]];
          const shader = {
            ...blankEffect("shader"),
            input: "none" as const,
            target: "background" as const,
            source: mixedPrefix
              ? "#version 300 es\nprecision highp float;uniform float u_t;in vec2 v_uv;out vec4 outColor;void main(){float c=step(.5,fract(v_uv.x*18.+u_t));outColor=vec4(.08+.65*c,.18,.9-.45*c,.32);}"
              : "#version 300 es\nprecision highp float;uniform float u_t;in vec2 v_uv;out vec4 outColor;void main(){float c=step(.5,fract(v_uv.x*32.+u_t));outColor=vec4(vec3(c),1.);}",
          };
          const css = {
            ...blankEffect("css-js"),
            source:
              ":scope { backdrop-filter: blur(12px); background: #ffffff22; }",
          };
          if (mode === "glass" || mode === "browser-native")
            css.source =
              ":scope { background: linear-gradient(135deg, rgba(255,255,255,.68), rgba(255,255,255,.24)); backdrop-filter: blur(26px) saturate(125%); border: 1px solid rgba(255,255,255,.78); border-radius: 28px; box-shadow: 0 24px 65px rgba(39,65,130,.12), inset 0 1px 0 rgba(255,255,255,.8); overflow: hidden; }";
          slide.effectResources = { shader, css };
          const lower = createBasicShape("lower", "rectangle", {
            x: 0,
            y: 0,
          });
          lower.frame.width = 640;
          lower.frame.height = 360;
          lower.effects = [newEffectInstance("shader", shader, "background")];
          if (imageBackground) {
            lower.effects = [];
            lower.appearance.fill = "#33aa44";
            lower.frame.x = 40;
            lower.frame.y = 20;
            lower.frame.width = 560;
            lower.frame.height = 320;
            lower.clipChildren = true;
            lower.content = {
              type: "image",
              assetId: "image-background",
              filename: "image-background.png",
              mediaType: "image",
              opacity: 0.7,
              lockAspect: true,
              transform: {
                rule: "fill",
                intrinsicWidth: 300,
                intrinsicHeight: 200,
                rotation: 15,
                flipX: true,
                flipY: false,
                anchorX: 0.4,
                anchorY: 0.6,
                zoom: 1.15,
              },
            };
          }
          if (mixedPrefix) {
            lower.effects = [];
            lower.appearance.fill = "#133050";
            lower.clipChildren = true;
            lower.content = {
              type: "image",
              assetId: "image-a",
              filename: "image-a.png",
              mediaType: "image",
              opacity: 0.82,
              lockAspect: true,
              transform: {
                rule: "fill",
                intrinsicWidth: 300,
                intrinsicHeight: 200,
                rotation: 0,
                flipX: false,
                flipY: false,
                anchorX: 0.5,
                anchorY: 0.5,
                zoom: 1,
              },
            };
          }
          const glass = createBasicShape("glass", "rectangle", {
            x: 80,
            y: 70,
          });
          glass.frame.width = 300;
          glass.frame.height = 200;
          glass.appearance.fill =
            mode === "fill" || mode === "glass" || mode === "browser-native"
              ? "#ffffff22"
              : "";
          glass.appearance.radius =
            mode === "glass" || mode === "browser-native"
              ? 28
              : mode === "rounded"
                ? 18
                : 0;
          if (mode === "glass" || mode === "browser-native") glass.clipChildren = true;
          glass.effects = [newEffectInstance("css", css, "content")];
          const a = createBasicShape("a", "rectangle", { x: 40, y: 40 }),
            b = createBasicShape("b", "rectangle", { x: 80, y: 80 });
          for (const child of [a, b]) {
            child.frame.width = 120;
            child.frame.height = 80;
          }
          a.appearance.fill = "#ff000088";
          b.appearance.fill = "#00ff0088";
          glass.children = [a, b];
          if (mode === "browser-native") {
            const label = createTextElement("glass-label", { x: 28, y: 132 });
            label.frame.width = 230;
            label.frame.height = 46;
            if (label.content?.type === "text") {
              label.content.text = "Native CSS glass";
              if (label.content.format.kind === "local")
                label.content.format.typography.fontSize = 24;
            }
            glass.children.push(label);
          }
          const group = createBasicShape("group", "rectangle", {
            x: 0,
            y: 0,
          });
          group.appearance.fill = "";
          group.frame.width = 640;
          group.frame.height = 360;
          group.children = [glass];
          const sources = [lower];
          if (mixedPrefix) {
            const rectangle = createBasicShape("mixed-rectangle", "rectangle", {
              x: 0,
              y: 0,
            });
            rectangle.frame.width = 640;
            rectangle.frame.height = 360;
            rectangle.appearance.fill = "#ff335566";

            const shaderLayer = createBasicShape("mixed-shader", "rectangle", {
              x: 0,
              y: 0,
            });
            shaderLayer.frame.width = 640;
            shaderLayer.frame.height = 360;
            shaderLayer.effects = [
              newEffectInstance("shader", shader, "background"),
            ];

            const imageB = createBasicShape("image-b", "rectangle", {
              x: 0,
              y: 0,
            });
            imageB.frame.width = 640;
            imageB.frame.height = 360;
            imageB.clipChildren = true;
            imageB.content = {
              type: "image",
              assetId: "image-b",
              filename: "image-b.png",
              mediaType: "image",
              opacity: 0.58,
              lockAspect: true,
              transform: {
                rule: "fill",
                intrinsicWidth: 300,
                intrinsicHeight: 200,
                rotation: 0,
                flipX: true,
                flipY: false,
                anchorX: 0.65,
                anchorY: 0.35,
                zoom: 1.08,
              },
            };
            sources.push(rectangle, shaderLayer, imageB);
          }
          if (mode === "browser-native") {
            const underlay = createBasicShape("translucent-underlay", "rectangle", {
              x: 36,
              y: 42,
            });
            underlay.frame.width = 380;
            underlay.frame.height = 230;
            underlay.appearance.fill = "#ef3c7d66";
            const foreground = createBasicShape("foreground", "ellipse", {
              x: 330,
              y: 118,
            });
            foreground.frame.width = 180;
            foreground.frame.height = 180;
            foreground.appearance.fill = "#18c9d999";
            slide.nodes[0].children = [
              ...sources,
              underlay,
              glass,
              foreground,
            ];
          } else
            slide.nodes[0].children =
              mode === "parent" ? [lower, group] : [...sources, glass];
          for (let index = 1; index < count; index++) {
            const copy = structuredClone(glass);
            copy.id = `glass-${index}`;
            copy.frame.x += index * 18;
            copy.frame.y += index * 5;
            copy.children.forEach((child) => {
              child.id += `-${index}`;
            });
            copy.effects!.forEach((effect) => {
              effect.id += `-${index}`;
            });
            slide.nodes[0].children.push(copy);
          }
          if (disjoint) {
            const cards = slide.nodes[0].children.filter(
              (element) =>
                element.id === "glass" || element.id.startsWith("glass-"),
            );
            cards.forEach((card, index) => {
              card.frame.x = 20 + (index % 5) * 124;
              card.frame.y = 20 + Math.floor(index / 5) * 154;
              card.frame.width = 100;
              card.frame.height = 120;
            });
          }
          if (mixedPrefix) {
            const later = createBasicShape("later-unrelated", "rectangle", {
              x: 520,
              y: 270,
            });
            later.frame.width = 80;
            later.frame.height = 60;
            later.appearance.fill = "#22dd88";
            slide.nodes[0].children.push(later);
          }
          if (mode === "browser-native") {
            slide.motion = {
              stages: [
                {
                  id: "stage",
                  tracks: [
                    {
                      id: "browser-move-x",
                      elementId: "glass",
                      property: "transform.x",
                      keyframes: [
                        {
                          id: "browser-move-x-a",
                          at: 0,
                          value: { type: "absolute", value: 80 },
                          easeToNext: [0, 0, 1, 1],
                        },
                        {
                          id: "browser-move-x-b",
                          at: 1000,
                          value: { type: "absolute", value: 170 },
                        },
                      ],
                    },
                    {
                      id: "browser-scale-x",
                      elementId: "glass",
                      property: "transform.scaleX",
                      keyframes: [
                        {
                          id: "browser-scale-x-a",
                          at: 0,
                          value: { type: "absolute", value: 0.9 },
                          easeToNext: [0, 0, 1, 1],
                        },
                        {
                          id: "browser-scale-x-b",
                          at: 1000,
                          value: { type: "absolute", value: 1.12 },
                        },
                      ],
                    },
                    {
                      id: "browser-scale-y",
                      elementId: "glass",
                      property: "transform.scaleY",
                      keyframes: [
                        {
                          id: "browser-scale-y-a",
                          at: 0,
                          value: { type: "absolute", value: 0.92 },
                          easeToNext: [0, 0, 1, 1],
                        },
                        {
                          id: "browser-scale-y-b",
                          at: 1000,
                          value: { type: "absolute", value: 1.05 },
                        },
                      ],
                    },
                    {
                      id: "browser-rotate",
                      elementId: "glass",
                      property: "transform.rotation",
                      keyframes: [
                        {
                          id: "browser-rotate-a",
                          at: 0,
                          value: { type: "absolute", value: -6 },
                          easeToNext: [0, 0, 1, 1],
                        },
                        {
                          id: "browser-rotate-b",
                          at: 1000,
                          value: { type: "absolute", value: 10 },
                        },
                      ],
                    },
                    {
                      id: "browser-fade",
                      elementId: "glass",
                      property: "appearance.opacity",
                      keyframes: [
                        {
                          id: "browser-fade-a",
                          at: 0,
                          value: { type: "absolute", value: 0.25 },
                          easeToNext: [0, 0, 1, 1],
                        },
                        {
                          id: "browser-fade-b",
                          at: 1000,
                          value: { type: "absolute", value: 0.9 },
                        },
                      ],
                    },
                  ],
                  blocks: [
                    {
                      id: "browser-presence",
                      label: "Presence",
                      members: [],
                      binding: { kind: "presence", elementId: "glass" },
                      presenceSchedule: {
                        version: 1,
                        startOffsetMs: 0,
                        end: { mode: "after", durationMs: 1000 },
                        enterTransition: {
                          kind: "move",
                          durationMs: 250,
                          easing: [0, 0, 1, 1],
                          direction: "Up",
                          distance: 30,
                        },
                        exitTransition: {
                          kind: "fade",
                          durationMs: 300,
                          easing: [0, 0, 1, 1],
                        },
                      },
                    },
                  ],
                },
              ],
            };
          } else {
            slide.motion = {
              stages: [
                {
                  id: "stage",
                  tracks: [],
                  blocks: [
                    {
                      id: "presence",
                      label: "Presence",
                      members: [],
                      binding: {
                        kind: "presence",
                        elementId: mode === "parent" ? "group" : "glass",
                      },
                      presenceSchedule: {
                        version: 1,
                        startOffsetMs: 0,
                        end: { mode: "none" },
                        enterTransition: {
                          kind: "move",
                          durationMs: 1000,
                          easing: [0, 0, 1, 1],
                          direction: "Up",
                          distance: 30,
                        },
                        exitTransition: {
                          kind: "none",
                          durationMs: 1000,
                          easing: [0, 0, 1, 1],
                        },
                      },
                    },
                  ],
                },
              ],
            };
          }
          (window as unknown as ProbeWindow).motion = slide.motion!;
          // Legacy compositor diagnostics own exact samples themselves.
          if (mode !== "parent" && mode !== "browser-native") delete slide.motion;
        },
      },
    );
  }, options);
}
async function image(page: Page) {
  return sharp(await page.locator(".slide-renderer").screenshot())
    .removeAlpha()
    .raw()
    .toBuffer();
}

async function enableScene(page: Page, prepare = true) {
  await page.evaluate(async (prepare) => {
    const w = window as unknown as ProbeWindow;
    const plannerPath = "/src/components/compositionBackendPlan.ts",
      runtimePath = "/src/components/compositionRuntime.ts",
      planPath = "/src/components/compositionPlan.ts";
    const {
      planCompositionBackends,
    }: typeof import("../../../src/components/compositionBackendPlan") =
      await import(/* @vite-ignore */ plannerPath);
    const {
      mountCompositionRuntime,
    }: typeof import("../../../src/components/compositionRuntime") =
      await import(/* @vite-ignore */ runtimePath);
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const planningSlide = { ...slide, motion: w.motion };
    const plan = planCompositionBackends(
      compileCompositionPlan(planningSlide, w.model.deck),
      planningSlide,
      w.model.deck,
      { restoration: true, padding: 2 },
    ).restoration;
    if (!plan) throw new Error("Real glass style was not admitted");
    for (const id of plan.glass) {
      const node = [
        ...w.native.host.querySelectorAll<HTMLElement>("[data-element-id]"),
      ].find((n) => n.dataset.elementId === id)!;
      // The diagnostic supplies the same renderer-owned output nodes without
      // starting a second React/Motion sampler. Product ownership is tested below.
      const paint = document.createElement("div");
      paint.dataset.compositionPaint = "true";
      paint.style.cssText =
        "position:absolute;inset:0;content-visibility:hidden";
      paint.append(...node.childNodes);
      node.append(paint);
      const alpha = document.createElement("div");
      alpha.dataset.compositionAlpha = "true";
      alpha.style.cssText = "display:none;opacity:1";
      node.append(alpha);
      node.style.opacity = "1";
      const overlay = document.createElement("div");
      overlay.dataset.backdropRestore = id;
      overlay.style.cssText = "position:absolute;opacity:0;pointer-events:none";
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      canvas.style.cssText = "width:100%;height:100%;display:block";
      overlay.append(canvas);
      node.after(overlay);
    }
    w.sceneErrors = [];
    w.compositor = mountCompositionRuntime(
      w.native.host.querySelector<HTMLElement>(".slide-renderer")!,
      { slide: planningSlide, deck: w.model.deck },
      {
        restoration: plan,
        failed: (_ids, error) => w.sceneErrors!.push(String(error)),
        density: { x: devicePixelRatio, y: devicePixelRatio },
      },
    );
    const apply = w.compositor.apply.bind(w.compositor);
    // Observe the semantic frame in this diagnostic, independently of output.
    // Production has no hidden DOM alpha proxy.
    w.compositor.apply = (samples) => {
      for (const sample of samples) {
        const node = [
          ...w.native.host.querySelectorAll<HTMLElement>("[data-element-id]"),
        ].find((n) => n.dataset.elementId === sample.elementId);
        const target = node?.querySelector<HTMLElement>(
          ":scope > [data-composition-alpha]",
        );
        if (target) target.style.opacity = String(sample.opacity);
      }
      apply(samples);
    };
    w.disposeScene = () => w.compositor!.dispose();
    if (prepare) await w.native.advance(0.37);
  }, prepare);
}
async function setAlpha(
  page: Page,
  which: "all" | "last" | "glass",
  alpha: number,
) {
  await page.evaluate(
    ({ which, alpha }) => {
      const w = window as unknown as ProbeWindow;
      const nodes = [
        ...w.native.host.querySelectorAll<HTMLElement>(
          "[data-composition-alpha]",
        ),
      ];
      const chosen =
        which === "all"
          ? nodes
          : which === "last"
            ? nodes.slice(-1)
            : nodes.filter(
                (n) => n.parentElement!.dataset.elementId === "glass",
              );
      w.compositor!.apply(
        chosen.map((target) => {
          const node = target.parentElement!,
            id = node.dataset.elementId!;
          target.style.opacity = String(alpha);
          const frame = {
            ...w.model.slides[w.model.deck.slideIds[0]].nodes[0].children.find(
              (e) => e.id === id,
            )!.frame,
          };
          const matrix = new DOMMatrix(getComputedStyle(node).transform);
          frame.x += matrix.e;
          frame.y += matrix.f;
          return { elementId: id, frame, opacity: alpha, present: true };
        }),
      );
    },
    { which, alpha },
  );
}

test("filled rounded Presence reveals its first restoration with the current Motion sample", async () => {
  await mount(page, "glass");
  await enableScene(page, false);
  await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow & {
      releasePublication: () => void;
      publicationStarted: Promise<void>;
      entranceFlush: Promise<unknown>;
      restoreMaterialize: () => void;
    };
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const materializer = w.compositor!.materializer;
    const original = materializer.materialize.bind(materializer);
    let started!: () => void;
    w.publicationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      w.releasePublication = resolve;
    });
    materializer.materialize = async (request) => {
      const published = await original(request);
      started();
      await held;
      return published;
    };
    w.restoreMaterialize = () => {
      materializer.materialize = original;
    };
    w.runtime = createMotionRuntime(
      w.native.host,
      { ...w.model.slides[w.model.deck.slideIds[0]], motion: w.motion },
      0,
      undefined,
      w.compositor,
    );
    w.runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 1,
      running: false,
      startedAt: 0,
    });
    w.entranceFlush = w.native.advance(0.37);
    await w.publicationStarted;
    // Advance the existing sampler while the materializer response is held.
    // The eventual reveal must use this sample, not the one before the await.
    w.runtime.samplePresence(100);
  });
  // Force an actual paint while restoration is still waiting for its first
  // materialized response. The fully opaque native card must not paint alone.
  await page.locator(".slide-renderer").screenshot({
    path: "test-results-native-composition/entrance-pending.png",
  });
  const pending = await page
    .locator('[data-element-id="glass"]')
    .evaluate((node) => ({
      opacity: Number(getComputedStyle(node).opacity),
      contentVisibility: getComputedStyle(
        node.querySelector("[data-composition-paint]")!,
      ).contentVisibility,
      populated: node.nextElementSibling!.querySelector("canvas")!.width > 1,
    }));
  expect(pending).toEqual({
    opacity: 1,
    contentVisibility: "hidden",
    populated: false,
  });
  await expect(page.locator("[data-css-backdrop]:visible")).toHaveCount(0);
  const first = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow & {
      releasePublication: () => void;
      entranceFlush: Promise<unknown>;
      restoreMaterialize: () => void;
    };
    w.releasePublication();
    await w.entranceFlush;
    w.restoreMaterialize();
    const node = w.native.host.querySelector<HTMLElement>(
        '[data-element-id="glass"]',
      )!,
      overlay = node.nextElementSibling as HTMLElement,
      canvas = overlay.querySelector("canvas")!;
    const transformPath = "/src/components/elementDomTransform.ts";
    const {
      elementWorldTransform,
    }: typeof import("../../../src/components/elementDomTransform") =
      await import(/* @vite-ignore */ transformPath);
    const world = elementWorldTransform(
      node,
      w.native.host.querySelector<HTMLElement>(".slide-renderer")!,
    );
    return {
      opacity: Number(getComputedStyle(node).opacity),
      contentVisibility: getComputedStyle(node).contentVisibility,
      alpha: Number(
        getComputedStyle(node.querySelector("[data-composition-alpha]")!)
          .opacity,
      ),
      restoration: Number(getComputedStyle(overlay).opacity),
      populated: canvas.width > 1,
      clip: (() => {
        const values = overlay.style.clipPath.match(/-?[\d.]+/g)!.map(Number);
        return values.length === 1
          ? [values[0], values[0], values[0], values[0]]
          : values.length === 2
            ? [values[0], values[1], values[0], values[1]]
            : values.length === 3
              ? [values[0], values[1], values[2], values[1]]
              : values;
      })(),
      x: world.e - parseFloat(overlay.style.left),
      y: world.f - parseFloat(overlay.style.top),
    };
  });
  expect(first.populated).toBe(true);
  expect(first.opacity).toBe(1);
  expect(first.contentVisibility).toBe("visible");
  expect(first.alpha).toBeCloseTo(0.1);
  expect(first.restoration).toBeCloseTo(1 - first.alpha, 5);
  expect(first.clip[0]).toBeCloseTo(first.y - 2, 2);
  expect(first.clip[3]).toBeCloseTo(first.x - 2, 2);
  await expect(page.locator("[data-css-backdrop]:visible")).toHaveCount(0);
  await page
    .locator(".slide-renderer")
    .screenshot({ path: "test-results-native-composition/entrance-first.png" });
});

test("filled rounded glass keeps native edge pixels and one resolved Presence fade with an ordered scene input", async () => {
  await mount(page, "glass");
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).native.advance(0.37),
  );
  const reference = await image(page);
  await enableScene(page);
  const actual = await image(page);
  let staticMax = 0;
  for (let i = 0; i < actual.length; i++)
    staticMax = Math.max(staticMax, Math.abs(actual[i] - reference[i]));
  expect(staticMax).toBeLessThanOrEqual(2);
  const captures = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    w.runtime = createMotionRuntime(
      w.native.host,
      { ...w.model.slides[w.model.deck.slideIds[0]], motion: w.motion },
      0,
      undefined,
      w.compositor,
    );
    await w.runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    await w.native.advance(0.37);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await w.native.advance(0.37);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await w.native.advance(0.37);
    return w.native.inspect().diagnostics.captures;
  });
  const faded = await image(page);
  await setAlpha(page, "glass", 1);
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).native.advance(0.37),
  );
  const full = await image(page);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => (node.style.visibility = "hidden"));
  const background = await image(page);
  let max = 0,
    sum = 0;
  for (let i = 0; i < faded.length; i++) {
    const e = Math.abs(faded[i] - (full[i] + background[i]) * 0.5);
    max = Math.max(max, e);
    sum += e;
  }
  expect(max).toBeLessThanOrEqual(2);
  expect(sum / faded.length).toBeLessThan(0.2);
  const restored = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const node = w.native.host.querySelector<HTMLElement>(
      '[data-element-id="glass"]',
    )!;
    node.style.visibility = "";
    w.runtime!.cancel();
    await w.native.advance(0.37);
    return {
      alpha: node.style.opacity,
      captures: w.native.inspect().diagnostics.captures,
      errors: w.sceneErrors,
    };
  });
  expect(restored).toEqual({ alpha: "1", captures, errors: [] });
  await expect(page.locator("[data-backdrop-restore]")).toHaveCount(1);
  await expect(page.locator("[data-css-backdrop]:visible")).toHaveCount(0);
});

test("three and ten disjoint filled rounded consumers retain resolved fade pixels without backdrop captures", async () => {
  for (const count of [3, 10]) {
    await mount(page, "glass", count, true);
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).native.advance(0.37),
    );
    const reference = await image(page);
    await enableScene(page);
    const actual = await image(page);
    let max = 0,
      sum = 0;
    for (let i = 0; i < actual.length; i++) {
      const e = Math.abs(actual[i] - reference[i]);
      max = Math.max(max, e);
      sum += e;
    }
    expect(max).toBeLessThanOrEqual(2);
    expect(sum / actual.length).toBeLessThan(0.2);
    await setAlpha(page, "all", 0.5);
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).native.advance(0.37),
    );
    const faded = await image(page);
    await setAlpha(page, "last", 1);
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).native.advance(0.37),
    );
    const full = await image(page);
    await page
      .locator("[data-composition-alpha]")
      .last()
      .evaluate(
        (node) =>
          ((node.parentElement as HTMLElement).style.visibility = "hidden"),
      );
    const background = await image(page);
    let fadeMax = 0;
    for (let i = 0; i < faded.length; i++)
      fadeMax = Math.max(
        fadeMax,
        Math.abs(faded[i] - (full[i] + background[i]) * 0.5),
      );
    expect(fadeMax).toBeLessThanOrEqual(2);
    await expect(page.locator("[data-backdrop-restore]")).toHaveCount(count);
    await expect(page.locator("[data-css-backdrop]:visible")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as ProbeWindow).sceneErrors),
    ).toEqual([]);
  }
});

test("mixed owned prefix is shared across two glass consumers and invalidates only from its sources", async () => {
  await mount(page, "glass", 2, true, false, true);
  for (const id of ["lower", "image-b"])
    await page
      .locator(`[data-element-id="${id}"] img`)
      .first()
      .evaluate(async (image: HTMLImageElement) => image.decode());

  await enableScene(page);
  await expect(page.locator("[data-backdrop-restore]")).toHaveCount(2);
  await expect(page.locator("[data-css-backdrop]")).toHaveCount(0);

  const initial = await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    return {
      diagnostics: w.compositor!.diagnostics(),
      captures: w.native.inspect().diagnostics.captures,
      errors: w.sceneErrors,
    };
  });
  expect(initial.captures).toBe(0);
  expect(initial.errors).toEqual([]);
  expect(initial.diagnostics.consumers).toBe(2);
  expect(initial.diagnostics.uniquePrefixes).toBe(2);
  expect(initial.diagnostics.prefixes.semanticSurfaces).toBe(2);
  expect(initial.diagnostics.prefixes.surfaces).toBe(1);
  expect(initial.diagnostics.prefixes.builds).toBe(1);

  const motion = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    w.runtime = createMotionRuntime(
      w.native.host,
      { ...slide, motion: w.motion },
      0,
      undefined,
      w.compositor,
    );
    const before = w.compositor!.diagnostics().prefixes.builds;
    w.runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    await w.compositor!.flush();
    const middle = w.compositor!.diagnostics();
    const glass = w.native.host.querySelector<HTMLElement>(
      '[data-element-id="glass"]',
    )!;
    const overlay = w.native.host.querySelector<HTMLElement>(
      '[data-backdrop-restore="glass"]',
    )!;
    return {
      before,
      after: middle.prefixes.builds,
      transform: getComputedStyle(glass).transform,
      restorationAlpha: Number(overlay.style.opacity),
    };
  });
  // createMotionRuntime also advances the continuously running GLSL source.
  // Consumer-only Motion invalidation is checked below with direct semantic
  // Motion samples so source time and consumer geometry are not conflated.
  expect(motion.after).toBeGreaterThanOrEqual(motion.before);
  expect(motion.transform).not.toBe("none");
  expect(motion.restorationAlpha).toBeGreaterThan(0);
  expect(motion.restorationAlpha).toBeLessThan(1);

  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.runtime!.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 999.999,
      running: false,
      startedAt: 0,
    });
  });
  const almost = await image(page);
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.runtime!.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 1000,
      running: false,
      startedAt: 0,
    });
  });
  const complete = await image(page);
  let boundaryMax = 0,
    boundaryMean = 0;
  for (let i = 0; i < complete.length; i++) {
    const error = Math.abs(almost[i] - complete[i]);
    boundaryMax = Math.max(boundaryMax, error);
    boundaryMean += error;
  }
  expect(boundaryMax).toBeLessThanOrEqual(8);
  expect(boundaryMean / complete.length).toBeLessThan(0.1);

  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.runtime!.cancel();
    w.runtime = undefined;
  });

  await setAlpha(page, "all", 1);
  const full = await image(page);
  await setAlpha(page, "all", 0.5);
  const faded = await image(page);
  await setAlpha(page, "all", 1);
  await page
    .locator('[data-element-id="glass"], [data-element-id^="glass-"]')
    .evaluateAll((nodes) => {
      nodes.forEach(
        (node) => ((node as HTMLElement).style.visibility = "hidden"),
      );
    });
  const background = await image(page);
  await page
    .locator('[data-element-id="glass"], [data-element-id^="glass-"]')
    .evaluateAll((nodes) => {
      nodes.forEach((node) => ((node as HTMLElement).style.visibility = ""));
    });

  let fadeMax = 0,
    fadeMean = 0;
  for (let i = 0; i < faded.length; i++) {
    const error = Math.abs(faded[i] - (full[i] + background[i]) * 0.5);
    fadeMax = Math.max(fadeMax, error);
    fadeMean += error;
  }
  expect(fadeMax).toBeLessThanOrEqual(3);
  expect(fadeMean / faded.length).toBeLessThan(0.1);

  const invalidation = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const compositor = w.compositor!;
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const builds = () => compositor.diagnostics().prefixes.builds;
    const result: Record<string, number> = { initial: builds() };

    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const glass = slide.nodes[0].children.find(
      (element) => element.id === "glass",
    )!;
    compositor.apply([
      {
        elementId: glass.id,
        frame: { ...glass.frame, x: glass.frame.x + 12 },
        opacity: 0.35,
        present: true,
      },
    ]);
    await compositor.flush();
    result.consumerMotion = builds();

    const later = root.querySelector<HTMLElement>(
      '[data-element-id="later-unrelated"]',
    )!;
    later.style.transform = "translateX(7px)";
    await Promise.resolve();
    await compositor.flush();
    result.laterElement = builds();

    const shaderHost = root.querySelector<HTMLElement>(
      '[data-element-id="mixed-shader"] [data-effect-id]',
    )!;
    shaderHost.style.setProperty("--presentationTime", "999");
    await Promise.resolve();
    await compositor.flush();
    result.sourceReferenceClock = builds();

    const lower = root.querySelector<HTMLElement>('[data-element-id="lower"]')!;
    const sourceImage = [
      ...lower.querySelectorAll<HTMLImageElement>("img"),
    ].find((image) => getComputedStyle(image).display !== "none")!;
    const changed = document.createElement("canvas");
    changed.width = 300;
    changed.height = 200;
    const changedContext = changed.getContext("2d")!;
    changedContext.fillStyle = "#f05a24";
    changedContext.fillRect(0, 0, changed.width, changed.height);
    changedContext.fillStyle = "#1535cc";
    changedContext.fillRect(0, 0, 130, changed.height);
    sourceImage.src = changed.toDataURL();
    await sourceImage.decode();
    await compositor.flush();
    result.imageSource = builds();

    const shader = root.querySelector<HTMLElement>(
      '[data-element-id="mixed-shader"] [data-effect-id]',
    )!;
    shader.dataset.effectRevision = String(
      Number(shader.dataset.effectRevision ?? 0) + 1,
    );
    shader.dispatchEvent(
      new CustomEvent("showme-effect-output", { bubbles: true }),
    );
    await compositor.flush();
    result.shaderSource = builds();

    return {
      result,
      diagnostics: compositor.diagnostics(),
      captures: w.native.inspect().diagnostics.captures,
      cssBackdrop: root.querySelectorAll("[data-css-backdrop]").length,
      errors: w.sceneErrors,
    };
  });
  expect(invalidation.result.consumerMotion).toBe(invalidation.result.initial);
  expect(invalidation.result.laterElement).toBe(invalidation.result.initial);
  expect(invalidation.result.sourceReferenceClock).toBe(invalidation.result.initial);
  expect(invalidation.result.imageSource).toBeGreaterThan(
    invalidation.result.laterElement,
  );
  expect(invalidation.result.shaderSource).toBeGreaterThan(
    invalidation.result.imageSource,
  );
  expect(invalidation.diagnostics.uniquePrefixes).toBe(2);
  expect(invalidation.diagnostics.prefixes.surfaces).toBe(1);
  expect(invalidation.diagnostics.prefixes.reuses).toBeGreaterThan(0);
  expect(invalidation.captures).toBe(0);
  expect(invalidation.cssBackdrop).toBe(0);
  expect(invalidation.errors).toEqual([]);
});

test("scene materializer shares one exact surface across independent regional consumers", async () => {
  await mount(page, "glass", 2, true, false, true);
  for (const id of ["lower", "image-b"])
    await page
      .locator('[data-element-id="' + id + '"] img')
      .first()
      .evaluate(async (image: HTMLImageElement) => image.decode());
  await enableScene(page);

  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const plannerPath = "/src/components/compositionBackendPlan.ts";
    const planPath = "/src/components/compositionPlan.ts";
    const {
      planCompositionBackends,
    }: typeof import("../../../src/components/compositionBackendPlan") =
      await import(/* @vite-ignore */ plannerPath);
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const planningSlide = { ...slide, motion: w.motion };
    const restoration = planCompositionBackends(
      compileCompositionPlan(planningSlide, w.model.deck),
      planningSlide,
      w.model.deck,
      { restoration: true, padding: 2 },
    ).restoration!;
    const surface = restoration.surfaces.get("glass")!;
    const materializer = w.compositor!.materializer;
    const before = materializer.diagnostics();
    const first = await materializer.materialize({
      surface,
      region: { x: 70, y: 60, width: 120, height: 90 },
      density: { x: devicePixelRatio, y: devicePixelRatio },
      irrelevantElementIds: restoration.irrelevantConsumers,
    });
    const second = await materializer.materialize({
      surface,
      region: { x: 140, y: 100, width: 80, height: 70 },
      density: { x: devicePixelRatio, y: devicePixelRatio },
      irrelevantElementIds: restoration.irrelevantConsumers,
    });
    const after = materializer.diagnostics();
    if (
      first.source.kind !== "canvas-image" ||
      !(first.source.value instanceof HTMLCanvasElement)
    )
      throw new Error("Expected the owned Canvas2D publication");
    const originalPixels = first.source.value.toDataURL();
    w.native.host.querySelector<HTMLElement>('[data-element-id="lower"]')!
      .style.opacity = "0.5";
    await Promise.resolve();
    const updated = await materializer.materialize({
      surface,
      region: { x: 70, y: 60, width: 120, height: 90 },
      density: { x: devicePixelRatio, y: devicePixelRatio },
      irrelevantElementIds: restoration.irrelevantConsumers,
    });
    const loading = document.createElement("span");
    loading.dataset.mediaLoading = "true";
    w.native.host.querySelector('[data-element-id="lower"]')!.append(loading);
    let settled = false;
    const prepared = materializer.materialize({
      surface,
      region: { x: 70, y: 60, width: 120, height: 90 },
      density: { x: 1.333, y: 1.333 },
      irrelevantElementIds: restoration.irrelevantConsumers,
    }).then((value) => { settled = true; return value; });
    // Let the task finish: decoding existing imgs alone must not bypass the
    // MediaSurface marker while its replacement image has not mounted yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waitedForMedia = !settled;
    loading.remove();
    const fractional = await prepared;
    return {
      sameSemanticRef: first.surface === second.surface,
      samePublishedSource:
        first.source.kind === "canvas-image" &&
        second.source.kind === "canvas-image" &&
        first.source.value === second.source.value,
      sameRevision: first.revision === second.revision,
      buildDelta: after.builds - before.builds,
      reuseDelta: after.reuses - before.reuses,
      semanticId: surface.id,
      previousPublicationIntact: first.source.value.toDataURL() === originalPixels,
      updatedRevision: updated.revision > first.revision,
      waitedForMedia,
      actualDensity: fractional.density,
      expectedDensity: {
        x: fractional.pixelSize.width / fractional.logicalBounds.width,
        y: fractional.pixelSize.height / fractional.logicalBounds.height,
      },
    };
  });

  expect(result.sameSemanticRef).toBe(true);
  expect(result.samePublishedSource).toBe(true);
  expect(result.sameRevision).toBe(true);
  expect(result.buildDelta).toBe(0);
  expect(result.reuseDelta).toBeGreaterThanOrEqual(2);
  expect(result.semanticId).toContain("scene:");
  expect(result.previousPublicationIntact).toBe(true);
  expect(result.updatedRevision).toBe(true);
  expect(result.waitedForMedia).toBe(true);
  expect(result.actualDensity).toEqual(result.expectedDensity);
});

test("one failed restoration surface leaves an independent consumer operational", async () => {
  await mount(page, "glass", 2, true, false, true);
  for (const id of ["lower", "image-b"])
    await page
      .locator('[data-element-id="' + id + '"] img')
      .first()
      .evaluate(async (image: HTMLImageElement) => image.decode());
  await enableScene(page, false);

  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const plannerPath = "/src/components/compositionBackendPlan.ts";
    const planPath = "/src/components/compositionPlan.ts";
    const {
      planCompositionBackends,
    }: typeof import("../../../src/components/compositionBackendPlan") =
      await import(/* @vite-ignore */ plannerPath);
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const planningSlide = { ...slide, motion: w.motion };
    const restoration = planCompositionBackends(
      compileCompositionPlan(planningSlide, w.model.deck),
      planningSlide,
      w.model.deck,
      { restoration: true, padding: 2 },
    ).restoration!;
    const failedSurface = restoration.surfaces.get("glass-1")!;
    const materializer = w.compositor!.materializer;
    const original = materializer.materialize.bind(materializer);
    materializer.materialize = async (request) => {
      if (request.surface.id === failedSurface.id)
        throw new Error("deliberate semantic surface failure");
      return original(request);
    };

    await w.compositor!.flush();
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const good = root.querySelector<HTMLCanvasElement>(
      '[data-backdrop-restore="glass"] canvas',
    )!;
    const failed = root.querySelector<HTMLCanvasElement>(
      '[data-backdrop-restore="glass-1"] canvas',
    )!;
    return {
      errors: w.sceneErrors,
      goodPopulated: good.width > 1,
      failedPopulated: failed.width > 1,
      goodOwned: w.compositor!.ownsOpacity?.("glass") ?? false,
      failedOwned: w.compositor!.ownsOpacity?.("glass-1") ?? false,
      goodPaint: getComputedStyle(
        root.querySelector(
          '[data-element-id="glass"] [data-composition-paint]',
        )!,
      ).contentVisibility,
      failedPaint: getComputedStyle(
        root.querySelector(
          '[data-element-id="glass-1"] [data-composition-paint]',
        )!,
      ).contentVisibility,
    };
  });

  expect(result.errors).toEqual(["Error: deliberate semantic surface failure"]);
  expect(result.goodPopulated).toBe(true);
  expect(result.failedPopulated).toBe(false);
  expect(result.goodOwned).toBe(true);
  expect(result.failedOwned).toBe(false);
  expect(result.goodPaint).toBe("visible");
  expect(result.failedPaint).toBe("visible");
});

test("materializer failure does not poison an independent retained projection", async () => {
  await mount(page, "glass", 1, false, false, true);
  for (const id of ["lower", "image-b"])
    await page
      .locator('[data-element-id="' + id + '"] img')
      .first()
      .evaluate(async (image: HTMLImageElement) => image.decode());
  await enableScene(page);

  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const planPath = "/src/components/compositionPlan.ts";
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const plan = compileCompositionPlan(slide, w.model.deck);
    const lowerOnly = plan.surface({
      kind: "element-entry",
      elementId: "mixed-rectangle",
    })!;
    const withRectangle = plan.surface({
      kind: "element-entry",
      elementId: "mixed-shader",
    })!;
    const materializer = w.compositor!.materializer;
    const request = (surface: typeof lowerOnly) => ({
      surface,
      region: { x: 0, y: 0, width: 200, height: 160 },
      density: { x: 1, y: 1 },
    });
    const first = await materializer.materialize(request(lowerOnly));
    w.native.host
      .querySelector<HTMLElement>('[data-element-id="mixed-rectangle"]')!
      .remove();
    await Promise.resolve();

    let failure = "";
    try {
      await materializer.materialize(request(withRectangle));
    } catch (error) {
      failure = String(error);
    }
    const again = await materializer.materialize(request(lowerOnly));
    return {
      failure,
      sameRevision: first.revision === again.revision,
      sameSource:
        first.source.kind === "canvas-image" &&
        again.source.kind === "canvas-image" &&
        first.source.value === again.source.value,
    };
  });

  expect(result.failure).toContain("not fully mounted");
  expect(result.sameRevision).toBe(true);
  expect(result.sameSource).toBe(true);
});

test("source changes commit one coherent frame without an async bitmap gap", async () => {
  await mount(page, "glass", 1, false, true);
  await page
    .locator('[data-element-id="lower"] img')
    .evaluate(async (image: HTMLImageElement) => image.decode());
  await enableScene(page);
  await setAlpha(page, "glass", 0.5);
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).compositor!.flush(),
  );

  const transition = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow & {
      pendingPublication?: Promise<boolean>;
      releasePublication?: () => void;
      originalCreateImageBitmap?: typeof createImageBitmap;
      bitmapCalls?: number;
    };
    const compositor = w.compositor!;
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const output = root.querySelector<HTMLCanvasElement>(
      '[data-backdrop-restore="glass"] canvas',
    )!;
    const lower = root.querySelector<HTMLElement>('[data-element-id="lower"]')!;
    const revision = () =>
      Math.max(...Object.values(compositor.diagnostics().prefixes.revisions));
    const before = {
      pixels: output.toDataURL(),
      revision: revision(),
    };

    const original = window.createImageBitmap.bind(window);
    w.originalCreateImageBitmap = original;
    w.bitmapCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.releasePublication = release;
    window.createImageBitmap = (async (
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      w.bitmapCalls = (w.bitmapCalls ?? 0) + 1;
      await held;
      return original(...args);
    }) as typeof createImageBitmap;

    lower.style.transform = "translateX(96px)";
    await Promise.resolve();
    w.pendingPublication = compositor.flush();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    return {
      before,
      current: {
        pixels: output.toDataURL(),
        revision: revision(),
      },
      bitmapCalls: w.bitmapCalls,
    };
  });

  // Force a painted boundary while the legacy async bitmap primitive is held.
  // The corrected Canvas2D publication path must not depend on it.
  const faded = await image(page);
  await setAlpha(page, "glass", 1);
  const full = await image(page);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.visibility = "hidden";
    });
  const backdrop = await image(page);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.visibility = "";
    });
  await setAlpha(page, "glass", 0.5);

  const cleanup = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow & {
      pendingPublication?: Promise<boolean>;
      releasePublication?: () => void;
      originalCreateImageBitmap?: typeof createImageBitmap;
      bitmapCalls?: number;
    };
    w.releasePublication?.();
    await w.pendingPublication;
    await w.compositor!.flush();
    if (w.originalCreateImageBitmap)
      window.createImageBitmap = w.originalCreateImageBitmap;
    return { bitmapCalls: w.bitmapCalls ?? 0 };
  });

  expect(transition.bitmapCalls).toBe(0);
  expect(cleanup.bitmapCalls).toBe(0);
  expect(transition.current.revision).toBeGreaterThan(
    transition.before.revision,
  );
  expect(transition.current.pixels).not.toBe(transition.before.pixels);

  let max = 0;
  let sum = 0;
  for (let i = 0; i < faded.length; i++) {
    const error = Math.abs(faded[i] - (full[i] + backdrop[i]) * 0.5);
    max = Math.max(max, error);
    sum += error;
  }
  expect(sum / faded.length).toBeLessThan(0.2);
  expect(max).toBeLessThanOrEqual(3);
});

test("overlapping motion envelopes retain the existing backdrop lowering for three and ten cards", async () => {
  for (const count of [3, 10]) {
    await mount(page, "glass", count);
    const eligible = await page.evaluate(async () => {
      const w = window as unknown as ProbeWindow;
      const scenePath = "/src/components/compositionBackendPlan.ts",
        planPath = "/src/components/compositionPlan.ts";
      const {
        planCompositionBackends,
      }: typeof import("../../../src/components/compositionBackendPlan") =
        await import(/* @vite-ignore */ scenePath);
      const {
        compileCompositionPlan,
      }: typeof import("../../../src/components/compositionPlan") =
        await import(/* @vite-ignore */ planPath);
      const slide = w.model.slides[w.model.deck.slideIds[0]];
      return !!planCompositionBackends(
        compileCompositionPlan(slide, w.model.deck),
        slide,
        w.model.deck,
        { restoration: true, padding: 2 },
      ).restoration;
    });
    expect(eligible).toBe(false);
    await expect(page.locator("[data-backdrop-restore]")).toHaveCount(0);
  }
});

test("backend selection is regional for bounded unrelated paint and overlapping consumers", async () => {
  await mount(page, "glass", 3, true);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const plannerPath = "/src/components/compositionBackendPlan.ts",
      planPath = "/src/components/compositionPlan.ts",
      factoryPath = "/src/core/elementFactory.ts";
    const {
      planCompositionBackends,
    }: typeof import("../../../src/components/compositionBackendPlan") =
      await import(/* @vite-ignore */ plannerPath);
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const {
      createBasicShape,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const unrelated = createBasicShape("unrelated", "rectangle", {
      x: 500,
      y: 260,
    });
    unrelated.frame.width = 80;
    unrelated.frame.height = 60;
    unrelated.clipChildren = true;
    unrelated.content = {
      type: "image",
      assetId: "missing",
      filename: "missing.png",
      mediaType: "image",
      lockAspect: true,
      opacity: 1,
      transform: {
        rule: "fit",
        intrinsicWidth: 80,
        intrinsicHeight: 60,
        anchorX: 0.5,
        anchorY: 0.5,
        rotation: 0,
        flipX: false,
        flipY: false,
      },
    };
    slide.nodes[0].children.push(unrelated);
    const select = () =>
      planCompositionBackends(
        compileCompositionPlan(slide, w.model.deck),
        slide,
        w.model.deck,
        { restoration: true, padding: 2 },
      );
    const before = [...select().restoration!.glass];
    // Ordinary motion elsewhere has a bounded sweep and is not a global veto.
    slide.motion = {
      stages: [
        {
          id: "stage",
          blocks: [],
          tracks: [
            {
              id: "move",
              elementId: "unrelated",
              property: "transform.x",
              keyframes: [
                {
                  id: "a",
                  at: 0,
                  value: { type: "absolute", value: 480 },
                  easeToNext: [0, 0, 1, 1],
                },
                { id: "b", at: 1000, value: { type: "absolute", value: 500 } },
              ],
            },
          ],
        },
      ],
    };
    const moved = [...select().restoration!.glass];
    const overlap = createBasicShape("overlap", "rectangle", { x: 25, y: 25 });
    overlap.frame.width = 20;
    overlap.frame.height = 20;
    slide.nodes[0].children.push(overlap);
    const after = select();
    return {
      before,
      moved,
      after: [...after.restoration!.glass],
      route: after.routes.get("glass"),
    };
  });
  expect(result.before).toEqual(["glass", "glass-1", "glass-2"]);
  expect(result.moved).toEqual(result.before);
  // Later paint is outside the semantic prefix and cannot affect this glass.
  expect(result.after).toEqual(["glass", "glass-1", "glass-2"]);
  expect(result.route).toBe("backdrop-restoration");
});

test("browser-native CSS glass bypasses compositor materialization during ordinary Motion", async () => {
  await mount(page, "browser-native", 1, false, true);
  await page
    .locator('[data-element-id="lower"] img')
    .evaluate(async (image: HTMLImageElement) => image.decode());
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    await w.native.setMotion({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 1000,
    });
    await w.native.advance(0.37);
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const glass = root.querySelector<HTMLElement>('[data-element-id="glass"]')!;
    const effect = glass.querySelector<HTMLElement>("[data-effect-id]")!;
    const foreground = root.querySelector<HTMLElement>(
      '[data-element-id="foreground"]',
    )!;
    return {
      backend: root.dataset.compositionBackend ?? null,
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      splitVisual: root.querySelectorAll("[data-composition-visual]").length,
      effectCanvas: effect.querySelectorAll(":scope > canvas").length,
      backdrop: getComputedStyle(effect).backdropFilter,
      opacity: Number(glass.style.opacity),
      transform: getComputedStyle(glass).transform,
      text: glass.textContent,
      foregroundAfter: Boolean(
        glass.compareDocumentPosition(foreground) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      captures: w.native.inspect().diagnostics.captures,
    };
  });
  expect(result.backend).toBeNull();
  expect(result.restoration).toBe(0);
  expect(result.replay).toBe(0);
  expect(result.splitVisual).toBe(0);
  expect(result.effectCanvas).toBe(0);
  expect(result.backdrop).not.toBe("none");
  expect(result.opacity).toBeGreaterThan(0.25);
  expect(result.opacity).toBeLessThan(0.9);
  expect(result.transform).not.toBe("none");
  expect(result.text).toContain("Native CSS glass");
  expect(result.foregroundAfter).toBe(true);
  expect(result.captures).toBe(0);
});

test("Move Scale Rotate and Fade stay on the mounted DOM hot path", async () => {
  await mount(page, "browser-native", 1, false, true);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const glass = root.querySelector<HTMLElement>('[data-element-id="glass"]')!;
    const effect = glass.querySelector<HTMLElement>("[data-effect-id]")!;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((next) => records.push(...next));
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    const runtime = createMotionRuntime(root, slide, 0);
    runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 0,
      running: false,
      startedAt: 0,
    });
    const start = {
      transform: getComputedStyle(glass).transform,
      opacity: Number(glass.style.opacity),
    };
    runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    const middle = {
      transform: getComputedStyle(glass).transform,
      opacity: Number(glass.style.opacity),
      sameNode:
        glass ===
          root.querySelector<HTMLElement>('[data-element-id="glass"]') &&
        effect === glass.querySelector<HTMLElement>("[data-effect-id]"),
    };
    runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 900,
      running: false,
      startedAt: 0,
    });
    await Promise.resolve();
    records.push(...observer.takeRecords());
    observer.disconnect();
    const childList = records.filter(
      (record) => record.type === "childList",
    ).length;
    const attributes = records.filter(
      (record) => record.type === "attributes",
    ).length;
    runtime.cancel();
    return {
      start,
      middle,
      childList,
      attributes,
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      restored: {
        opacity: glass.style.opacity,
        absent: glass.dataset.presentationAbsent,
      },
    };
  });
  expect(result.middle.sameNode).toBe(true);
  expect(result.middle.transform).not.toBe(result.start.transform);
  expect(result.middle.opacity).toBeGreaterThan(result.start.opacity);
  expect(result.childList).toBe(0);
  expect(result.attributes).toBeGreaterThan(0);
  expect(result.restoration).toBe(0);
  expect(result.replay).toBe(0);
  expect(result.restored.absent).toBeUndefined();
});

test("restoration consumes ordinary opacity samples without reading animated DOM values", async () => {
  await mount(page, "glass");
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.motion = {
      stages: [
        {
          id: "stage",
          blocks: [],
          tracks: [
            {
              id: "fade",
              elementId: "glass",
              property: "appearance.opacity",
              keyframes: [
                {
                  id: "start",
                  at: 0,
                  value: { type: "absolute", value: 0 },
                  easeToNext: [0, 0, 1, 1],
                },
                { id: "end", at: 1000, value: { type: "absolute", value: 1 } },
              ],
            },
          ],
        },
      ],
    };
  });
  await enableScene(page);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const path = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ path
    );
    const slide = {
      ...w.model.slides[w.model.deck.slideIds[0]],
      motion: w.motion,
    };
    const runtime = createMotionRuntime(
      w.native.host,
      slide,
      0,
      undefined,
      w.compositor,
    );
    runtime.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 250,
      running: false,
      startedAt: 0,
    });
    const node = w.native.host.querySelector<HTMLElement>(
      '[data-element-id="glass"]',
    )!;
    const overlay = node.nextElementSibling as HTMLElement;
    const sampled = {
      nativeOpacity: node.style.opacity,
      restoration: Number(overlay.style.opacity),
    };
    const computed = window.getComputedStyle;
    window.getComputedStyle = () => {
      throw new Error("Compositor read animated DOM");
    };
    try {
      w.compositor!.apply([
        {
          elementId: "glass",
          frame: slide.nodes[0].children[1].frame,
          opacity: 0.6,
          present: true,
        },
      ]);
    } finally {
      window.getComputedStyle = computed;
    }
    const direct = Number(overlay.style.opacity);
    runtime.cancel();
    return {
      sampled,
      direct,
      cancelled: {
        opacity: node.style.opacity,
        restoration: Number(overlay.style.opacity),
      },
    };
  });
  expect(result.sampled).toEqual({ nativeOpacity: "1", restoration: 0.75 });
  expect(result.direct).toBeCloseTo(0.4, 5);
  expect(result.cancelled).toEqual({ opacity: "1", restoration: 0 });
});

test("Presence enter and exit keeps the native CSS subtree mounted", async () => {
  await mount(page, "browser-native", 1, false, true);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const glass = root.querySelector<HTMLElement>('[data-element-id="glass"]')!;
    const effect = glass.querySelector<HTMLElement>("[data-effect-id]")!;
    const runtime = createMotionRuntime(root, slide, 0);
    const sample = (time: number) => {
      runtime.sync({
        stageId: "stage",
        stageIndex: 0,
        time,
        running: false,
        startedAt: 0,
      });
      return {
        absent: glass.dataset.presentationAbsent,
        visibility: glass.style.visibility,
        contentVisibility: glass.style.contentVisibility,
        pointerEvents: glass.style.pointerEvents,
        inert: glass.inert,
        opacity: Number(glass.style.opacity),
        sameEffect: effect === glass.querySelector("[data-effect-id]"),
      };
    };
    const entering = sample(100);
    const present = sample(800);
    const exiting = sample(1200);
    const absent = sample(1300);
    runtime.cancel();
    return {
      entering,
      present,
      exiting,
      absent,
      restored: {
        visibility: glass.style.visibility,
        contentVisibility: glass.style.contentVisibility,
        inert: glass.inert,
        absent: glass.dataset.presentationAbsent,
      },
      customOutputs:
        root.querySelectorAll("[data-backdrop-restore], [data-css-backdrop]")
          .length,
    };
  });
  expect(result.entering.absent).toBe("false");
  expect(result.entering.sameEffect).toBe(true);
  expect(result.present.absent).toBe("false");
  expect(result.exiting.absent).toBe("false");
  expect(result.exiting.opacity).toBeLessThan(result.present.opacity);
  expect(result.absent).toMatchObject({
    absent: "true",
    visibility: "hidden",
    contentVisibility: "hidden",
    pointerEvents: "none",
    inert: true,
    sameEffect: true,
  });
  expect(result.restored).toEqual({
    visibility: "",
    contentVisibility: "",
    inert: false,
    absent: undefined,
  });
  expect(result.customOutputs).toBe(0);
});

test("later foreground content and group alpha keep Chromium CSS semantics", async () => {
  await mount(page, "browser-native", 1, false, true);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    await w.native.setMotion({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const glass = root.querySelector<HTMLElement>('[data-element-id="glass"]')!;
    const effect = glass.querySelector<HTMLElement>("[data-effect-id]")!;
    const foreground = root.querySelector<HTMLElement>(
      '[data-element-id="foreground"]',
    )!;
    glass.style.opacity = "0.5";
    await w.native.advance(0.37);
    return {
      opacity: Number(getComputedStyle(glass).opacity),
      backdrop: getComputedStyle(effect).backdropFilter,
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      splitVisual: root.querySelectorAll("[data-composition-visual]").length,
      foregroundAfter: Boolean(
        glass.compareDocumentPosition(foreground) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(result.opacity).toBeCloseTo(0.5);
  expect(result.backdrop).not.toBe("none");
  expect(result.restoration).toBe(0);
  expect(result.replay).toBe(0);
  expect(result.splitVisual).toBe(0);
  expect(result.foregroundAfter).toBe(true);
});

test("generated shader layers remain operational beside browser-native CSS", async () => {
  await mount(page, "native");
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    await w.native.advance(0.37);
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const generated = root.querySelector<HTMLElement>(
      '[data-element-id="lower"] [data-effect-id]',
    )!;
    const canvas = generated.querySelector<HTMLCanvasElement>(":scope > canvas")!;
    const css = root.querySelector<HTMLElement>(
      '[data-element-id="glass"] [data-effect-id]',
    )!;
    return {
      generatedReady: generated.dataset.effectReady,
      shaderWidth: canvas.width,
      shaderHeight: canvas.height,
      cssCanvas: css.querySelectorAll(":scope > canvas").length,
      backdrop: getComputedStyle(css).backdropFilter,
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      errors: w.native.inspect().errors,
    };
  });
  expect(result.generatedReady).toBe("true");
  expect(result.shaderWidth).toBeGreaterThan(1);
  expect(result.shaderHeight).toBeGreaterThan(1);
  expect(result.cssCanvas).toBe(0);
  expect(result.backdrop).not.toBe("none");
  expect(result.restoration).toBe(0);
  expect(result.replay).toBe(0);
  expect(result.errors).toEqual([]);
});

