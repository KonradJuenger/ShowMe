import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const numberOption = (name, fallback) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
const width = Math.round(numberOption("--width", 1596));
const height = Math.round(numberOption("--height", 998));
const dpr = numberOption("--dpr", 1.6042);
const durationMs = numberOption("--duration", 20000);
const warmupMs = numberOption("--warmup", 1500);
const output = path.resolve(option("--output", ".benchmark-data/shared-texture/legacy-scene-texture.json"));
const evidence = option("--evidence", "");
const show = args.includes("--show");
const port = Math.round(numberOption("--port", 5194));

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const intervals = (times) => {
  const values = times.slice(1).map((value, index) => value - times[index]);
  return { samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: values.length ? Math.max(...values) : null, over33Ms: values.filter((value) => value > 33.34).length };
};
const deltaDiagnostics = (before, after) => ({
  scene: Object.fromEntries(Object.entries(after.scene).filter(([, value]) => typeof value === "number").map(([key, value]) => [key, value - (typeof before.scene[key] === "number" ? before.scene[key] : 0)])),
  shader: Object.fromEntries(Object.entries(after.shader).filter(([, value]) => typeof value === "number").map(([key, value]) => [key, value - (typeof before.shader[key] === "number" ? before.shader[key] : 0)])),
});
const cpuDeltas = (before, after) => {
  const previous = new Map(before.map((entry) => [`${entry.pid}:${entry.creationTime}`, entry]));
  return after.map((entry) => {
    const first = previous.get(`${entry.pid}:${entry.creationTime}`);
    const a = first?.cpu?.cumulativeCPUUsage;
    const b = entry.cpu?.cumulativeCPUUsage;
    return { pid: entry.pid, type: entry.type, serviceName: entry.serviceName, cumulativeCpuSeconds: Number.isFinite(a) && Number.isFinite(b) ? b - a : null };
  });
};

