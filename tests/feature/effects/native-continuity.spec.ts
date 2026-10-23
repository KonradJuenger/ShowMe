import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  continuityFaults,
  fadedReference,
  visualFrameError,
  presentationRgb,
} from "../../helpers/visualContinuity";
import type { mountNativeContinuity } from "../../helpers/nativeContinuityHarness";

declare global {
  interface Window {
    continuity: Awaited<ReturnType<typeof mountNativeContinuity>>;
  }
}
let server: ViteDevServer, app: ElectronApplication, page: Page;
test.beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 5199, strictPort: true },
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async () => {
  const directory = path.resolve("test-results-native-continuity");
  await mkdir(directory, { recursive: true });
  const main = path.join(directory, "main.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor','1');app.whenReady().then(()=>{new BrowserWindow({width:640,height:360,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}}).loadURL('http://127.0.0.1:5199/tests/helpers/effects-harness.html');});`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined && e[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  app = await electron.launch({ args: [main], env });
  page = await app.firstWindow();
});
test.afterEach(async ({ browserName: _browserName }, info) => {
  if (info.status !== info.expectedStatus && app) {
    const captured = await app
      .evaluate(() => {
        const frames =
          (globalThis as unknown as { continuityFrames?: { id: number }[] })
            .continuityFrames ?? [];
        return {
          count: frames.length,
          recentIds: frames.slice(-30).map((f) => f.id),
        };
      })
      .catch((error) => ({ error: String(error) }));
    const presented = await page
      .evaluate(() => ({
        requested: (window as unknown as { continuityRequested?: number })
          .continuityRequested,
        acknowledged: (window as unknown as { continuityPresented?: number })
          .continuityPresented,
      }))
      .catch((error) => ({ error: String(error) }));
    await info.attach("capture-acknowledgements", {
      body: JSON.stringify({ captured, presented }, null, 2),
      contentType: "application/json",
    });
  }
  await app?.close();
});

async function mount(
  background: "image" | "shader" = "image",
  grouped = false,
  mixed = false,
) {
  await page.evaluate(
    async ({ background, grouped, mixed }) => {
      const modulePath = "/tests/helpers/nativeContinuityHarness.ts";
      const {
        mountNativeContinuity,
      }: typeof import("../../helpers/nativeContinuityHarness") = await import(
        /* @vite-ignore */ modulePath
      );
      window.continuity = await mountNativeContinuity(
        background,
        grouped,
        mixed,
      );
    },
    { background, grouped, mixed },
  );
}
async function pixels(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const png = await page
    .locator(".slide-renderer")
    .screenshot({ scale: "css" });
  return {
    png,
    raw: await sharp(png)
      .extract({
        left: Math.round(rect.x),
        top: Math.round(rect.y),
        width: rect.width,
        height: rect.height,
      })
      .removeAlpha()
      .raw()
      .toBuffer(),
  };
}
async function observation(time: number) {
  const geometry = () =>
    page.evaluate(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-element-id="card"]',
      )!;
      const root = card.closest(".slide-renderer")!.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      return {
        x: rect.x - root.x + 50,
        y: rect.y - root.y + 40,
        width: 80,
        height: 30,
      };
    });
  // This fixture has a periodic checker blurred to a uniform interior. Capture
  // its fully presented native material through the canonical transport, not
  // by overriding authored/runtime opacity (which can leave compositor caches).
  await page.evaluate(() => window.continuity.sample(600));
  const full = await pixels(await geometry());
  await page.evaluate((time) => window.continuity.sample(time), time);
  const region = await geometry();
  const actual = await pixels(region);
  await page.locator('[data-element-id="card"]').evaluate((node) => {
    (node as HTMLElement).style.visibility = "hidden";
  });
  const background = await pixels(region);
  await page.locator('[data-element-id="card"]').evaluate((node) => {
    (node as HTMLElement).style.removeProperty("visibility");
  });
  const alpha =
    time <= 600
      ? time / 600
      : time < 1400
        ? 1
        : Math.max(0, 1 - (time - 1400) / 600);
  return {
    actual,
    expected: fadedReference(background.raw, full.raw, alpha),
    geometry: region,
    full,
    background,
  };
}

