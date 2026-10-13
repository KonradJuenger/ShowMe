import { mountMixedEffectsHarness } from "./mixedEffectsHarness";
import { createContainerElement } from "../../src/core/elementFactory";
import {
  newEffectInstance,
  type EffectDefinition,
} from "../../src/core/effects";
import {
  presentationDocumentSchema,
  type PresentationDocument,
} from "../../src/core/document";
import { walkElements, type Element } from "../../src/core/element";
import {
  domRasterDiagnostics,
  setDomRasterExperimentBackend,
  setDomRasterVideoExperiment,
  type DomRasterBackend,
} from "../../src/components/domRaster";
import {
  effectSurface,
  effectRuntimeDiagnostics,
  setEffectRuntimeDiagnostics,
  flushEffectSurfaces,
  setGpuEffectChainingExperiment,
  setEffectExecutionExperiment,
  effectSourceTextureBytes,
} from "../../src/components/effectRuntime";
import { platform } from "../../src/platform";
import { shaderOutputTextureBytes } from "../../src/components/shaderOutput";

export type StressScenario = {
  id: string;
  family:
    | "original"
    | "shader"
    | "mixed"
    | "css"
    | "js"
    | "backdrop"
    | "video"
    | "tiles"
    | "composite";
  depth: number;
  count: number;
  videoCount: number;
  profileWidth: number;
  heavy?: boolean;
  taps?: number;
  slideIndex?: number;
  videoInvalidation?: "decoded" | "poll";
  backend?: DomRasterBackend | "gpu" | "refined";
};
const passShader = `#version 300 es
precision highp float;
uniform sampler2D u_input; uniform float u_t; uniform vec2 u_size;
in vec2 v_uv; out vec4 outColor;
void main(){ vec2 uv=v_uv+vec2(sin(u_t)*0.00001,0.0); outColor=texture(u_input,uv); }`;
const heavyShader = `#version 300 es
precision highp float;
uniform sampler2D u_input; uniform float u_t; uniform vec2 u_size;
in vec2 v_uv; out vec4 outColor;
void main(){vec4 color=vec4(0.0);for(int i=0;i<32;i++){float angle=float(i)*6.2831853/32.0+u_t*0.2;vec2 uv=v_uv+vec2(cos(angle),sin(angle))*8.0/max(u_size,vec2(1.0));color+=texture(u_input,uv);}outColor=color/32.0;}`;
const cssSource = `:scope { filter:blur(calc(1px + 0.5px * sin(var(--t) * 1rad))) saturate(1.1); transform:translateX(calc(2px * sin(var(--t) * 1rad))); }`;
const jsSource = `function render({text,t,random}) {const tick=Math.floor(t*60);return Array.from(text).map((letter,i)=>letter===' '?letter:String.fromCharCode(65+Math.floor(random(tick*1000+i)*26))).join('');}`;

