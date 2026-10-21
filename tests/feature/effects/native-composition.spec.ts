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
  sceneErrors?: string[];
};

async function mount(
  page: Page,
  mode: "native" | "parent" | "rounded" | "fill" | "glass" = "native",
  count = 1,
  disjoint = false,
) {
  await page.goto(
    `http://127.0.0.1:${port}/tests/helpers/effects-harness.html`,
  );
  const options = { mode, count, disjoint };
  await page.evaluate(async (options) => {
    const { mode, count, disjoint } = options;
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      factoryPath = "/src/core/elementFactory.ts",
      authoringPath = "/src/core/effectAuthoring.ts",
      effectsPath = "/src/core/effects.ts";
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
            source:
              "#version 300 es\nprecision highp float;uniform float u_t;in vec2 v_uv;out vec4 outColor;void main(){float c=step(.5,fract(v_uv.x*32.+u_t));outColor=vec4(vec3(c),1.);}",
          };
          const css = {
            ...blankEffect("css-js"),
            source:
              ":scope { backdrop-filter: blur(12px); background: #ffffff22; }",
          };
          if (mode === "glass")
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
          const glass = createBasicShape("glass", "rectangle", {
            x: 80,
            y: 70,
          });
          glass.frame.width = 300;
          glass.frame.height = 200;
          glass.appearance.fill =
            mode === "fill" || mode === "glass" ? "#ffffff22" : "";
          glass.appearance.radius =
            mode === "glass" ? 28 : mode === "rounded" ? 18 : 0;
          if (mode === "glass") glass.clipChildren = true;
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
          const group = createBasicShape("group", "rectangle", {
            x: 0,
            y: 0,
          });
          group.appearance.fill = "";
          group.frame.width = 640;
          group.frame.height = 360;
          group.children = [glass];
          slide.nodes[0].children =
            mode === "parent" ? [lower, group] : [lower, glass];
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
          if (disjoint)
            slide.nodes[0].children.slice(1).forEach((card, index) => {
              card.frame.x = 20 + (index % 5) * 124;
              card.frame.y = 20 + Math.floor(index / 5) * 154;
              card.frame.width = 100;
              card.frame.height = 120;
            });
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
          (window as unknown as ProbeWindow).motion = slide.motion;
          // The diagnostic owns exact Motion samples. Do not also start the
          // harness hook's separate Presence sampler for the same element.
          if (mode !== "parent") delete slide.motion;
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

async function enableScene(page: Page) {
  await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const scenePath = "/src/components/sceneBackdrop.ts",
      planPath = "/src/components/compositionPlan.ts";
    const {
      sceneBackdropPlan,
      mountSceneBackdrop,
    }: typeof import("../../../src/components/sceneBackdrop") = await import(
      /* @vite-ignore */ scenePath
    );
    const {
      compileCompositionPlan,
    }: typeof import("../../../src/components/compositionPlan") = await import(
      /* @vite-ignore */ planPath
    );
    const slide = w.model.slides[w.model.deck.slideIds[0]];
    const plan = sceneBackdropPlan(
      compileCompositionPlan(slide, w.model.deck),
      slide,
      w.model.deck,
    );
    if (!plan) throw new Error("Real glass style was not admitted");
    for (const id of plan.glass) {
      const node = [
        ...w.native.host.querySelectorAll<HTMLElement>("[data-element-id]"),
      ].find((n) => n.dataset.elementId === id)!;
      const visual = document.createElement("div");
      visual.dataset.compositionAlpha = "true";
      visual.style.cssText = "display:none;opacity:1;";
      node.append(visual);
      node.style.opacity = "1";
    }
    w.sceneErrors = [];
    w.disposeScene = mountSceneBackdrop(
      w.native.host.querySelector<HTMLElement>(".slide-renderer")!,
      plan,
      w.model.deck,
      (error) => w.sceneErrors!.push(String(error)),
    );
    await w.native.advance(0.37);
  });
}

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
  await page
    .locator('[data-element-id="glass"] [data-composition-alpha]')
    .evaluate((node: HTMLElement) => (node.style.opacity = "1"));
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
    await page
      .locator("[data-composition-alpha]")
      .evaluateAll((nodes) =>
        nodes.forEach((node) => ((node as HTMLElement).style.opacity = ".5")),
      );
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).native.advance(0.37),
    );
    const faded = await image(page);
    await page
      .locator("[data-composition-alpha]")
      .last()
      .evaluate((node: HTMLElement) => (node.style.opacity = "1"));
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

