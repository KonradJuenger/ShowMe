import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

declare global {
  interface Window {
    audienceStressMetrics: {
      frames: number[];
      longTasks: number[];
      last: number;
      running: boolean;
    };
  }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

test("audience stress benchmark renders dense animated slides and reports comparable performance", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    localStorage.setItem("showme.presentationDiagnostics", "true");
    const modulePath = "/tests/helpers/audienceNavigationHarness.tsx";
    const {
      mountAudienceNavigationHarness,
    }: typeof import("../../helpers/audienceNavigationHarness") = await import(
      /* @vite-ignore */ modulePath
    );
    mountAudienceNavigationHarness(true);
  });
  const settle = async () =>
    page.waitForFunction(() => {
      const state = window.audienceNavigationHarness.snapshot();
      return (
        !state.awaitingAudience &&
        document
          .querySelector(
            '[data-active-slide][data-images-prepared="true"] .slide-renderer',
          )
          ?.getAttribute("data-slide-id") === state.slideId
      );
    });
  await settle();
  await expect(
    page.locator("[data-active-slide] [data-effect-ready='true'] canvas"),
  ).toHaveCount(3);
  // Verify the workload is alive before collecting timing: real motion must advance.
  const animated = page.locator(
    '[data-active-slide] [data-element-id="image-0"]',
  );
  const initialTransform = await animated.evaluate(
    (node) => getComputedStyle(node).transform,
  );
  await expect
    .poll(() => animated.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe(initialTransform);
  const shaderClock = () =>
    page.evaluate(() =>
      document
        .querySelector('[data-active-slide] [data-effect-ready="true"] canvas')
        ?.closest<HTMLElement>("[data-effect-id]")
        ?.style.getPropertyValue("--t"),
    );
  const initialClock = await shaderClock();
  expect(initialClock).toBeTruthy();
  await expect.poll(shaderClock).not.toBe(initialClock);
  const before = await cdp.send("Performance.getMetrics");
  await page.evaluate(() => {
    performance.clearMeasures();
    window.audienceStressMetrics = {
      frames: [],
      longTasks: [],
      last: 0,
      running: true,
    };
    new PerformanceObserver((list) => {
      if (window.audienceStressMetrics.running)
        window.audienceStressMetrics.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
    }).observe({ type: "longtask" });
    const frame = (at: number) => {
      const metrics = window.audienceStressMetrics;
      if (!metrics.running) return;
      if (metrics.last) metrics.frames.push(at - metrics.last);
      metrics.last = at;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const navigation: Array<{
    pass: string;
    slide: number;
    readyMs: number;
    decodes: number;
    variants: number;
    mountedSlides: number;
    effectErrors: string[];
  }> = [];
  for (const pass of ["first", "revisit"]) {
    for (let index = 1; index < 30; index++) {
      const sample = await page.evaluate(async (index) => {
        const before = window.audienceNavigationHarness.snapshot();
        const start = performance.now();
        await window.audienceNavigationHarness.jump(index);
        await new Promise<void>((resolve) => {
          const ready = () => {
            const state = window.audienceNavigationHarness.snapshot();
            if (
              !state.awaitingAudience &&
              document
                .querySelector(
                  '[data-active-slide][data-images-prepared="true"] .slide-renderer',
                )
                ?.getAttribute("data-slide-id") === state.slideId
            )
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            else requestAnimationFrame(ready);
          };
          ready();
        });
        const after = window.audienceNavigationHarness.snapshot();
        return {
          readyMs: performance.now() - start,
          decodes: after.imageDecodes - before.imageDecodes,
          variants: after.preparedVariants - before.preparedVariants,
          mountedSlides: document.querySelectorAll(".slide-renderer").length,
          effectErrors: [
            ...document.querySelectorAll<HTMLElement>("[data-effect-error]"),
          ].map((node) => node.dataset.effectError ?? "Unknown effect failure"),
        };
      }, index);
      navigation.push({ pass, slide: index + 1, ...sample });
      // Actual animation/rendering dwell, using rAF rather than virtual time.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const until = performance.now() + 180;
            const frame = () =>
              performance.now() >= until
                ? resolve()
                : requestAnimationFrame(frame);
            requestAnimationFrame(frame);
          }),
      );
    }
    if (pass === "first") {
      await page.evaluate(() => window.audienceNavigationHarness.jump(0));
      await settle();
    }
  }
  const after = await cdp.send("Performance.getMetrics");
  const result = await page.evaluate(() => {
    window.audienceStressMetrics.running = false;
    return {
      ...window.audienceStressMetrics,
      workload: window.audienceNavigationHarness.workload,
      snapshot: window.audienceNavigationHarness.snapshot(),
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      mountedSlides: document.querySelectorAll(".slide-renderer").length,
      effectErrors: [
        ...document.querySelectorAll<HTMLElement>("[data-effect-error]"),
      ].map((node) => node.dataset.effectError),
      preparation: performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("ShowMe:"))
        .map((entry) => ({ name: entry.name, ms: entry.duration })),
    };
  });
  const metric = (list: typeof before.metrics, name: string) =>
    list.find((value) => value.name === name)?.value ?? 0;
  // Compare retained heap after GC instead of whichever allocation cycle happens
  // to be active. GC is outside the measured navigation/frame/CPU interval.
  await cdp.send("HeapProfiler.collectGarbage");
  const memory = await cdp.send("Performance.getMetrics");
  const shaderPixels = await page.evaluate(async () => {
    const runtimePath = "/src/components/effectRuntime.ts";
    const {
      effectSurface,
    }: typeof import("../../../src/components/effectRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    return [
      ...document.querySelectorAll<HTMLCanvasElement>(
        '[data-active-slide] [data-effect-ready="true"] canvas',
      ),
    ].map((canvas) => {
      // Paired main measurements have Canvas2D outputs. Readback is outside
      // every timed region on both revisions.
      const context2d = canvas.dataset.shaderStage
        ? null
        : canvas.getContext("2d");
      const surface = context2d ? null : effectSurface(canvas.parentElement!);
      surface?.materialize();
      const output = surface?.gpuOutput();
      const gl = output?.gl;
      const center = new Uint8Array(4);
      let pixels: Uint8Array | Uint8ClampedArray;
      if (context2d) {
        center.set(
          context2d.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data,
        );
        pixels = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
      } else if (gl) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, output!.framebuffer);
        gl.readPixels(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          center,
        );
        pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
      } else throw new Error("Shader output has no readable context");
      let textPixels = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3] &&
          pixels[i] < 160 &&
          pixels[i + 1] < 160 &&
          pixels[i + 2] < 160
        )
          textPixels++;
      return { center: Array.from(center), textPixels };
    });
  });
  const report = {
    schemaVersion: 2,
    workload: result.workload,
    shaderPixels,
    environment: {
      userAgent: result.userAgent,
      dpr: result.dpr,
      width: result.width,
      height: result.height,
    },
    summary: {
      firstNavigationMs: distribution(
        navigation
          .filter((sample) => sample.pass === "first")
          .map((sample) => sample.readyMs),
      ),
      revisitNavigationMs: distribution(
        navigation
          .filter((sample) => sample.pass === "revisit")
          .map((sample) => sample.readyMs),
      ),
      frameIntervalMs: distribution(result.frames),
      longTaskMs: distribution(result.longTasks),
      longTaskTotalMs: result.longTasks.reduce((sum, value) => sum + value, 0),
      taskCpuMs:
        (metric(after.metrics, "TaskDuration") -
          metric(before.metrics, "TaskDuration")) *
        1000,
      heapBytes: metric(memory.metrics, "JSHeapUsedSize"),
      domNodes: metric(memory.metrics, "Nodes"),
      imageRequests: result.snapshot.requests.length,
      peakMountedSlides: Math.max(
        result.mountedSlides,
        ...navigation.map((sample) => sample.mountedSlides),
      ),
      preparedVariants: result.snapshot.preparedVariants,
      imageDecodes: result.snapshot.imageDecodes,
    },
    navigation,
    frames: result.frames,
    longTasks: result.longTasks,
    preparation: result.preparation,
    errors: [
      ...errors,
      ...result.effectErrors,
      ...navigation.flatMap((sample) => sample.effectErrors),
    ],
  };
  const json = JSON.stringify(report, null, 2);
  await writeFile(testInfo.outputPath("audience-stress.json"), json);
  await testInfo.attach("audience-stress.json", {
    body: json,
    contentType: "application/json",
  });
  const screenshot = await page.screenshot({
    path: testInfo.outputPath("audience-stress.png"),
  });
  await testInfo.attach("audience-stress.png", {
    body: screenshot,
    contentType: "image/png",
  });
  if (process.env.SHOWME_AUDIENCE_BENCHMARK_OUTPUT) {
    await mkdir(process.env.SHOWME_AUDIENCE_BENCHMARK_OUTPUT, {
      recursive: true,
    });
    await writeFile(
      path.join(
        process.env.SHOWME_AUDIENCE_BENCHMARK_OUTPUT,
        `run-${testInfo.repeatEachIndex}.json`,
      ),
      json,
    );
    await writeFile(
      path.join(
        process.env.SHOWME_AUDIENCE_BENCHMARK_OUTPUT,
        `run-${testInfo.repeatEachIndex}.png`,
      ),
      screenshot,
    );
  }
  expect(report.errors).toEqual([]);
  expect(shaderPixels).toHaveLength(3);
  expect(
    shaderPixels.every(
      (sample) => sample.center[3] === 255 && sample.textPixels > 0,
    ),
    "Each animated shader must produce opaque panel pixels containing captured text",
  ).toBe(true);
  expect(report.summary.frameIntervalMs.samples).toBeGreaterThan(0);
  expect(report.summary.peakMountedSlides).toBeLessThanOrEqual(4);
  expect(result.snapshot.pendingVariants).toBe(0);
  expect(result.snapshot.preparedVariants).toBe(
    result.workload!.uniqueImageAssets,
  );
  await expect(
    page.locator("[data-active-slide] [data-media-asset-id] img"),
  ).toHaveCount(12);
  expect(
    navigation
      .filter((sample) => sample.pass === "revisit")
      .every((sample) => sample.variants === 0),
  ).toBe(true);
  await expect(
    page.locator("[data-active-slide] [data-effect-ready='true'] canvas"),
  ).toHaveCount(3);
});

