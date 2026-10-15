import { _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Use a production build: npm run build, then npm run benchmark:animation -- file.sme.
if (!process.argv[2]) throw new Error("Usage: npm run benchmark:animation -- presentation.sme [slide]");
const file = path.resolve(process.argv[2]);
const cacheEnabled = process.env.SHOWME_BENCHMARK_IMAGE_CACHE !== "off";
const previewMode = process.env.SHOWME_BENCHMARK_PREVIEW_MODE ?? "normal";
if (!["normal", "blank-console", "console-placeholder-images"].includes(previewMode)) throw new Error("Unknown diagnostic preview mode");
const navigationDelayMs = Number(process.env.SHOWME_BENCHMARK_NAVIGATION_DELAY_MS ?? 0);
if (!Number.isFinite(navigationDelayMs) || navigationDelayMs < 0) throw new Error("Invalid navigation delay");
const output = path.resolve(`test-results-image-cache-benchmark-${previewMode}-cache-${cacheEnabled ? "on" : "off"}-delay-${navigationDelayMs}`);
const openedAt = Date.now();
const sourceBytes = await readFile(file);
const sourceDocumentDigest = createHash("sha256").update(sourceBytes).digest("hex");
const source = JSON.parse(sourceBytes.toString("utf8"));
const index =
  process.argv[3] === undefined
    ? source.deck.slideIds.findIndex(
        (id) => source.slides[id].motion?.stages.length,
      )
    : Number(process.argv[3]) - 1;
if (index < 0) throw new Error("Document has no animated slide");
const slide = source.slides[source.deck.slideIds[index]];
if (!slide?.motion?.stages.length)
  throw new Error(
    "Requested slide has no animation (slide numbers start at 1)",
  );
const stage = slide.motion.stages[0];
const duration = Math.max(
  ...stage.tracks.flatMap((t) => t.keyframes.map((k) => k.at)),
  0,
);
const ids = [...new Set(stage.tracks.map((t) => t.elementId))];
const root = await mkdtemp(path.join(os.tmpdir(), "showme-benchmark-"));
let app;
try {
  await mkdir(output, { recursive: true });
  await mkdir(path.join(root, "user"));
  // Benchmark copies of originals in a fresh library, preserving the user's cache.
  const settingsPath =
    process.env.APPDATA &&
    path.join(process.env.APPDATA, "show-me", "settings.json");
  if (settingsPath) {
    const settings = await readFile(settingsPath, "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    if (!settings.showMeRootPath)
      throw new Error("ShowMe root is not configured for this benchmark");
    const library = path.join(settings.showMeRootPath, "Library");
    const isolatedRoot = path.join(root, "ShowMe Root");
    const isolatedLibrary = path.join(isolatedRoot, "Library");
    const assets = new Set();
    const visit = (elements) => {
      for (const element of elements) {
        if (element.content?.assetId) assets.add(element.content.assetId);
        visit(element.children);
      }
    };
    for (const slide of Object.values(source.slides))
      for (const node of slide.nodes) visit(node.children);
    for (const folder of ["images", "video", "audio", "fonts"]) {
      await mkdir(path.join(isolatedLibrary, folder), { recursive: true });
      for (const name of await readdir(path.join(library, folder)).catch(
        () => [],
      )) {
        if (
          folder === "fonts" ||
          [...assets].some((id) => name.includes(`__${id}.`))
        )
          await cp(
            path.join(library, folder, name),
            path.join(isolatedLibrary, folder, name),
          );
      }
    }
    await writeFile(
      path.join(root, "user", "settings.json"),
      JSON.stringify({
        showMeRootPath: isolatedRoot,
        imageCachingEnabled: cacheEnabled,
      }),
    );
  }
  const isolatedRoot = path.join(root, "ShowMe Root");
  await mkdir(path.join(isolatedRoot, "Library"), { recursive: true });
  const copy = path.join(isolatedRoot, path.basename(file));
  await writeFile(copy, sourceBytes);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      path.resolve("."),
      `--user-data-dir=${path.join(root, "user")}`,
      copy,
    ],
    env,
  });
  if (previewMode === "blank-console") {
    // Diagnostic ablation only: keep the native window/session lifecycle, but
    // omit the console renderer to isolate its decode/raster/GPU workload.
    await app.evaluate(({ BrowserWindow }) => {
      const original = BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile = function (file, options) {
        if (options?.query?.present === "console") return this.loadURL("about:blank");
        return original.call(this, file, options);
      };
    });
  }
  if (previewMode === "console-placeholder-images") {
    await app.context().addInitScript(() => {
      if (!location.search.includes("present=console")) return;
      const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
      const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      Object.defineProperty(HTMLImageElement.prototype, "src", { ...source, set(value) { source.set.call(this, value ? pixel : value); } });
      const attribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        return attribute.call(this, name, this instanceof HTMLImageElement && name === "src" && value ? pixel : value);
      };
    });
  }
  await app.context().addInitScript(
    ({ ids }) => {
      localStorage.setItem("showme.presentationDiagnostics", "true");
      if (!location.search.includes("present=audience")) return;
      window.showmeBenchmark = { frames: [], longTasks: [], sampleCosts: [] };
      new PerformanceObserver((list) => {
        window.showmeBenchmark.longTasks.push(
          ...list
            .getEntries()
            .map((e) => ({ start: e.startTime, duration: e.duration })),
        );
      }).observe({ type: "longtask", buffered: true });
      function sample(at) {
        const start = performance.now();
        const active = document.querySelector("[data-active-slide]");
        const animations = ids.map((id) => {
          const node = active?.querySelector(`[data-element-id="${id}"]`);
          if (!node) return { id, missing: true };
          const style = getComputedStyle(node);
          return {
            id,
            opacity: Number(style.opacity),
            transform: style.transform,
          };
        });
        window.showmeBenchmark.frames.push({
          at,
          active: Boolean(active),
          ready: active?.dataset.imagesPrepared,
          animations,
        });
        window.showmeBenchmark.sampleCosts.push(performance.now() - start);
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    },
    { ids },
  );
  const editor = await app.firstWindow();
  await editor.getByTestId("stage").waitFor();
  const preparation = [];
  async function waitForImages() {
    if (!cacheEnabled) return null;
    const started = Date.now();
    while (Date.now() - started < 120000) {
      const status = await editor.evaluate(
        (id) => window.desktop.imageReadiness(id),
        source.documentId,
      );
      if (status?.state === "failed")
        throw new Error(JSON.stringify(status.failures));
      if (status?.state === "ready") return status;
      await editor.waitForTimeout(100);
    }
    throw new Error("Image preparation did not become ready");
  }
  const openedReadiness = await waitForImages();
  preparation.push({
    phase: "open",
    readiness: openedReadiness,
    milliseconds: Date.now() - openedAt,
    diagnostics: await editor.evaluate(() =>
      window.desktop.presentationImageDiagnostics(),
    ),
  });
  const reopenedAt = Date.now();
  await editor.evaluate(
    async ({ id, file }) => {
      await window.desktop.closeDocument(id);
      await window.desktop.openDocumentFile(file);
    },
    { id: source.documentId, file: copy },
  );
  const reopenedReadiness = await waitForImages();
  preparation.push({
    phase: "cache-hit-reopen",
    readiness: reopenedReadiness,
    milliseconds: Date.now() - reopenedAt,
    diagnostics: await editor.evaluate(() =>
      window.desktop.presentationImageDiagnostics(),
    ),
  });
  if (preparation[1].diagnostics.jobs !== preparation[0].diagnostics.jobs)
    throw new Error("Cache-hit reopen generated images");
  await writeFile(
    path.join(output, "preparation.json"),
    JSON.stringify(preparation, null, 2),
  );
  console.log(JSON.stringify(preparation, null, 2));
  // Chromium Tracing is browser-wide. Start BEFORE creating the audience.
  const cdp = await app.context().newCDPSession(editor);
  let trace = [];
  cdp.on("Tracing.dataCollected", ({ value }) => trace.push(...value));
  const summaries = [];
  let audience;
  const readyJobs = preparation[1].diagnostics.jobs;
  for (const mode of ["cold-entry", "warm-repeat", "new-audience-navigation"]) {
    if (mode === "new-audience-navigation") {
      const closed = audience.waitForEvent("close");
      await editor.evaluate(() => window.desktop.closePresentation());
      await closed;
      audience = undefined;
    }
    trace = [];
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,blink.user_timing,cc,gpu,v8,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
      transferMode: "ReportEvents",
    });
    if (!audience) {
      const windowPromise = app.waitForEvent("window", (page) =>
        page.url().includes("present=audience"),
      );
      const initialIndex =
        mode === "new-audience-navigation" ? Math.max(0, index - 1) : index;
      await editor.evaluate(
        async ({ deck, index }) =>
          window.desktop.present({
            deckId: deck.id,
            slideIds: deck.slideIds,
            index,
          }),
        { deck: source.deck, index: initialIndex },
      );
      audience = await windowPromise;
      await audience.waitForLoadState();
      if (mode === "new-audience-navigation") {
        await audience.locator('[data-active-slide][data-images-prepared="true"]').waitFor({ timeout: 15000 });
        if (navigationDelayMs) await new Promise(resolve => setTimeout(resolve, navigationDelayMs));
        await editor.evaluate(
          (index) =>
            window.desktop.presentationCommand({ type: "jump", index }),
          index,
        );
      }
    } else {
      await audience.evaluate(() => {
        window.showmeBenchmark.frames = [];
        window.showmeBenchmark.longTasks = [];
        window.showmeBenchmark.sampleCosts = [];
        performance.clearMeasures();
      });
      // Jump re-enters stage zero. restart-media only restarts media elements.
      await editor.evaluate(
        (index) => window.desktop.presentationCommand({ type: "jump", index }),
        index,
      );
    }
    await audience
      .locator('[data-active-slide][data-images-prepared="true"]')
      .waitFor({ timeout: 15000 });
    await audience.waitForFunction(
      (slideId) =>
        performance
          .getEntriesByName("ShowMe:motion-sync")
          .some((e) => e.detail?.running && e.detail.slideId === slideId),
      slide.id,
      { timeout: 15000 },
    );
    await audience.waitForTimeout(duration + 500);
    const data = await audience.evaluate(() => ({
      ...window.showmeBenchmark,
      measures: performance
        .getEntriesByType("measure")
        .filter((e) => e.name.startsWith("ShowMe:"))
        .map((e) => ({
          name: e.name,
          start: e.startTime,
          duration: e.duration,
          detail: e.detail,
        })),
      images: [...document.querySelectorAll("[data-active-slide] img")].map(
        (i) => ({
          complete: i.complete,
          width: i.naturalWidth,
          height: i.naturalHeight,
        }),
      ),
      error: document.querySelector("main")?.dataset.error,
      missingAssets: document.querySelectorAll(
        '[data-active-slide] [aria-label="Missing asset"]',
      ).length,
      mediaStillLoading: document.querySelectorAll(
        '[data-active-slide] [data-media-loading="true"]',
      ).length,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
    }));
    const done = new Promise((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    );
    await cdp.send("Tracing.end");
    await done;
    await writeFile(
      path.join(output, `${mode}.trace.json`),
      JSON.stringify({ traceEvents: trace }),
    );
    await writeFile(
      path.join(output, `${mode}.samples.json`),
      JSON.stringify(data, null, 2),
    );
    const start = data.measures.find(
      (e) =>
        e.name === "ShowMe:motion-sync" &&
        e.detail.slideId === slide.id &&
        e.detail.running,
    );
    const traceStart = trace.find(
      (event) =>
        event.name === "ShowMe:motion-sync" &&
        event.ph === "b" &&
        Math.abs((event.args?.startTime ?? -1) - start.start) < 0.01 &&
        JSON.parse(event.args?.detail ?? "{}").slideId === slide.id,
    );
    const clockOffset = traceStart ? traceStart.ts / 1000 - start.start : 0;
    const mainThreadEvents = traceStart
      ? trace
          .filter(
            (event) =>
              event.pid === traceStart.pid &&
              event.tid === traceStart.tid &&
              event.ph === "X" &&
              event.dur > 16_670 &&
              [
                "Decode Image",
                "MajorGC",
                "Layout",
                "UpdateLayoutTree",
                "Paint",
                "EvaluateScript",
                "FunctionCall",
              ].includes(event.name),
          )
          .sort((a, b) => b.dur - a.dur)
          .slice(0, 12)
          .map((event) => ({
            name: event.name,
            durationMs: event.dur / 1000,
            startMs: event.ts / 1000 - clockOffset,
            overlapsPlayback:
              event.ts / 1000 - clockOffset < start.start + duration &&
              event.ts / 1000 - clockOffset + event.dur / 1000 > start.start,
          }))
      : [];
    const frames = data.frames.filter(
      (f) =>
        f.at >= start.start &&
        f.at <= start.start + duration - start.detail.time,
    );
    const gaps = frames
      .slice(1)
      .map((f, i) => f.at - frames[i].at)
      .sort((a, b) => a - b);
    const cacheDiagnostics = await editor.evaluate(() =>
      window.desktop.presentationImageDiagnostics(),
    );
    if (
      cacheDiagnostics.jobs !== readyJobs ||
      data.measures.some((measure) =>
        /image-resize|image-png-encode/.test(measure.name),
      )
    )
      throw new Error("Ready presentation generated images");
    const summary = {
      mode,
      previewMode,
      cacheEnabled,
      navigationDelayMs,
      sourceDocumentDigest,
      processRoles: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ url: window.webContents.getURL(), pid: window.webContents.getOSProcessId() }))),
      cacheDiagnostics,
      slideId: slide.id,
      duration,
      viewport: data.viewport,
      images: data.images,
      error: data.error,
      missingAssets: data.missingAssets,
      mediaStillLoading: data.mediaStillLoading,
      frameCountDuringPlayback: frames.length,
      maximumGapMs: gaps.at(-1) ?? null,
      p95GapMs: gaps[Math.floor(gaps.length * 0.95)] ?? null,
      gapsOver33ms: gaps.filter((g) => g > 33.34).length,
      playbackStartedAtMs: start.start,
      firstPlaybackFrameDelayMs: frames.length
        ? frames[0].at - start.start
        : null,
      distinctAnimationSamples: new Set(
        frames.map((f) => JSON.stringify(f.animations)),
      ).size,
      maximumSamplingCostMs: Math.max(...data.sampleCosts, 0),
      longTasks: data.longTasks,
      audienceProcess: traceStart
        ? { pid: traceStart.pid, mainThreadId: traceStart.tid }
        : null,
      mainThreadEvents,
      measures: data.measures,
      traceScope:
        "All Electron processes; audience samples and User Timing entries identify playback",
    };
    summaries.push(summary);
    console.log(JSON.stringify({ ...summary, measures: undefined }, null, 2));
    await audience.screenshot({ path: path.join(output, `${mode}.png`) });
    if (
      data.error ||
      data.missingAssets ||
      data.mediaStillLoading ||
      data.images.some((i) => !i.complete || !i.width)
    )
      throw new Error(
        "Audience assets failed to load; see diagnostic artifacts",
      );
    if (duration > 0 && summary.distinctAnimationSamples < 2)
      throw new Error(
        "No animation progress observed; see diagnostic artifacts",
      );
  }
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(summaries, null, 2),
  );
} finally {
  await app?.close();
  if (
    path.dirname(root) !== os.tmpdir() ||
    !path.basename(root).startsWith("showme-benchmark-")
  )
    throw new Error("Unexpected cleanup target");
  await rm(root, { recursive: true, force: true });
}
