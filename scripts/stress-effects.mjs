import { _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readdir,
  cp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

// npm run build; start Vite on 5173; then node scripts/stress-effects.mjs source.sme
// Every source asset/file is read-only. The app uses a private profile/library.
const sourcePath = process.argv[2];
if (!sourcePath)
  throw new Error(
    "Usage: node scripts/stress-effects.mjs file.sme [family|all|gpu|compare|id,...] [durationMs=3000] [repetitions=1]",
  );
const selected = process.argv[3] ?? "all";
const duration = Number(process.argv[4] ?? 3000);
const repetitions = Number(process.argv[5] ?? 1);
if (
  !Number.isFinite(duration) ||
  duration < 1000 ||
  !Number.isInteger(repetitions) ||
  repetitions < 1
)
  throw new Error("Use duration >= 1000ms and a positive integer repeat count");
const selectors = selected.split(",");
const runName = `${selected}-${duration}ms-${repetitions}x`;
const bytes = await readFile(path.resolve(sourcePath));
const model = JSON.parse(bytes.toString("utf8"));
const output = path.resolve("test-results-effects-stress");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "showme-effects-stress-"),
);
await mkdir(output, { recursive: true });
await mkdir(path.resolve(".agenttmp"), { recursive: true });
const harnessPath = path.resolve(".agenttmp/effects-stress.html");
const harnessHtml = `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import '/src/presentation.css';import '/src/style.css';import '/src/frame.css';</script></body></html>`;
if ((await readFile(harnessPath, "utf8").catch(() => "")) !== harnessHtml)
  await writeFile(harnessPath, harnessHtml);
const ids = new Set();
function visit(elements) {
  for (const element of elements) {
    if (element.content?.assetId) ids.add(element.content.assetId);
    visit(element.children);
  }
}
for (const slide of Object.values(model.slides))
  slide.nodes.forEach((node) => visit(node.children));
const settingsPath = path.join(
  process.env.APPDATA ?? "",
  "show-me",
  "settings.json",
);
const settings = JSON.parse(await readFile(settingsPath, "utf8"));
const library =
  settings.mediaLibraryPath ?? path.join(path.dirname(settingsPath), "assets");
const copied = [];
for (const folder of ["images", "video", "audio", "fonts", "other"]) {
  await mkdir(path.join(temporary, "library", folder), { recursive: true });
  for (const name of await readdir(path.join(library, folder)).catch(
    () => [],
  )) {
    if (folder === "fonts" || [...ids].some((id) => name.includes(id))) {
      const from = path.join(library, folder, name),
        to = path.join(temporary, "library", folder, name);
      await cp(from, to, { recursive: true });
      copied.push({ folder, name });
    }
  }
}
await mkdir(path.join(temporary, "profile"), { recursive: true });
await writeFile(
  path.join(temporary, "profile", "settings.json"),
  JSON.stringify({
    mediaLibraryPath: path.join(temporary, "library"),
    presentationsFolderPath: path.join(temporary, "presentations"),
    imageCachingEnabled: false,
  }),
);
const copy = path.join(temporary, "source.sme");
await writeFile(copy, bytes);
const cases = [];
const add = (
  family,
  depth,
  count = 1,
  videoCount = 1,
  profileWidth = 1920,
  heavy = false,
  backend = "native",
  slideIndex,
) =>
  cases.push({
    id: `${family}-d${depth}-n${count}-v${videoCount}-p${profileWidth}-${heavy ? "heavy" : "light"}-${backend}${slideIndex === undefined ? "" : `-s${slideIndex + 1}`}`,
    family,
    depth,
    count,
    videoCount,
    profileWidth,
    heavy,
    backend,
    slideIndex,
  });
for (let slideIndex = 0; slideIndex < model.deck.slideIds.length; slideIndex++)
  add("original", 0, 1, 1, 1920, false, "native", slideIndex);