export function buildEffectStressDocument(
  base: PresentationDocument,
  scenario: StressScenario,
) {
  const model = structuredClone(base);
  const index = scenario.slideIndex ?? 0;
  const slide = model.slides[model.deck.slideIds[index]];
  if (scenario.family === "original")
    return { model: presentationDocumentSchema.parse(model), index };
  const originals = Object.values(model.slides).flatMap((slide) =>
    walkElements(slide.nodes.flatMap((node) => node.children)),
  );
  const image = originals.find((element) => element.content?.type === "image");
  const video = originals.find((element) => element.content?.type === "video");
  const text = originals.find((element) => element.content?.type === "text");
  if (!image || !video || !text)
    throw new Error("Stress source must contain text, an image and video");
  delete slide.motion;
  let sequence = 0;
  const clone = (element: Element, label: string) => {
    const value = structuredClone(element);
    value.id = `stress-${label}-${sequence++}`;
    value.effects = [];
    value.children = [];
    return value;
  };
  const definition = (
    kind: "css" | "text-js" | "fragment-glsl",
    input?: "content" | "backdrop",
  ): EffectDefinition => ({
    apiVersion: 1,
    name: `Stress ${kind}`,
    category: "effect",
    kind,
    target:
      kind === "text-js"
        ? "text"
        : input === "backdrop"
          ? "background"
          : "content",
    ...(input ? { input } : {}),
    source:
      kind === "text-js"
        ? jsSource
        : kind === "css"
          ? cssSource
          : scenario.heavy
            ? heavyShader.replaceAll("32", String(scenario.taps ?? 32))
            : passShader,
    parameters: [],
    timeControl: { start: "slide", stop: { mode: "none" } },
  });
  slide.effectResources = {
    stressShader: definition("fragment-glsl", "content"),
    stressBackdrop: definition("fragment-glsl", "backdrop"),
    stressCss: definition("css"),
    stressJs: definition("text-js"),
  };
  slide.effectResources.stressGenerated = {
    ...definition("fragment-glsl"),
    input: "none",
    target: "background",
    source: `#version 300 es
precision highp float; uniform float u_t; in vec2 v_uv;out vec4 outColor;
void main(){vec2 p=v_uv*12.0;float n=0.0;for(int i=0;i<12;i++){float f=float(i)+1.0;n+=sin(p.x*f+u_t)*cos(p.y*f-u_t*0.7)/f;}outColor=vec4(0.3+0.2*sin(n),0.35+0.2*cos(n),0.5+0.3*sin(n+u_t),1.0);}`,
  };
  const glassDefinition = Object.values(base.slides)
    .flatMap((slide) => Object.values(slide.effectResources ?? {}))
    .find(
      (effect) =>
        effect.kind === "fragment-glsl" && effect.input === "backdrop",
    );
  slide.effectResources.stressGlass = glassDefinition
    ? structuredClone(glassDefinition)
    : definition("fragment-glsl", "backdrop");
  const effect = (resourceId: string) =>
    newEffectInstance(
      resourceId,
      slide.effectResources![resourceId],
      ["stressBackdrop", "stressGlass", "stressGenerated"].includes(resourceId)
        ? "background"
        : "content",
    );
  const width = model.deck.width,
    height = model.deck.height;
  const roots: Element[] = [];
  const sources = (label: string, tileWidth = width, tileHeight = height) => {
    const background = clone(image, `${label}-image`);
    Object.assign(background.frame, {
      x: 0,
      y: 0,
      width: tileWidth,
      height: tileHeight,
      scaleX: 1,
      scaleY: 1,
    });
    const heading = clone(text, `${label}-text`);
    Object.assign(heading.frame, {
      x: tileWidth * 0.1,
      y: tileHeight * 0.4,
      width: tileWidth * 0.8,
      height: tileHeight * 0.2,
      scaleX: 1,
      scaleY: 1,
    });
    if (heading.content?.type === "text") {
      heading.content.text = "CSS JS SHADER STRESS 0123456789";
      heading.content.autoSize = "none";
      if (heading.content.format.kind === "local")
        heading.content.format.typography.fontSize = Math.min(
          64,
          tileHeight * 0.15,
        );
    }
    if (scenario.family !== "shader") heading.effects = [effect("stressJs")];
    const children = [background, heading];
    for (let i = 0; i < scenario.videoCount; i++) {
      const media = clone(video, `${label}-video`);
      Object.assign(media.frame, {
        x: tileWidth * 0.15 + (i % 4) * tileWidth * 0.1,
        y: tileHeight * 0.1,
        width: tileWidth * 0.6,
        height: tileHeight * 0.6,
        scaleX: 1,
        scaleY: 1,
      });
      if (media.content?.type === "video") {
        media.content.loop = true;
        media.content.mute = true;
        media.content.autoplay = true;
      }
      children.splice(1, 0, media);
    }
    return children;
  };
  if (scenario.family === "composite") {
    for (let groupIndex = 0; groupIndex < scenario.count; groupIndex++) {
      const background = createContainerElement(
        `stress-generated-${groupIndex}`,
      );
      Object.assign(background.frame, { width, height });
      background.effects = [effect("stressGenerated")];
      const sceneSources = sources(`scene-${groupIndex}`);
      Object.assign(sceneSources[0].frame, {
        x: width * 0.04,
        y: height * 0.69,
        width: width * 0.28,
        height: height * 0.27,
      });
      const children = [background, ...sceneSources];
      for (let i = 0; i < scenario.depth; i++) {
        const lens = createContainerElement(`stress-glass-${groupIndex}-${i}`);
        Object.assign(lens.frame, {
          x: width * 0.05 + (i % 3) * width * 0.03,
          y: height * 0.05 + (i % 4) * height * 0.025,
          width: width * 0.85,
          height: height * 0.85,
        });
        lens.effects = [effect("stressGlass"), effect("stressCss")];
        children.push(lens);
      }
      const group = createContainerElement(
        `stress-composite-${groupIndex}`,
        children,
      );
      Object.assign(group.frame, { width, height });
      group.effects = [effect("stressCss"), effect("stressShader")];
      const outer = createContainerElement(
        `stress-composite-outer-${groupIndex}`,
        [group],
      );
      Object.assign(outer.frame, { width, height });
      outer.effects = [effect("stressCss"), effect("stressShader")];
      roots.push(outer);
    }
  } else if (scenario.family === "js") {
    for (let i = 0; i < scenario.count; i++) {
      const heading = clone(text, "js");
      const columns = Math.ceil(Math.sqrt(scenario.count));
      Object.assign(heading.frame, {
        x: ((i % columns) * width) / columns,
        y: (Math.floor(i / columns) * height) / columns,
        width: width / columns,
        height: height / columns,
        scaleX: 1,
        scaleY: 1,
      });
      heading.effects = Array.from({ length: scenario.depth }, () =>
        effect("stressJs"),
      );
      roots.push(heading);
    }
  } else if (scenario.family === "backdrop" || scenario.family === "video") {
    roots.push(...sources("scene"));
    for (let i = 0; i < scenario.count; i++) {
      const lens = createContainerElement(`stress-lens-${i}`);
      Object.assign(lens.frame, { width, height });
      lens.effects = [effect("stressBackdrop")];
      roots.push(lens);
    }
  } else {
    for (let i = 0; i < scenario.count; i++) {
      const columns =
        scenario.family === "tiles" ? Math.ceil(Math.sqrt(scenario.count)) : 1;
      const tileWidth = width / columns,
        tileHeight = height / columns;
      let group = createContainerElement(
        `stress-group-${i}`,
        sources(`group-${i}`, tileWidth, tileHeight),
      );
      Object.assign(group.frame, { width: tileWidth, height: tileHeight });
      let remaining = scenario.depth,
        stage = 0;
      while (remaining > 0) {
        const length = Math.min(16, remaining);
        group.effects = Array.from({ length }, (_, j) =>
          effect(
            scenario.family === "css"
              ? "stressCss"
              : scenario.family === "shader"
                ? "stressShader"
                : (stage + j) % 2
                  ? "stressShader"
                  : "stressCss",
          ),
        );
        remaining -= length;
        stage += length;
        if (remaining) {
          group = createContainerElement(`stress-nested-${i}-${remaining}`, [
            group,
          ]);
          Object.assign(group.frame, { width: tileWidth, height: tileHeight });
        }
      }
      group.frame.x = (i % columns) * tileWidth;
      group.frame.y = Math.floor(i / columns) * tileHeight;
      roots.push(group);
    }
  }
  slide.nodes[0].children = roots;
  for (const node of slide.nodes.slice(1)) node.children = [];
  model.deck.stylesheet =
    '[data-showme-part="content"] { text-shadow: 1px 1px 2px #000; }';
  return { model: presentationDocumentSchema.parse(model), index };
}

