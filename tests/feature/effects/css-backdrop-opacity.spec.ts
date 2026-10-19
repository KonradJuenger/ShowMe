import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import type { PresentationDocument } from "../../../src/core/document";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";

type GlassWindow = Window & {
  glass: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
  glassModel: PresentationDocument;
};

async function mount(
  page: Page,
  grouped: boolean,
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
              slide.nodes[0].children = [lower, group];
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

async function pixels(page: Page) {
  return sharp(await page.locator(".slide-renderer").screenshot())
    .removeAlpha()
    .raw()
    .toBuffer();
}

async function parity(
  page: Page,
  owner: string,
  time = 0,
  opacity = 0.5,
  offset = 0,
) {
  await page
    .locator(`[data-element-id="${owner}"]`)
    .evaluate((node: HTMLElement, offset) => {
      node.style.opacity = "1";
      node.style.transform = `translateY(${offset}px)`;
    }, offset);
  await page.evaluate(
    (time) => (window as unknown as GlassWindow).glass.advance(time),
    time,
  );
  const full = await pixels(page);
  await page
    .locator(`[data-element-id="${owner}"]`)
    .evaluate((node: HTMLElement) => {
      node.style.visibility = "hidden";
    });
  const backdrop = await pixels(page);
  await page
    .locator(`[data-element-id="${owner}"]`)
    .evaluate((node: HTMLElement, opacity) => {
      node.style.visibility = "";
      node.style.opacity = String(opacity);
    }, opacity);
  await page.evaluate(
    (time) => (window as unknown as GlassWindow).glass.advance(time),
    time,
  );
  const faded = await pixels(page);
  assertPixelComposition(faded, full, backdrop, opacity);
  expect(
    await page
      .locator(`[data-element-id="${owner}"]`)
      .evaluate((node: HTMLElement) => Number(node.style.opacity)),
  ).toBeCloseTo(opacity);
}

function assertPixelComposition(
  faded: Buffer,
  full: Buffer,
  backdrop: Buffer,
  opacity: number,
  bounds = { left: 60, top: 55, right: 400, bottom: 290 },
) {
  let error = 0,
    count = 0;
  // Compare the material, overlapping children, rounded edges and shadow against
  // resolve-glass-then-fade pixel composition, rather than computed CSS alone.
  for (let y = bounds.top; y < bounds.bottom; y++)
    for (let x = bounds.left; x < bounds.right; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * 640 + x) * 3 + c;
        error += Math.abs(
          faded[i] - (full[i] * opacity + backdrop[i] * (1 - opacity)),
        );
        count++;
      }
    }
  expect(error / count).toBeLessThan(2);
}

test("CSS glass resolves an animated shader before whole-element opacity", async ({
  page,
}) => {
  await mount(page, false);
  await parity(page, "glass");
  await expect(page.locator("[data-css-backdrop]")).toHaveAttribute(
    "data-css-backdrop-backend",
    "material",
  );
  await parity(page, "glass", 0.37, 0.99997, -20);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.opacity = "1";
    });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0),
  );
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as GlassWindow).glass.inspect(),
      )
    ).errors,
  ).toEqual([]);
});

test("CSS glass retains resolved pixels and overlapping children under parent-group fades", async ({
  page,
}) => {
  await mount(page, true);
  await parity(page, "group");
  await parity(page, "group", 0.37, 0.7, -20);
  expect(
    (
      await page.evaluate(() =>
        (window as unknown as GlassWindow).glass.inspect(),
      )
    ).unchanged,
  ).toBe(true);
});

