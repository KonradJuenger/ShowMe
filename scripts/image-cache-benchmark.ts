import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DocumentStorage } from "../electron/storage";
import { newPresentationDocument } from "../src/core/document";
import { createBasicShape } from "../src/core/elementFactory";
import { imageIdentity, planPresentationImages } from "../src/core/presentationImages";

const option = (key: string, fallback: string) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? fallback : process.argv[index + 1];
};
const count = Number(option("--runs", "3"));
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("--runs must be 1–10");
const output = path.resolve(option("--output", ".benchmark-data/image-cache"));
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD"), dirty = !!git("status", "--porcelain");
const percentile = (values: number[], quantile: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(folder: string) {
  const userData = path.join(folder, "user");
  const storage = new DocumentStorage(path.join(userData, "assets"), path.join(folder, "fixture-cache"), "keep-all");
  await storage.init();
  await writeFile(path.join(userData, "settings.json"), JSON.stringify({ libraryLifecycleMode: "keep-all", storageWarningSeen: true, imageCacheFormat: "png" }));
  const document = newPresentationDocument("Native image cache benchmark");
  const base = document.slides[document.deck.slideIds[0]], meta = document.deck.slideMeta[base.id];
  document.deck.slideIds = [];
  document.deck.slideMeta = {};
  document.slides = {};
  document.deck.layers.push({ ...document.deck.layers[0], id: "hidden-layer", hidden: true });
  for (const template of Object.values(document.templates)) template.nodes.push({ type: "layer", id: "hidden-layer", children: [] });
  for (let index = 0; index < 26; index++) {
    const width = index < 24 ? 2048 : 6000, height = index < 24 ? 1536 : 4000;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 13 + y * 7 + index * 23) & 255;
      pixels[offset + 1] = ((x >> 3) * 11 + y * 19 + index * 3) & 255;
      pixels[offset + 2] = ((x ^ y) * 17 + index * 31) & 255;
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const asset = { ...await storage.importAssetData(`Image${index}.png`, bytes), width, height };
    await storage.updateAsset(asset);
    const image = createBasicShape(`image${index}`, "rectangle", { x: 0, y: 0 });
    image.appearance.fill = null;
    image.clipChildren = true;
    image.content = { type: "image", assetId: asset.id, filename: asset.filename, mediaType: "image",
      opacity: 1, lockAspect: true, transform: { rule: "fill", intrinsicWidth: width, intrinsicHeight: height,
        rotation: 0, flipX: false, flipY: false, anchorX: .5, anchorY: .5, zoom: 1 } };
    image.frame.width = 1920; image.frame.height = 1080;
    if (index === 25) {
      document.slides.slide0.nodes[1].children = [image];
    } else {
      const slide = { ...structuredClone(base), id: `slide${index}` };
      slide.nodes[0].children = [image];
      slide.nodes.push({ type: "layer", id: "hidden-layer", children: [] });
      document.deck.slideIds.push(slide.id);
      document.deck.slideMeta[slide.id] = { ...meta, name: `Slide ${index + 1}`, hidden: index === 24 };
      document.slides[slide.id] = slide;
    }
  }
  const file = path.join(folder, "Native image cache benchmark.sme");
  await writeFile(file, JSON.stringify(document));
  return { file, userData, documentId: document.documentId, document };
}

async function measure(app: ElectronApplication) {
  return app.evaluate(({ app }) => ({
    mainRssBytes: process.memoryUsage().rss,
    processes: app.getAppMetrics().map(metric => ({ pid: metric.pid,
      cpuSeconds: metric.cpu.cumulativeCPUUsage ?? 0, residentKiB: metric.memory.workingSetSize })),
  }));
}