const root = await mkdtemp(path.join(os.tmpdir(), "showme-shared-texture-legacy-"));
let server;
let app;
try {
  server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true } });
  await server.listen();
  const main = path.join(root, "main.cjs");
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement');app.commandLine.appendSwitch('force-device-scale-factor','${dpr}');app.whenReady().then(()=>{const w=new BrowserWindow({width:${width},height:${height},useContentSize:true,show:${show},webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:${port}/tests/helpers/effects-harness.html');});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [main], env });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  const gpu = await app.evaluate(async ({ app }) => ({
    hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: app.getGPUFeatureStatus(),
    basicInfo: await app.getGPUInfo("basic").catch((error) => ({ error: String(error) })),
  }));
  const beforeMetrics = await app.evaluate(({ app }) => app.getAppMetrics());

  const result = await page.evaluate(async ({ width, height, durationMs }) => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const factoryPath = "/src/core/elementFactory.ts";
    const textPath = "/src/core/text.ts";
    const authoringPath = "/src/core/effectAuthoring.ts";
    const effectsPath = "/src/core/effects.ts";
    const runtimePath = "/src/components/effectRuntime.ts";
    const scenePath = "/src/components/sceneTexture.ts";
    const { mountMixedEffectsHarness } = await import(/* @vite-ignore */ harnessPath);
    const { createBasicShape } = await import(/* @vite-ignore */ factoryPath);
    const { createTextElement } = await import(/* @vite-ignore */ textPath);
    const { blankEffect } = await import(/* @vite-ignore */ authoringPath);
    const { newEffectInstance } = await import(/* @vite-ignore */ effectsPath);
    const { effectSurface, flushEffectSurfaces, shaderRuntimeDiagnostics } = await import(/* @vite-ignore */ runtimePath);
    const { sceneTextureDiagnostics } = await import(/* @vite-ignore */ scenePath);

    const cheapFinalShader = "#version 300 es\\nprecision highp float;uniform sampler2D u_input;in vec2 v_uv;out vec4 outColor;void main(){vec4 c=texture(u_input,v_uv);outColor=vec4(1.0-c.r,0.18+0.78*c.b,1.0-c.g,c.a);}";
    const generatedShader = "#version 300 es\\nprecision highp float;uniform float u_t;uniform vec2 u_size;in vec2 v_uv;out vec4 outColor;void main(){float a=.5+.5*sin(u_t*.9+v_uv.x*9.+v_uv.y*4.);float b=.5+.5*sin(-u_t*.55+v_uv.y*11.);vec3 c=mix(vec3(.05,.12,.42),vec3(.95,.28,.08),a);c=mix(c,vec3(1.,.68,.08),b*.45);outColor=vec4(c,1.);}";
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      profileWidth: width,
      configure(model) {
        model.deck.width = width;
        model.deck.height = height;
        model.deck.stylesheet = '[data-element-id="native-text"] [data-text-content] { text-shadow: 8px 8px 22px rgba(0,0,0,.45); }';
        const slide = model.slides[model.deck.slideIds[0]];
        slide.background = "#14213d";
        const generated = { ...blankEffect("shader"), name: "Generated source", input: "none", target: "background", source: generatedShader };
        const final = { ...blankEffect("shader"), name: "Transport comparison", input: "backdrop", target: "background", source: cheapFinalShader };
        slide.effectResources = { generated, final };
        const background = createBasicShape("generated-background", "rectangle", { x: 0, y: 0 });
        Object.assign(background.frame, { width, height });
        background.appearance.fill = "";
        background.effects = [{ ...newEffectInstance("generated", generated, "background"), id: "generated-instance" }];
        const text = createTextElement("native-text", { x: width * .08, y: height * .13 });
        Object.assign(text.frame, { width: width * .62, height: height * .42, rotation: -2 });
        text.appearance.fill = "#11182794";
        text.appearance.radius = 42;
        if (text.content?.type === "text") {
          text.content.text = "Chromium native scene\\nGenerated GPU background + native text/CSS";
          text.content.autoSize = "none";
          if (text.content.format.kind === "local") Object.assign(text.content.format.typography, { fontSize: 72, fontWeight: 700, bold: true, color: "#ffffff", lineHeight: 1.05 });
        }
        const finalSurface = createBasicShape("final-surface", "rectangle", { x: 0, y: 0 });
        Object.assign(finalSurface.frame, { width, height });
        finalSurface.appearance.fill = "";
        finalSurface.effects = [{ ...newEffectInstance("final", final, "background"), id: "final-instance" }];
        slide.nodes[0].children = [background, text, finalSurface];
        delete slide.motion;
      },
    });
    await harness.advance(0);
    await new Promise((resolve) => setTimeout(resolve, warmupMs));
    const host = harness.host;
    const before = { scene: sceneTextureDiagnostics(), shader: shaderRuntimeDiagnostics() };
    const rafTimes = [];
    const publications = [];
    let frameTicks = 0;
    let startedAt = 0;
    let endedAt = 0;
    host.addEventListener("showme-effect-output", (event) => {
      const node = event.target;
      const now = performance.now();
      if (
        node instanceof HTMLElement &&
        node.dataset.effectId === "final-instance" &&
        now >= startedAt &&
        now < endedAt
      )
        publications.push(now);
    });
    startedAt = performance.now();
    endedAt = startedAt + durationMs;
    await new Promise((resolve, reject) => {
      const tick = async (now) => {
        try {
          if (now >= endedAt) {
            resolve();
            return;
          }
          rafTimes.push(now);
          frameTicks++;
          const elapsed = now - startedAt;
          for (const node of host.querySelectorAll("[data-effect-id]")) {
            effectSurface(node)?.setTiming({ time: elapsed / 1000, duration: durationMs / 1000, progress: Math.min(1, elapsed / durationMs), running: true });
          }
          await flushEffectSurfaces(host);
          requestAnimationFrame(tick);
        } catch (error) { reject(error); }
      };
      requestAnimationFrame(tick);
    });
    const observedStopAt = performance.now();
    const after = { scene: sceneTextureDiagnostics(), shader: shaderRuntimeDiagnostics() };
    const viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    const errors = [...host.querySelectorAll("[data-effect-error]")].map((node) => node.dataset.effectError);
    const finalCanvas = host.querySelector('[data-effect-id="final-instance"] canvas[data-shader-stage="terminal"]');
    const canvas = finalCanvas ? { width: finalCanvas.width, height: finalCanvas.height } : null;
    window.__showMeSharedTextureLegacyHarness = harness;
    return { startedAt, endedAt, observedStopAt, durationMs, frameTicks, rafTimes, publications, viewport, canvas, errors, before, after };
  }, { width, height, durationMs, warmupMs });

  if (evidence) {
    const target = path.resolve(evidence);
    await mkdir(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target });
  }
  await page.evaluate(() => {
    window.__showMeSharedTextureLegacyHarness?.dispose();
    delete window.__showMeSharedTextureLegacyHarness;
  });
  const afterMetrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const report = {
    schemaVersion: 1,
    experiment: "current-scene-texture-cadence-reference",
    electron: await app.evaluate(() => process.versions.electron),
    chrome: await app.evaluate(() => process.versions.chrome),
    configuration: { width, height, dpr, durationMs, warmupMs, show },
    viewport: result.viewport,
    outputCanvas: result.canvas,
    rates: {
      rafPerSec: result.frameTicks / Math.max(.001, durationMs / 1000),
      shaderPublicationsPerSec: result.publications.length / Math.max(.001, durationMs / 1000),
    },
    intervals: { raf: intervals(result.rafTimes), shaderPublications: intervals(result.publications) },
    diagnostics: deltaDiagnostics(result.before, result.after),
    errors: result.errors,
    processMetrics: { scope: "whole fixture run; not directly comparable to shared transport CPU cost", initial: beforeMetrics, final: afterMetrics, cumulativeCpuDeltas: cpuDeltas(beforeMetrics, afterMetrics) },
    gpu,
    claims: {
      usesCurrentSceneTextureImplementation: true,
      usesProductionSlideRendererAndEffectRuntime: true,
      finalShaderMatchesSharedTextureHarness: true,
      sceneEquivalentToSharedHarness: false,
      cadenceReferenceOnly: true,
      cpuCostDirectlyComparable: false,
      physicalDisplayFpsMeasured: false,
    },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`LEGACY_SCENE_TEXTURE_BENCHMARK ${JSON.stringify(report)}`);
  if (result.errors.length) process.exitCode = 1;
} finally {
  await app?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
