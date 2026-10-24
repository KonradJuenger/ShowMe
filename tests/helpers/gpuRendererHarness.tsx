import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { flushEffectSurfaces } from "../../src/components/effectRuntime";
import { createDomRasterSource } from "../../src/components/domRaster";
import { newPresentationDocument, type PresentationDocument } from "../../src/core/document";
import { createBasicShape, createContainerElement } from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import { addParameterAnimation } from "../../src/core/motion";
import type { MotionPreviewState } from "../../src/core/motionPlayback";
import type { Element } from "../../src/core/element";
import { platform } from "../../src/platform";
import { GpuRendererExperiment } from "../../src/experiments/gpu-renderer/renderer";
import { createChromiumNativeTextRasterSource } from "./gpuNativeTextRaster";

const BASE = { width: 640, height: 360 } as const;

function scaleFrame(element: Element, scaleX: number, scaleY: number) {
  element.frame.x *= scaleX;
  element.frame.y *= scaleY;
  element.frame.width *= scaleX;
  element.frame.height *= scaleY;
}

function setText(element: Element, text: string, fontSize: number) {
  if (element.content?.type !== "text" || element.content.format.kind !== "local")
    throw new Error("GPU renderer fixture text is invalid");
  element.content.text = text;
  element.content.placeholder = false;
  element.content.autoSize = "none";
  element.content.format.typography.fontFamily = "Arial";
  element.content.format.typography.fontSize = fontSize;
  element.content.format.typography.fontWeight = 700;
  element.content.format.typography.color = "#f4f6fb";
  element.content.format.typography.lineHeight = 1.05;
}

function generatedShader() {
  return {
    ...blankEffect("shader"),
    name: "GPU experiment generated",
    target: "background" as const,
    input: "none" as const,
    source: `#version 300 es
precision highp float;
uniform float u_t;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec2 p = v_uv;
  float wave = 0.5 + 0.5 * sin(p.x * 10.0 + p.y * 7.0 + u_t * 1.2);
  vec3 a = vec3(0.035, 0.055, 0.11);
  vec3 b = vec3(0.18, 0.43, 0.72);
  outColor = vec4(mix(a, b, wave * 0.65), 1.0);
}`,
  };
}

function glassShader() {
  return {
    ...blankEffect("shader"),
    name: "GPU experiment glass",
    target: "background" as const,
    input: "backdrop" as const,
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_resolution;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec2 px = 1.0 / max(u_resolution, vec2(1.0));
  vec4 c = texture(u_input, v_uv) * 0.28;
  c += texture(u_input, v_uv + vec2(px.x, 0.0) * 4.0) * 0.18;
  c += texture(u_input, v_uv - vec2(px.x, 0.0) * 4.0) * 0.18;
  c += texture(u_input, v_uv + vec2(0.0, px.y) * 4.0) * 0.18;
  c += texture(u_input, v_uv - vec2(0.0, px.y) * 4.0) * 0.18;
  c.rgb = mix(c.rgb, vec3(0.66, 0.82, 0.98), 0.18);
  outColor = vec4(c.rgb, 0.92);
}`,
  };
}

function finalShader() {
  return {
    ...blankEffect("shader"),
    name: "GPU experiment final",
    target: "background" as const,
    input: "backdrop" as const,
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 c = texture(u_input, v_uv);
  c.rgb = c.rgb * vec3(0.985, 1.0, 0.995) + vec3(0.008, 0.002, 0.012);
  outColor = c;
}`,
  };
}

function drawFixtureImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ef3f43";
  ctx.fillRect(0, 0, 160, 100);
  ctx.fillStyle = "#42d26f";
  ctx.fillRect(160, 0, 160, 100);
  ctx.fillStyle = "#326be8";
  ctx.fillRect(0, 100, 160, 100);
  ctx.fillStyle = "#f0d33f";
  ctx.fillRect(160, 100, 160, 100);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 34px Arial";
  ctx.fillText("TOP", 118, 58);
  ctx.fillText("L", 34, 162);
  ctx.fillText("R", 265, 162);
  return canvas;
}

