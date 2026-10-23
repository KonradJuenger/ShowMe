"use strict";

const { ipcRenderer, sharedTexture } = require("electron");
const { intervalSummary, valueSummary, rate } = require("./stats.cjs");

const params = new URLSearchParams(location.search);
const backend = params.get("backend") || "webgpu";
const verbose = params.get("verbose") === "1";
const canvas = document.getElementById("output");
const hud = document.getElementById("hud");
let measurementWindow = null;
let measurementStarted = false;
let measurementEnded = false;
let measuredStartedAt = null;
let measuredEndedAt = null;
const arrivals = [];
const publications = [];
const rafs = [];
const submitCosts = [];
const gpuCompletionWaits = [];
let contextLosses = 0;
let received = 0;
let rendered = 0;
let renderErrors = 0;
let renderer;
let stopped = false;

function fullScreenWgsl() {
  return `
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uvs = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: VertexOut;
  out.position = vec4f(positions[index], 0.0, 1.0);
  out.uv = uvs[index];
  return out;
}
@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var sampleClamp: sampler;
@fragment fn fs(in: VertexOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(source, sampleClamp, in.uv);
  return vec4f(1.0 - c.r, 0.18 + 0.78 * c.b, 1.0 - c.g, c.a);
}`;
}

async function createWebGpuRenderer() {
  if (!navigator.gpu) throw new Error("WebGPU is unavailable in this Electron renderer");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();
  device.lost.then(() => { contextLosses++; });
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Cannot create WebGPU canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const module = device.createShaderModule({ code: fullScreenWgsl() });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  let measuredSubmittedFrames = 0;
  return {
    kind: "webgpu-external-texture",
    draw(frame, measured) {
      if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
        canvas.width = frame.codedWidth;
        canvas.height = frame.codedHeight;
      }
      const begin = performance.now();
      const external = device.importExternalTexture({ source: frame });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: external },
          { binding: 1, resource: sampler },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (measured) submitCosts.push(performance.now() - begin);
      if (measured) measuredSubmittedFrames++;
      if (measured && measuredSubmittedFrames % 60 === 0) {
        const submittedAt = performance.now();
        void device.queue.onSubmittedWorkDone().then(() => {
          gpuCompletionWaits.push(performance.now() - submittedAt);
        });
      }
      return Promise.resolve();
    },
  };
}

