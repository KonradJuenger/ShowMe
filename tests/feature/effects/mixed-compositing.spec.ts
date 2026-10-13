import { expect, test, type Page } from "@playwright/test";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";
type HarnessWindow = Window & {
  mixed: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
};
test.use({ deviceScaleFactor: 1.25 });

test("inherited shader clocks refresh captured stylesheet pixels after forward and backward seeks", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const rows = await page.evaluate(async () => {
    const path = "/tests/helpers/mixedEffectsHarness.tsx";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ path
    );
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]];
        const text = slide.nodes[0].children[0];
        text.effects = text.effects!.slice(2);
        slide.nodes[0].children = [text];
        model.deck.stylesheet =
          "[data-text-content] { color:red!important; opacity:var(--slideTime); }";
      },
    });
    try {
      const rows = [];
      for (const clock of ["slideTime", "p", "t"]) {
        harness.setStylesheet(
          `[data-text-content] { color:red!important; opacity:var(--${clock}); }`,
        );
        const hidden = await harness.stage(0, 0, 0);
        const visible = await harness.stage(1, 0, 1);
        const repeated = await harness.stage(1, 0, 1);
        const backward = await harness.stage(0, 0, 0);
        rows.push({ hidden, visible, repeated, backward });
      }
      return rows;
    } finally {
      harness.dispose();
    }
  });
  for (const row of rows) {
    expect(row.hidden.errors).toEqual([]);
    expect(row.visible.errors).toEqual([]);
    expect(row.hidden.surfaces[0].opaque).toBe(0);
    expect(row.visible.surfaces[0].green).toBeGreaterThan(1000);
    expect(row.backward.surfaces[0].opaque).toBe(0);
    expect(row.repeated.diagnostics.captures).toBe(
      row.visible.diagnostics.captures,
    );
  }
});

test("unused, disabled and unrelated CSS effects preserve primitive content and backdrop sources", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const rows = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const factoryPath = "/src/core/elementFactory.ts";
    const effectsPath = "/src/core/effects.ts";
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
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const rows = [];
    for (const placement of [
      "unused",
      "disabled",
      "unrelated",
      "contributing",
    ]) {
      const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
        configure(model) {
          const slide = model.slides[model.deck.slideIds[0]];
          const resources = slide.effectResources!;
          const red = createBasicShape("red", "rectangle", { x: 40, y: 40 });
          red.frame.width = red.frame.height = 120;
          red.appearance.fill = "red";
          red.effects = [
            newEffectInstance("shader", resources.shader, "content"),
          ];
          const unrelated = createBasicShape("unrelated", "rectangle", {
            x: 300,
            y: 40,
          });
          if (placement === "unrelated")
            unrelated.effects = [
              newEffectInstance("css", resources.css, "content"),
            ];
          if (placement === "disabled" || placement === "contributing") {
            const css = newEffectInstance("css", resources.css, "content");
            css.enabled = placement === "contributing";
            red.effects.unshift(css);
          }
          slide.nodes[0].children = [
            red,
            slide.nodes[0].children[1],
            unrelated,
          ];
          slide.effectResources = {
            css: resources.css,
            shader: resources.shader,
            backdrop: resources.backdrop,
          };
          delete model.deck.stylesheet;
        },
      });
      try {
        rows.push({ placement, state: await harness.stage(0, 0, 1) });
      } finally {
        harness.dispose();
      }
    }
    return rows;
  });
  for (const { placement, state } of rows) {
    expect(state.errors).toEqual([]);
    expect(
      state.surfaces.every(
        (surface) =>
          surface.backend ===
          (placement === "contributing" ? "native" : "primitive"),
      ),
    ).toBe(true);
    expect(state.surfaces.every((surface) => surface.green > 1000)).toBe(true);
  }
});