async function importFixtureImage() {
  const canvas = drawFixtureImage();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encode failed"))), "image/png"),
  );
  const [asset] = await platform.importAssets([
    new File([blob], "gpu-renderer-experiment.png", { type: "image/png" }),
  ]);
  const url = await platform.assetUrl(asset.id);
  if (!url) throw new Error("GPU renderer fixture asset URL is unavailable");
  const image = new Image();
  image.src = url;
  await image.decode();
  return { asset, url, image };
}

function buildDocument(
  assetId: string,
  size: { width: number; height: number },
): PresentationDocument {
  const model = newPresentationDocument("General GPU renderer experiment");
  model.deck.width = size.width;
  model.deck.height = size.height;
  const slide = model.slides[model.deck.slideIds[0]];
  slide.background = "#080d18";
  const sx = size.width / BASE.width;
  const sy = size.height / BASE.height;
  const ss = Math.min(sx, sy);

  const generated = generatedShader();
  const glass = glassShader();
  const final = finalShader();
  slide.effectResources = { generated, glass, final };

  const background = createBasicShape("gpu-bg", "rectangle", { x: 0, y: 0 });
  background.frame.width = size.width;
  background.frame.height = size.height;
  background.appearance.fill = null;
  background.effects = [newEffectInstance("generated", generated, "background")];

  const title = createTextElement("gpu-title", { x: 34, y: 25 });
  title.frame.width = 420;
  title.frame.height = 78;
  scaleFrame(title, sx, sy);
  setText(title, "Chromium native raster", 40 * ss);
  title.cssClasses = ["gpu-native-title"];

  const image = createBasicShape("gpu-image", "rectangle", { x: 42, y: 126 });
  image.frame.width = 196;
  image.frame.height = 142;
  image.frame.rotation = -7;
  image.appearance.fill = null;
  image.clipChildren = true;
  scaleFrame(image, sx, sy);
  image.content = {
    type: "image",
    assetId,
    filename: "gpu-renderer-experiment.png",
    mediaType: "image",
    opacity: 1,
    lockAspect: true,
    transform: {
      rule: "fill",
      intrinsicWidth: 320,
      intrinsicHeight: 200,
      rotation: 0,
      flipX: false,
      flipY: false,
      anchorX: 0.54,
      anchorY: 0.48,
      zoom: 1.08,
    },
  };

  const clippedChild = createBasicShape("gpu-clipped-child", "rectangle", {
    x: -38,
    y: 26,
  });
  clippedChild.frame.width = 220;
  clippedChild.frame.height = 86;
  clippedChild.appearance.fill = "#28d4c5";
  scaleFrame(clippedChild, sx, sy);

  const nestedText = createTextElement("gpu-nested-text", { x: 22, y: 37 });
  nestedText.frame.width = 174;
  nestedText.frame.height = 54;
  scaleFrame(nestedText, sx, sy);
  setText(nestedText, "NESTED", 29 * ss);

  const group = createContainerElement(
    "gpu-group",
    [clippedChild, nestedText],
    { x: 260, y: 128 },
  );
  group.frame.width = 188;
  group.frame.height = 118;
  group.frame.rotation = 6;
  group.appearance.opacity = 0.56;
  group.clipChildren = true;
  scaleFrame(group, sx, sy);

  const glassElement = createBasicShape("gpu-glass", "rectangle", { x: 330, y: 62 });
  glassElement.frame.width = 245;
  glassElement.frame.height = 178;
  glassElement.appearance.fill = null;
  scaleFrame(glassElement, sx, sy);
  glassElement.effects = [newEffectInstance("glass", glass, "background")];

  const moving = createTextElement("gpu-moving-text", { x: 280, y: 280 });
  moving.frame.width = 285;
  moving.frame.height = 58;
  scaleFrame(moving, sx, sy);
  setText(moving, "MOVE WITHOUT RASTER", 28 * ss);
  moving.cssClasses = ["gpu-moving-native"];

  const finalElement = createBasicShape("gpu-final", "rectangle", { x: 0, y: 0 });
  finalElement.frame.width = size.width;
  finalElement.frame.height = size.height;
  finalElement.appearance.fill = null;
  finalElement.effects = [newEffectInstance("final", final, "background")];

  slide.nodes[0].children = [
    background,
    title,
    image,
    group,
    glassElement,
    moving,
    finalElement,
  ];
  model.deck.stylesheet = `
.gpu-native-title [data-text-content] { text-shadow: ${1 * ss}px ${2 * ss}px ${3 * ss}px rgba(0,0,0,.55); }
.gpu-moving-native [data-text-content] { color: rgb(255, 235, 115) !important; text-shadow: ${2 * ss}px ${2 * ss}px ${2 * ss}px rgba(0,0,0,.65); }
`;

  slide.motion = addParameterAnimation(
    slide.motion,
    0,
    moving.id,
    "transform.x",
    "GPU transport X",
    moving.frame.x,
    moving.frame.x + 74 * sx,
    2400,
  );
  slide.motion = addParameterAnimation(
    slide.motion,
    0,
    moving.id,
    "transform.rotation",
    "GPU transport rotation",
    -5,
    11,
    2400,
  );
  slide.motion = addParameterAnimation(
    slide.motion,
    0,
    moving.id,
    "transform.scaleX",
    "GPU transport scale X",
    0.94,
    1.08,
    2400,
  );
  slide.motion = addParameterAnimation(
    slide.motion,
    0,
    moving.id,
    "transform.scaleY",
    "GPU transport scale Y",
    0.94,
    1.08,
    2400,
  );
  return model;
}