test("production Move In presence keeps glass resolved while its transform and opacity are intermediate", async ({
  page,
}) => {
  await mount(page, false);
  await page.evaluate(async () => {
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
    const runtime = createMotionRuntime(w.glass.host, slide, 0);
    runtime.sync({
      stageId: "entrance",
      stageIndex: 0,
      time: 480,
      startedAt: Date.now(),
      running: false,
    });
    await w.glass.advance(0.48);
  });
  await expect(page.locator("[data-css-backdrop]")).toBeVisible();
  const card = page.locator('[data-element-id="glass"]');
  const alpha = await card.evaluate((node: HTMLElement) =>
    Number(node.style.opacity),
  );
  expect(alpha).toBeCloseTo(0.5);
  expect(
    await card.evaluate((node: HTMLElement) => node.style.transform),
  ).toContain("-18px");
  const faded = await pixels(page);
  await card.evaluate((node: HTMLElement) => {
    node.style.opacity = "1";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.48),
  );
  const full = await pixels(page);
  await card.evaluate((node: HTMLElement) => {
    node.style.visibility = "hidden";
  });
  const backdrop = await pixels(page);
  assertPixelComposition(faded, full, backdrop, alpha);
});

test("custom contributing CSS retains native backdrop pixels during a fade", async ({
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
  await parity(page, "glass");
  await expect(page.locator("[data-css-backdrop]")).toHaveAttribute(
    "data-css-backdrop-backend",
    "native",
  );
});

test("cached static CSS backdrop styles retain current shader, source transform and group opacity pixels", async ({
  page,
}) => {
  await mount(page, false, true);
  await parity(page, "glass");
  await page
    .locator('[data-element-id="lower"]')
    .evaluate((node: HTMLElement) => {
      node.style.transform = "translateX(13px)";
      node.style.opacity = "0.65";
    });
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.transform = "translateY(-10px)";
    });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const faded = await pixels(page);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.opacity = "1";
    });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const full = await pixels(page);
  await page
    .locator('[data-element-id="glass"]')
    .evaluate((node: HTMLElement) => {
      node.style.visibility = "hidden";
    });
  assertPixelComposition(faded, full, await pixels(page), 0.5);
});

test("overlapping glass consumers reuse resolved material pixels without refading their foreground", async ({
  page,
}) => {
  await mount(page, false, false, true);
  const card = page.locator('[data-element-id="glass"]');
  const next = page.locator('[data-element-id="next"]');
  const full = await pixels(page);
  await card.evaluate((node: HTMLElement) => {
    node.style.visibility = "hidden";
  });
  const backdrop = await pixels(page);
  await card.evaluate((node: HTMLElement) => {
    node.style.visibility = "";
    node.style.opacity = "0.5";
  });
  await next.evaluate((node: HTMLElement) => {
    node.style.opacity = "0.5";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0),
  );
  await expect(
    page.locator('[data-css-backdrop-backend="material"]'),
  ).toHaveCount(2);
  assertPixelComposition(await pixels(page), full, backdrop, 0.5, {
    left: 60,
    top: 55,
    right: 270,
    bottom: 290,
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const changed = await pixels(page);
  await next.evaluate((node: HTMLElement) => {
    node.style.opacity = "1";
  });
  await card.evaluate((node: HTMLElement) => {
    node.style.opacity = "1";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const changedFull = await pixels(page);
  await card.evaluate((node: HTMLElement) => {
    node.style.visibility = "hidden";
  });
  assertPixelComposition(changed, changedFull, await pixels(page), 0.5, {
    left: 60,
    top: 55,
    right: 270,
    bottom: 290,
  });
  await card.evaluate((node: HTMLElement) => {
    node.style.visibility = "";
    node.style.opacity = "0.5";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  const nextFull = await pixels(page);
  await next.evaluate((node: HTMLElement) => {
    node.style.visibility = "hidden";
  });
  const nextBackdrop = await pixels(page);
  await next.evaluate((node: HTMLElement) => {
    node.style.visibility = "";
    node.style.opacity = "0.5";
  });
  await page.evaluate(() =>
    (window as unknown as GlassWindow).glass.advance(0.37),
  );
  assertPixelComposition(await pixels(page), nextFull, nextBackdrop, 0.5, {
    left: 270,
    top: 55,
    right: 475,
    bottom: 290,
  });
});
