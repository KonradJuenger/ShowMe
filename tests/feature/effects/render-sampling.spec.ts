import { expect, test, type Page } from "@playwright/test";
import type { mountRenderSamplingHarness } from "../../helpers/renderSamplingHarness";

type Harness = Awaited<ReturnType<typeof mountRenderSamplingHarness>>;
type SampleWindow = Window & { sampling: Harness };
async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/helpers/renderSamplingHarness.tsx";
    const {
      mountRenderSamplingHarness,
    }: typeof import("../../helpers/renderSamplingHarness") = await import(
      /* @vite-ignore */ path
    );
    (window as unknown as SampleWindow).sampling =
      await mountRenderSamplingHarness();
  });
}

test("4K shader output preserves input pixels, text proportions and paused clocks without remount", async ({
  page,
}) => {
  await mount(page);
  const first = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.inspect(),
  );
  const large = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.resize(2),
  );
  expect(large).toMatchObject({
    width: 3840,
    height: 2160,
    pixel: [0, 255, 0, 255],
    error: null,
    unchanged: true,
    sameCanvas: true,
  });
  expect(large.font).toBe(first.font);
  expect(large.wrapHeight).toBe(first.wrapHeight);
  expect(large.textFraction).toBeCloseTo(first.textFraction);
  expect(large.time).toBe(first.time);
  expect(large.uniforms[0]).toBe(255);
  expect(large.uniforms[1]).toBeCloseTo(245, 0);
  expect(large.uniforms[2]).toBe(51);
  const pdf = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.resize(1, true),
  );
  expect(pdf).toMatchObject({
    width: 4000,
    height: 2250,
    sameCanvas: true,
    unchanged: true,
    error: null,
  });
  expect(pdf.uniforms).toEqual([255, 255, 51, 255]);
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
});

test("nested CSS scale increases shader detail while rotation and translation retain it", async ({
  page,
}) => {
  await mount(page);
  const rotated = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.transform(
      "translate(123px, 45px) rotate(45deg)",
    ),
  );
  expect(rotated).toMatchObject({ width: 1920, height: 1080, error: null });
  const scaled = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.transform(
      "rotate(45deg) scale(2, 1)",
    ),
  );
  expect(scaled).toMatchObject({
    width: 3840,
    height: 2160,
    error: null,
    pixel: [0, 255, 0, 255],
  });
  expect(scaled.time).toBe(rotated.time);
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
});

test("density-only changes refresh paused shader sampling and preserve explicit PDF density", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = window.matchMedia.bind(window);
    const queries = new Map<string, MediaQueryList>();
    window.matchMedia = (text) => {
      if (!queries.has(text)) queries.set(text, native(text));
      return queries.get(text)!;
    };
  });
  await mount(page);
  const changed = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.density(2),
  );
  expect(changed).toMatchObject({
    width: 3840,
    height: 2160,
    unchanged: true,
    error: null,
  });
  const pdf = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.resize(1, true),
  );
  expect(pdf).toMatchObject({ width: 4000, height: 2250, error: null });
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
});

test("Motion sampling and backdrop inputs use the same transformed output detail", async ({
  page,
}) => {
  await mount(page);
  const start = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.motion(0),
  );
  const grown = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.motion(1000),
  );
  expect(start).toMatchObject({ width: 1920, height: 1080, error: null });
  expect(grown).toMatchObject({
    width: 3840,
    height: 2160,
    error: null,
    pixel: [0, 255, 0, 255],
  });
  const rewound = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.motion(0),
  );
  expect(rewound).toMatchObject({ width: 1920, height: 1080, error: null });
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
  await mount(page);
  const backdrop = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.backdrop(),
  );
  expect(backdrop).toMatchObject({
    width: 3840,
    height: 2160,
    error: null,
    pixel: [0, 255, 0, 255],
  });
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
});

test("shader allocation failure restores original content and context recreation repaints output", async ({
  page,
}) => {
  await mount(page);
  const failed = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.allocationFailure(),
  );
  expect(failed.error).toContain("Cannot allocate");
  expect(failed.hidden).toBe("hidden");
  expect(failed.originalOpacity).not.toBe("0");
  const recovered = await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.loseContext(),
  );
  expect(recovered).toMatchObject({
    error: null,
    pixel: [0, 255, 0, 255],
    unchanged: true,
  });
  await page.evaluate(() =>
    (window as unknown as SampleWindow).sampling.dispose(),
  );
});

test("shader time alone reuses the source while unregistered subtree mutations mark it dirty", async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const rasterPath = "/src/components/elementRaster.ts", runtimePath = "/src/components/effectRuntime.ts";
    const { rasterSourceDiagnostics }: typeof import("../../../src/components/elementRaster") = await import(/* @vite-ignore */ rasterPath);
    const { effectSurface }: typeof import("../../../src/components/effectRuntime") = await import(/* @vite-ignore */ runtimePath);
    const surface = document.querySelector<HTMLElement>("[data-effect-id]")!;
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await effectSurface(surface)!.flush();
    const before = rasterSourceDiagnostics().scans;
    for (let time = 1; time <= 10; time++) {
      effectSurface(surface)!.setTiming({ progress: 0.5, time, duration: 10 });
      await effectSurface(surface)!.flush();
    }
    const afterTime = rasterSourceDiagnostics().scans;
    surface.querySelector("[data-effect-source]")!.append(document.createTextNode("custom source mutation"));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    await effectSurface(surface)!.flush();
    return { before, afterTime, afterMutation: rasterSourceDiagnostics().scans };
  });
  expect(result.afterTime).toBe(result.before);
  expect(result.afterMutation).toBeGreaterThan(result.afterTime);
  await page.evaluate(() => (window as unknown as SampleWindow).sampling.dispose());
});
