import { expect, test, type Page } from "@playwright/test";
import type { mountMixedEffectsHarness } from "../../helpers/mixedEffectsHarness";
type HarnessWindow = Window & {
  mixed: Awaited<ReturnType<typeof mountMixedEffectsHarness>>;
};
test.use({ deviceScaleFactor: 1.25 });

test("backdrop pixels recover after dragging outside the slide without resizing", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const states = await page.evaluate(async () => {
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
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]];
        const resources = slide.effectResources!;
        const lower = createBasicShape("lower", "rectangle", { x: 0, y: 0 });
        lower.frame.width = model.deck.width;
        lower.frame.height = model.deck.height;
        lower.appearance.fill = "red";
        lower.effects = [
          newEffectInstance("shader", resources.shader, "content"),
        ];
        const glass = slide.nodes[0].children[1];
        glass.frame.width = glass.frame.height = 100;
        slide.nodes[0].children = [lower, glass];
        delete model.deck.stylesheet;
      },
    });
    try {
      const glass = harness.host.querySelector<HTMLElement>(
        '[data-element-id="glass"]',
      )!;
      const states = [await harness.stage(0)];
      // Preserve the backing-store size throughout the drag, including a fully
      // out-of-slide position and a return to the original position.
      for (const x of [-50, -120, 0, 200, 0]) {
        glass.style.transform = `translateX(${x}px)`;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        states.push(await harness.stage(0));
      }
      return states;
    } finally {
      harness.dispose();
    }
  });
  for (const state of states) expect(state.errors).toEqual([]);
  const initial = states[0].surfaces[1];
  expect(initial.backend).toBe("scene-texture");
  expect(initial.green).toBeGreaterThan(0);
  expect(states[1].surfaces[1].green).toBeLessThan(initial.green);
  expect(states[2].surfaces[1].opaque).toBe(0);
  for (const state of states.slice(3)) {
    expect(state.surfaces[1].width).toBe(initial.width);
    expect(state.surfaces[1].height).toBe(initial.height);
    expect(state.surfaces[1].green).toBe(initial.green);
    expect(state.surfaces[1].opaque).toBe(initial.opaque);
  }
});

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
          surface.backend === "scene-texture",
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
  expect(result.visible.surfaces.at(-1)!.backend).toBe("scene-texture");
  expect(result.visible.surfaces.at(-1)!.green).toBeGreaterThan(1000);
  expect(result.hidden.surfaces.at(-1)!.green).toBe(0);
  expect(result.restored.errors).toEqual([]);
  expect(result.restored.surfaces.at(-1)!.backend).toBe("scene-texture");
  expect(result.restored.surfaces.at(-1)!.green).toBeGreaterThan(1000);
  expect(result.styled.errors).toEqual([]);
  expect(result.styled.surfaces.at(-1)!.backend).toBe("scene-texture");
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
        '[data-effect-id] > canvas[data-shader-stage="terminal"]',
      )!;
      const gl = canvas.getContext("webgl2")!;
      const buffer = new Uint8Array(canvas.width * canvas.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        buffer,
      );
      const pixels = Array.from(buffer);
      let recovered = null;
      if (lose) {
        const surface = runtime.effectSurface(canvas.parentElement!)!;
        const active = surface.gpuContext()!;
        const extension = active.getExtension("WEBGL_lose_context")!;
        extension.loseContext();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        extension.restoreContext();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
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
  expect(result.css.surfaces[0].backend).toBe("scene-texture");
  expect(result.remaining).toBe(0);
});

