import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RenderingWorkload } from "../../helpers/renderingWorkloadHarness";

type WorkloadResult = Awaited<
  ReturnType<
    (typeof import("../../helpers/renderingWorkloadHarness"))["runRenderingWorkload"]
  >
>;

test.use({ deviceScaleFactor: 1 });

const enabled = process.env.SHOWME_RENDERER_BENCHMARK === "1";
const baseline = process.env.SHOWME_RENDERER_BASELINE === "1";

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

async function run(
  page: Page,
  kind: RenderingWorkload,
  read: () => Promise<Record<string, number>>,
) {
  await page.addInitScript((value) => {
    (window as unknown as { rendererBaseline: boolean }).rendererBaseline =
      value;
  }, baseline);
  await page.goto("/tests/helpers/effects-harness.html");
  const performance = { before: {}, after: {} };
  await page.exposeFunction(
    "measureRendererWorkload",
    async (phase: "start" | "end") => {
      performance[phase === "start" ? "before" : "after"] = await read();
    },
  );
  const result = await page.evaluate(async (workload: RenderingWorkload) => {
    const modulePath = "/tests/helpers/renderingWorkloadHarness.tsx";
    const {
      runRenderingWorkload,
    }: typeof import("../../helpers/renderingWorkloadHarness") = await import(
      /* @vite-ignore */ modulePath
    );
    return runRenderingWorkload(workload, (phase) =>
      (
        window as unknown as {
          measureRendererWorkload(phase: "start" | "end"): Promise<void>;
        }
      ).measureRendererWorkload(phase),
    );
  }, kind);
  return { result, performance };
}

async function report(
  kind: RenderingWorkload,
  result: WorkloadResult,
  performance: {
    before: Record<string, number>;
    after: Record<string, number>;
  },
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
      schemaVersion: 2,
      baseline,
      unavailableCounters: baseline
        ? [
            "SceneTexture preparation/cache/reuse",
            "shader context/output diagnostics",
          ]
        : [],
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
  if (!enabled) return;
  const perf = await performanceMetrics(page);
  const { result, performance } = await run(page, "native", perf.read);
  if (!("diagnostics" in result) || !("discovered" in result))
    throw new Error("Unexpected native workload result");
  expect(result.frames.length).toBeGreaterThan(0);
  if (!baseline) {
    expect(result.diagnostics.sceneCaptures).toBe(0);
    expect(result.diagnostics.domCaptures).toBe(0);
    expect(result.diagnostics.domClones).toBe(0);
    expect(result.discovered.styleReads).toBe(0);
    expect(result.discovered.queries).toBe(0);
    expect(result.discovered.canvasAllocations).toBe(0);
  }
  await report("native", result, performance, page, testInfo);
});

test("renderer workload: generated input-none shaders", async ({
  page,
}, testInfo) => {
  if (!enabled) return;
  const perf = await performanceMetrics(page);
  const { result, performance } = await run(page, "generated", perf.read);
  if (
    !("diagnostics" in result) ||
    !("contextCount" in result) ||
    !("errors" in result)
  )
    throw new Error("Unexpected generated workload result");
  expect(result.frames.length).toBeGreaterThan(0);
  expect(result.errors).toEqual([]);
  if (!baseline) {
    expect(result.diagnostics.sceneCaptures).toBe(0);
    expect(result.diagnostics.domCaptures).toBe(0);
    expect(result.diagnostics.canvas2dPresentationCopies).toBe(0);
    expect(result.discovered.canvas2dCopies).toBe(0);
    expect(result.diagnostics.shaderCompilations).toBe(0);
    expect(result.diagnostics.gpuOutputAllocations).toBe(0);
    expect(result.contextCount).toBe(4);
  }
  await report("generated", result, performance, page, testInfo);
});

test("renderer workload: retained SceneTexture revisit", async ({
  page,
}, testInfo) => {
  if (!enabled) return;
  const perf = await performanceMetrics(page);
  const { result, performance } = await run(page, "scene-texture", perf.read);
  if (!("firstPreparation" in result) || !("revisit" in result))
    throw new Error("Unexpected SceneTexture workload result");
  expect(result.firstPreparation.sceneCaptures).toBeGreaterThan(0);
  if (!baseline) {
    expect(result.revisit.sceneCaptures).toBe(0);
    expect(result.revisit.domCaptures).toBe(0);
    expect(result.revisit.sceneRetainedReuses).toBeGreaterThan(0);
  }
  await report("scene-texture", result, performance, page, testInfo);
});

test("twelve simultaneous visible shader chains retain their contexts and release ownership", async ({
  page,
}) => {
  if (!enabled || baseline) return;
  await page.goto("/tests/helpers/effects-harness.html");
  const result = await page.evaluate(async () => {
    const modulePath = "/tests/helpers/renderingWorkloadHarness.tsx";
    const {
      runShaderContextStress,
    }: typeof import("../../helpers/renderingWorkloadHarness") = await import(
      /* @vite-ignore */ modulePath
    );
    return runShaderContextStress();
  });
  expect(result.errors).toEqual([]);
  expect(result.contextCount).toBe(12);
  expect(result.contextsAfterDispose).toBe(0);
  expect(result.discovered.canvas2dCopies).toBe(0);
  expect(result.discovered.shaderCompilations).toBe(0);
});