async function run(index: number) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-cache-benchmark-"));
  let app: ElectronApplication | undefined;
  let stopped = false, sampler: Promise<void> | undefined;
  try {
    const input = await fixture(folder);
    const started = performance.now();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
    app = await electron.launch({ args: [path.resolve("."), input.file, `--user-data-dir=${input.userData}`], env, timeout: 120000 });
    const page = await app.firstWindow();
    const cpu = new Map<number, number>();
    let peakMainRssBytes = 0, peakResidentBytes = 0;
    const ipcMs: number[] = [];
    sampler = (async () => {
      while (!stopped) {
        const start = performance.now();
        const sample = await measure(app!);
        ipcMs.push(performance.now() - start);
        peakMainRssBytes = Math.max(peakMainRssBytes, sample.mainRssBytes);
        peakResidentBytes = Math.max(peakResidentBytes, sample.processes.reduce((sum, item) => sum + item.residentKiB * 1024, 0));
        for (const item of sample.processes) cpu.set(item.pid, Math.max(cpu.get(item.pid) ?? 0, item.cpuSeconds));
        await pause(100);
      }
    })();
    await page.evaluate(() => {
      const gaps: number[] = [], longTasks: number[] = [];
      let previous = performance.now();
      const tick = (now: number) => { gaps.push(now - previous); previous = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: "longtask", buffered: true });
      Object.assign(window, { cacheBenchmark: { gaps, longTasks } });
    });
    await page.locator("[data-editor]").waitFor({ timeout: 120000 });
    const editorReadyMs = performance.now() - started;
    const status = () => page.evaluate(id => window.desktop!.imageReadiness!(id), input.documentId);
    const profile = await page.evaluate(id => window.desktop!.audienceImageProfile!(id), input.documentId);
    const visibleHashes = new Set(planPresentationImages(input.document.deck, Object.values(input.document.slides), profile)
      .map(requirement => createHash("sha256").update(imageIdentity(requirement.assetId, Math.min(2048, requirement.width), Math.min(1536, requirement.height))).digest("hex") + ".png"));
    const deadline = performance.now() + 120000;
    let snapshot = await status();
    for (;;) {
      const files = await readdir(path.join(input.userData, "image-cache"), { recursive: true });
      const cached = new Set(files.map(file => path.basename(file)));
      if ([...visibleHashes].every(hash => cached.has(hash))) break;
      if (performance.now() > deadline) throw new Error("Visible image preparation timed out");
      await pause(25);
    }
    const visiblePreparedMs = performance.now() - started;
    const timings = await page.evaluate(() => (window as unknown as { cacheBenchmark: { gaps: number[]; longTasks: number[] } }).cacheBenchmark);
    const presentStarted = performance.now();
    await page.getByRole("button", { name: "Present", exact: true }).click();
    let audience: Page | undefined;
    while (!(audience = app.windows().find(window => window.url().includes("present=audience")))) {
      if (performance.now() > deadline) throw new Error("Audience startup timed out");
      await pause(25);
    }
    await audience.locator("[data-active-slide] .slide-renderer").waitFor({ timeout: 120000 });
    const presentMs = performance.now() - presentStarted;
    snapshot = await status();
    const backgroundStateAtAudience = snapshot?.state;
    while (snapshot?.state !== "ready") {
      if (snapshot?.state === "failed") throw new Error(JSON.stringify(snapshot.failures));
      if (performance.now() > deadline) throw new Error("Whole-deck image preparation timed out");
      await pause(25); snapshot = await status();
    }
    const allPreparedMs = performance.now() - started;
    const diagnostics = await page.evaluate(() => window.desktop!.presentationImageDiagnostics!());
    if (snapshot.total !== 26 || snapshot.completed !== 26 || diagnostics.jobs !== 26)
      throw new Error("Unexpected native workload: " + JSON.stringify({ snapshot, diagnostics }));
    stopped = true;
    await sampler;
    const result = { index, editorReadyMs, visiblePreparedMs, presentMs, allPreparedMs, backgroundStateAtAudience,
      profile, editorViewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
      cpuMs: [...cpu.values()].reduce((sum, seconds) => sum + seconds * 1000, 0), peakMainRssBytes, peakResidentBytes,
      mainIpcP95Ms: percentile(ipcMs, .95), mainIpcMaxMs: Math.max(...ipcMs),
      editorFrameP95Ms: percentile(timings.gaps, .95), editorFrameMaxMs: Math.max(...timings.gaps),
      editorLongTasks: timings.longTasks.length, editorLongTaskMs: timings.longTasks.reduce((sum, ms) => sum + ms, 0),
      diagnostics, total: snapshot.total, completed: snapshot.completed,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    stopped = true;
    await sampler?.catch(() => {});
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app?.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
}

async function main() {
  const runs = [];
  for (let index = 0; index < count; index++) runs.push(await run(index));
  if (git("rev-parse", "HEAD") !== revision) throw new Error("HEAD changed during measurement");
  const keys = ["editorReadyMs", "visiblePreparedMs", "presentMs", "allPreparedMs", "cpuMs", "peakMainRssBytes", "peakResidentBytes", "mainIpcP95Ms", "mainIpcMaxMs", "editorFrameP95Ms", "editorFrameMaxMs", "editorLongTasks", "editorLongTaskMs"] as const;
  const report = { workloadVersion: 1, revision, dirty, runs, createdAt: new Date().toISOString(),
    environment: { platform: process.platform, cpu: os.cpus()[0]?.model, logicalThreads: os.availableParallelism(), node: process.version,
      electron: JSON.parse(execFileSync(process.execPath, ["-p", "JSON.stringify(require('electron/package.json').version)"], { encoding: "utf8" })),
      libuvThreads: process.env.UV_THREADPOOL_SIZE ?? "default (4)", format: "png", images: 26, visibleSources: "24 × 2048 × 1536", hiddenSources: "2 × 6000 × 4000" },
    medians: Object.fromEntries(keys.map(key => [key, percentile(runs.map(run => run[key]), .5)])),
  };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, revision, dirty, medians: report.medians }, null, 2));
}
// Fixture Library indexes watch their temporary folders; measurements and app
// cleanup are complete before ending this disposable benchmark process.
void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
