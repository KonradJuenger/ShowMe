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
  presentation = false,
) {
  await page.goto(
    `http://127.0.0.1:${port}/tests/helpers/effects-harness.html`,
  );
  const options = {
    mode,
    count,
    disjoint,
    imageBackground,
    mixedPrefix,
    presentation,
  };
  await page.evaluate(async (options) => {
    const {
      mode,
      count,
      disjoint,
      imageBackground,
      mixedPrefix,
      presentation,
    } = options;
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
        liveMedia: presentation,
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
          if (mode === "glass" || mode === "browser-native")
            glass.clipChildren = true;
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
            const underlay = createBasicShape(
              "translucent-underlay",
              "rectangle",
              {
                x: 36,
                y: 42,
              },
            );
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
            slide.nodes[0].children = [...sources, underlay, glass, foreground];
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
          if (mode !== "parent" && mode !== "browser-native")
            delete slide.motion;
        },
      },
    );
  }, options);
}

test("browser-native CSS glass bypasses compositor materialization during ordinary Motion", async () => {
  for (const presentation of [false, true]) {
    await mount(page, "browser-native", 1, false, true, false, presentation);
    await page
      .locator('[data-element-id="lower"] img')
      .evaluate(async (image: HTMLImageElement) => image.decode());
    const result = await page.evaluate(async () => {
      const runtimePath = "/src/components/effectRuntime.ts";
      const {
        effectSourceTextureBytes,
      }: typeof import("../../../src/components/effectRuntime") = await import(
        /* @vite-ignore */ runtimePath
      );
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
      const glass = root.querySelector<HTMLElement>(
        '[data-element-id="glass"]',
      )!;
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
        opacity: Number(getComputedStyle(effect).opacity),
        transform: getComputedStyle(glass).transform,
        text: glass.textContent,
        foregroundAfter: Boolean(
          glass.compareDocumentPosition(foreground) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        captures: w.native.inspect().diagnostics.captures,
        sceneTextureBytes: effectSourceTextureBytes(),
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
    expect(result.sceneTextureBytes).toBe(0);
  }
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
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
    });
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
      opacity: Number(getComputedStyle(effect).opacity),
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
      opacity: Number(getComputedStyle(effect).opacity),
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
        opacity: Number(getComputedStyle(effect).opacity),
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
      customOutputs: root.querySelectorAll(
        "[data-backdrop-restore], [data-css-backdrop]",
      ).length,
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
    const runtimePath = "/src/components/effectRuntime.ts";
    const {
      effectSourceTextureBytes,
    }: typeof import("../../../src/components/effectRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const w = window as unknown as ProbeWindow;
    await w.native.advance(0.37);
    const root = w.native.host.querySelector<HTMLElement>(".slide-renderer")!;
    const generated = root.querySelector<HTMLElement>(
      '[data-element-id="lower"] [data-effect-id]',
    )!;
    const canvas =
      generated.querySelector<HTMLCanvasElement>(":scope > canvas")!;
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
      sceneTextureBytes: effectSourceTextureBytes(),
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
  expect(result.sceneTextureBytes).toBe(0);
  expect(result.errors).toEqual([]);
});