test("native glass retains filtered pixels on every sampled entrance and exit frame", async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(120000);
  await mount();
  const samples = [];
  for (const start of [0, 1400])
    for (let offset = 17; offset < 600; offset += 17) {
      const frame = start + offset;
      const result = await observation(frame);
      const error = visualFrameError(result.actual.raw, result.expected);
      samples.push({ frame, error });
      if (error > 3)
        await info.attach(`frame-${frame}`, {
          body: result.actual.png,
          contentType: "image/png",
        });
    }
  await info.attach("continuity.json", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
  expect(continuityFaults(samples, 3)).toEqual([]);
});

test("nested overlapping glass stays filtered over a shader through seeks and endpoints", async ({
  browserName: _browserName,
}, info) => {
  await mount("shader", true);
  const samples = [];
  for (const frame of [
    17, 100, 300, 599, 600, 601, 1000, 1400, 1700, 1983, 1999, 601, 300,
  ]) {
    const result = await observation(frame);
    if (frame === 300) {
      await writeFile(info.outputPath("actual.png"), result.actual.png);
      await writeFile(info.outputPath("opaque.png"), result.full.png);
      await writeFile(info.outputPath("background.png"), result.background.png);
    }
    samples.push({
      frame,
      error: visualFrameError(result.actual.raw, result.expected),
    });
  }
  await info.attach("nested-continuity.json", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
  await writeFile(
    info.outputPath("nested-continuity.json"),
    JSON.stringify(samples, null, 2),
  );
  await page
    .locator(".slide-renderer")
    .screenshot({ path: info.outputPath("nested.png"), scale: "css" });
  expect(continuityFaults(samples, 3)).toEqual([]);
  expect(await page.evaluate(() => window.continuity.inspect().errors)).toEqual(
    [],
  );
  // Bound the intentional overlap approximation against a once-faded fully
  // rendered group. This tolerance is specific to this material/fixture.
  await page.evaluate(() => window.continuity.sample(600));
  const overlap = { x: 320, y: 170, width: 20, height: 5 };
  const fullOverlap = await pixels(overlap);
  await page.evaluate(() => window.continuity.sample(300));
  const shift = await page
    .locator('[data-element-id="group"]')
    .evaluate((node) => node.getBoundingClientRect().y);
  const movingOverlap = { ...overlap, y: overlap.y + shift };
  const actualOverlap = await pixels(movingOverlap);
  await page.locator('[data-element-id="group"]').evaluate((node) => {
    (node as HTMLElement).style.visibility = "hidden";
  });
  const overlapBackground = await pixels(movingOverlap);
  await page.locator('[data-element-id="group"]').evaluate((node) => {
    (node as HTMLElement).style.removeProperty("visibility");
  });
  const overlapError = visualFrameError(
    actualOverlap.raw,
    fadedReference(overlapBackground.raw, fullOverlap.raw, 0.5),
  );
  await writeFile(
    info.outputPath("overlap-approximation.json"),
    JSON.stringify(
      { alpha: 0.5, meanChannelError: overlapError, limit: 24 },
      null,
      2,
    ),
  );
  expect(overlapError).toBeLessThanOrEqual(24);
});

test("pixel detector catches a single missing element and a single unfiltered frame", async ({
  browserName: _browserName,
}, info) => {
  await mount();
  const clean = await observation(600);
  const samples = [
    { frame: 0, error: visualFrameError(clean.actual.raw, clean.expected) },
  ];
  await page.locator('[data-element-id="card"]').evaluate((node) => {
    (node as HTMLElement).style.visibility = "hidden";
  });
  const hidden = await pixels(clean.geometry);
  samples.push({
    frame: 1,
    error: visualFrameError(hidden.raw, clean.expected),
  });
  await page.locator('[data-element-id="card"]').evaluate((node) => {
    (node as HTMLElement).style.removeProperty("visibility");
  });
  const restored = await pixels(clean.geometry);
  samples.push({
    frame: 2,
    error: visualFrameError(restored.raw, clean.expected),
  });
  await page
    .locator('[data-element-id="card"] [data-effect-id]')
    .evaluate((node) => {
      (node as HTMLElement).style.backdropFilter = "none";
    });
  const unfiltered = await pixels(clean.geometry);
  samples.push({
    frame: 3,
    error: visualFrameError(unfiltered.raw, clean.expected),
  });
  await page
    .locator('[data-element-id="card"] [data-effect-id]')
    .evaluate((node) => {
      (node as HTMLElement).style.removeProperty("backdrop-filter");
    });
  samples.push({
    frame: 4,
    error: visualFrameError((await pixels(clean.geometry)).raw, clean.expected),
  });
  await info.attach("detector.json", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
  expect(continuityFaults(samples, 3).map((s) => s.frame)).toEqual([1, 3]);
});

test("presentation capture detects each injected faulty state without unobserved transitions", async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(60000);
  await mount("shader");
  const clean = await observation(600);
  const tones: Buffer[] = [];
  for (const tone of [0, 1]) {
    await page
      .locator('[data-element-id="card"] [data-effect-id]')
      .evaluate((node, tone) => {
        (node as HTMLElement).style.backgroundColor = tone
          ? "rgba(255,70,70,.55)"
          : "rgba(70,255,70,.55)";
      }, tone);
    tones.push((await pixels(clean.geometry)).raw);
  }
  await page.evaluate(() => {
    (window as unknown as { continuityPresented: number }).continuityPresented =
      0;
    const marker = document.createElement("canvas");
    marker.id = "continuity-marker";
    marker.width = 16;
    marker.height = 8;
    marker.style.cssText =
      "position:fixed;left:0;top:350px;width:16px;height:8px;z-index:99999";
    document.body.append(marker);
  });
  await app.evaluate(({ BrowserWindow }, rect) => {
    const frames: { id: number; at: number; pixels: string }[] = [];
    (
      globalThis as unknown as { continuityFrames: typeof frames }
    ).continuityFrames = frames;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.beginFrameSubscription(false, (image) => {
      const marker = image
        .crop({ x: 2, y: 352, width: 1, height: 1 })
        .toBitmap();
      const id = marker[2];
      if (marker[0] !== 71 || marker[1] !== 255 - id || id < 1 || id > 110)
        return;
      frames.push({
        id,
        at: performance.now(),
        pixels: image
          .crop({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: rect.width,
            height: rect.height,
          })
          .toBitmap()
          .toString("base64"),
      });
      void contents
        .executeJavaScript(`window.continuityPresented=${id}`)
        .catch(() => {});
    });
  }, clean.geometry);
  await page.evaluate(async () => {
    const card = document.querySelector<HTMLElement>(
      '[data-element-id="card"]',
    )!;
    const effect = card.querySelector<HTMLElement>("[data-effect-id]")!;
    const shader = document.querySelector<HTMLElement>(
      '[data-element-id="checker"] canvas',
    )!;
    const marker = document
      .querySelector<HTMLCanvasElement>("#continuity-marker")!
      .getContext("2d")!;
    let frame = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        // Frame subscription may downsample the display. Hold each fixture state
        // until its real presentation is observed, never silently miss a fault.
        // This qualifies pixels, not natural-rate frame pacing/performance.
        if (
          frame > 0 &&
          (window as unknown as { continuityPresented: number })
            .continuityPresented !== frame
        ) {
          requestAnimationFrame(tick);
          return;
        }
        if (frame === 110) {
          resolve();
          return;
        }
        frame++;
        (
          window as unknown as { continuityRequested: number }
        ).continuityRequested = frame;
        card.style.visibility = frame === 20 ? "hidden" : "";
        effect.style.backdropFilter = frame === 40 ? "none" : "";
        shader.style.visibility = frame === 60 ? "hidden" : "";
        effect.style.setProperty("opacity", frame === 80 ? "0.2" : "1");
        const tone = (frame === 100 ? 99 : frame) % 2;
        effect.style.backgroundColor = tone
          ? "rgba(255,70,70,.55)"
          : "rgba(70,255,70,.55)";
        marker.fillStyle = `rgb(${frame},${255 - frame},71)`;
        marker.fillRect(0, 0, 16, 8);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  const frames = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
    return (
      globalThis as unknown as {
        continuityFrames: { id: number; at: number; pixels: string }[];
      }
    ).continuityFrames;
  });
  const seen = new Set(frames.map((f) => f.id));
  const missing = Array.from({ length: 110 }, (_, i) => i + 1).filter(
    (id) => !seen.has(id),
  );
  const samples = frames.map((frame) => {
    const bgra = Buffer.from(frame.pixels, "base64");
    const rgb = presentationRgb(bgra);
    return {
      frame: frame.id,
      error: visualFrameError(rgb, tones[frame.id % 2]),
    };
  });
  const faults = [...new Set(continuityFaults(samples, 3).map((f) => f.frame))];
  for (const id of faults) {
    const strips: Buffer[] = [];
    for (const adjacent of [id - 1, id, id + 1]) {
      const frame = frames.find((frame) => frame.id === adjacent);
      if (!frame) continue;
      const rgb = presentationRgb(Buffer.from(frame.pixels, "base64"));
      strips.push(
        await sharp(rgb, {
          raw: {
            width: clean.geometry.width,
            height: clean.geometry.height,
            channels: 3,
          },
        })
          .resize(300, 120, { kernel: "nearest" })
          .png()
          .toBuffer(),
      );
    }
    if (strips.length === 3) {
      const png = await sharp({
        create: { width: 900, height: 120, channels: 3, background: "white" },
      })
        .composite(
          strips.map((input, index) => ({ input, left: index * 300, top: 0 })),
        )
        .png()
        .toBuffer();
      await info.attach(`fault-${id}-before-during-after`, {
        body: png,
        contentType: "image/png",
      });
      await writeFile(
        info.outputPath(`fault-${id}-before-during-after.png`),
        png,
      );
    }
  }
  await writeFile(
    info.outputPath("presentation-capture.json"),
    JSON.stringify(
      {
        mode: "presentation-acknowledged states; not full-rate display coverage",
        missing,
        faults,
        samples,
      },
      null,
      2,
    ),
  );
  expect(missing, "Capture gaps can hide a single-frame flash").toEqual([]);
  expect(faults).toEqual([20, 40, 60, 80, 100]);
});

test("native playback meets frame pacing and captured seek response budgets", async ({
  browserName: _browserName,
}, info) => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await mount("image", true);
  // No pixel capture during timing collection: capture is intentionally isolated
  // from the frame-pacing measurement and measured as response latency afterward.
  const intervals = await page.evaluate(async () => {
    await window.continuity.sample(0, true);
    const frames: number[] = [];
    let last = performance.now();
    const until = last + 2100;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (now < until) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    await window.continuity.sample(600);
    return frames.slice(2);
  });
  const reference = await observation(600);
  const replies: number[] = [];
  for (const time of [300, 600, 300, 600, 300]) {
    const alpha = time / 600;
    const expected = fadedReference(
      reference.background.raw,
      reference.full.raw,
      alpha,
    );
    await app.evaluate(
      ({ BrowserWindow }, { rect, expected }) => {
        const state = { visibleAt: 0 };
        (
          globalThis as unknown as { seekObservation: typeof state }
        ).seekObservation = state;
        BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(
          false,
          (image) => {
            const bgra = image
              .crop({ x: 170, y: 120, width: rect.width, height: rect.height })
              .toBitmap();
            let error = 0;
            for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3)
              error +=
                Math.abs(bgra[i + 2] - expected[j]) +
                Math.abs(bgra[i + 1] - expected[j + 1]) +
                Math.abs(bgra[i] - expected[j + 2]);
            if (error / expected.length <= 3 && !state.visibleAt)
              state.visibleAt = Date.now();
          },
        );
      },
      { rect: reference.geometry, expected: [...expected] },
    );
    const startedAt = await page.evaluate(async (time) => {
      const started = Date.now();
      await window.continuity.sample(time);
      return started;
    }, time);
    await expect
      .poll(
        () =>
          app.evaluate(
            () =>
              (
                globalThis as unknown as {
                  seekObservation: { visibleAt: number };
                }
              ).seekObservation.visibleAt,
          ),
        { timeout: 2000 },
      )
      .toBeGreaterThan(0);
    const visibleAt = await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
      return (
        globalThis as unknown as { seekObservation: { visibleAt: number } }
      ).seekObservation.visibleAt;
    });
    replies.push(visibleAt - startedAt);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  const report = {
    captureDuringPacing: false,
    intervals,
    p95: percentile(0.95),
    p99: percentile(0.99),
    longestGap: Math.max(...intervals),
    capturedSeekResponseMs: replies,
    userAgent: await page.evaluate(() => navigator.userAgent),
  };
  await writeFile(
    info.outputPath("playback-performance.json"),
    JSON.stringify(report, null, 2),
  );
  expect(intervals.length).toBeGreaterThan(60);
  expect(report.p95).toBeLessThanOrEqual(20);
  expect(report.p99).toBeLessThanOrEqual(33.4);
  expect(report.longestGap).toBeLessThanOrEqual(50);
  expect(Math.min(...replies)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...replies)).toBeLessThanOrEqual(100);
});