for (const depth of [1, 2, 4, 8, 16]) add("shader", depth);
for (const depth of [1, 2, 4, 8]) add("shader", depth, 1, 1, 1920, true);
for (const depth of [2, 4, 8, 16, 32, 64]) add("mixed", depth);
for (const depth of [1, 4, 8, 16]) add("css", depth);
for (const count of [1, 4, 16, 64, 128, 256, 512]) add("js", 1, count, 0);
for (const count of [1, 2, 4, 8, 16]) add("backdrop", 1, count);
for (const count of [1, 4, 16, 64]) add("tiles", 4, count, 0);
for (const count of [1, 2, 4, 8]) add("mixed", 8, count, 1);
for (const videoCount of [0, 1, 2, 4, 8, 16]) add("video", 1, 1, videoCount);
for (const profileWidth of [1280, 1920, 3840])
  add("mixed", 8, 1, 1, profileWidth);
for (const backend of ["svg", "native-naive", "native"])
  add("mixed", 8, 1, 1, 1920, false, backend);
for (const depth of [1, 2, 4, 8]) add("composite", depth, 1, 1);
for (const count of [2, 4, 8]) add("composite", 2, count, 1);
for (const profileWidth of [1280, 3840])
  add("composite", 2, 1, 1, profileWidth);
for (const depth of [1, 2, 4, 8, 16, 32, 64])
  add("shader", depth, 1, 1, 1920, false, "gpu");
for (const depth of [4, 8, 16]) add("shader", depth, 1, 1, 1920, true, "gpu");
for (const taps of [128, 512, 1024]) {
  add("shader", 4, 1, 1, 1920, true, "gpu");
  cases.at(-1).id += `-taps${taps}`;
  cases.at(-1).taps = taps;
}
add("shader", 8, 1, 1, 3840, true, "gpu");
for (const depth of [8, 16]) add("mixed", depth, 1, 1, 1920, false, "gpu");
// Identical fixtures exercise both strategies in the same renderer build.
for (const backend of ["native", "refined"]) {
  add("shader", 8, 1, 0, 1920, false, backend);
  add("js", 1, 512, 0, 1920, false, backend);
  add("video", 1, 1, 16, 1920, false, backend);
  for (const depth of [4, 8, 16, 32, 64])
    add("shader", depth, 1, 1, 1920, false, backend);
  for (const depth of [8, 16, 32])
    add("mixed", depth, 1, 1, 1920, false, backend);
  for (const count of [1, 4, 16, 64])
    add("tiles", 4, count, 0, 1920, false, backend);
  for (const count of [1, 4, 8])
    add("backdrop", 1, count, 1, 1920, false, backend);
  for (const depth of [1, 2, 4])
    add("composite", depth, 1, 1, 1920, false, backend);
  for (const count of [2, 4])
    add("composite", 2, count, 1, 1920, false, backend);
  add("css", 16, 1, 1, 1920, false, backend);
  add("js", 1, 128, 0, 1920, false, backend);
  add("shader", 8, 1, 1, 3840, true, backend);
}
for (const videoInvalidation of ["decoded", "poll"]) {
  add("video", 1, 1, 16, 1920, false, "refined");
  cases.at(-1).id += `-${videoInvalidation}`;
  cases.at(-1).videoInvalidation = videoInvalidation;
}
const unique = [
  ...new Map(cases.map((value) => [value.id, value])).values(),
].filter((value) =>
  selectors.some(
    (selector) =>
      selector === "all" ||
      value.family === selector ||
      value.id === selector ||
      (selector === "video-isolation" &&
        (value.videoInvalidation || value.id === "video-d1-n1-v16-p1920-light-native")) ||
      (selector === "gpu" && value.backend === "gpu") ||
      (selector === "refined" && value.backend === "refined") ||
      (selector === "v2extras" &&
        ["native", "refined"].includes(value.backend) &&
        ((value.family === "shader" &&
          value.depth === 8 &&
          value.videoCount === 0) ||
          (value.backend === "refined" &&
            value.family === "shader" &&
            [32, 64].includes(value.depth) &&
            !value.heavy) ||
          (value.family === "js" && value.count === 512) ||
          (value.family === "video" && value.videoCount === 16))) ||
      (selector === "v2cold" &&
        value.backend === "refined" &&
        ((value.family === "shader" && value.depth === 64 && !value.heavy) ||
          (value.family === "mixed" &&
            value.depth === 32 &&
            value.count === 1) ||
          (value.family === "composite" &&
            value.depth === 2 &&
            [2, 4].includes(value.count)))) ||
      (selector === "v2limits" &&
        (value.backend === "refined" ||
          (value.backend === "native" &&
            ((value.family === "tiles" && [1, 16, 64].includes(value.count)) ||
              (value.family === "backdrop" && [4, 8].includes(value.count)) ||
              (value.family === "composite" &&
                (value.depth === 4 || [2, 4].includes(value.count))) ||
              (value.family === "css" && value.depth === 16) ||
              (value.family === "js" && value.count === 128) ||
              (value.family === "shader" &&
                value.depth === 8 &&
                value.profileWidth === 3840 &&
                value.heavy))))) ||
      (selector === "v2compare" &&
        ["native", "refined"].includes(value.backend) &&
        value.count === 1 &&
        value.videoCount === 1 &&
        value.profileWidth === 1920 &&
        !value.heavy &&
        ((value.family === "shader" && [4, 8, 16].includes(value.depth)) ||
          (value.family === "mixed" && value.depth === 8) ||
          (value.family === "composite" && value.depth === 2))) ||
      (selector === "compare" &&
        ["native", "gpu"].includes(value.backend) &&
        value.count === 1 &&
        value.videoCount === 1 &&
        value.profileWidth === 1920 &&
        !value.heavy &&
        ((value.family === "shader" && [4, 8].includes(value.depth)) ||
          (value.family === "mixed" && value.depth === 8))),
  ),
);
if (!unique.length) throw new Error(`No stress cases match ${selected}`);
const percentile = (values, fraction) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.floor(values.length * fraction))
      ]
    : null;
