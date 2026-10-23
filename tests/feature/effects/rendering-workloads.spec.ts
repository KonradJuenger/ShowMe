import {
  expect,
  test,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  RenderingWorkload,
  runRenderingWorkload,
} from "../../helpers/renderingWorkloadHarness";

test.use({ deviceScaleFactor: 1 });

const enabled = process.env.SHOWME_RENDERER_BENCHMARK === "1";

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

async function run(page: Page, kind: RenderingWorkload) {
  await page.goto("/tests/helpers/effects-harness.html");
  return page.evaluate(async (workload: RenderingWorkload) => {
    const modulePath = "/tests/helpers/renderingWorkloadHarness.tsx";
    const {
      runRenderingWorkload,
    }: typeof import("../../helpers/renderingWorkloadHarness") = await import(
      /* @vite-ignore */ modulePath
    );
    return runRenderingWorkload(workload);
  }, kind);
}

async function report(
  kind: RenderingWorkload,
  result: Awaited<ReturnType<typeof runRenderingWorkload>>,
  performance: { before: Record<string, number>; after: Record<string, number> },
  page: Page,
  testInfo: TestInfo,
) {
  const frames =
    "frames" in result && Array.isArray(result.frames)
      ? distribution(result.frames)
      : undefined;
  const metrics = Object.fromEntries(
    Object.keys(performance.after).map((key) => [
      key,
      performance.after[key] - (performance.before[key] ?? 0),
    ]),
  );
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    dpr: devicePixelRatio,
    width: innerWidth,
    height: innerHeight,
  }));
  const body = JSON.stringify(
    {
      schemaVersion: 1,
      workload: kind,
      environment,
      frames,
      metrics,
      result,
    },
    null,
    2,
  );
  await testInfo.attach(`renderer-${kind}.json`, {
    body,
    contentType: "application/json",
  });
  const output = process.env.SHOWME_RENDERER_BENCHMARK_OUTPUT;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, `${kind}-run-${testInfo.repeatEachIndex}.json`),
      body,
    );
  }
}

async function performanceMetrics(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const read = async () => {
    const result = await session.send("Performance.getMetrics");
    return Object.fromEntries(
      result.metrics
        .filter(({ name }: { name: string }) =>
          [
            "TaskDuration",
            "RecalcStyleCount",
            "RecalcStyleDuration",
            "LayoutCount",
            "LayoutDuration",
            "JSHeapUsedSize",
          ].includes(name),
        )
        .map(({ name, value }: { name: string; value: number }) => [
          name,
          name.endsWith("Duration") ? value * 1000 : value,
        ]),
    );
  };
  return { session, read };
}

test("renderer workload: native DOM CSS Motion Presence", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "benchmark-only workload");
  const perf = await performanceMetrics(page);
  const before = await perf.read();
  const result = await run(page, "native");
  const after = await perf.read();
  if (!("diagnostics" in result) || !("discovered" in result))
    throw new Error("Unexpected native workload result");
  expect(result.diagnostics.sceneCaptures).toBe(0);
  expect(result.diagnostics.domCaptures).toBe(0);
  expect(result.diagnostics.domClones).toBe(0);
  expect(result.discovered.styleReads).toBe(0);
  expect(result.discovered.queries).toBe(0);
  expect(result.discovered.canvasAllocations).toBe(0);
  await report("native", result, { before, after }, page, testInfo);
});

test("renderer workload: generated input-none shaders", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "benchmark-only workload");
  const perf = await performanceMetrics(page);
  const before = await perf.read();
  const result = await run(page, "generated");
  const after = await perf.read();
  if (!("diagnostics" in result) || !("contextCount" in result))
    throw new Error("Unexpected generated workload result");
  expect(result.diagnostics.sceneCaptures).toBe(0);
  expect(result.diagnostics.domCaptures).toBe(0);
  expect(result.diagnostics.canvas2dPresentationCopies).toBe(0);
  expect(result.diagnostics.shaderCompilations).toBe(0);
  expect(result.diagnostics.gpuOutputAllocations).toBe(0);
  expect(result.contextCount).toBe(4);
  await report("generated", result, { before, after }, page, testInfo);
});

test("renderer workload: retained SceneTexture revisit", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "benchmark-only workload");
  const perf = await performanceMetrics(page);
  const before = await perf.read();
  const result = await run(page, "scene-texture");
  const after = await perf.read();
  if (!("firstPreparation" in result) || !("revisit" in result))
    throw new Error("Unexpected SceneTexture workload result");
  expect(result.firstPreparation.sceneCaptures).toBeGreaterThan(0);
  expect(result.revisit.sceneCaptures).toBe(0);
  expect(result.revisit.domCaptures).toBe(0);
  expect(result.revisit.sceneRetainedReuses).toBeGreaterThan(0);
  await report("scene-texture", result, { before, after }, page, testInfo);
});