test("live native Presence playback has no flicker in captured presentation samples", async ({
  browserName: _browserName,
}, info) => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await mount("shader");
  const reference = await observation(600);
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.id = "live-marker";
    canvas.width = 8;
    canvas.height = 4;
    canvas.style.cssText =
      "position:fixed;left:0;top:350px;width:8px;height:4px;z-index:99999";
    document.body.append(canvas);
  });
  await app.evaluate(({ BrowserWindow }) => {
    const frames: {
      id: number;
      time: number;
      alpha: number;
      pixels: string;
    }[] = [];
    (globalThis as unknown as { liveFrames: typeof frames }).liveFrames =
      frames;
    BrowserWindow.getAllWindows()[0].webContents.beginFrameSubscription(
      false,
      (image) => {
        const marker = image
          .crop({ x: 0, y: 350, width: 2, height: 1 })
          .toBitmap();
        const id = marker[2];
        if (marker[0] !== 71 || marker[1] !== 255 - id || id === 0) return;
        frames.push({
          id,
          time: marker[5] + marker[4] * 256,
          alpha: marker[6] / 255,
          pixels: image
            .crop({ x: 170, y: 120, width: 80, height: 30 })
            .toBitmap()
            .toString("base64"),
        });
      },
    );
  });
  const emitted = await page.evaluate(async () => {
    const started = Date.now();
    await window.continuity.sample(0, true);
    const effect = document.querySelector<HTMLElement>(
      '[data-element-id="card"] [data-effect-id]',
    )!;
    const marker = document
      .querySelector<HTMLCanvasElement>("#live-marker")!
      .getContext("2d")!;
    const emitted: { id: number; time: number; alpha: number }[] = [];
    let index = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const time = Math.round(Date.now() - started),
          id = (index++ % 254) + 1;
        const alpha = effect.closest('[data-presentation-absent="true"]')
          ? 0
          : Number(getComputedStyle(effect).opacity);
        marker.fillStyle = `rgb(${id},${255 - id},71)`;
        marker.fillRect(0, 0, 1, 1);
        marker.fillStyle = `rgb(${Math.round(alpha * 255)},${time % 256},${Math.floor(time / 256)})`;
        marker.fillRect(1, 0, 1, 1);
        emitted.push({ id, time, alpha });
        if (time < 2050) requestAnimationFrame(tick);
        else requestAnimationFrame(() => resolve());
      };
      requestAnimationFrame(tick);
    });
    return emitted;
  });
  const captured = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
    return (
      globalThis as unknown as {
        liveFrames: {
          id: number;
          time: number;
          alpha: number;
          pixels: string;
        }[];
      }
    ).liveFrames;
  });
  const samples = captured.map((frame) => {
    const rgb = presentationRgb(Buffer.from(frame.pixels, "base64"));
    return {
      frame: frame.time,
      error: visualFrameError(
        rgb,
        fadedReference(
          reference.background.raw,
          reference.full.raw,
          frame.alpha,
        ),
      ),
    };
  });
  const observed = new Set(captured.map((f) => `${f.id}:${f.time}`));
  const missing = emitted
    .filter((f) => !observed.has(`${f.id}:${f.time}`))
    .map((f) => f.time);
  const faults = continuityFaults(samples, 3);
  await writeFile(
    info.outputPath("live-continuity.json"),
    JSON.stringify(
      {
        coverage: missing.length
          ? "sampled; some display states unobserved"
          : "all fixture marker states observed",
        emitted: emitted.length,
        captured: captured.length,
        missing,
        faults,
        samples,
      },
      null,
      2,
    ),
  );
  expect(captured.length).toBeGreaterThan(20);
  expect(samples.at(-1)!.frame - samples[0].frame).toBeGreaterThan(1500);
  expect(faults).toEqual([]);
  // This verdict is deliberately limited to observed frames. The separate
  // acknowledged fault test covers every injected state, without claiming that
  // the native subscription can see every high-refresh display frame.
});

