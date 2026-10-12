import { expect, test, type Page } from "@playwright/test";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";
type HarnessWindow = Window & {
  mixed: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
};
test.use({ deviceScaleFactor: 1.25 });

async function mount(page: Page) {
  await page.goto("/tests/helpers/effects-harness.html");
  await page.evaluate(async () => {
    const path = "/tests/helpers/mixedEffectsHarness.tsx";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ path
    );
    (window as unknown as HarnessWindow).mixed =
      await mountMixedEffectsHarness();
  });
}
test("JS text, CSS clipping and custom text shadows reach content and backdrop shaders without stale frames", async ({
  page,
}) => {
  await mount(page);
  const first = await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.stage(0, 0, 1),
  );
  const second = await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.stage(0.5, 1, 1),
  );
  expect(second).toMatchObject({
    unchanged: true,
    errors: [],
    text: ["SECOND"],
  });
  expect(second.surfaces.every((surface) => surface.ready === "true")).toBe(
    true,
  );
  expect(second.surfaces[0].green).toBeGreaterThan(first.surfaces[0].green);
  expect(second.surfaces[1].green).toBeGreaterThan(first.surfaces[1].green);
  expect(second.surfaces[0].red).toBeGreaterThan(0); // Custom blue shadow becomes red in GLSL.
  const clipped = await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.stage(0.5, 1, 0),
  );
  expect(clipped.surfaces[0].opaque).toBe(0);
  expect(clipped.surfaces[1].green).toBe(0);
  const empty = await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.stage(0.6, 2, 1),
  );
  expect(empty.text).toEqual([""]);
  expect(empty.surfaces[0].opaque).toBe(0);
  expect(empty.surfaces[1].green).toBe(0);
  const restored = await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.stage(0.7, 1, 1),
  );
  expect(restored.surfaces[0].opaque).toBeGreaterThan(1000);
  await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.dispose(),
  );
});

test("paused mixed stacks reuse pixels and preserve live DOM identities through capture and teardown", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as HarnessWindow).mixed;
    const before = await harness.stage(0.5, 1, 1);
    for (let i = 0; i < 5; i++) await harness.advance(0.5, 1, 1);
    const after = harness.inspect();
    const effects = document.querySelectorAll("[data-effect-id]").length;
    const elements = document.querySelectorAll("[data-element-id]").length;
    const mirrors = document.querySelectorAll("[data-dom-raster]").length;
    harness.dispose();
    return {
      before,
      after,
      effects,
      elements,
      mirrors,
      remaining: document.querySelectorAll("[data-dom-raster]").length,
    };
  });
  expect(result.after.diagnostics.captures).toBe(
    result.before.diagnostics.captures,
  );
  expect(result.after.diagnostics.clones).toBe(
    result.before.diagnostics.clones,
  );
  expect(result.effects).toBe(4);
  expect(result.elements).toBe(2);
  expect(result.mirrors).toBe(2);
  expect(result.remaining).toBe(0);
});

test("custom CSS keyframes invalidate a static shader and retain their final rendered color", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (window as unknown as HarnessWindow).mixed.setStylesheet(`
      [data-text-content], [data-effect-text-output] { animation: mixed-color 0.12s linear forwards !important; }
      @keyframes mixed-color { from { color: rgb(255,0,0); } to { color: rgb(0,0,255); } }
    `);
  });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = (window as unknown as HarnessWindow).mixed.inspect();
        return state.surfaces[0].red > 1000 && state.surfaces[0].green === 0;
      }),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as unknown as HarnessWindow).mixed.dispose(),
  );
});

test("CSS keyframes attached to JS text sample the same ShowMe clock before shader capture", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const path = "/tests/helpers/mixedEffectsHarness.tsx";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ path
    );
    const harness = await mountMixedEffectsHarness(
      undefined,
      0,
      ":scope { animation: reveal 1s linear both; } @keyframes reveal { from { opacity: 0; } to { opacity: 1; } }",
    );
    const visible = await harness.stage(1, 1, 1);
    const hidden = await harness.stage(0, 1, 0);
    harness.dispose();
    return { visible, hidden };
  });
  expect(result.visible.surfaces[0].opaque).toBeGreaterThan(1000);
  expect(result.hidden.surfaces[0].opaque).toBe(0);
  expect(result.visible.errors).toEqual([]);
});

