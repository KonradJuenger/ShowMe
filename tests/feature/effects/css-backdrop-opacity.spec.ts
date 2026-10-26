import { expect, test, type Page } from "@playwright/test";
import type { PresentationDocument } from "../../../src/core/document";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";

type GlassWindow = Window & {
  glass: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
  glassModel: PresentationDocument;
};

async function mount(
  page: Page,
  grouped: boolean | "nested",
  lowerCss = false,
  consumer = false,
) {
  await page.goto("/tests/helpers/effects-harness.html");
  await page.evaluate(
    async ({ grouped, lowerCss, consumer }) => {
      const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
      const factoryPath = "/src/core/elementFactory.ts";
      const effectsPath = "/src/core/effects.ts";
      const authoringPath = "/src/core/effectAuthoring.ts";
      const textPath = "/src/core/text.ts";
      const { createTextElement } = await import(/* @vite-ignore */ textPath);
      const { mountMixedEffectsHarness } = await import(
        /* @vite-ignore */ harnessPath
      );
      const { createBasicShape } = await import(/* @vite-ignore */ factoryPath);
      const { newEffectInstance } = await import(
        /* @vite-ignore */ effectsPath
      );
      const { blankEffect } = await import(/* @vite-ignore */ authoringPath);
      (window as unknown as GlassWindow).glass = await mountMixedEffectsHarness(
        undefined,
        0,
        undefined,
        {
          configure(model: PresentationDocument) {
            (window as unknown as GlassWindow).glassModel = model;
            const slide = model.slides[model.deck.slideIds[0]];
            model.deck.stylesheet = "";
            const shader = {
              ...blankEffect("shader"),
              input: "none",
              target: "background",
              source:
                "#version 300 es\nprecision highp float; uniform float u_t; in vec2 v_uv; out vec4 outColor; void main(){ float s=step(0.5,fract(v_uv.x*32.0+u_t)); outColor=vec4(vec3(s),1.0); }",
            };
            const css = {
              ...blankEffect("css-js"),
              source:
                ":scope { backdrop-filter: blur(12px) saturate(1.25); background: linear-gradient(135deg, #ffffff66, #6699ff33); border-radius: 18px; border: 2px solid #ffffffaa; box-shadow: 0 6px 12px #00224444; }",
            };
            slide.effectResources = { shader, css };

            const lower = createBasicShape("lower", "rectangle", {
              x: 0,
              y: 0,
            });
            lower.frame.width = 640;
            lower.frame.height = 360;
            lower.effects = [newEffectInstance("shader", shader, "background")];
            if (lowerCss) {
              const tint = {
                ...blankEffect("css-js"),
                source: ":scope { background: rgba(40,80,220,0.15); }",
              };
              slide.effectResources.tint = tint;
              lower.effects.push(newEffectInstance("tint", tint, "background"));
            }

            const glass = createBasicShape("glass", "rectangle", {
              x: 80,
              y: 70,
            });
            glass.frame.width = 300;
            glass.frame.height = 200;
            glass.appearance.fill = "#ffffff22";
            glass.appearance.radius = 18;
            glass.clipChildren = true;
            glass.effects = [newEffectInstance("css", css, "content")];

            const a = createBasicShape("a", "rectangle", { x: 40, y: 40 });
            const b = createBasicShape("b", "rectangle", { x: 80, y: 80 });
            a.frame.width = b.frame.width = 120;
            a.frame.height = b.frame.height = 80;
            a.appearance.fill = "#ff000088";
            b.appearance.fill = "#00ff0088";
            glass.children = [a, b];

            if (grouped) {
              const group = createBasicShape("group", "rectangle", {
                x: 0,
                y: 0,
              });
              group.frame.width = 500;
              group.frame.height = 320;
              group.appearance.fill = "";
              group.children = [glass];
              if (grouped === "nested") {
                const outer = createBasicShape("outer", "rectangle", {
                  x: 0,
                  y: 0,
                });
                outer.frame.width = 640;
                outer.frame.height = 360;
                outer.appearance.fill = "";
                outer.children = [group];
                slide.nodes[0].children = [lower, outer];
              } else slide.nodes[0].children = [lower, group];
            } else slide.nodes[0].children = [lower, glass];

            if (consumer) {
              const caption = createTextElement("caption", { x: 20, y: 8 });
              caption.frame.width = 250;
              caption.frame.height = 35;
              if (
                caption.content?.type === "text" &&
                caption.content.format.kind === "local"
              ) {
                caption.content.text = "Sharp native text";
                caption.content.format.typography.fontSize = 26;
                caption.content.format.typography.color = "#000000";
              }
              glass.children.push(caption);

              const next = createBasicShape("next", "rectangle", {
                x: 280,
                y: 70,
              });
              next.frame.width = 180;
              next.frame.height = 200;
              next.appearance.fill = "";
              next.appearance.radius = 18;
              next.clipChildren = true;
              next.effects = [newEffectInstance("css", css, "content")];
              slide.nodes[0].children.push(next);
            }
          },
        },
      );
    },
    { grouped, lowerCss, consumer },
  );
}

