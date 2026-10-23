"use strict";

const { app, BrowserWindow, ipcMain, sharedTexture } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { BoundedLatestFrameQueue } = require("./framePolicy.cjs");
const { intervalSummary, valueSummary, rate } = require("./stats.cjs");

function option(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--"))
    return process.argv[index + 1];
  return fallback;
}
function numberOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

const width = Math.round(numberOption("--width", 1596));
const height = Math.round(numberOption("--height", 998));
const dpr = numberOption("--dpr", 1.6042);
const fps = Math.round(numberOption("--fps", 60));
const durationMs = numberOption("--duration", process.argv.includes("--benchmark") ? 20000 : 15000);
const warmupMs = numberOption("--warmup", 1500);
const barrierLeadMs = 250;
const backend = option("--backend", "webgpu");
const maxActive = Math.round(numberOption("--max-active", 2));
const drainTimeoutMs = numberOption("--drain-timeout", 5000);
const verbose = process.argv.includes("--verbose");
const show = process.argv.includes("--show") || !process.argv.includes("--benchmark");
const output = option("--output", "");
const evidence = option("--evidence", "");
if (!new Set(["webgpu", "webgl"]).has(backend)) throw new Error("--backend must be webgpu or webgl");

let sourceWindow = null;
let consumerWindow = null;
let stopping = false;
let consumerResult = null;
let measurementWindow = null;
let measurementStarted = false;
let measurementEnded = false;
const paintTimes = [];
const releaseLatencies = [];
const sourceFrameCounts = [];
const textureShapes = new Map();
const textureFormats = new Set();
const handleKinds = new Set();
let paintEvents = 0;
let missingTextures = 0;
let sourceReleased = 0;
let timedSourceReleased = 0;
let releaseErrors = 0;
let transferErrors = 0;
let consumerErrors = [];
let finalTimer = null;
let drainTimedOut = false;
let gpuInfo = null;
let sourceViewport = null;
let finalizing = false;
let initialAppMetrics = [];
let finalAppMetrics = [];
let timedOffered = 0;
let timedConsumed = 0;
let timedStaleReleased = 0;
const lifetimeSamples = [];
let lifetimeTimer = null;
let stopReason = null;

function handleKind(info) {
  const handle = info?.handle || {};
  if (handle.ntHandle) return "windows-nt-handle";
  if (handle.ioSurface) return "macos-iosurface";
  if (handle.nativePixmap) return "linux-native-pixmap";
  return "unknown";
}
function safeRelease(texture, measured = false) {
  try {
    texture.release();
    sourceReleased++;
    if (measured) timedSourceReleased++;
  } catch (error) {
    releaseErrors++;
    if (verbose) console.error("source texture release failed", error);
  }
}

const queue = new BoundedLatestFrameQueue({
  maxActive,
  release: (frame, reason) => {
    if (frame.measured && reason === "stale") timedStaleReleased++;
    safeRelease(frame.texture, frame.measured);
  },
  consume: async (frame, done) => {
    if (frame.measured) timedConsumed++;
    const receivedAt = frame.receivedAt;
    let imported;
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: frame.texture.textureInfo,
        allReferencesReleased: () => {
          if (frame.measured)
            releaseLatencies.push(performance.now() - receivedAt);
          safeRelease(frame.texture, frame.measured);
          done();
        },
      });
      await sharedTexture.sendSharedTexture(
        {
          frame: consumerWindow.webContents.mainFrame,
          importedSharedTexture: imported,
        },
        frame.metadata,
      );
      imported.release();
    } catch (error) {
      transferErrors++;
      if (verbose) console.error("shared texture transfer failed", error);
      if (imported) imported.release();
      else {
        safeRelease(frame.texture, frame.measured);
        done();
      }
    }
  },
});

function appMetricsSnapshot() {
  return app.getAppMetrics().map((entry) => ({
    pid: entry.pid,
    creationTime: entry.creationTime,
    type: entry.type,
    serviceName: entry.serviceName,
    cpu: entry.cpu,
    memory: entry.memory,
  }));
}
function cpuDeltas(initial, final) {
  const before = new Map(initial.map((entry) => [`${entry.pid}:${entry.creationTime}`, entry]));
  return final.map((entry) => {
    const previous = before.get(`${entry.pid}:${entry.creationTime}`);
    const a = previous?.cpu?.cumulativeCPUUsage;
    const b = entry.cpu?.cumulativeCPUUsage;
    return {
      pid: entry.pid,
      type: entry.type,
      serviceName: entry.serviceName,
      cumulativeCpuSeconds: Number.isFinite(a) && Number.isFinite(b) ? b - a : null,
    };
  });
}
function beginMeasurement() {
  if (measurementStarted || !measurementWindow) return;
  measurementStarted = true;
  paintTimes.length = 0;
  releaseLatencies.length = 0;
  sourceFrameCounts.length = 0;
  textureShapes.clear();
  textureFormats.clear();
  handleKinds.clear();
  paintEvents = 0;
  missingTextures = 0;
  timedSourceReleased = 0;
  timedOffered = 0;
  timedConsumed = 0;
  timedStaleReleased = 0;
  initialAppMetrics = appMetricsSnapshot();
  lifetimeTimer = setInterval(() => {
    lifetimeSamples.push({ epochMs: Date.now(), paintEvents, sourceReleased,
      queue: queue.snapshot(), processes: appMetricsSnapshot() });
  }, 10000);
  if (verbose) console.log("measurement started", measurementWindow);
}