test("mixed-size shader outputs preserve pixels and release their visible WebGL contexts", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      runtimePath = "/src/components/effectRuntime.ts",
      factoryPath = "/src/core/elementFactory.ts",
      authoringPath = "/src/core/effectAuthoring.ts",
      effectsPath = "/src/core/effects.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const runtime: typeof import("../../../src/components/effectRuntime") =
      await import(/* @vite-ignore */ runtimePath);
    const {
      createBasicShape,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const { blankEffect }: typeof import("../../../src/core/effectAuthoring") =
      await import(/* @vite-ignore */ authoringPath);
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const source =
      "#version 300 es\nprecision highp float;in vec2 v_uv;out vec4 outColor;void main(){outColor=vec4(v_uv.x,v_uv.y,0.25,0.75);}";
    const run = async (gpu: boolean) => {
      runtime.setEffectExecutionForTests(gpu ? "refined" : "naive");
      const initialContexts = runtime.shaderRuntimeDiagnostics().activeContexts;
      const h = await mountMixedEffectsHarness(undefined, 0, undefined, {
        configure(model) {
          model.deck.stylesheet = "";
          const slide = model.slides[model.deck.slideIds[0]];
          const shader = {
            ...blankEffect("shader"),
            input: "none" as const,
            source,
          };
          slide.effectResources = { shader };
          slide.nodes[0].children = ["large", "small"].map((id) => {
            const node = createBasicShape(id, "rectangle", { x: 0, y: 0 });
            node.appearance.fill = "";
            node.frame.width = id === "large" ? 640 : 80;
            node.frame.height = id === "large" ? 360 : 60;
            node.effects = [newEffectInstance("shader", shader, "background")];
            return node;
          });
        },
      });
      const samples = [];
      for (const zoom of [1, 0.5, 1.25]) {
        await h.setZoom(zoom);
        await h.advance(0.37);
        const canvas = h.host.querySelector<HTMLCanvasElement>(
          '[data-element-id="small"] canvas',
        )!;
        samples.push({
          width: canvas.width,
          height: canvas.height,
          pixels: (() => {
            const gl = canvas.getContext("webgl2")!;
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(
              0,
              0,
              canvas.width,
              canvas.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            return Array.from(pixels);
          })(),
        });
      }
      h.dispose();
      return {
        samples,
        released:
          runtime.shaderRuntimeDiagnostics().activeContexts === initialContexts,
      };
    };
    try {
      const reference = await run(false),
        actual = await run(true);
      let max = 0;
      for (let j = 0; j < reference.samples.length; j++) {
        const a = actual.samples[j],
          b = reference.samples[j];
        if (a.width !== b.width || a.height !== b.height)
          throw new Error("Output bounds changed");
        for (let i = 0; i < a.pixels.length; i++)
          max = Math.max(max, Math.abs(a.pixels[i] - b.pixels[i]));
      }
      return { max, released: actual.released };
    } finally {
      runtime.setEffectExecutionForTests("refined");
    }
  });
  expect(result.max).toBeLessThanOrEqual(1);
  expect(result.released).toBe(true);
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
        '[data-effect-id] > canvas[data-shader-stage="terminal"]',
      )!;
      const gl = canvas.getContext("webgl2")!;
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = ((canvas.height - 1 - y) * canvas.width + x) * 4;
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