test("excluded animations do not refresh a source while contributing animations still change its pixels", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const path = "/src/components/domRaster.ts";
    const {
      createDomRasterSource,
      domRasterDiagnostics,
    }: typeof import("../../../src/components/domRaster") = await import(
      /* @vite-ignore */ path
    );
    const root = document.createElement("div");
    root.style.cssText = "width:100px;height:100px;background:red";
    const excluded = document.createElement("div");
    root.append(excluded);
    document.body.append(root);
    const animation = excluded.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 60000,
      iterations: Infinity,
    });
    let invalidations = 0;
    const source = createDomRasterSource(
      () => root,
      (node) => node !== excluded,
      () => {},
      () => invalidations++,
      async () => {},
      undefined,
      true,
    );
    let contributing: Animation | undefined;
    try {
      await source.update(100, 100, 100, 100);
      const before = domRasterDiagnostics();
      const initialInvalidations = invalidations;
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        await source.update(100, 100, 100, 100);
      }
      const after = domRasterDiagnostics();
      const excludedInvalidations = invalidations - initialInvalidations;
      contributing = root.animate(
        [{ backgroundColor: "red" }, { backgroundColor: "blue" }],
        { duration: 60000 },
      );
      contributing.currentTime = 30000;
      await source.update(100, 100, 100, 100);
      const pixel = Array.from(
        source.canvas.getContext("2d")!.getImageData(50, 50, 1, 1).data,
      );
      return { before, after, excludedInvalidations, pixel };
    } finally {
      source.dispose();
      animation.cancel();
      contributing?.cancel();
      root.remove();
    }
  });
  expect(result.excludedInvalidations).toBe(0);
  expect(result.after.styleReads).toBe(result.before.styleReads);
  expect(result.after.captures).toBe(result.before.captures);
  expect(result.pixel[0]).toBeGreaterThan(50);
  expect(result.pixel[2]).toBeGreaterThan(50);
});

test("a mounted backdrop switches from primitive capture when lower CSS is added", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      factoryPath = "/src/core/elementFactory.ts",
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
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    let model!: import("../../../src/core/document").PresentationDocument;
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(value) {
        model = value;
        const slide = value.slides[value.deck.slideIds[0]];
        const red = createBasicShape("red", "rectangle", { x: 40, y: 40 });
        red.frame.width = 120;
        red.frame.height = 120;
        red.appearance.fill = "red";
        red.effects = [
          newEffectInstance("shader", slide.effectResources!.shader, "content"),
        ];
        slide.nodes[0].children = [red, slide.nodes[0].children[1]];
        slide.effectResources = {
          backdrop: slide.effectResources!.backdrop,
          shader: slide.effectResources!.shader,
        };
        delete value.deck.stylesheet;
      },
    });
    try {
      const before = await harness.stage(0);
      const slide = model.slides[model.deck.slideIds[0]],
        red = slide.nodes[0].children[0];
      const css = {
        apiVersion: 1 as const,
        name: "Reveal",
        category: "effect" as const,
        kind: "css" as const,
        target: "content" as const,
        source: ":scope { opacity: var(--p); }",
        timeControl: {
          start: "slide" as const,
          stop: { mode: "none" as const },
        },
        parameters: [],
      };
      slide.effectResources = { ...slide.effectResources, css };
      red.effects = [...red.effects!, newEffectInstance("css", css, "content")];
      await harness.setZoom(1);
      const visible = await harness.stage(0.5, 0, 1);
      const hidden = await harness.stage(0.5, 0, 0);
      slide.effectResources = {
        backdrop: slide.effectResources.backdrop,
        shader: slide.effectResources.shader,
      };
      red.effects = red.effects.slice(0, 1);
      await harness.setZoom(1);
      const restored = await harness.stage(0.5, 0, 1);
      harness.setStylesheet('[data-element-id="red"] { filter:grayscale(1); }');
      await harness.setZoom(1);
      const styled = await harness.stage(0.5, 0, 1);
      return {
        before,
        visible,
        hidden,
        restored,
        styled,
        warnings: Array.from(
          harness.host.querySelectorAll('[role="status"]'),
          (node) => node.textContent,
        ),
      };
    } finally {
      harness.dispose();
    }
  });
  expect(result.before.errors).toEqual([]);
  expect(result.before.surfaces.at(-1)!.opaque).toBeGreaterThan(1000);
  expect(result.visible.errors).toEqual([]);
  expect(result.visible.surfaces.at(-1)!.backend).toBe("native");
  expect(result.visible.surfaces.at(-1)!.green).toBeGreaterThan(1000);
  expect(result.hidden.surfaces.at(-1)!.green).toBe(0);
  expect(result.restored.errors).toEqual([]);
  expect(result.restored.surfaces.at(-1)!.backend).toBe("primitive");
  expect(result.restored.surfaces.at(-1)!.green).toBeGreaterThan(1000);
  expect(result.styled.errors).toEqual([]);
  expect(result.styled.surfaces.at(-1)!.backend).toBe("native");
  expect(result.styled.surfaces.at(-1)!.green).toBe(0);
  expect(result.warnings).toEqual([]);
});