test("overlapping motion envelopes retain the existing backdrop lowering for three and ten cards", async () => {
  for (const count of [3, 10]) {
    await mount(page, "glass", count);
    const eligible = await page.evaluate(async () => {
      const w = window as unknown as ProbeWindow;
      const scenePath = "/src/components/sceneBackdrop.ts",
        planPath = "/src/components/compositionPlan.ts";
      const {
        sceneBackdropPlan,
      }: typeof import("../../../src/components/sceneBackdrop") = await import(
        /* @vite-ignore */ scenePath
      );
      const {
        compileCompositionPlan,
      }: typeof import("../../../src/components/compositionPlan") =
        await import(/* @vite-ignore */ planPath);
      const slide = w.model.slides[w.model.deck.slideIds[0]];
      return !!sceneBackdropPlan(
        compileCompositionPlan(slide, w.model.deck),
        slide,
        w.model.deck,
      );
    });
    expect(eligible).toBe(false);
    await expect(page.locator("[data-backdrop-restore]")).toHaveCount(0);
  }
});

test("eligible native groups preserve resolved pixels through actual Move In without prefix replay", async () => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const h = (window as unknown as ProbeWindow).native;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const slide = h.host.querySelector(".slide-renderer")!;
    const model = (window as unknown as ProbeWindow).model;
    const s = {
      ...model.slides[model.deck.slideIds[0]],
      motion: (window as unknown as ProbeWindow).motion,
    };
    const rt = createMotionRuntime(slide as HTMLElement, s, 0);
    (window as unknown as ProbeWindow).runtime = rt;
    await rt.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    await h.advance(0.37);
    // Motion's clock delivery queues an Effect flush; settle that cohort before
    // freezing the shader for all three pixel observations.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await h.advance(0.37);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const node = slide.querySelector<HTMLElement>('[data-element-id="glass"]')!,
      visual = node.querySelector<HTMLElement>(
        ":scope > [data-composition-visual]",
      )!;
    return {
      alpha: Number(visual.style.opacity),
      transportAlpha: node.style.opacity,
      transform: node.style.transform,
      captures: h.inspect().diagnostics.captures,
      errors: h.inspect().errors,
    };
  });
  expect(result.alpha).toBeCloseTo(0.5);
  expect(result.transportAlpha).toBe("1");
  expect(result.transform).not.toBe("none");
  expect(result.errors).toEqual([]);
  const faded = await image(page);
  await page
    .locator("[data-composition-visual]")
    .evaluate((node: HTMLElement) => {
      node.style.opacity = "1";
    });
  const full = await image(page);
  await page
    .locator("[data-composition-visual]")
    .evaluate((visual: HTMLElement) => {
      visual.style.backdropFilter = "none";
      visual
        .querySelector<HTMLElement>("[data-effect-id]")!
        .style.removeProperty("backdrop-filter");
    });
  const reference = await image(page);
  let staticMax = 0;
  for (let i = 0; i < full.length; i++)
    staticMax = Math.max(staticMax, Math.abs(full[i] - reference[i]));
  expect(staticMax).toBeLessThanOrEqual(1);
  await page
    .locator("[data-composition-visual]")
    .evaluate((visual: HTMLElement) => {
      visual.style.backdropFilter = "blur(12px)";
      visual.querySelector<HTMLElement>(
        "[data-effect-id]",
      )!.style.backdropFilter = "none";
    });
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.visibility = "hidden";
    });
  const backdrop = await image(page);
  let max = 0,
    sum = 0;
  for (let i = 0; i < faded.length; i++) {
    const error = Math.abs(faded[i] - (full[i] + backdrop[i]) * 0.5);
    max = Math.max(max, error);
    sum += error;
  }
  expect(sum / faded.length).toBeLessThan(0.2);
  expect(max).toBeLessThanOrEqual(2);
  expect(result.captures).toBe(0);
  await expect(page.locator("[data-css-backdrop]")).toHaveCount(0);
  const restored = await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    w.runtime!.cancel();
    const owner = w.native.host.querySelector<HTMLElement>(
      '[data-element-id="glass"]',
    )!;
    return {
      alpha: owner.querySelector<HTMLElement>("[data-composition-visual]")!
        .style.opacity,
      transport: owner.style.opacity,
    };
  });
  expect(restored).toEqual({ alpha: "1", transport: "1" });
});