test("representative browser-native presentation crosses SceneTexture only for explicit scene-pixel shaders", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      factoryPath = "/src/core/elementFactory.ts",
      authoringPath = "/src/core/effectAuthoring.ts",
      effectsPath = "/src/core/effects.ts",
      mediaPath = "/src/core/media.ts",
      textPath = "/src/core/text.ts",
      platformPath = "/src/platform/index.ts",
      runtimePath = "/src/components/effectRuntime.ts";
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
    const { createMediaElement }: typeof import("../../../src/core/media") =
      await import(/* @vite-ignore */ mediaPath);
    const { createTextElement }: typeof import("../../../src/core/text") =
      await import(/* @vite-ignore */ textPath);
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ platformPath
    );
    const {
      effectSourceTextureBytes,
    }: typeof import("../../../src/components/effectRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );

    const source = document.createElement("canvas");
    source.width = 320;
    source.height = 180;
    const context = source.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 320, 180);
    gradient.addColorStop(0, "#113c8d");
    gradient.addColorStop(1, "#e56b35");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 320, 180);
    const imageUrl = source.toDataURL("image/png");
    platform.assetUrl = async () => imageUrl;

    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]];
        const resources = slide.effectResources!;
        const originalText = slide.nodes[0].children[0];
        const sceneBackdrop = slide.nodes[0].children[1];

        const imageAsset = {
          version: 1 as const,
          id: "c".repeat(64),
          filename: "renderer-boundary.png",
          names: ["renderer-boundary.png"],
          type: "image" as const,
          mediaType: "image" as const,
          mime: "image/png" as const,
          bytes: 1,
          width: 320,
          height: 180,
          createdAt: "2026-10-23T00:00:00Z",
        };
        const directImageShader = {
          ...blankEffect("shader"),
          input: "content" as const,
          target: "content" as const,
          source:
            "#version 300 es\nprecision highp float; uniform sampler2D u_input; in vec2 v_uv; out vec4 outColor; void main(){ outColor=texture(u_input,v_uv); }",
        };
        const background = createMediaElement(
          "background-image",
          imageAsset,
          { x: 0, y: 0 },
        );
        Object.assign(background.frame, {
          x: 0,
          y: 0,
          width: 640,
          height: 360,
        });
        background.effects = [
          newEffectInstance("direct-image", directImageShader, "content"),
        ];

        const generated = {
          ...blankEffect("shader"),
          input: "none" as const,
          target: "background" as const,
          source:
            "#version 300 es\nprecision highp float; uniform float u_t; in vec2 v_uv; out vec4 outColor; void main(){ outColor=vec4(v_uv.x,.25+.08*sin(u_t),1.-v_uv.x,.22); }",
        };
        const generatedLayer = createBasicShape(
          "generated-layer",
          "rectangle",
          { x: 0, y: 0 },
        );
        Object.assign(generatedLayer.frame, { width: 640, height: 360 });
        generatedLayer.appearance.fill = "";
        generatedLayer.effects = [
          newEffectInstance("generated", generated, "background"),
        ];

        const nestedFrame = createBasicShape("nested-frame", "rectangle", {
          x: 365,
          y: 22,
        });
        Object.assign(nestedFrame.frame, { width: 220, height: 125 });
        nestedFrame.appearance.fill = "#00000000";
        nestedFrame.appearance.radius = 14;
        nestedFrame.clipChildren = true;
        const nestedImage = createMediaElement(
          "nested-image",
          imageAsset,
          { x: -18, y: -8 },
        );
        Object.assign(nestedImage.frame, {
          x: -18,
          y: -8,
          width: 270,
          height: 152,
          rotation: -4,
        });
        nestedFrame.children = [nestedImage];

        const nativeCss = {
          ...blankEffect("css-js"),
          source:
            ":scope { backdrop-filter: blur(14px) saturate(120%); background: rgba(255,255,255,.24); border: 1px solid rgba(255,255,255,.7); border-radius: 18px; overflow: hidden; }",
        };
        const nativeGlass = createBasicShape("native-glass", "rectangle", {
          x: 345,
          y: 178,
        });
        Object.assign(nativeGlass.frame, { width: 245, height: 130 });
        nativeGlass.appearance.fill = "#ffffff18";
        nativeGlass.appearance.radius = 18;
        nativeGlass.clipChildren = true;
        nativeGlass.effects = [
          newEffectInstance("native-css", nativeCss, "content"),
        ];
        const label = createTextElement("native-label", { x: 18, y: 38 });
        Object.assign(label.frame, { width: 205, height: 55 });
        if (label.content?.type === "text") {
          label.content.text = "Chromium glass";
          if (label.content.format.kind === "local")
            label.content.format.typography.fontSize = 24;
        }
        nativeGlass.children = [label];

        const foreground = createBasicShape("foreground-overlap", "ellipse", {
          x: 535,
          y: 250,
        });
        Object.assign(foreground.frame, { width: 90, height: 90 });
        foreground.appearance.fill = "#11c9aacc";

        resources.generated = generated;
        resources["direct-image"] = directImageShader;
        resources["native-css"] = nativeCss;
        sceneBackdrop.frame.width = 320;
        sceneBackdrop.frame.height = 180;
        sceneBackdrop.frame.x = 0;
        sceneBackdrop.frame.y = 180;
        slide.nodes[0].children = [
          background,
          generatedLayer,
          originalText,
          sceneBackdrop,
          nestedFrame,
          nativeGlass,
          foreground,
        ];
        slide.motion = {
          stages: [
            {
              id: "representative-stage",
              tracks: [
                {
                  id: "native-glass-move",
                  elementId: "native-glass",
                  property: "transform.x",
                  keyframes: [
                    {
                      id: "native-glass-move-a",
                      at: 0,
                      value: { type: "absolute", value: 345 },
                      easeToNext: "linear",
                    },
                    {
                      id: "native-glass-move-b",
                      at: 1000,
                      value: { type: "absolute", value: 380 },
                    },
                  ],
                },
              ],
              blocks: [
                {
                  id: "native-glass-presence",
                  label: "Presence",
                  members: [],
                  binding: { kind: "presence", elementId: "native-glass" },
                  presenceSchedule: {
                    version: 1,
                    startOffsetMs: 0,
                    end: { mode: "after", durationMs: 1000 },
                    enterTransition: {
                      kind: "fade",
                      durationMs: 150,
                      easing: [0, 0, 1, 1],
                    },
                    exitTransition: {
                      kind: "fade",
                      durationMs: 150,
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

    try {
      const root = harness.host.querySelector<HTMLElement>(".slide-renderer")!;
      const nativeGlass = root.querySelector<HTMLElement>(
        '[data-element-id="native-glass"]',
      )!;
      const nativeEffect =
        nativeGlass.querySelector<HTMLElement>("[data-effect-id]")!;
      await Promise.all(
        Array.from(root.querySelectorAll<HTMLImageElement>("img")).map(
          (image) => image.decode().catch(() => undefined),
        ),
      );
      await harness.advance(0.25);
      const directImageEffect = root.querySelector<HTMLElement>(
        '[data-element-id="background-image"] [data-effect-id]',
      )!;
      const generatedEffect = root.querySelector<HTMLElement>(
        '[data-element-id="generated-layer"] [data-effect-id]',
      )!;
      const contentShader = Array.from(
        root.querySelectorAll<HTMLElement>(
          '[data-element-id="animated"] [data-effect-id]',
        ),
      ).find((node) => node.querySelector(":scope > canvas"))!;
      const backdropShader = root.querySelector<HTMLElement>(
        '[data-element-id="glass"] [data-effect-id]',
      )!;
      const beforeTransform = getComputedStyle(nativeGlass).transform;
      await harness.setMotion({
        stageId: "representative-stage",
        stageIndex: 0,
        time: 500,
        running: false,
        startedAt: 1000,
      });
      await harness.advance(0.5, 0, 0.5);
      const state = harness.inspect();
      const afterTransform = getComputedStyle(nativeGlass).transform;
      const foreground = root.querySelector<HTMLElement>(
        '[data-element-id="foreground-overlap"]',
      )!;
      return {
        errors: state.errors,
        text: state.text,
        directImageBackend:
          directImageEffect.dataset.effectSourceBackend ?? null,
        contentBackend: contentShader.dataset.effectSourceBackend ?? null,
        backdropBackend: backdropShader.dataset.effectSourceBackend ?? null,
        sceneTextureBytes: effectSourceTextureBytes(),
        generatedReady: generatedEffect.dataset.effectReady,
        generatedBackend: generatedEffect.dataset.effectSourceBackend ?? null,
        generatedCanvas:
          generatedEffect.querySelectorAll(":scope > canvas").length,
        nativeCanvas: nativeEffect.querySelectorAll(":scope > canvas").length,
        nativeBackdrop: getComputedStyle(nativeEffect).backdropFilter,
        restoration: root.querySelectorAll("[data-backdrop-restore]").length,
        cssReplay: root.querySelectorAll("[data-css-backdrop]").length,
        compositionBackend: root.dataset.compositionBackend ?? null,
        nestedImage: root.querySelectorAll(
          '[data-element-id="nested-frame"] [data-element-id="nested-image"] img',
        ).length,
        motionChanged: beforeTransform !== afterTransform,
        present: nativeGlass.dataset.presentationAbsent,
        foregroundAfter: Boolean(
          nativeGlass.compareDocumentPosition(foreground) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    } finally {
      harness.dispose();
    }
  });

  expect(result.errors).toEqual([]);
  expect(result.text).toContain("FIRST");
  expect(result.directImageBackend).toBe("image");
  expect(result.contentBackend).toBe("scene-texture");
  expect(result.backdropBackend).toBe("scene-texture");
  expect(result.generatedReady).toBe("true");
  expect(result.generatedBackend).toBe("none");
  expect(result.generatedCanvas).toBe(1);
  expect(result.sceneTextureBytes).toBeGreaterThan(0);
  expect(result.nativeCanvas).toBe(0);
  expect(result.nativeBackdrop).not.toBe("none");
  expect(result.restoration).toBe(0);
  expect(result.cssReplay).toBe(0);
  expect(result.compositionBackend).toBeNull();
  expect(result.nestedImage).toBe(1);
  expect(result.motionChanged).toBe(true);
  expect(result.present).toBe("false");
  expect(result.foregroundAfter).toBe(true);
});



test("neutral live video binds directly as shader input without SceneTexture", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx",
      mediaPath = "/src/core/media.ts",
      authoringPath = "/src/core/effectAuthoring.ts",
      effectsPath = "/src/core/effects.ts",
      platformPath = "/src/platform/index.ts",
      scenePath = "/src/components/sceneTexture.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const { createMediaElement }: typeof import("../../../src/core/media") =
      await import(/* @vite-ignore */ mediaPath);
    const { blankEffect }: typeof import("../../../src/core/effectAuthoring") =
      await import(/* @vite-ignore */ authoringPath);
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ platformPath
    );
    const {
      sceneTextureDiagnostics,
    }: typeof import("../../../src/components/sceneTexture") = await import(
      /* @vite-ignore */ scenePath
    );

    platform.assetUrl = async (_id, preview) =>
      preview ? null : "/tests/fixtures/media/prepared-red.webm";
    platform.releaseUrl = () => {};
    const before = sceneTextureDiagnostics();
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      liveMedia: true,
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
        const video = createMediaElement("video", {
          version: 1,
          id: "e".repeat(64),
          filename: "prepared-red.webm",
          names: ["prepared-red.webm"],
          type: "video",
          mediaType: "video",
          mime: "video/webm",
          bytes: 1,
          width: 160,
          height: 90,
          duration: 0.5,
          createdAt: "2026-10-23T00:00:00Z",
        });
        if (video.content?.type !== "video")
          throw new Error("Video fixture required");
        video.content.autoplay = true;
        video.content.loop = true;
        video.content.mute = true;
        video.effects = [newEffectInstance("video-shader", shader, "content")];
        slide.effectResources = { "video-shader": shader };
        slide.nodes[0].children = [video];
        delete slide.motion;
      },
    });
    try {
      const video = harness.host.querySelector<HTMLVideoElement>("video")!;
      const deadline = performance.now() + 3000;
      while (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (performance.now() > deadline)
          throw new Error("Video shader fixture did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await video.play().catch(() => undefined);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await harness.advance(0.1);
      const effect =
        harness.host.querySelector<HTMLElement>("[data-effect-id]")!;
      const after = sceneTextureDiagnostics();
      return {
        backend: effect.dataset.effectSourceBackend,
        ready: effect.dataset.effectReady,
        captures: after.captures - before.captures,
        domCaptures: after.domRaster.captures - before.domRaster.captures,
        errors: harness.inspect().errors,
      };
    } finally {
      harness.dispose();
    }
  });
  expect(result.backend).toBe("video");
  expect(result.ready).toBe("true");
  expect(result.captures).toBe(0);
  expect(result.domCaptures).toBe(0);
  expect(result.errors).toEqual([]);
});