test("retained snapshots preserve mixed text insertion and CSS changes around unchanged media", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const differences = await page.evaluate(async () => {
    const path = "/src/components/domRaster.ts";
    const {
      createDomRasterSource,
    }: typeof import("../../../src/components/domRaster") = await import(
      /* @vite-ignore */ path
    );
    const node = document.createElement("div");
    node.style.cssText = "width:150px;height:50px;color:red;font:20px Arial";
    const middle = document.createElement("b");
    middle.textContent = "a";
    const bitmap = document.createElement("canvas");
    bitmap.width = 20;
    bitmap.height = 20;
    const context = bitmap.getContext("2d")!;
    context.fillStyle = "blue";
    context.fillRect(0, 0, 20, 20);
    node.append(
      document.createTextNode("a"),
      middle,
      document.createTextNode("a"),
      bitmap,
    );
    document.body.append(node);
    const create = () =>
      createDomRasterSource(
        () => node,
        () => true,
        () => {},
        () => {},
        async () => {},
        undefined,
        true,
      );
    const retained = create();
    const rows: number[] = [];
    try {
      await retained.update(150, 50, 150, 50);
      for (const mutate of [
        () => middle.after(document.createTextNode("d")),
        () => middle.after(node.firstChild!),
        () => {
          node.style.filter = "brightness(0.5)";
        },
      ]) {
        mutate();
        await Promise.resolve();
        await retained.update(150, 50, 150, 50);
        const fresh = create();
        try {
          await fresh.update(150, 50, 150, 50);
          const a = retained.canvas
            .getContext("2d")!
            .getImageData(0, 0, 150, 50).data;
          const b = fresh.canvas
            .getContext("2d")!
            .getImageData(0, 0, 150, 50).data;
          rows.push(
            a.reduce(
              (max, value, index) => Math.max(max, Math.abs(value - b[index])),
              0,
            ),
          );
        } finally {
          fresh.dispose();
        }
      }
      return rows;
    } finally {
      retained.dispose();
      node.remove();
    }
  });
  expect(differences.every((difference) => difference <= 1)).toBe(true);
});

test("batched raster reads preserve text, pseudo-element and fitted-media pixels", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const difference = await page.evaluate(async () => {
    const path = "/src/components/domRaster.ts";
    const {
      createDomRasterSource,
      setDomRasterReadBatchingForTests,
    }: typeof import("../../../src/components/domRaster") = await import(
      /* @vite-ignore */ path
    );
    const node = document.createElement("div");
    node.id = "raster-read-parity";
    node.style.cssText =
      "width:100px;height:100px;background:#123456;overflow:hidden";
    const text = document.createElement("span");
    text.textContent = "Mixed";
    text.style.cssText = "color:red;font:18px Arial;text-shadow:1px 2px blue";
    const bitmap = document.createElement("canvas");
    bitmap.width = 20;
    bitmap.height = 10;
    bitmap.style.cssText =
      "width:40px;height:40px;object-fit:contain;object-position:20% 80%";
    const context = bitmap.getContext("2d")!;
    context.fillStyle = "green";
    context.fillRect(0, 0, 20, 10);
    const style = document.createElement("style");
    style.textContent =
      '#raster-read-parity span::before { content:"X"; color:yellow; }';
    document.head.append(style);
    node.append(text, bitmap);
    document.body.append(node);
    const images: Uint8ClampedArray[] = [];
    try {
      for (const mode of ["interleaved", "batched"] as const) {
        setDomRasterReadBatchingForTests(mode);
        const source = createDomRasterSource(
          () => node,
          () => true,
          () => {},
          () => {},
          async () => {},
          undefined,
          true,
        );
        try {
          await source.update(100, 100, 100, 100);
          images.push(
            source.canvas.getContext("2d")!.getImageData(0, 0, 100, 100).data,
          );
        } finally {
          source.dispose();
        }
      }
      return images[0].reduce(
        (max, value, index) =>
          Math.max(max, Math.abs(value - images[1][index])),
        0,
      );
    } finally {
      setDomRasterReadBatchingForTests("batched");
      node.remove();
      style.remove();
    }
  });
  expect(difference).toBeLessThanOrEqual(1);
});