function endMeasurement() {
  if (measurementEnded || !measurementStarted) return;
  measurementEnded = true;
  clearInterval(lifetimeTimer);
  finalAppMetrics = appMetricsSnapshot();
  if (verbose) console.log("measurement ended", measurementWindow);
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

function scheduleMeasurementWindow() {
  if (measurementWindow || stopping) return;
  const startEpochMs = Date.now() + barrierLeadMs;
  const endEpochMs = startEpochMs + durationMs;
  measurementWindow = {
    startEpochMs,
    endEpochMs,
    durationMs,
    warmupMs,
    barrierLeadMs,
  };
  consumerWindow.webContents.send(
    "shared-texture:benchmark-window",
    measurementWindow,
  );
  setTimeout(
    () => beginMeasurement(),
    Math.max(0, startEpochMs - Date.now()),
  ).unref();
  finalTimer = setTimeout(() => {
    endMeasurement();
    stop("duration-complete");
  }, Math.max(0, endEpochMs - Date.now()));
}

function finishIfReady() {
  if (!stopping || !consumerResult || finalizing) return;
  if (queue.snapshot().active > 0 && !drainTimedOut) {
    setTimeout(finishIfReady, 25);
    return;
  }
  finalizing = true;
  endMeasurement();
  const counts = sourceFrameCounts.filter((value) => Number.isFinite(value));
  const sourceFrameGaps = counts.slice(1).map((value, index) => value - counts[index] - 1).filter((value) => value > 0);
  if (!finalAppMetrics.length) finalAppMetrics = appMetricsSnapshot();
  const finalQueue = queue.snapshot();
  const result = {
    schemaVersion: 1,
    experiment: "native-gpu-shared-texture-boundary",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    configuration: { width, height, dpr, fps, durationMs, warmupMs, barrierLeadMs, backend, maxActive, drainTimeoutMs, show },
    measurementWindow,
    stopReason,
    consumerErrors,
    source: {
      paintEvents,
      missingTextures,
      paintEventsPerSec: measurementWindow
        ? rate(
            paintEvents,
            measurementWindow.startEpochMs,
            measurementWindow.endEpochMs,
          )
        : null,
      paintIntervals: intervalSummary(paintTimes),
      frameCountGapEvents: sourceFrameGaps.length,
      skippedByFrameCount: sourceFrameGaps.reduce((sum, value) => sum + value, 0),
      textureFormats: [...textureFormats],
      textureShapes: [...textureShapes.entries()].map(([shape, count]) => ({ shape, count })),
      handleKinds: [...handleKinds],
    },
    transport: {
      queue: finalQueue,
      timedQueue: {
        offered: timedOffered,
        consumed: timedConsumed,
        staleReleased: timedStaleReleased,
      },
      sourceReleased,
      timedSourceReleased,
      releaseErrors,
      transferErrors,
      releaseLatencyMs: valueSummary(releaseLatencies),
      drainTimedOut,
      lifetimeSamples,
    },
    consumer: consumerResult,
    processMetrics: {
      scope: "timed measurement window before resource drain",
      initial: initialAppMetrics,
      final: finalAppMetrics,
      cumulativeCpuDeltas: cpuDeltas(initialAppMetrics, finalAppMetrics),
    },
    gpu: gpuInfo,
    sourceViewport,
    claims: {
      sourceIsChromiumCompositedFrame: true,
      cpuReadbackRequestedByHarness: false,
      webgpuPathUsesExternalTextureApi: backend === "webgpu",
      zeroCopyConsumerProven: false,
      physicalDisplayFpsMeasured: false,
      sceneSemantics: "final offscreen webContents compositor frame, not arbitrary ShowMe paint prefix",
    },
  };
  const finalize = () => {
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (output) {
      const target = path.resolve(output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serialized);
    }
    console.log(`SHARED_TEXTURE_BENCHMARK ${JSON.stringify(result)}`);
    if (verbose) console.log(serialized);
    if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.destroy();
    if (consumerWindow && !consumerWindow.isDestroyed()) consumerWindow.destroy();
    app.exit(consumerErrors.length || transferErrors || releaseErrors ||
      consumerResult?.renderErrors || consumerResult?.contextLosses ||
      drainTimedOut || !consumerResult || stopReason !== "duration-complete" ? 1 : 0);
  };
  if (evidence && consumerWindow && !consumerWindow.isDestroyed()) {
    const target = path.resolve(evidence);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    consumerWindow.webContents.capturePage().then((image) => {
      fs.writeFileSync(target, image.toPNG());
    }).catch((error) => {
      consumerErrors.push(`evidence capture failed: ${error}`);
    }).finally(finalize);
  } else finalize();
}

function stop(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  if (finalTimer) clearTimeout(finalTimer);
  endMeasurement();
  if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.webContents.stopPainting();
  queue.close();
  if (consumerWindow && !consumerWindow.isDestroyed())
    consumerWindow.webContents.send("shared-texture:stop", reason);
  setTimeout(() => {
    if (!consumerResult) {
      consumerResult = { reason: "consumer-timeout", received: 0, rendered: 0, renderErrors: 1 };
      finishIfReady();
    }
  }, 3000).unref();
  setTimeout(() => {
    if (queue.snapshot().active > 0) {
      drainTimedOut = true;
      console.error("SHARED_TEXTURE_DRAIN_TIMEOUT", queue.snapshot());
      consumerResult ??= { reason: "drain-timeout", renderErrors: 1 };
      finishIfReady();
    }
  }, drainTimeoutMs).unref();
  finishIfReady();
}

ipcMain.on("shared-texture:consumer-error", (_event, error) => {
  consumerErrors.push(String(error));
  console.error("SHARED_TEXTURE_CONSUMER_ERROR", error);
});
ipcMain.on("shared-texture:finished", (_event, result) => {
  consumerResult = result;
  if (!stopping) stop("consumer-finished");
  else finishIfReady();
});

app.on("window-all-closed", () => {
  if (!stopping) stop("window-closed");
});
app.on("before-quit", (event) => {
  event.preventDefault();
  stop("application-quit");
});

app.whenReady().then(async () => {
  gpuInfo = {
    hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: app.getGPUFeatureStatus(),
    basicInfo: await app.getGPUInfo("basic").catch((error) => ({ error: String(error) })),
  };
  ipcMain.once("shared-texture:consumer-ready", (_event, info) => {
    if (verbose) console.log("consumer ready", info);
    sourceWindow = new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        offscreen: {
          useSharedTexture: true,
          sharedTexturePixelFormat: "argb",
          deviceScaleFactor: dpr,
        },
      },
    });
    sourceWindow.webContents.setFrameRate(fps);
    sourceWindow.on("closed", () => stop("source-closed"));
    sourceWindow.webContents.on("paint", (event) => {
      const now = performance.now();
      const measured = inMeasurementWindow(Date.now());
      if (measured) {
        paintEvents++;
        paintTimes.push(now);
      }
      const texture = event.texture;
      if (!texture) {
        if (measured) missingTextures++;
        return;
      }
      const info = texture.textureInfo;
      const frameCount = info.metadata?.frameCount;
      if (measured) {
        if (Number.isFinite(frameCount)) sourceFrameCounts.push(frameCount);
        textureFormats.add(info.pixelFormat);
        const shape = `${info.codedSize.width}x${info.codedSize.height}`;
        textureShapes.set(shape, (textureShapes.get(shape) || 0) + 1);
        handleKinds.add(handleKind(info));
      }
      if (measured) timedOffered++;
      queue.offer({
        texture,
        receivedAt: now,
        measured,
        metadata: {
          frameCount: Number.isFinite(frameCount) ? frameCount : null,
          timestamp: info.timestamp ?? null,
          pixelFormat: info.pixelFormat,
          codedSize: info.codedSize,
          visibleRect: info.visibleRect,
          contentRect: info.contentRect,
        },
      });
    });
    sourceWindow.webContents.once("did-finish-load", async () => {
      // Windows DIP rounding and initial work-area clamping can change OSR size.
      // Correct against the actual CSS viewport before starting the warmup.
      let windowWidth = width;
      let windowHeight = height;
      for (let attempt = 0; attempt < 4; attempt++) {
        sourceWindow.setContentSize(windowWidth, windowHeight);
        sourceViewport = await sourceWindow.webContents.executeJavaScript(
          'new Promise(resolve => setTimeout(() => resolve({width: innerWidth, height: innerHeight, dpr: devicePixelRatio}), 100))',
        );
        if (sourceViewport.width === width && sourceViewport.height === height) break;
        windowWidth += width - sourceViewport.width;
        windowHeight += height - sourceViewport.height;
      }
      if (sourceViewport.width !== width || sourceViewport.height !== height) {
        consumerErrors.push(`Unexpected source viewport: ${JSON.stringify(sourceViewport)}`);
        stop("invalid-source-size");
        return;
      }
      gpuInfo = {
        hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
        featureStatus: app.getGPUFeatureStatus(),
        completeInfo: await app.getGPUInfo("complete"),
      };
      if (verbose)
        console.log("source ready", {
          requestedFrameRate: fps,
          actualFrameRate: sourceWindow.webContents.getFrameRate(),
          warmupMs,
        });
      setTimeout(() => scheduleMeasurementWindow(), warmupMs).unref();
    });
    sourceWindow.loadFile(path.join(__dirname, "scene.html"));
  });

  consumerWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show,
    backgroundColor: "#000000",
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  consumerWindow.setContentSize(width, height);
  consumerWindow.on("closed", () => stop("consumer-closed"));
  consumerWindow.webContents.once("did-finish-load", () => {
    consumerWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) stop("consumer-navigation");
    });
  });
  consumerWindow.loadFile(path.join(__dirname, "consumer.html"), {
    query: { backend, verbose: verbose ? "1" : "0" },
  });
});