async function nativeState(page: Page, id = "glass") {
  return page.locator(`[data-element-id="${id}"]`).evaluate((owner) => {
    const root = owner.closest(".slide-renderer")!;
    const effect = owner.querySelector<HTMLElement>("[data-effect-id]")!;
    return {
      backdrop: getComputedStyle(effect).backdropFilter,
      ownerOpacity: Number(getComputedStyle(owner).opacity),
      ownerTransform: getComputedStyle(owner).transform,
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      splitVisual: root.querySelectorAll("[data-composition-visual]").length,
      cssCanvas: effect.querySelectorAll(":scope > canvas").length,
      ready: effect.dataset.effectReady,
    };
  });
}

test("CSS glass is real Chromium backdrop-filter over an animated shader", async ({
  page,
}) => {
  await mount(page, false);
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const state = await nativeState(page);
  expect(state.backdrop).not.toBe("none");
  expect(state.restoration).toBe(0);
  expect(state.replay).toBe(0);
  expect(state.splitVisual).toBe(0);
  expect(state.cssCanvas).toBe(0);
  expect(state.ready).toBe("true");

  const shader = await page
    .locator('[data-element-id="lower"] [data-effect-id]')
    .evaluate((effect) => {
      const canvas =
        effect.querySelector<HTMLCanvasElement>(":scope > canvas")!;
      return {
        ready: (effect as HTMLElement).dataset.effectReady,
        width: canvas.width,
        height: canvas.height,
      };
    });
  expect(shader.ready).toBe("true");
  expect(shader.width).toBeGreaterThan(1);
  expect(shader.height).toBeGreaterThan(1);
});