test("DOM snapshots refresh logical viewport changes at fixed raster size and ignore disposed work", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const path = "/src/components/domRaster.ts";
    const {
      createDomRasterSource,
    }: typeof import("../../../src/components/domRaster") = await import(
      /* @vite-ignore */ path
    );
    const node = document.createElement("div");
    node.style.cssText = "width:100px;height:100px;background:red";
    document.body.append(node);
    let invalidations = 0;
    let matrix = new DOMMatrix();
    const source = createDomRasterSource(
      () => node,
      () => true,
      () => {},
      () => {
        invalidations++;
      },
      async () => {},
      () => matrix,
      true,
    );
    await source.update(100, 100, 100, 100);
    const first = source.revision;
    await source.update(100, 100, 100, 100);
    const cached = source.revision;
    await source.update(100, 100, 200, 100);
    const resized = source.revision;
    matrix = new DOMMatrix().translate(10, 0);
    await source.update(100, 100, 200, 100);
    const transformed = source.revision;
    const pending = source.update(200, 100, 200, 100);
    source.dispose();
    const before = invalidations;
    source.markDirty();
    await pending;
    node.remove();
    return {
      first,
      cached,
      resized,
      transformed,
      final: source.revision,
      before,
      after: invalidations,
      attached: source.canvas.isConnected,
    };
  });
  expect(result.cached).toBe(result.first);
  expect(result.resized).toBeGreaterThan(result.cached);
  expect(result.transformed).toBeGreaterThan(result.resized);
  expect(result.final).toBe(result.transformed);
  expect(result.after).toBe(result.before);
  expect(result.attached).toBe(false);
});

test("a failed DOM capture stays dirty and an explicit retry can recover", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const path = "/src/components/domRaster.ts";
    const {
      createDomRasterSource,
    }: typeof import("../../../src/components/domRaster") = await import(
      /* @vite-ignore */ path
    );
    const node = document.createElement("div");
    node.style.cssText = "width:100px;height:100px;background:red";
    document.body.append(node);
    const source = createDomRasterSource(
      () => node,
      () => true,
      () => {},
      () => {},
      async () => {},
      undefined,
      true,
    );
    await source.update(100, 100, 100, 100);
    const first = source.revision;
    source.markDirty();
    const context = source.canvas.getContext(
      "2d",
    )! as CanvasRenderingContext2D & {
      drawElementImage(element: HTMLElement, x: number, y: number): DOMMatrix;
    };
    const draw = context.drawElementImage;
    context.drawElementImage = () => {
      throw new Error("injected paint failure");
    };
    node.style.background = "blue";
    let failed = false;
    try {
      await source.update(100, 100, 100, 100);
    } catch {
      failed = true;
    }
    const dirty = source.isDirty;
    context.drawElementImage = draw;
    await source.update(100, 100, 100, 100);
    const recovered = source.revision;
    source.dispose();
    node.remove();
    return { first, failed, dirty, recovered };
  });
  expect(result.failed).toBe(true);
  expect(result.dirty).toBe(true);
  expect(result.recovered).toBeGreaterThan(result.first);
});

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
      runtime.setEffectExecutionForTests(gpu ? "refined" : "naive");
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
      runtime.setEffectExecutionForTests("refined");
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

test("custom pseudo-element rules remain independent across duplicated shader instances", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const state = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]],
          first = slide.nodes[0].children[0],
          second = structuredClone(first);
        second.id = "second";
        second.frame.y = 180;
        // Duplication retains instance IDs; source ownership includes the Element.
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
