// Isolated production-bundled renderer, visible installed Electron, no app integration.
import { build } from "vite";
import { chromium } from "playwright";
import electron from "electron";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import { createHash } from "node:crypto";

const root = resolve(".agenttmp/general-gpu");
await mkdir(root, { recursive: true });
await build({
  build: {
    outDir: `${root}/dist`,
    rollupOptions: { input: "tests/helpers/gpu-renderer-experiment.html" },
  },
});
const main = `${root}/main.cjs`;
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(`${root}/profile`)});
app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement');
app.commandLine.appendSwitch('force-device-scale-factor','1.604166666666667');
app.whenReady().then(async()=>{const w=new BrowserWindow({width:1596,height:998,useContentSize:true,frame:false,fullscreen:true,show:true,webPreferences:{backgroundThrottling:false}});await w.loadURL(process.argv.at(-1));});
app.on('window-all-closed',()=>app.quit());`,
);
const dist = resolve(root, "dist");
const server = createServer(async (req, res) => {
  const file = resolve(
    dist,
    `.${new URL(req.url, "http://localhost").pathname}`,
  );
  if (!file.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
    };
    res.setHeader(
      "Content-Type",
      mime[extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/tests/helpers/gpu-renderer-experiment.html`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const debuggingPort = probe.address().port;