test("parent-group opacity uses Chromium group compositing without reconstruction", async ({
  page,
}) => {
  await mount(page, true);
  await page.locator('[data-element-id="group"]').evaluate((node) => {
    (node as HTMLElement).style.opacity = "0.7";
    (node as HTMLElement).style.transform = "translateY(-20px)";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const group = await page
    .locator('[data-element-id="group"]')
    .evaluate((node) => ({
      opacity: Number(getComputedStyle(node).opacity),
      transform: getComputedStyle(node).transform,
    }));
  const state = await nativeState(page);
  expect(group.opacity).toBeCloseTo(0.7);
  expect(group.transform).not.toBe("none");
  expect(state.backdrop).not.toBe("none");
  expect(state.restoration).toBe(0);
  expect(state.replay).toBe(0);
});

test("nested group alpha remains browser-native at every enclosing level", async ({
  page,
}) => {
  await mount(page, "nested");
  await page.locator('[data-element-id="group"]').evaluate((node) => {
    (node as HTMLElement).style.opacity = "0.6";
  });
  await page.locator('[data-element-id="outer"]').evaluate((node) => {
    (node as HTMLElement).style.opacity = "0.4";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const alphas = await page.evaluate(() => ({
    group: Number(
      getComputedStyle(document.querySelector('[data-element-id="group"]')!)
        .opacity,
    ),
    outer: Number(
      getComputedStyle(document.querySelector('[data-element-id="outer"]')!)
        .opacity,
    ),
  }));
  expect(alphas).toEqual({ group: 0.6, outer: 0.4 });
  const state = await nativeState(page);
  expect(state.backdrop).not.toBe("none");
  expect(state.restoration).toBe(0);
  expect(state.replay).toBe(0);
});

test("production Move In keeps transport opaque and fades the native glass material", async ({
  page,
}) => {
  await mount(page, false);
  const result = await page.evaluate(async () => {
    const w = window as unknown as GlassWindow;
    const slide = w.glassModel.slides[w.glassModel.deck.slideIds[0]];
    slide.motion = {
      stages: [
        {
          id: "entrance",
          tracks: [],
          blocks: [
            {
              id: "glass-presence",
              label: "Presence",
              members: [],
              binding: { kind: "presence", elementId: "glass" },
              presenceSchedule: {
                version: 1,
                startOffsetMs: 80,
                end: { mode: "slide-end" },
                enterTransition: {
                  kind: "move",
                  durationMs: 800,
                  easing: [0, 0, 1, 1],
                  direction: "Up",
                  distance: 36,
                },
                exitTransition: {
                  kind: "none",
                  durationMs: 400,
                  easing: [0, 0, 1, 1],
                },
              },
            },
          ],
        },
      ],
    };
    const path = "/src/components/motionRuntime.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ path
    );
    const root = w.glass.host.querySelector<HTMLElement>(".slide-renderer")!;
    const glass = root.querySelector<HTMLElement>('[data-element-id="glass"]')!;
    const effect = glass.querySelector<HTMLElement>("[data-effect-id]")!;
    const runtime = createMotionRuntime(root, slide, 0);
    runtime.sync({
      stageId: "entrance",
      stageIndex: 0,
      time: 480,
      startedAt: Date.now(),
      running: false,
    });
    await w.glass.advance(0.48);
    const value = {
      opacity: Number(getComputedStyle(effect).opacity),
      transportOpacity: Number(getComputedStyle(glass).opacity),
      transform: glass.style.transform,
      sameEffect: effect === glass.querySelector("[data-effect-id]"),
      restoration: root.querySelectorAll("[data-backdrop-restore]").length,
      replay: root.querySelectorAll("[data-css-backdrop]").length,
      backdrop: getComputedStyle(effect).backdropFilter,
    };
    runtime.cancel();
    return value;
  });
  expect(result.opacity).toBeCloseTo(0.5);
  expect(result.transportOpacity).toBe(1);
  expect(result.transform).toContain("-18px");
  expect(result.sameEffect).toBe(true);
  expect(result.restoration).toBe(0);
  expect(result.replay).toBe(0);
  expect(result.backdrop).not.toBe("none");
});

test("external stylesheet changes do not cause CSS backdrop raster replay", async ({
  page,
}) => {
  await mount(page, false);
  await page.evaluate(() => {
    const h = (window as unknown as GlassWindow).glass;
    const css = '[data-element-id="lower"] { filter: contrast(0.6); }';
    h.setStylesheet(css);
    const style = document.createElement("style");
    style.textContent = css;
    h.host.querySelector(".slide-renderer")!.append(style);
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const state = await nativeState(page);
  expect(state.backdrop).not.toBe("none");
  expect(state.restoration).toBe(0);
  expect(state.replay).toBe(0);
  expect(state.cssCanvas).toBe(0);
});

test("source transforms and opacity remain independent from native glass paint", async ({
  page,
}) => {
  await mount(page, false, true);
  await page.locator('[data-element-id="lower"]').evaluate((node) => {
    const element = node as HTMLElement;
    element.style.transform = "translateX(13px)";
    element.style.opacity = "0.65";
  });
  await page.locator('[data-element-id="glass"]').evaluate((node) => {
    const element = node as HTMLElement;
    element.style.transform = "translateY(-10px)";
    element.style.opacity = "0.5";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const state = await nativeState(page);
  const stable = await page
    .locator('[data-element-id="glass"] [data-effect-id]')
    .evaluate(
      (node) =>
        node ===
        document.querySelector('[data-element-id="glass"] [data-effect-id]'),
    );
  expect(stable).toBe(true);
  expect(state.ownerOpacity).toBeCloseTo(0.5);
  expect(state.ownerTransform).not.toBe("none");
  expect(state.backdrop).not.toBe("none");
  expect(state.restoration).toBe(0);
  expect(state.replay).toBe(0);
});

test("overlapping glass consumers stay independent native DOM effects", async ({
  page,
}) => {
  await mount(page, false, false, true);
  await page.locator('[data-element-id="glass"]').evaluate((node) => {
    (node as HTMLElement).style.opacity = "0.5";
  });
  await page.locator('[data-element-id="next"]').evaluate((node) => {
    (node as HTMLElement).style.opacity = "0.5";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );

  const first = await nativeState(page, "glass");
  const second = await nativeState(page, "next");
  expect(first.backdrop).not.toBe("none");
  expect(second.backdrop).not.toBe("none");
  expect(first.ownerOpacity).toBeCloseTo(0.5);
  expect(second.ownerOpacity).toBeCloseTo(0.5);
  expect(first.restoration).toBe(0);
  expect(first.replay).toBe(0);
  await expect(
    page.locator('[data-css-backdrop-backend="material"]'),
  ).toHaveCount(0);
  await expect(page.locator("[data-backdrop-restore]")).toHaveCount(0);
});