async function settleAudience(page: Page) {
  await expect
    .poll(async () => {
      await page.clock.runFor(80);
      return page.evaluate(
        () => window.audienceNavigationHarness.snapshot().awaitingAudience,
      );
    })
    .toBe(false);
}

test("a late slide with a new image is prepared during the preceding slide instead of blocking audience navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await readyEditor(page);
  await page.clock.install();
  await page.evaluate(async () => {
    const path = "/tests/helpers/audienceNavigationHarness.tsx";
    const {
      mountAudienceNavigationHarness,
    }: typeof import("../../helpers/audienceNavigationHarness") = await import(
      /* @vite-ignore */ path
    );
    mountAudienceNavigationHarness();
  });
  await settleAudience(page);
  // Early navigation reuses the same already-prepared image.
  await page.evaluate(() => window.audienceNavigationHarness.jump(1));
  await settleAudience(page);
  const early = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );

  await page.evaluate(() => window.audienceNavigationHarness.jump(23));
  await settleAudience(page);
  await page.clock.runFor(1000);
  await page.evaluate(() => window.audienceNavigationHarness.releaseImages());
  await page.clock.runFor(160);
  const beforeLateEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await page.evaluate(() => window.audienceNavigationHarness.jump(24));
  await expect(
    page.locator("[data-active-slide] .slide-renderer"),
  ).toHaveAttribute(
    "data-slide-id",
    await page.evaluate(
      () => window.audienceNavigationHarness.snapshot().slideId,
    ),
  );
  await page.clock.runFor(3000);
  const lateEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await page.evaluate(() => window.audienceNavigationHarness.releaseImages());
  await settleAudience(page);
  await page.evaluate(() => window.audienceNavigationHarness.jump(23));
  await settleAudience(page);
  await page.evaluate(() => window.audienceNavigationHarness.jump(24));
  await settleAudience(page);
  const warmEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await testInfo.attach("synthetic-audience-navigation.json", {
    body: JSON.stringify(
      { early, beforeLateEntry, lateEntry, warmEntry },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(early.pendingVariants).toBe(0);
  expect(beforeLateEntry.lateImageDecodes).toBeGreaterThan(0);
  expect(
    lateEntry.lateImageDecodes,
    "The next slide's image must already be decoded before activation",
  ).toBe(beforeLateEntry.lateImageDecodes);
  expect(warmEntry.pendingVariants).toBe(0);
  expect(warmEntry.coldVariants).toBe(lateEntry.coldVariants);
  expect(
    lateEntry.coldVariants - beforeLateEntry.coldVariants,
    "Slide 25 must not start uncached image work after navigation; prepare and decode it while slide 24 is shown",
  ).toBe(0);
  expect(
    lateEntry.awaitingAudience,
    "Entering a prepared neighbour must not wait for image IO",
  ).toBe(false);
});