await new Promise((done) => probe.close(done));
const child = spawn(
  electron,
  [`--remote-debugging-port=${debuggingPort}`, main, `${url}?noReference=1`],
  { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
);
child.stderr.on("data", (value) => {
  if (/Error|failed/i.test(String(value))) console.error(String(value));
});
let browser;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${debuggingPort}`,
      {
        timeout: 1000,
      },
    );
    break;
  } catch {
    await new Promise((done) => setTimeout(done, 100));
  }
}
if (!browser) {
  child.kill();
  server.close();
  throw new Error("Electron CDP did not start");
}
const evidence = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  diff: execFileSync("git", ["diff"], { encoding: "utf8" }),
  recordedAt: new Date().toISOString(),
  runnerSha256: createHash("sha256")
    .update(await readFile(import.meta.filename))
    .digest("hex"),
  host: {
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0].model,
    node: process.version,
  },
  runs: [],
};
const save = () =>
  writeFile(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
const processMemory = async () => {
  if (process.platform !== "win32") return null;
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const ids = processInfo
    .map((item) => Number(item.id))
    .filter(Number.isSafeInteger);
  return {
    processInfo,
    memory: JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-Process -Id ${ids.join(",")} | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json`,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    ),
  };
};
try {
  const page =
    browser.contexts()[0].pages()[0] ??
    (await browser.contexts()[0].waitForEvent("page"));
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
  await page.waitForFunction(() => window.gpuRendererExperiment, undefined, {
    timeout: 30000,
  });
  console.log("Electron harness ready");
  evidence.electron = await browser
    .newBrowserCDPSession()
    .then(async (session) => ({
      version: await session.send("Browser.getVersion"),
      system: await session.send("SystemInfo.getInfo"),
    }));
  evidence.semantics = await page.evaluate(() => window.verifyGpuSemantics());
  evidence.cache = await page.evaluate(() =>
    window.gpuRendererExperiment.nativeCacheAudit(),
  );
  await page.goto(`${url}?dpr=1.604166666666667`);
  await page.waitForFunction(() => window.gpuRendererExperiment);
  evidence.parity = await page.evaluate(() =>
    window.gpuRendererExperiment.staticParity(1200),
  );
  await page.screenshot({ path: `${root}/static-parity.png`, fullPage: true });
  await page.goto(
    `${url}?benchmark=1&noReference=1&width=1596&height=998&dpr=1.604166666666667`,
  );
  await page.waitForFunction(() => window.gpuRendererExperiment);
  await page.evaluate(() => {
    document.querySelector("main").style.cssText = "padding:0;display:block";
    document.querySelector("strong").remove();
    window.gpuRendererExperiment.canvas.style.margin = "0";
    document.body.style.overflow = "hidden";
  });
  evidence.viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    canvas: [
      window.gpuRendererExperiment.canvas.width,
      window.gpuRendererExperiment.canvas.height,
    ],
  }));
  evidence.processBefore = await processMemory();
  for (let run = 0; run < 3; run++) {
    await page.evaluate(() => window.gpuRendererExperiment.runBenchmark(3000));
    const sample = await page.evaluate(() =>
      window.gpuRendererExperiment.runBenchmark(10000),
    );
    const ids = await page.evaluate(
      () => window.gpuRendererExperiment.effectIds,
    );
    const delta = (key) => sample.diagnostics[key] - sample.before[key];
    sample.rates = {
      graph: sample.callbackRate,
      output: (delta("outputPublications") * 1000) / sample.elapsed,
      ...Object.fromEntries(
        Object.entries(ids).map(([name, id]) => [
          name,
          ((sample.diagnostics.shaderByEffect[id].total -
            sample.before.shaderByEffect[id].total) *
            1000) /
            sample.elapsed,
        ]),
      ),
      rasters: (delta("nativeRasterizations") * 1000) / sample.elapsed,
      uploads: (delta("gpuUploads") * 1000) / sample.elapsed,
    };
    evidence.runs.push(sample);
    await save();
    console.log(
      JSON.stringify({
        run: run + 1,
        rates: sample.rates,
        intervals: sample.frameIntervalMs,
        allocations: delta("renderTargetAllocations"),
        resizes: delta("renderTargetResizes"),
        textures: sample.diagnostics.activeTextures,
        fbos: sample.diagnostics.activeFbos,
        bytes: sample.diagnostics.logicalTextureBytes,
      }),
    );
  }
  await page.screenshot({ path: `${root}/hardware-output.png` });
  evidence.longRun = await page.evaluate(() =>
    window.gpuRendererExperiment.runBenchmark(30000),
  );
  evidence.processAfterLong = await processMemory();
  evidence.resize = await page.evaluate(async () => {
    const h = window.gpuRendererExperiment;
    const group = h.slide.nodes[0].children.find(
      (element) => element.id === "gpu-group",
    );
    const width = group.frame.width;
    const before = h.renderer.diagnostics();
    const checkpoints = [];
    for (let index = 0; index < 120; index++) {
      group.frame.width = width + (index % 30) * 0.7;
      await h.render(index * 20);
      if (index % 30 === 29) checkpoints.push(h.renderer.diagnostics());
    }
    group.frame.width = width;
    await h.transformOnlyCheck(6);
    return {
      before,
      checkpoints,
      after: h.renderer.diagnostics(),
      glError: h.renderer.gl.getError(),
    };
  });
  evidence.lifecycle = [];
  for (const [width, height, effects] of [
    [640, 360, true],
    [800, 500, false],
    [320, 240, true],
    [1596, 998, false],
    [640, 360, true],
  ]) {
    const result = await page.evaluate(
      async ([width, height, effects]) => {
        const old = window.gpuRendererExperiment;
        old.dispose();
        const disposed = old.renderer.diagnostics();
        const next = (window.gpuRendererExperiment =
          await window.mountGpuRendererHarness({
            width,
            height,
            effects,
            pixelRatio: 1.604166666666667,
            reference: false,
          }));
        await next.runBenchmark(1000);
        return {
          disposed,
          mounted: next.renderer.diagnostics(),
          nativeHosts: document.querySelectorAll(".gpu-renderer-native-raster")
            .length,
        };
      },
      [width, height, effects],
    );
    evidence.lifecycle.push(result);
  }
  evidence.video = await page.evaluate(() => window.verifyGpuVideo());
  evidence.processAfterLifecycle = await processMemory();
  evidence.memory = await page.evaluate(() =>
    performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        }
      : null,
  );
  evidence.contextLoss = await page.evaluate(async () => {
    const h = window.gpuRendererExperiment;
    const extension = h.renderer.gl.getExtension("WEBGL_lose_context");
    if (!extension) return { supported: false };
    extension.loseContext();
    await new Promise((done) => setTimeout(done, 100));
    const lost = h.renderer.gl.isContextLost();
    extension.restoreContext();
    await new Promise((done) => setTimeout(done, 100));
    return { supported: true, lost, restored: !h.renderer.gl.isContextLost() };
  });
  await save();
  console.log(`Evidence: ${root}/evidence.json`);
} finally {
  await browser.close();
  child.kill();
  server.close();
}