test("moving video and JS text remain visible inside animated native glass", async ({
  browserName: _browserName,
}, info) => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].showInactive(),
  );
  await mount("shader", false, true);
  const measurements = [];
  for (const time of [300, 599, 600, 601, 1000, 1700, 300]) {
    await page.evaluate((time) => window.continuity.sample(time), time);
    const state = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(
        '[data-element-id="movie"] video',
      )!;
      const region = video.getBoundingClientRect();
      return {
        time: video.currentTime,
        decoded: video.getVideoPlaybackQuality().totalVideoFrames,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        rect: { x: region.x + 10, y: region.y + 5, width: 60, height: 25 },
        text: document.querySelector("[data-effect-text-output]")?.textContent,
      };
    });
    const frame = await pixels(state.rect);
    let red = 0,
      blue = 0;
    for (let i = 0; i < frame.raw.length; i += 3) {
      red += frame.raw[i];
      blue += frame.raw[i + 2];
    }
    const redAdvantage = (red - blue) / (frame.raw.length / 3);
    measurements.push({ sample: time, ...state, redAdvantage });
    expect(state.width).toBe(80);
    expect(state.height).toBe(40);
    expect(state.paused).toBe(false);
    expect(state.text).toContain("Native glass");
    expect(
      redAdvantage,
      "Video must contribute visible red pixels on every sample",
    ).toBeGreaterThan(15);
  }
  await writeFile(
    info.outputPath("mixed-video-continuity.json"),
    JSON.stringify(measurements, null, 2),
  );
  expect(new Set(measurements.map((m) => m.time)).size).toBeGreaterThan(1);
  expect(measurements.at(-1)!.decoded).toBeGreaterThan(measurements[0].decoded);
  expect(await page.evaluate(() => window.continuity.inspect().errors)).toEqual(
    [],
  );
});