function summarize(data) {
  const outputs = Object.values(data.outputs);
  const rates = outputs.map((values) => (values.length * 1000) / data.elapsed);
  return {
    elapsedMs: data.elapsed,
    rafFps: (data.frames.length * 1000) / data.elapsed,
    rafMedianMs: percentile(data.frames, 0.5),
    rafP95Ms: percentile(data.frames, 0.95),
    rafP99Ms: percentile(data.frames, 0.99),
    over33ms: data.frames.filter((value) => value > 33.4).length,
    terminalMinFps: rates.length ? Math.min(...rates) : null,
    terminalMedianFps: percentile(rates, 0.5),
    terminalOutputs: outputs.reduce((sum, values) => sum + values.length, 0),
    inputP95Ms: percentile(data.inputLatency, 0.95),
    longTasks: data.longTasks.length,
    longTaskMs: data.longTasks.reduce((sum, value) => sum + value, 0),
    videoFrames: data.videoQuality.reduce((sum, value) => sum + value.total, 0),
    videoDrops: data.videoQuality.reduce(
      (sum, value) => sum + value.dropped,
      0,
    ),
    canvasMiB: data.canvasBytes / 1048576,
    visibleCanvasMiB: data.visibleCanvasBytes / 1048576,
    mirrorCanvasMiB: data.mirrorCanvasBytes / 1048576,
    outputTextureMiB: data.outputTextureBytes / 1048576,
    inputTextureMiB: data.inputTextureBytes / 1048576,
    dom: data.dom,
    runtime: data.runtime,
    state: data.state,
  };
}
const report = {
  rendererCommit: await new Promise((resolve, reject) =>
    execFile("git", ["rev-parse", "HEAD"], (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  ),
  source: path.resolve(sourcePath),
  sourceDigest: createHash("sha256").update(bytes).digest("hex"),
  durationMs: duration,
  repetitions,
  fixtureVersion: "full-viewport-visible-background-gpu-v2",
  created: new Date().toISOString(),
  copiedAssets: copied,
  machine: {
    platform: os.platform(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryGiB: os.totalmem() / 1073741824,
  },
  cases: [],
};
let app, page, cdp, nativePid;
async function launch() {
  console.log(JSON.stringify({ phase: "launch" }));
  const env = {
    ...process.env,
    SHOWME_DEV_URL: "http://127.0.0.1:5173/.agenttmp/effects-stress.html",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      path.resolve("."),
      `--user-data-dir=${path.join(temporary, "profile")}`,
      copy,
    ],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  nativePid = await bounded(
    app.evaluate(() => process.pid),
    5000,
  ).catch(() => null);
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);
  console.log(JSON.stringify({ phase: "window", url: page.url() }));
  await page.waitForFunction(() => Boolean(window.desktop), null, {
    timeout: 10000,
  });
  const projection = await bounded(
    page.evaluate(
      (id) => window.desktop.documentProjection(id),
      model.documentId,
    ),
    15000,
  );
  // The current .sme writer omits the filename-derived deck name. Obtain the
  // runtime deck from the current native reader instead of inventing a reader.
  model.deck = projection.deck;
  console.log(JSON.stringify({ phase: "editor-ready" }));
  if (!report.electron) {
    report.electron = await bounded(
      app.evaluate(({ app }) => ({
        versions: process.versions,
        gpu: app.getGPUFeatureStatus(),
      })),
      5000,
    ).catch((error) => ({ error: String(error) }));
    console.log(
      JSON.stringify({ phase: "gpu-ready", electron: report.electron }),
    );
  }
  await bounded(
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1920, 1080);
      win.setBackgroundThrottling?.(false);
      win.webContents.setBackgroundThrottling(false);
    }),
    5000,
  ).catch((error) =>
    console.log(
      JSON.stringify({ phase: "background-policy", error: String(error) }),
    ),
  );
  await page.waitForFunction(() => Boolean(document.getElementById("root")));
  if (!report.renderer)
    report.renderer = await page.evaluate(() => {
      const canvas = document.createElement("canvas"),
        gl = canvas.getContext("webgl2"),
        debug = gl?.getExtension("WEBGL_debug_renderer_info");
      const info = {
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        gpu:
          gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      };
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return info;
    });
  console.log(JSON.stringify({ phase: "harness-ready" }));
  cdp = await app.context().newCDPSession(page);
  await cdp.send("Performance.enable");
}
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Benchmark exceeded ${ms}ms wall limit`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function shutdown() {
  if (!app) return;
  // The benchmark replaces the editor UI, so there is no editor close-command
  // listener. Destroy its private window, with no document mutations to save.
  await bounded(
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    ),
    3000,
  ).catch(() => {});
  await bounded(app.close(), 3000).catch(async () => {
    // On Windows Playwright's process can be the Electron CLI launcher. Killing
    // only that launcher can leave a timed-out native renderer benchmarking in
    // the background and contaminate later trials. Terminate its private tree.
    if (process.platform === "win32")
      await new Promise((resolve) =>
        execFile(
          "taskkill",
          ["/PID", String(nativePid ?? app.process().pid), "/T", "/F"],
          () => resolve(),
        ),
      );
    app.process().kill();
  });
}
try {
  await launch();
  for (const trial of Array.from(
    { length: repetitions },
    (_, index) => index + 1,
  ))
    for (const scenario of unique) {
      console.log(JSON.stringify({ starting: scenario.id }));
      const record = { scenario, trial };
      const began = Date.now();
      try {
        await bounded(
          page.evaluate(
            async ({ model, scenario }) => {
              window.stress?.dispose();
              const { mountEffectStressHarness } =
                await import("/tests/helpers/effectStressHarness.ts");
              window.stress = await mountEffectStressHarness(model, scenario);
              return window.stress.readiness();
            },
            { model, scenario },
          ),
          30000,
        );
        record.cold = await page.evaluate(() => ({
          coldMs: window.stress.coldMs,
          state: window.stress.readiness(),
        }));
        await bounded(
          page.evaluate(() => window.stress.measure(800)),
          10000,
        );
        const before = await cdp.send("Performance.getMetrics");
        const memoryBefore = report.electron.error
          ? null
          : await bounded(
              app.evaluate(({ app }) => app.getAppMetrics()),
              5000,
            ).catch(() => null);
        const measured = await bounded(
          page.evaluate(
            (duration) => window.stress.measure(duration),
            duration,
          ),
          Math.max(20000, duration * 5),
        );
        record.summary = summarize(measured);
        record.samples = measured;
        record.performanceBefore = before;
        record.performanceAfter = await cdp.send("Performance.getMetrics");
        record.processesBefore = memoryBefore;
        record.processesAfter = report.electron.error
          ? null
          : await bounded(
              app.evaluate(({ app }) => app.getAppMetrics()),
              5000,
            ).catch(() => null);
        record.settled = await bounded(
          page.evaluate(() => window.stress.settle()),
          8000,
        );
        if (
          (scenario.backend === "refined" &&
            scenario.family === "shader" &&
            [32, 64].includes(scenario.depth) &&
            !scenario.heavy) ||
          (scenario.family === "js" && scenario.count === 512) ||
          (scenario.family === "composite" &&
            scenario.depth === 1 &&
            scenario.count === 1) ||
          (scenario.family === "mixed" &&
            scenario.depth === 8 &&
            scenario.count === 1 &&
            scenario.profileWidth === 1920 &&
            scenario.backend === "native")
        ) {
          const events = [];
          const collect = ({ value }) => events.push(...value);
          cdp.on("Tracing.dataCollected", collect);
          await cdp.send("Tracing.start", {
            categories:
              "devtools.timeline,blink.user_timing,cc,gpu,v8,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
            transferMode: "ReportEvents",
          });
          await bounded(
            page.evaluate(() => window.stress.measure(1500)),
            15000,
          );
          const ended = new Promise((resolve) =>
            cdp.once("Tracing.tracingComplete", resolve),
          );
          await cdp.send("Tracing.end");
          await ended;
          cdp.off("Tracing.dataCollected", collect);
          await writeFile(
            path.join(output, `${scenario.id}.trace.json`),
            JSON.stringify({ traceEvents: events }),
          );
          const costs = new Map();
          for (const event of events) {
            if (event.ph === "X" && event.dur) {
              const item = costs.get(event.name) ?? {
                totalMs: 0,
                maxMs: 0,
                count: 0,
              };
              item.totalMs += event.dur / 1000;
              item.maxMs = Math.max(item.maxMs, event.dur / 1000);
              item.count++;
              costs.set(event.name, item);
            }
          }
          record.traceCosts = [...costs]
            .map(([name, value]) => ({ name, ...value }))
            .sort((a, b) => b.totalMs - a.totalMs)
            .slice(0, 35);
          const names = new Map(
            events
              .filter(
                (event) => event.ph === "M" && event.name === "thread_name",
              )
              .map((event) => [`${event.pid}/${event.tid}`, event.args.name]),
          );
          const perThread = new Map();
          for (const event of events)
            if (event.ph === "X" && event.dur) {
              const key = `${event.pid}/${event.tid}/${event.name}`,
                item = perThread.get(key) ?? {
                  name: event.name,
                  thread:
                    names.get(`${event.pid}/${event.tid}`) ?? String(event.tid),
                  pid: event.pid,
                  tid: event.tid,
                  totalMs: 0,
                  maxMs: 0,
                  count: 0,
                };
              item.totalMs += event.dur / 1000;
              item.maxMs = Math.max(item.maxMs, event.dur / 1000);
              item.count++;
              perThread.set(key, item);
            }
          record.traceThreadCosts = [...perThread.values()]
            .sort((a, b) => b.totalMs - a.totalMs)
            .slice(0, 60);
        }
        const missing =
          record.settled.missingAssets ||
          record.settled.images.some(
            (image) => !image.complete || !image.width,
          ) ||
          record.settled.videos.some((video) => video.ready < 2);
        record.status = missing
          ? "invalid-assets"
          : record.settled.errors.length
            ? "diagnostic"
            : !record.settled.unchanged
              ? "mutated-document"
              : "ok";
        await page.screenshot({
          path: path.join(output, `${scenario.id}-trial${trial}.png`),
          timeout: 5000,
        });
      } catch (error) {
        record.status = "failed";
        record.error = String(error);
        await shutdown();
        app = null;
        await launch();
      }
      record.wallMs = Date.now() - began;
      report.cases.push(record);
      await writeFile(
        path.join(output, `case-${scenario.id}-trial${trial}.json`),
        JSON.stringify(record, null, 2),
      );
      await writeFile(
        path.join(output, `report-${runName}.json`),
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          id: scenario.id,
          status: record.status,
          wallMs: record.wallMs,
          ...(record.summary
            ? {
                rafFps: record.summary.rafFps,
                outputFps: record.summary.terminalMinFps,
                p95: record.summary.rafP95Ms,
                canvasMiB: record.summary.canvasMiB,
                errors: record.settled?.errors,
              }
            : { error: record.error }),
        }),
      );
    }
} finally {
  await shutdown();
  if (
    path.dirname(temporary) !== os.tmpdir() ||
    !path.basename(temporary).startsWith("showme-effects-stress-")
  )
    throw new Error("Unexpected temporary path");
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