test("outer alpha, rounded clipping and intervening fill retain the correctness fallback", async () => {
  for (const mode of ["parent", "rounded", "fill"] as const) {
    await mount(page, mode);
    await expect(page.locator("[data-composition-visual]")).toHaveCount(0);
    const owner = mode === "parent" ? "group" : "glass";
    await page
      .locator(`[data-element-id="${owner}"]`)
      .evaluate((node: HTMLElement) => {
        node.style.opacity = ".5";
      });
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).native.advance(0.37),
    );
    await expect(page.locator("[data-css-backdrop]")).toBeVisible();
  }
});

test("ordinary opacity and move tracks share the split targets and restore both owners", async () => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const w = window as unknown as ProbeWindow;
    const runtimePath = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const slide = { ...w.model.slides[w.model.deck.slideIds[0]] };
    slide.motion = {
      stages: [
        {
          id: "stage",
          tracks: [
            {
              id: "move",
              elementId: "glass",
              property: "transform.x",
              keyframes: [
                {
                  id: "x0",
                  at: 0,
                  value: { type: "absolute", value: 80 },
                  easeToNext: [0, 0, 1, 1],
                },
                { id: "x1", at: 1000, value: { type: "absolute", value: 180 } },
              ],
            },
            {
              id: "fade",
              elementId: "glass",
              property: "appearance.opacity",
              keyframes: [
                {
                  id: "o0",
                  at: 0,
                  value: { type: "absolute", value: 0 },
                  easeToNext: [0, 0, 1, 1],
                },
                { id: "o1", at: 1000, value: { type: "absolute", value: 1 } },
              ],
            },
          ],
        },
      ],
    };
    const rt = createMotionRuntime(w.native.host, slide, 0);
    rt.sync({
      stageId: "stage",
      stageIndex: 0,
      time: 500,
      running: false,
      startedAt: 0,
    });
    const owner = w.native.host.querySelector<HTMLElement>(
        '[data-element-id="glass"]',
      )!,
      visual = owner.querySelector<HTMLElement>("[data-composition-visual]")!;
    const intermediate = {
      alpha: Number(visual.style.opacity),
      outer: owner.style.opacity,
      movement: new DOMMatrix(getComputedStyle(owner).transform).e,
    };
    rt.cancel();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return {
      intermediate,
      restored: { alpha: visual.style.opacity, outer: owner.style.opacity },
      replay: w.native.host.querySelectorAll("[data-css-backdrop]").length,
    };
  });
  expect(result.intermediate.alpha).toBeCloseTo(0.5);
  expect(result.intermediate.outer).toBe("1");
  expect(result.intermediate.movement).toBeCloseTo(50);
  expect(result.restored).toEqual({ alpha: "1", outer: "1" });
  expect(result.replay).toBe(0);
});
