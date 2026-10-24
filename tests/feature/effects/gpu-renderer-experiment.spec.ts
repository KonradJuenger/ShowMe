import { expect, test } from "@playwright/test";
import type { mountGpuRendererHarness } from "../../helpers/gpuRendererHarness";

type ExperimentWindow = Window & {
  gpuRendererExperiment: Awaited<ReturnType<typeof mountGpuRendererHarness>>;
};

test("transform-only Motion keeps Chromium text rasters and GPU resources stable", async ({
  page,
}) => {
  await page.goto("/tests/helpers/gpu-renderer-experiment.html?noReference=1");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { gpuRendererExperiment?: unknown }).gpuRendererExperiment),
  );
  const check = await page.evaluate(async () => {
    const harness = (window as unknown as ExperimentWindow).gpuRendererExperiment;
    const motion = await harness.transformOnlyCheck(72);
    const pixels = await harness.nativePixelChangeCheck();
    return { motion, pixels };
  });
  const result = check.motion;
  expect(result.after.errors).toEqual([]);
  expect(result.after.nativeRasterizations).toBe(
    result.before.nativeRasterizations,
  );
  expect(result.after.gpuUploads).toBe(result.before.gpuUploads);
  expect(result.after.renderTargetAllocations).toBe(
    result.before.renderTargetAllocations,
  );
  expect(result.after.renderTargetResizes).toBe(result.before.renderTargetResizes);
  expect(result.after.liveNativeSurfaces).toBeGreaterThanOrEqual(2);
  expect(result.after.nativeCacheHits).toBeGreaterThan(
    result.before.nativeCacheHits,
  );
  expect(result.after.shaderPublications).toBeGreaterThan(
    result.before.shaderPublications + 72 * 2,
  );
  expect(check.pixels.changed.nativeRasterizations).toBeGreaterThan(
    check.pixels.before.nativeRasterizations,
  );
});

test("direct media orientation, clipping stack and current-renderer parity stay inspectable", async ({
  page,
}) => {
  await page.goto("/tests/helpers/gpu-renderer-experiment.html");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { gpuRendererExperiment?: unknown }).gpuRendererExperiment),
  );
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as ExperimentWindow).gpuRendererExperiment;
    await harness.render(1200);
    return {
      parity: await harness.staticParity(1200),
      imageLeft: harness.renderer.readPixel(90, 182),
      imageRight: harness.renderer.readPixel(184, 170),
      diagnostics: harness.renderer.diagnostics(),
    };
  });
  expect(result.diagnostics.errors).toEqual([]);
  expect(result.imageLeft[0]).toBeGreaterThan(result.imageLeft[1]);
  expect(result.imageRight[1]).toBeGreaterThan(result.imageRight[0]);
  expect(result.parity.visible).toBeGreaterThan(10_000);
  expect(result.parity.meanAlphaError).toBeLessThan(8);
  // This is intentionally a coarse architecture check, not a golden-image
  // framework. Local hardware verification inspects the side-by-side scene.
  expect(result.parity.meanAbsoluteChannelError).toBeLessThan(80);
});


test("manual 1080p GPU renderer benchmark", async ({ page }) => {
  test.skip(
    process.env.SHOWME_GPU_BENCHMARK !== "1",
    "Run explicitly on the Radeon 880M reference machine",
  );
  await page.goto(
    "/tests/helpers/gpu-renderer-experiment.html?benchmark=1&noReference=1",
  );
  await page.waitForFunction(() =>
    Boolean((window as unknown as { gpuRendererExperiment?: unknown }).gpuRendererExperiment),
  );
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as ExperimentWindow).gpuRendererExperiment;
    await harness.transformOnlyCheck(6);
    const before = harness.renderer.diagnostics();
    const benchmark = await harness.runBenchmark(10_000);
    const after = harness.renderer.diagnostics();
    return { before, benchmark, after, ids: harness.effectIds };
  });
  console.log("SHOWME_GPU_RENDERER_BENCHMARK", JSON.stringify(result, null, 2));
  expect(result.after.errors).toEqual([]);
  expect(result.after.nativeRasterizations).toBe(
    result.before.nativeRasterizations,
  );
  expect(result.after.renderTargetAllocations).toBe(
    result.before.renderTargetAllocations,
  );
});