function delta(after: Record<string, number>, before: Record<string, number>) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]]),
  );
}
export async function mountEffectStressHarness(
  base: PresentationDocument,
  scenario: StressScenario,
) {
  setGpuEffectChainingExperiment(scenario.backend === "gpu");
  setDomRasterVideoExperiment(scenario.videoInvalidation ?? "decoded");
  setEffectExecutionExperiment(
    scenario.backend === "refined" ? "refined" : "naive",
  );
  setDomRasterExperimentBackend(
    scenario.backend === "gpu" || scenario.backend === "refined"
      ? "native"
      : (scenario.backend ?? "native"),
  );
  setEffectRuntimeDiagnostics(true);
  const { model, index } = buildEffectStressDocument(base, scenario);
  await platform.managedFonts?.(base.documentId);
  const beforeModel = JSON.stringify(model);
  const mountedAt = performance.now();
  const harness = await mountMixedEffectsHarness(model, index, undefined, {
    liveMedia: true,
    profileWidth: scenario.profileWidth,
  });
  const root = harness.host;
  await document.fonts.ready;
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-effect-id]"),
  );
  // Asset URLs are asynchronous React state. Poll outside the timed interval.
  const readyAt = performance.now();
  while (performance.now() - readyAt < 10000) {
    const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
    const videos = Array.from(root.querySelectorAll<HTMLVideoElement>("video"));
    const required = walkElements(
      model.slides[model.deck.slideIds[index]].nodes.flatMap(
        (node) => node.children,
      ),
    );
    const expectedImages = required.filter(
      (element) => element.content?.type === "image",
    ).length;
    const expectedVideos = required.filter(
      (element) => element.content?.type === "video",
    ).length;
    if (
      images.length >= expectedImages &&
      images.every((image) => image.complete && image.naturalWidth > 0) &&
      videos.length >= expectedVideos &&
      videos.every((video) => video.readyState >= 2)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>("video"));
  videos.forEach((video) => {
    video.loop = true;
    video.muted = true;
    void video.play().catch(() => {});
  });
  const shaderNodes = nodes.filter((node) =>
    node.querySelector(":scope > canvas"),
  );
  const terminals = new Set(
    shaderNodes
      .filter(
        (node) =>
          !shaderNodes.some((other) => other !== node && other.contains(node)),
      )
      .map((node) => node.dataset.effectId!),
  );
  const tick = (time: number) =>
    nodes.forEach((node) =>
      effectSurface(node)?.setTiming({
        time,
        stepTime: time % 1.2,
        stepIndex: 1,
        duration: 2,
        running: true,
      }),
    );
  return {
    model,
    coldMs: performance.now() - mountedAt,
    readiness() {
      return {
        missingAssets: root.querySelectorAll('[aria-label="Missing asset"]')
          .length,
        images: Array.from(root.querySelectorAll<HTMLImageElement>("img")).map(
          (image) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
            complete: image.complete,
          }),
        ),
        videos: videos.map((video) => ({
          width: video.videoWidth,
          height: video.videoHeight,
          ready: video.readyState,
          paused: video.paused,
        })),
        errors: Array.from(
          root.querySelectorAll<HTMLElement>("[data-effect-error]"),
        ).map((node) => node.dataset.effectError),
        effects: nodes.length,
        terminals: terminals.size,
        unchanged: JSON.stringify(model) === beforeModel,
      };
    },
    async measure(milliseconds: number) {
      await Promise.all(videos.map((video) => video.play().catch(() => {})));
      const beforeDom = domRasterDiagnostics(),
        beforeRuntime = effectRuntimeDiagnostics();
      const videoBefore = videos.map((video) =>
        video.getVideoPlaybackQuality(),
      );
      const frames: number[] = [],
        inputLatency: number[] = [],
        longTasks: number[] = [];
      const outputs: Record<string, number[]> = Object.fromEntries(
        [...terminals].map((id) => [id, []]),
      );
      const start = performance.now();
      const published = (event: Event) => {
        const node = event.target as HTMLElement;
        const id = node.dataset.effectId!;
        if (terminals.has(id))
          (outputs[id] ??= []).push(performance.now() - start);
      };
      root.addEventListener("showme-effect-output", published);
      const observer = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      );
      observer.observe({ type: "longtask" });
      let last = start;
      await new Promise<void>((resolve) => {
        const frame = (at: number) => {
          frames.push(at - last);
          last = at;
          tick((at - start) / 1000);
          const queued = performance.now();
          setTimeout(() => inputLatency.push(performance.now() - queued), 0);
          if (at - start < milliseconds) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      const elapsed = performance.now() - start;
      observer.disconnect();
      root.removeEventListener("showme-effect-output", published);
      videos.forEach((video) => video.pause());
      const videoQuality = videos.map((video, index) => {
        const after = video.getVideoPlaybackQuality();
        return {
          total: after.totalVideoFrames - videoBefore[index].totalVideoFrames,
          dropped:
            after.droppedVideoFrames - videoBefore[index].droppedVideoFrames,
        };
      });
      const state = this.readiness();
      const canvasBytes = (canvases: Iterable<HTMLCanvasElement>) =>
        [...canvases].reduce(
          (bytes, canvas) => bytes + canvas.width * canvas.height * 4,
          0,
        );
      const visibleCanvasBytes = canvasBytes(
        root.querySelectorAll<HTMLCanvasElement>("canvas"),
      );
      const memory = canvasBytes(
        document.querySelectorAll<HTMLCanvasElement>("canvas"),
      );
      return {
        elapsed,
        frames,
        inputLatency,
        longTasks,
        outputs,
        videoQuality,
        state,
        dom: delta(domRasterDiagnostics(), beforeDom),
        runtime: delta(effectRuntimeDiagnostics(), beforeRuntime),
        canvasBytes: memory,
        visibleCanvasBytes,
        mirrorCanvasBytes: memory - visibleCanvasBytes,
        outputTextureBytes: shaderOutputTextureBytes(),
        inputTextureBytes: effectSourceTextureBytes(),
      };
    },
    async settle() {
      videos.forEach((video) => video.pause());
      await flushEffectSurfaces(root);
      return this.readiness();
    },
    dispose() {
      harness.dispose();
      setEffectRuntimeDiagnostics(false);
    },
  };
}