function nextPaint() {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function motionState(model: PresentationDocument, timeMs: number): MotionPreviewState {
  const slide = model.slides[model.deck.slideIds[0]];
  const stage = slide.motion!.stages[0];
  return {
    stageId: stage.id,
    stageIndex: 0,
    time: timeMs,
    startedAt: performance.now(),
    running: false,
  };
}

export async function mountGpuRendererHarness(options: {
  width?: number;
  height?: number;
  pixelRatio?: number;
  reference?: boolean;
} = {}) {
  const size = {
    width: options.width ?? BASE.width,
    height: options.height ?? BASE.height,
  };
  const fixture = await importFixtureImage();
  const model = buildDocument(fixture.asset.id, size);
  const slide = model.slides[model.deck.slideIds[0]];

  document.body.replaceChildren();
  document.body.style.margin = "0";
  document.body.style.background = "#17191e";
  document.body.style.color = "white";
  const shell = document.createElement("main");
  shell.dataset.gpuRendererExperiment = "true";
  shell.style.cssText = "font:13px Arial,sans-serif;padding:12px;display:grid;gap:12px";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:12px;align-items:flex-start;overflow:auto";
  shell.append(row);
  document.body.append(shell);

  const gpuPanel = document.createElement("section");
  gpuPanel.innerHTML = "<strong>GPU graph</strong>";
  const canvas = document.createElement("canvas");
  canvas.dataset.gpuExperimentCanvas = "true";
  canvas.style.display = "block";
  canvas.style.marginTop = "6px";
  gpuPanel.append(canvas);
  row.append(gpuPanel);

  const renderer = new GpuRendererExperiment(canvas, slide, model.deck, {
    pixelRatio: options.pixelRatio ?? 1,
    mediaSource: (element) =>
      element.content && element.content.type !== "text" && element.content.assetId === fixture.asset.id
        ? fixture.image
        : null,
    nativeTextSource: createChromiumNativeTextRasterSource,
  });

  let referenceRoot: Root | null = null;
  let referenceHost: HTMLDivElement | null = null;
  let referenceRaster: ReturnType<typeof createDomRasterSource> | null = null;
  if (options.reference !== false) {
    const panel = document.createElement("section");
    panel.innerHTML = "<strong>Current Chromium renderer</strong>";
    referenceHost = document.createElement("div");
    referenceHost.dataset.gpuExperimentReference = "true";
    referenceHost.style.marginTop = "6px";
    panel.append(referenceHost);
    row.append(panel);
    referenceRoot = createRoot(referenceHost);
  }

  const renderReference = async (timeMs: number) => {
    if (!referenceRoot || !referenceHost) return;
    flushSync(() =>
      referenceRoot!.render(
        <SlideRenderer
          deck={model.deck}
          slide={slide}
          staticVideo
          preparedImages={false}
          renderScale={1}
          motionState={motionState(model, timeMs)}
        />,
      ),
    );
    await nextPaint();
    await flushEffectSurfaces(referenceHost);
    await nextPaint();
  };

  const render = async (timeMs: number) => {
    await renderer.render({ stageIndex: 0, timeMs });
  };

  const warm = async () => {
    for (const time of [0, 0, 1]) {
      await render(time);
      await nextPaint();
    }
  };

  const transformOnlyCheck = async (frames = 90) => {
    await warm();
    const before = renderer.diagnostics();
    for (let index = 0; index < frames; index++)
      await render((index / Math.max(1, frames - 1)) * 2400);
    const after = renderer.diagnostics();
    return { before, after };
  };

  const nativePixelChangeCheck = async () => {
    await warm();
    const moving = slide.nodes[0].children.find((element) => element.id === "gpu-moving-text")!;
    if (moving.content?.type !== "text") throw new Error("Moving text fixture is missing");
    const original = moving.content.text;
    const before = renderer.diagnostics();
    moving.content.text = original + "*";
    await render(1200);
    await nextPaint();
    const changed = renderer.diagnostics();
    moving.content.text = original;
    await render(1200);
    return { before, changed };
  };

  const staticParity = async (timeMs = 1200) => {
    if (!referenceHost) throw new Error("Reference renderer is disabled");
    await render(timeMs);
    await renderReference(timeMs);
    const source = () =>
      referenceHost!.querySelector<HTMLElement>(".slide-renderer")!;
    referenceRaster ??= createDomRasterSource(
      source,
      () => true,
      () => {},
      () => {},
      async () => {
        await flushEffectSurfaces(referenceHost!);
      },
      undefined,
      true,
    );
    referenceRaster.markDirty();
    await referenceRaster.update(size.width, size.height, size.width, size.height);
    const reference = referenceRaster.canvas.getContext("2d")!.getImageData(
      0,
      0,
      size.width,
      size.height,
    ).data;
    const gpu = renderer.readPixels();
    if (gpu.length !== reference.length)
      throw new Error(`Parity size mismatch ${gpu.length} != ${reference.length}`);
    let total = 0;
    let alpha = 0;
    let visible = 0;
    for (let index = 0; index < gpu.length; index += 4) {
      total +=
        Math.abs(gpu[index] - reference[index]) +
        Math.abs(gpu[index + 1] - reference[index + 1]) +
        Math.abs(gpu[index + 2] - reference[index + 2]) +
        Math.abs(gpu[index + 3] - reference[index + 3]);
      alpha += Math.abs(gpu[index + 3] - reference[index + 3]);
      if (gpu[index + 3] > 8 || reference[index + 3] > 8) visible++;
    }
    const pixels = gpu.length / 4;
    return {
      pixels,
      visible,
      meanAbsoluteChannelError: total / (pixels * 4),
      meanAlphaError: alpha / pixels,
      gpuDiagnostics: renderer.diagnostics(),
    };
  };

  const runBenchmark = async (durationMs = 3000) => {
    await warm();
    const started = performance.now();
    let callbacks = 0;
    await new Promise<void>((resolve, reject) => {
      const tick = async (now: number) => {
        try {
          if (now - started >= durationMs) {
            resolve();
            return;
          }
          callbacks++;
          await render((now - started) % 2400);
          requestAnimationFrame(tick);
        } catch (error) {
          reject(error);
        }
      };
      requestAnimationFrame(tick);
    });
    const elapsed = performance.now() - started;
    return {
      callbacks,
      elapsed,
      callbackRate: (callbacks * 1000) / elapsed,
      diagnostics: renderer.diagnostics(),
    };
  };

  await render(0);
  if (referenceRoot) await renderReference(0);

  return {
    model,
    slide,
    canvas,
    renderer,
    render,
    renderReference,
    transformOnlyCheck,
    nativePixelChangeCheck,
    staticParity,
    runBenchmark,
    effectIds: {
      generated: slide.nodes[0].children[0].effects![0].id,
      glass: slide.nodes[0].children[4].effects![0].id,
      final: slide.nodes[0].children[6].effects![0].id,
    },
    dispose() {
      referenceRaster?.dispose();
      referenceRoot?.unmount();
      renderer.dispose();
      platform.releaseUrl(fixture.url);
      shell.remove();
    },
  };
}
