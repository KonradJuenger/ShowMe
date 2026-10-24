import { newPresentationDocument } from "../../src/core/document";
import {
  createBasicShape,
  createContainerElement,
} from "../../src/core/elementFactory";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import { GpuRendererExperiment } from "../../src/experiments/gpu-renderer/renderer";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { flushEffectSurfaces } from "../../src/components/effectRuntime";
import { createDomRasterSource } from "../../src/components/domRaster";
import { createMediaElement } from "../../src/core/media";

export async function verifyGpuVideo() {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.src = new URL(
    "../fixtures/media/native-motion.webm",
    import.meta.url,
  ).href;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Video fixture failed"));
  });
  await video.play();
  const model = newPresentationDocument("Direct video upload smoke");
  model.deck.width = 640;
  model.deck.height = 360;
  const slide = model.slides[model.deck.slideIds[0]];
  const element = createMediaElement(
    "video",
    {
      version: 1,
      id: "a".repeat(64),
      filename: "native-motion.webm",
      names: ["native-motion.webm"],
      type: "video",
      mediaType: "video",
      mime: "video/webm",
      bytes: 1,
      width: video.videoWidth,
      height: video.videoHeight,
      createdAt: "2026-10-24T00:00:00.000Z",
    },
    { x: 0, y: 0 },
  );
  slide.nodes[0].children = [element];
  const canvas = document.createElement("canvas");
  const renderer = new GpuRendererExperiment(canvas, slide, model.deck, {
    pixelRatio: 1,
    mediaSource: () => video,
  });
  const start = performance.now();
  let frames = 0;
  while (performance.now() - start < 1000) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await renderer.render({ stageIndex: 0, timeMs: performance.now() - start });
    frames++;
  }
  const result = {
    elapsed: performance.now() - start,
    frames,
    currentTime: video.currentTime,
    dimensions: [video.videoWidth, video.videoHeight],
    diagnostics: renderer.diagnostics(),
    glError: renderer.gl.getError(),
  };
  video.pause();
  video.removeAttribute("src");
  video.load();
  renderer.dispose();
  return { ...result, disposed: renderer.diagnostics() };
}

/** Small exact-color probes, independent of the demo's coarse parity tolerance. */
export async function verifyGpuSemantics() {
  const model = newPresentationDocument("GPU semantic probes");
  model.deck.width = 100;
  model.deck.height = 100;
  const slide = model.slides[model.deck.slideIds[0]];
  slide.background = "#0000ff";
  const definition = {
    ...blankEffect("shader"),
    target: "overlay" as const,
    input: "backdrop" as const,
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
in vec2 v_uv;
out vec4 outColor;
void main() { outColor = texture(u_input, v_uv); }`,
  };
  slide.effectResources = { identity: definition };
  const shape = (id: string, color: string, width = 100) => {
    const element = createBasicShape(id, "rectangle", { x: 0, y: 0 });
    element.frame.width = width;
    element.frame.height = 100;
    element.appearance.fill = color;
    return element;
  };
  const render = async () => {
    const canvas = document.createElement("canvas");
    const renderer = new GpuRendererExperiment(canvas, slide, model.deck, {
      pixelRatio: 1,
    });
    await renderer.render({ stageIndex: -1, timeMs: 0 });
    const pixel = renderer.readPixel(25, 50);
    renderer.dispose();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        createElement(SlideRenderer, {
          deck: structuredClone(model.deck),
          slide: structuredClone(slide),
          staticVideo: true,
          preparedImages: false,
        }),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await flushEffectSurfaces(host);
    const raster = createDomRasterSource(
      () => host.querySelector<HTMLElement>(".slide-renderer")!,
      () => true,
      () => {},
      () => {},
      async () => {
        await flushEffectSurfaces(host);
      },
      undefined,
      true,
    );
    await raster.update(100, 100, 100, 100);
    const reference = [
      ...raster.canvas.getContext("2d")!.getImageData(25, 50, 1, 1).data,
    ];
    raster.dispose();
    root.unmount();
    host.remove();
    return { gpu: pixel, reference };
  };
  const lens = shape("lens", "#ff0000");
  lens.effects = [newEffectInstance("identity", definition, "overlay")];
  const later = shape("later", "#00ff00", 10);
  slide.nodes[0].children = [lens, later];
  // Probe a coordinate covered by later green paint, publishing elsewhere so
  // later paint cannot hide a wrong input. Own red and later green both fail.
  definition.source = definition.source.replace(
    "texture(u_input, v_uv)",
    "texture(u_input, vec2(0.05, 0.5))",
  );
  const elementEntry = await render();
  definition.source = definition.source.replace(
    "texture(u_input, vec2(0.05, 0.5))",
    "texture(u_input, v_uv)",
  );
  lens.appearance.fill = null;
  const prior = shape("prior", "#ff0000");
  const group = createContainerElement("parent", [prior, lens], { x: 0, y: 0 });
  group.frame.width = group.frame.height = 100;
  group.appearance.opacity = 0.5;
  group.clipChildren = true;
  slide.nodes[0].children = [group];
  const nestedOpacity = await render();
  const outer = createContainerElement("outer", [group], { x: 2.25, y: 1.5 });
  outer.frame.width = outer.frame.height = 100;
  outer.frame.rotation = 7;
  outer.frame.scaleX = 0.9;
  outer.appearance.opacity = 0.7;
  outer.clipChildren = true;
  group.frame.rotation = -5;
  group.frame.x = 4.5;
  group.frame.y = 3.5;
  slide.nodes[0].children = [outer];
  const nestedTransforms = await render();
  group.frame.rotation = group.frame.x = group.frame.y = 0;
  slide.nodes[0].children = [group];
  group.frame.width = 30;
  definition.source = definition.source.replace(
    "texture(u_input, v_uv)",
    "texture(u_input, vec2(0.75, 0.5))",
  );
  const ancestorClip = await render();
  // A content chain must sample its immediate predecessor, entirely on GPU.
  const content = {
    ...definition,
    target: "content" as const,
    input: "content" as const,
    source: definition.source.replace(
      "outColor = texture(u_input, vec2(0.75, 0.5));",
      "vec4 c = texture(u_input, v_uv); outColor = vec4(c.a - c.rgb, c.a);",
    ),
  };
  slide.effectResources.content = content;
  const chained = shape("chained", "#ff0000");
  chained.effects = [
    newEffectInstance("content", content, "content"),
    newEffectInstance("content", content, "content"),
  ];
  slide.nodes[0].children = [chained];
  const contentChain = await render();
  return {
    elementEntry,
    nestedOpacity,
    nestedTransforms,
    ancestorClip,
    contentChain,
  };
}
