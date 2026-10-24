// Research-only measurement adapter. No invalidation implementation is installed.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { effectSurface, flushEffectSurfaces, effectSourceTextureBytes } from "../../src/components/effectRuntime";
import { domRasterDiagnostics } from "../../src/components/domRaster";
import { GpuRendererExperiment } from "../../src/experiments/gpu-renderer/renderer";
import { createChromiumNativeTextRasterSource } from "./gpuNativeTextRaster";
import { buildDocument, importFixtureImage } from "./gpuRendererHarness";

export async function mountResourceAudit(params: URLSearchParams) {
  const kind = params.get("kind") ?? "gpu";
  const variant = params.get("variant") ?? "animated";
  const fixture = await importFixtureImage();
  const model = buildDocument(fixture.asset.id, { width: 1596, height: 998 });
  const slide = model.slides[model.deck.slideIds[0]];
  const staticSlide = variant === "static" || variant === "parked";
  if (staticSlide) {
    slide.motion = undefined;
    for (const element of slide.nodes[0].children) element.effects = [];
  } else if (variant === "upper-motion" || variant.startsWith("frozen")) {
    slide.effectResources!.generated.source = slide.effectResources!.generated.source.replace(/\bu_t\b/g, "constant_time").replace("uniform float constant_time;", "const float constant_time = 1.2;");
    if (variant.startsWith("frozen")) slide.motion = undefined;
  }
  document.body.replaceChildren();
  document.body.style.cssText = "margin:0;overflow:hidden;background:#080d18";
  const host = document.createElement("div");
  document.body.append(host);
  const canvas = document.createElement("canvas");
  let gpu: GpuRendererExperiment | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  if (kind === "gpu") {
    host.append(canvas);
    gpu = new GpuRendererExperiment(canvas, slide, model.deck, {
      pixelRatio: 77 / 48,
      nativeTextSource: createChromiumNativeTextRasterSource,
      mediaSource: () => fixture.image,
    });
  } else root = createRoot(host);
  let frameCount = 0;
  const render = async (time: number) => {
    const timeMs = staticSlide || variant.startsWith("frozen") ? 1200 : time % 2400;
    if (gpu) await gpu.render({ stageIndex: 0, timeMs });
    else flushSync(() => root!.render(<SlideRenderer deck={model.deck} slide={slide}
      staticVideo preparedImages={false} renderScale={1}
      visualPlayback={staticSlide || variant.startsWith("frozen") ? "static" : "live"}
      motionState={slide.motion ? {stageId: slide.motion.stages[0].id, stageIndex: 0,
        time: timeMs, startedAt: performance.now(), running: false} : undefined} />));
    frameCount++;
  };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (let index = 0; index < 6; index++) { await render(1200); await frame(); }
  if (!gpu) await flushEffectSurfaces(host);

  // Wrapping only during an explicit single-frame probe keeps pixel accounting
  // and graph inspection out of timed samples. Private methods are inspected,
  // never changed in production code.
  const inspectFrame = async () => {
    if (!gpu) return null;
    const runtime = gpu as unknown as Record<string, (...args: unknown[]) => unknown>;
    const operations: Record<string, unknown>[] = [];
    const target = (value: unknown) => {
      const t = value as {width: number; height: number; bounds: unknown};
      return { width: t.width, height: t.height, bounds: structuredClone(t.bounds) };
    };
    let visits = 0;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    for (const key of ["drawTexture", "drawSolid", "runEffect", "clear", "renderOperation"]) {
      const original = runtime[key]; originals.set(key, original);
      runtime[key] = function (...args: unknown[]) {
        if (key === "renderOperation") visits++;
        else if (key === "clear") operations.push({kind: key, target: target(args[0])});
        else if (key === "drawTexture") operations.push({kind: key, target: target(args[1]), rect: args[2], matrix: args[3] ?? [1,0,0,1,0,0]});
        else if (key === "drawSolid") operations.push({kind: key, target: target(args[0]), rect: args[1]});
        else operations.push({kind: key, effectId: (args[1] as {id: string}).id, target: target(args[5])});
        return original.apply(gpu, args);
      };
    }
    try { await render(1200); }
    finally { for (const [key, original] of originals) runtime[key] = original; }
    // Snapshot immediately: pooled objects will otherwise change their bounds.
    return {visits, groups: gpu.graph.groups.size, operations: JSON.parse(JSON.stringify(operations))};
  };
  const snapshot = () => ({frameCount, gpu: gpu?.diagnostics(), dom: domRasterDiagnostics(),
    nativeSourceTextureBytes: effectSourceTextureBytes(),
    shaders: [...host.querySelectorAll<HTMLElement>("[data-effect-id]")].map((node) => ({
      id: node.dataset.effectId, revision: effectSurface(node)?.gpuOutput()?.revision ?? 0,
    }))});
  return {
    kind, variant, snapshot, inspectFrame,
    async sample(durationMs = 10000) {
      const before = snapshot();
      const started = performance.now();
      let rafs = 0, renders = 0, nextAt = started;
      const renderCosts: number[] = [], timestamps: number[] = [];
      await new Promise<void>((resolve, reject) => {
        if (variant.endsWith("parked") || (kind !== "gpu" && (staticSlide || variant.startsWith("frozen")))) {
          setTimeout(resolve, durationMs); return;
        }
        const tick = async (now: number) => {
          try {
            if (now - started >= durationMs) {resolve(); return;}
            rafs++;
            if (now + 0.2 >= nextAt) {
              nextAt = Math.max(nextAt + 1000 / 60, now);
              const begin = performance.now();
              await render(now - started);
              renderCosts.push(performance.now() - begin);
              timestamps.push(now); renders++;
            }
            requestAnimationFrame(tick);
          } catch (error) {reject(error);}
        };
        requestAnimationFrame(tick);
      });
      return {before, after: snapshot(), elapsedMs: performance.now() - started, rafs, renders, renderCosts, timestamps};
    },
  };
}