test("GPU shader handoff preserves channel order and alpha, recovers context loss and captures intervening CSS", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const runtimePath = "/src/components/effectRuntime.ts";
    const effectsPath = "/src/core/effects.ts";
    const outputPath = "/src/components/shaderOutput.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const runtime: typeof import("../../../src/components/effectRuntime") =
      await import(/* @vite-ignore */ runtimePath);
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const {
      shaderOutputTextureBytes,
    }: typeof import("../../../src/components/shaderOutput") = await import(
      /* @vite-ignore */ outputPath
    );
    const run = async (gpu: boolean, gap: boolean, lose: boolean) => {
      runtime.setGpuEffectChainingExperiment(gpu);
      const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
        configure(model) {
          const slide = model.slides[model.deck.slideIds[0]],
            text = slide.nodes[0].children[0];
          slide.nodes[0].children = [text];
          model.deck.stylesheet +=
            " [data-effect-text-output] { opacity: 0.5 !important; }";
          if (gap)
            text.effects!.push(
              newEffectInstance("css", slide.effectResources!.css, "content"),
            );
          const second = {
            ...slide.effectResources!.shader,
            source: slide.effectResources!.shader.source.replace(
              "vec4(c.b,c.r,c.g,c.a)",
              "vec4(c.b * 0.5,c.r,c.g,c.a)",
            ),
          };
          slide.effectResources!.second = second;
          text.effects!.push(newEffectInstance("second", second, "content"));
        },
      });
      const state = await harness.stage(0.5, 1, 1);
      const canvas = harness.host.querySelector<HTMLCanvasElement>(
        "[data-effect-id] > canvas",
      )!;
      const pixels = Array.from(
        canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
          .data,
      );
      let recovered = null;
      if (lose) {
        const gl = runtime.shaderProgram(
          "#version 300 es\nprecision highp float;out vec4 outColor;void main(){outColor=vec4(1.0);}",
        ).gl;
        gl.getExtension("WEBGL_lose_context")!.loseContext();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        recovered = await harness.stage(0.5, 1, 1);
      }
      harness.dispose();
      return {
        state,
        pixels,
        recovered,
        remaining: shaderOutputTextureBytes(),
      };
    };
    try {
      const native = await run(false, false, false),
        gpu = await run(true, false, true),
        css = await run(true, true, false);
      let maxDifference = 0;
      for (let i = 0; i < native.pixels.length; i++)
        maxDifference = Math.max(
          maxDifference,
          Math.abs(native.pixels[i] - gpu.pixels[i]),
        );
      return {
        native: native.state,
        gpu: gpu.state,
        recovered: gpu.recovered,
        css: css.state,
        maxDifference,
        remaining: css.remaining,
      };
    } finally {
      runtime.setGpuEffectChainingExperiment(false);
    }
  });
  expect(result.gpu.surfaces[0].backend).toBe("gpu");
  expect(result.gpu.surfaces[0].blue).toBeGreaterThan(1000);
  expect(result.maxDifference).toBeLessThanOrEqual(1);
  expect(result.recovered?.errors).toEqual([]);
  expect(
    result.recovered?.surfaces.every((surface) => surface.ready === "true"),
  ).toBe(true);
  expect(result.css.surfaces[0].backend).toBe("native");
  expect(result.remaining).toBe(0);
});

test("backdrop pixels retain the red element's world position at editor zoom and fractional display scaling", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const rows = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      factoryPath = "/src/core/elementFactory.ts";
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
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]],
          lens = slide.nodes[0].children[1];
        const red = createBasicShape("red", "rectangle", { x: 160, y: 120 });
        red.frame.width = 240;
        red.frame.height = 60;
        red.appearance.fill = "#ff0000";
        lens.frame = { ...lens.frame, x: 80, y: 40, width: 360, height: 200 };
        slide.nodes[0].children = [red, lens];
        model.deck.stylesheet = "/* Browser paint input */";
      },
    });
    const rows = [];
    for (const zoom of [0.35, 0.57, 1, 2, 1]) {
      await harness.setZoom(zoom);
      if (rows.length === 4)
        harness.host.querySelector<HTMLElement>(
          '[data-element-id="glass"]',
        )!.style.width = "500px";
      await harness.advance(0, 0, 1);
      const canvas = harness.host.querySelector<HTMLCanvasElement>(
        "[data-effect-id] > canvas",
      )!;
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (
            data[i] > 240 &&
            data[i + 1] < 10 &&
            data[i + 2] < 10 &&
            data[i + 3] > 240
          ) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
        }
      rows.push({
        zoom,
        width: canvas.width,
        height: canvas.height,
        logicalWidth: parseFloat(
          getComputedStyle(canvas.closest<HTMLElement>("[data-element-id]")!)
            .width,
        ),
        x0,
        y0,
        x1,
        y1,
        errors: harness.inspect().errors,
      });
    }
    harness.dispose();
    return rows;
  });
  for (const row of rows) {
    expect(row.errors).toEqual([]);
    expect(
      Math.abs(row.x0 - (80 / row.logicalWidth) * row.width),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(row.y0 - (80 / 200) * row.height)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(row.x1 + 1 - (320 / row.logicalWidth) * row.width),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(row.y1 + 1 - (140 / 200) * row.height)).toBeLessThanOrEqual(
      1,
    );
  }
});

test("custom pseudo-element rules remain independent across simultaneous shader captures", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const state = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      effectsPath = "/src/core/effects.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]],
          first = slide.nodes[0].children[0],
          second = structuredClone(first);
        second.id = "second";
        second.frame.y = 180;
        second.effects = second.effects!.map((instance) =>
          newEffectInstance(
            instance.resourceId,
            slide.effectResources![instance.resourceId],
            instance.placement,
          ),
        );
        slide.nodes[0].children = [first, second];
        model.deck.stylesheet += ` [data-element-id="animated"] [data-effect-text-output]::before {content:"TEST";color:red;}
        [data-element-id="second"] [data-effect-text-output]::before {content:"TEST";color:blue;}`;
      },
    });
    const state = await harness.stage(0.5, 1, 1);
    harness.dispose();
    return state;
  });
  expect(state.errors).toEqual([]);
  expect(state.surfaces[0].green).toBeGreaterThan(
    state.surfaces[1].green + 1000,
  );
  expect(state.surfaces[1].red).toBeGreaterThan(state.surfaces[0].red + 1000);
});