function createWebGlRenderer() {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) throw new Error("WebGL2 unavailable");
  canvas.addEventListener("webglcontextlost", (event) => {
    contextLosses++;
    event.preventDefault();
  });
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compile failed");
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, `#version 300 es\nprecision highp float;\nout vec2 uv;\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=vec2(p.x,1.0-p.y);gl_Position=vec4(p*2.0-1.0,0,1);}`);
  const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nin vec2 uv;uniform sampler2D source;out vec4 outColor;\nvoid main(){vec4 c=texture(source,uv);outColor=vec4(1.0-c.r,0.18+0.78*c.b,1.0-c.g,c.a);}`);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
  return {
    kind: "webgl-videoframe-upload",
    draw(frame, measured) {
      if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
        canvas.width = frame.codedWidth;
        canvas.height = frame.codedHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      const begin = performance.now();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
      if (measured) submitCosts.push(performance.now() - begin);
      return Promise.resolve();
    },
  };
}

function sampleMemory() {
  return typeof process.getProcessMemoryInfo === "function"
    ? process.getProcessMemoryInfo().catch(() => null)
    : Promise.resolve(null);
}

let initialMemoryPromise = Promise.resolve(null);
let finalMemoryPromise = Promise.resolve(null);

function beginMeasurement() {
  if (measurementStarted || !measurementWindow) return;
  measurementStarted = true;
  measurementEnded = false;
  measuredStartedAt = performance.now();
  measuredEndedAt = null;
  arrivals.length = 0;
  publications.length = 0;
  rafs.length = 0;
  submitCosts.length = 0;
  gpuCompletionWaits.length = 0;
  received = 0;
  rendered = 0;
  renderErrors = 0;
  initialMemoryPromise = sampleMemory();
}

function endMeasurement() {
  if (measurementEnded || !measurementStarted) return;
  measurementEnded = true;
  measuredEndedAt = performance.now();
  finalMemoryPromise = sampleMemory();
}

function inMeasurementWindow(epochMs = Date.now()) {
  if (!measurementWindow) return false;
  if (epochMs >= measurementWindow.startEpochMs && !measurementStarted)
    beginMeasurement();
  if (epochMs >= measurementWindow.endEpochMs && !measurementEnded)
    endMeasurement();
  return (
    measurementStarted &&
    !measurementEnded &&
    epochMs >= measurementWindow.startEpochMs &&
    epochMs < measurementWindow.endEpochMs
  );
}

function raf(now) {
  if (inMeasurementWindow(Date.now())) rafs.push(now);
  if (!stopped) requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

async function finish(reason = "requested") {
  if (stopped) return;
  stopped = true;
  endMeasurement();
  const initialMemory = await initialMemoryPromise;
  const finalMemory = await finalMemoryPromise;
  const durationMs =
    measurementWindow?.durationMs ??
    Math.max(0, (measuredEndedAt ?? performance.now()) - (measuredStartedAt ?? performance.now()));
  const rateStart = measurementWindow?.startEpochMs ?? 0;
  const rateEnd = measurementWindow?.endEpochMs ?? Math.max(1, durationMs);
  ipcRenderer.send("shared-texture:finished", {
    reason,
    backend: renderer?.kind ?? backend,
    received,
    rendered,
    droppedOrLateFrames: Math.max(0, received - rendered),
    renderErrors,
    contextLosses,
    durationMs,
    measurementWindow,
    measuredRuntimeMs:
      measuredStartedAt !== null && measuredEndedAt !== null
        ? measuredEndedAt - measuredStartedAt
        : null,
    rates: {
      arrivalsPerSec: rate(received, rateStart, rateEnd),
      shaderPublicationsPerSec: rate(rendered, rateStart, rateEnd),
      rafPerSec: rate(rafs.length, rateStart, rateEnd),
    },
    intervals: {
      arrivals: intervalSummary(arrivals),
      shaderPublications: intervalSummary(publications),
      raf: intervalSummary(rafs),
    },
    submitCostMs: valueSummary(submitCosts),
    gpuCompletionWaitMs: valueSummary(gpuCompletionWaits),
    memory: { initial: initialMemory, final: finalMemory },
  });
}

ipcRenderer.on("shared-texture:benchmark-window", (_event, value) => {
  measurementWindow = value;
  setTimeout(
    () => beginMeasurement(),
    Math.max(0, value.startEpochMs - Date.now()),
  );
  setTimeout(
    () => endMeasurement(),
    Math.max(0, value.endEpochMs - Date.now()),
  );
});
ipcRenderer.on("shared-texture:stop", () => void finish());

(async () => {
  renderer = backend === "webgl" ? createWebGlRenderer() : await createWebGpuRenderer();
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
    if (stopped) {
      importedSharedTexture.release();
      return;
    }
    const arrivedAt = performance.now();
    const measured = inMeasurementWindow(Date.now());
    if (measured) {
      received++;
      arrivals.push(arrivedAt);
    }
    let frame;
    let importedReleased = false;
    try {
      frame = importedSharedTexture.getVideoFrame();
      importedSharedTexture.release();
      importedReleased = true;
      await renderer.draw(frame, measured);
      if (inMeasurementWindow(Date.now())) {
        rendered++;
        publications.push(performance.now());
      }
      if (verbose && rendered > 0 && rendered % 60 === 0)
        hud.textContent = `${renderer.kind}\nreceived ${received}\nrendered ${rendered}\nsource frame ${metadata?.frameCount ?? "?"}`;
    } catch (error) {
      if (measured) renderErrors++;
      if (!importedReleased) {
        try { importedSharedTexture.release(); } catch {}
      }
      ipcRenderer.send("shared-texture:consumer-error", String(error?.stack || error));
    } finally {
      frame?.close();
    }
  });
  hud.textContent = renderer.kind;
  ipcRenderer.send("shared-texture:consumer-ready", { backend: renderer.kind });
})().catch((error) => {
  ipcRenderer.send("shared-texture:consumer-error", String(error?.stack || error));
  void finish("initialization-error");
});
