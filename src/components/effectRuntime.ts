import { createTextEffectRunner } from "./textEffectRunner";
import { EffectGraph } from "./effectGraph";
import { EffectSources } from "./effectSources";
import { frame, cancelFrame } from "motion";
import {
  affineSamplingDensity,
  shaderSamplingSize,
  type RenderDensity,
  type ShaderCapabilities,
} from "../core/renderProfile";
import { elementWorldTransform } from "./elementDomTransform";
import { resizeRasterCanvas } from "./canvasAllocation";
import {
  createElementRasterSource,
  createBackdropRasterSource,
  backdropPrefix,
} from "./elementRaster";
import { createDomRasterSource } from "./domRaster";
import {
  allocateShaderOutput,
  disposeShaderOutput,
  neutralShaderBridge,
  type ShaderOutput,
} from "./shaderOutput";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";
import {
  consumedParameter,
  effectDependencies,
  cssEffectValue,
  type EffectParameterValue,
  effectParameters,
  effectPlacement,
  shaderDiagnostics,
  type EffectDefinition,
  type ElementEffect,
} from "../core/effects";

export interface EffectSampling extends RenderDensity {
  root?: HTMLElement | null;
  retain?: boolean;
  envelope?: number;
}
function samplingRoot(node: HTMLElement, sampling: EffectSampling) {
  return (
    sampling.root ??
    node.closest<HTMLElement>(".slide-renderer") ??
    node.parentElement ??
    node
  );
}
type Surface = {
  inputs(): HTMLElement[];
  materialize(): void;
  gpuOutput(): ShaderOutput | null;
  setSampling(value: EffectSampling): void;
  prepareSampling(): void;
  set(key: string, value: EffectParameterValue): void;
  setTiming(value: {
    time: number;
    duration: number;
    slideTime?: number;
    presentationTime?: number;
    stepTime?: number;
    stepIndex?: number;
    active?: boolean;
    started?: boolean;
    running?: boolean;
    progress?: number;
  }): void;
  flush(cohort?: Map<HTMLElement, Promise<void>>): void | Promise<void>;
  reset(): void;
};
const surfaces = new WeakMap<HTMLElement, Surface>();
const scheduled = new Map<HTMLElement, { prepare(): void; draw(): unknown }>();
const shaderRedraws = new Set<() => void>();
export type EffectExecutionMode = "naive" | "refined";
let executionMode: EffectExecutionMode = "refined";
/** Regression reference control. Production uses the refined renderer. */
export function setEffectExecutionForTests(mode: EffectExecutionMode) {
  executionMode = mode;
}
type Raster =
  | ReturnType<typeof createElementRasterSource>
  | ReturnType<typeof createDomRasterSource>;
type Coordinator = {
  graph: EffectGraph<HTMLElement>;
  sources: EffectSources<Raster>;
  nodes: Set<HTMLElement>;
  compiled: boolean;
  observer: MutationObserver;
};
const coordinators = new WeakMap<HTMLElement, Coordinator>();
const liveCoordinators = new Set<Coordinator>();
function coordinatorFor(root: HTMLElement) {
  let coordinator = coordinators.get(root);
  if (!coordinator) {
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) => node instanceof HTMLElement,
            ),
        )
      )
        coordinator!.compiled = false;
    });
    coordinator = {
      graph: new EffectGraph(),
      sources: new EffectSources(),
      nodes: new Set(),
      compiled: false,
      observer,
    };
    observer.observe(root, { childList: true, subtree: true });
    coordinators.set(root, coordinator);
    liveCoordinators.add(coordinator);
  }
  return coordinator;
}
function compileCoordinator(coordinator: Coordinator) {
  if (coordinator.compiled) return;
  coordinator.graph.compile((node) => surfaces.get(node)?.inputs() ?? []);
  coordinator.compiled = true;
}
export function effectSourceTextureBytes() {
  return [...liveCoordinators].reduce(
    (sum, coordinator) => sum + coordinator.sources.textureBytes,
    0,
  );
}
function dependencyOrder(a: HTMLElement, b: HTMLElement) {
  if (a.contains(b)) return 1;
  if (b.contains(a)) return -1;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}
function flushScheduled() {
  const work = [...scheduled.entries()].sort(([a], [b]) =>
    dependencyOrder(a, b),
  );
  scheduled.clear();
  // Read all current transforms after Motion writes, before allocating/painting.
  work.forEach(([, value]) => value.prepare());
  work.forEach(([node, value]) => {
    const coordinator = nodeCoordinators.get(node);
    if (coordinator) {
      compileCoordinator(coordinator);
      void coordinator.graph
        .resolve(node, (input) => !!surfaces.get(input)?.gpuOutput())
        .then(() => {
          if (
            nodeCoordinators.get(node) === coordinator &&
            coordinator.graph.isDirty(node)
          ) {
            scheduled.set(node, value);
            frame.postRender(flushScheduled);
          }
        })
        .catch((error) => {
          node.dataset.effectError = String(error);
        });
    } else value.draw();
  });
}
const nodeCoordinators = new WeakMap<HTMLElement, Coordinator>();
export function effectSurface(node: HTMLElement) {
  return surfaces.get(node);
}
/** Readiness includes asynchronous text output and diagnosed fallback. */
export async function flushEffectSurfaces(root: ParentNode) {
  // Inner groups and earlier pipeline stages must finish before their consumers.
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-effect-id]"),
  ).sort(dependencyOrder);
  nodes.forEach((node) => surfaces.get(node)?.prepareSampling());
  const cohorts = new Map<Coordinator, Map<HTMLElement, Promise<void>>>();
  for (const node of nodes) {
    const coordinator = nodeCoordinators.get(node);
    if (coordinator && !cohorts.has(coordinator))
      cohorts.set(coordinator, new Map());
    await surfaces
      .get(node)
      ?.flush(coordinator ? cohorts.get(coordinator) : undefined);
  }
  return !Array.from(root.querySelectorAll('[data-effect-ready="false"]')).some(
    (node) => !node.closest('[data-presentation-absent="true"]'),
  );
}

const vertex = `#version 300 es
in vec2 position;
out vec2 v_uv;
void main() { v_uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;
let gpu: {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  programs: Map<string, WebGLProgram>;
  buffer: WebGLBuffer;
  capabilities: ShaderCapabilities;
  textureSize: number;
  generation: number;
} | null = null;
let gpuGeneration = 0;
function sharedGpu() {
  if (gpu && !gpu.gl.isContextLost()) return gpu;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  });
  if (!gl)
    throw new Error(
      "WebGL2 is unavailable; the original Element remains visible.",
    );
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Cannot allocate shader buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const state = {
    canvas,
    gl,
    buffer,
    programs: new Map<string, WebGLProgram>(),
    capabilities: {
      width: Math.min(
        (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)[0],
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      ),
      height: Math.min(
        (gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)[1],
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      ),
    },
    textureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    generation: ++gpuGeneration,
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    state.programs.clear();
    if (gpu === state) gpu = null;
    shaderRedraws.forEach((redraw) => redraw());
  });
  gpu = state;
  return state;
}
export function shaderProgram(source: string) {
  const state = sharedGpu(),
    { gl, programs } = state;
  const cached = programs.get(source);
  if (cached) return { ...state, program: cached };
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, text] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, source],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Cannot allocate shader");
      shaders.push(shader);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(
          gl.getShaderInfoLog(shader) || "Shader compilation failed",
        );
    }
    program = gl.createProgram();
    if (!program) throw new Error("Cannot allocate shader program");
    shaders.forEach((shader) => gl.attachShader(program!, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "Shader linking failed");
    for (
      let i = 0;
      i < (gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number);
      i++
    ) {
      const uniform = gl.getActiveUniform(program, i)!;
      if (uniform.name === "u_resolution" || uniform.name === "u_size") {
        if (uniform.type !== gl.FLOAT_VEC2)
          throw new Error(`${uniform.name} must be vec2`);
      } else if (uniform.name === "u_input") {
        if (uniform.type !== gl.SAMPLER_2D || uniform.size !== 1)
          throw new Error("u_input must be sampler2D");
      } else if (uniform.type !== gl.FLOAT || uniform.size !== 1)
        throw new Error(
          `Parameter ${uniform.name} must be a float; this shader surface is procedural`,
        );
    }
    if (programs.size >= 32) {
      const [key, old] = programs.entries().next().value!;
      gl.deleteProgram(old);
      programs.delete(key);
    }
    programs.set(source, program);
    return { ...state, program };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    shaders.forEach((shader) => gl.deleteShader(shader));
  }
}

let scopeId = 0;
/** Only instance-local style rules and keyframes. Keyframes have private names. */
export function compileEffectCss(source: string, scope: string) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(source);
  if (!sheet.cssRules.length) throw new Error("CSS must contain a :scope rule");
  const names = new Map<string, string>();
  for (const rule of sheet.cssRules)
    if (rule instanceof CSSKeyframesRule)
      names.set(rule.name, `${scope}_${rule.name}`);
  const declarations = (style: CSSStyleDeclaration) => {
    for (const property of ["animation", "animation-name"]) {
      let value = style.getPropertyValue(property);
      for (const [name, replacement] of names)
        value = value.replace(
          new RegExp(
            `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
            "g",
          ),
          replacement,
        );
      if (value) style.setProperty(property, value);
    }
    // ShowMe samples CSS keyframes; transitions must not lag behind exact seeks.
    style.setProperty("animation-play-state", "paused", "important");
    style.setProperty("transition", "none", "important");
  };
  const output: string[] = [];
  for (const rule of sheet.cssRules) {
    if (rule instanceof CSSStyleRule) {
      if (rule.selectorText !== ":scope")
        throw new Error("CSS effects support :scope and @keyframes rules only");
      declarations(rule.style);
      output.push(`[data-effect-scope="${scope}"] { ${rule.style.cssText} }`);
    } else if (rule instanceof CSSKeyframesRule) {
      rule.name = names.get(rule.name)!;
      output.push(rule.cssText);
    } else
      throw new Error("CSS effects support :scope and @keyframes rules only");
  }
  return output.join("\n");
}

/** Renderer-owned surfaces consume values, never advance presentation time. */
export function mountEffectSurface(
  node: HTMLElement,
  canvas: HTMLCanvasElement | null,
  definition: EffectDefinition,
  instance: ElementEffect,
  size: { width: number; height: number },
  onDiagnostic?: (error: string) => void,
  content?: {
    element: Element;
    resources: EffectResources;
    scene?: () => { slide: Slide; deck: Deck };
  },
  initialSampling: EffectSampling = {
    x: devicePixelRatio || 1,
    y: devicePixelRatio || 1,
    mode: "live",
  },
) {
  const refined = executionMode === "refined";
  const useGpu = refined;
  const sceneRoot = samplingRoot(node, initialSampling);
  const coordinator = refined ? coordinatorFor(sceneRoot) : null;
  const dependencies = effectDependencies(definition);
  const cssSource =
    (definition.kind === "css"
      ? definition.source
      : (definition.styleSource ?? "")) +
    (content?.scene?.().deck.stylesheet ?? "");
  const clockKey = (value: typeof timing) => {
    // CSS variables and arbitrary JS property access are public Effect API.
    // Keep their full delivery conservative; shader uniforms have explicit names.
    if (definition.kind !== "fragment-glsl")
      return [
        value.time,
        value.duration,
        value.slideTime,
        value.presentationTime,
        value.stepTime,
        value.stepIndex,
        value.active,
        value.started,
        value.progress,
      ];
    const source =
      definition.kind === "fragment-glsl"
        ? definition.source.replace(/\buniform\s+[^;]+;/g, "")
        : definition.source;
    const uses = (key: string) =>
      new RegExp(
        `\\b${definition.kind === "fragment-glsl" ? "u_" : ""}${key}\\b`,
      ).test(source) || new RegExp(`--${key}(?![\\w-])`).test(cssSource);
    return [
      value.started,
      value.active,
      value.duration,
      dependencies.genericTime || uses("t") ? value.time : 0,
      dependencies.progress || uses("p") ? value.progress : undefined,
      dependencies.stepState || uses("stepIndex") ? value.stepIndex : 0,
      uses("slideTime") ? value.slideTime : 0,
      uses("presentationTime") ? value.presentationTime : 0,
      uses("stepTime") ? value.stepTime : 0,
      /@keyframes\b/.test(cssSource) ? value.time : 0,
    ];
  };
  const values = Object.fromEntries(
    effectParameters(definition).map((p) => [
      p.key,
      instance.parameters[p.key] ?? p.default,
    ]),
  );
  const base = { ...values };
  let live = true;
  let sampling = initialSampling;
  let samplingDensity = 0;
  let heldDensity = 0;
  let preparedSampling = false;
  let logicalSize = size;
  let samplingGeometry = "";
  const prepareSampling = () => {
    if (!live || definition.kind !== "fragment-glsl") return;
    try {
      const owner = node.closest<HTMLElement>("[data-element-id]");
      if (owner) {
        const style = getComputedStyle(owner),
          width = parseFloat(style.width),
          height = parseFloat(style.height);
        logicalSize =
          Number.isFinite(width) &&
          width > 0 &&
          Number.isFinite(height) &&
          height > 0
            ? { width, height }
            : size;
      }
      const root =
        sampling.root ?? node.closest<HTMLElement>(".slide-renderer");
      const matrix =
        owner && root ? elementWorldTransform(owner, root) : new DOMMatrix();
      const next = Math.max(
        affineSamplingDensity(sampling, matrix),
        sampling.envelope ?? 0,
      );
      if (!Number.isFinite(next))
        throw new Error("Invalid shader transform sampling");
      const geometry = JSON.stringify([
        logicalSize.width,
        logicalSize.height,
        next,
        ...Array.from(matrix.toFloat64Array()),
      ]);
      if (refined && samplingGeometry !== geometry) {
        samplingGeometry = geometry;
        coordinator?.graph.invalidate(node);
        raster?.markDirty();
      }
      samplingDensity = next;
      if (sampling.retain) heldDensity = Math.max(heldDensity, next);
      else heldDensity = next;
      preparedSampling = true;
    } catch (error) {
      samplingDensity = 0;
      preparedSampling = true;
      diagnose(error);
    }
  };
  let timing = {
    time: 0,
    duration: 0,
    slideTime: 0,
    presentationTime: 0,
    stepTime: 0,
    stepIndex: 0,
    active: true,
    started: false,
    running: false,
    progress: undefined as number | undefined,
  };
  let runner: ReturnType<typeof createTextEffectRunner> | null = null;
  let original: HTMLElement | null = null,
    output: HTMLElement | null = null;
  let originalOpacity = "",
    sequence = 0;
  let textInputHidden = false;
  let pending: Promise<void> = Promise.resolve();
  let lastTextInput = "";
  let lastShaderInput = "";
  let lastCssOutput = "";
  let raster: Raster | null = null;
  let createRaster: ((invalidate: () => void) => Raster) | null = null;
  let needsDomRaster = () => false;
  let sourceLease: ReturnType<EffectSources<Raster>["acquire"]> | null = null;
  let leaseKey = "";
  let rasterPending = false;
  let shaderOutput: ShaderOutput | null = null;
  let rasterPrepared = false;
  let rasterPreparedKey = "";
  let texture: {
    gl: WebGL2RenderingContext;
    value: WebGLTexture;
    revision: number;
    width: number;
    height: number;
  } | null = null;
  let observer: MutationObserver | null = null;
  let sourceRoot: HTMLElement | null = null;
  let sourceContent: HTMLElement | null = null;
  let sourceOpacity = "";
  const ownerAbsent = () => !!node.closest('[data-presentation-absent="true"]');
  const schedule = () => {
    if (live) {
      coordinator?.graph.invalidate(node);
      if (ownerAbsent()) return;
      scheduled.set(node, { prepare: prepareSampling, draw });
      frame.postRender(flushScheduled);
    }
  };
  const publish = () => {
    node.dataset.effectRevision = String(
      Number(node.dataset.effectRevision ?? 0) + 1,
    );
    node.dispatchEvent(
      new CustomEvent("showme-effect-output", { bubbles: true }),
    );
  };
  const sourceChanged = () => {
    raster?.markDirty();
    schedule();
  };
  const outputChanged = (event: Event) => {
    if (
      event.target instanceof Node &&
      event.target !== node &&
      sourceRoot?.contains(event.target) &&
      (!refined ||
        definition.input !== "content" ||
        !!sourceContent?.contains(event.target)) &&
      (!refined ||
        definition.input !== "backdrop" ||
        inputDependencies().includes(event.target as HTMLElement))
    )
      sourceChanged();
  };
  const inputDependencies = () => {
    const root =
      definition.kind === "css"
        ? node
        : definition.input === "content"
          ? sourceContent
          : sourceRoot;
    if (!root) return [];
    const prefix =
      definition.input === "backdrop" && content?.scene
        ? backdropPrefix(
            content.scene().slide,
            content.scene().deck,
            content.element.id,
          )
        : null;
    const allowed = new Set<string>();
    const collect = (elements: Element[]) =>
      elements.forEach((element) => {
        allowed.add(element.id);
        collect(element.children);
      });
    if (prefix) collect(prefix.elements);
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>("[data-effect-id]"),
    )
      .filter((dependency) => {
        if (dependency === node || dependency.contains(node)) return false;
        const owner =
          dependency.closest<HTMLElement>("[data-element-id]")?.dataset
            .elementId;
        return (
          !prefix ||
          (!!owner && allowed.has(owner) && !prefix.partial.has(owner))
        );
      })
      .sort(dependencyOrder);
    // The outer stage resolves its own inputs. Re-listing every descendant
    // makes a deep stack repeatedly walk and wait on the same subtree.
    return candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && other.contains(candidate),
        ),
    );
  };
  let domRevision = -1;
  const materialize = () => {
    if (
      !canvas ||
      !shaderOutput ||
      node.dataset.effectError ||
      node.dataset.effectStarted === "false" ||
      domRevision === shaderOutput.revision
    )
      return;
    const state = sharedGpu();
    if (state.gl !== shaderOutput.gl || state.gl.isContextLost()) return;
    const { gl, canvas: source } = state;
    if (source.width !== shaderOutput.width) source.width = shaderOutput.width;
    if (source.height !== shaderOutput.height)
      source.height = shaderOutput.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, shaderOutput.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      source.width,
      source.height,
      0,
      0,
      source.width,
      source.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const context = resizeRasterCanvas(canvas, source.width, source.height);
    context.clearRect(0, 0, source.width, source.height);
    context.drawImage(source, 0, 0);
    domRevision = shaderOutput.revision;
    canvas.style.visibility = "visible";
  };
  const needsDomOutput = () => {
    if (!refined) return true;
    const source = node.parentElement;
    const consumer = source?.parentElement;
    if (
      !source?.hasAttribute("data-effect-source") ||
      !consumer?.dataset.effectId
    )
      return true;
    const consumerSurface = surfaces.get(consumer);
    return !(
      consumerSurface &&
      canvas &&
      consumer.dataset.effectStarted !== "false" &&
      !consumer.dataset.effectError &&
      source.children.length === 1 &&
      neutralShaderBridge(source, node, canvas, logicalSize)
    );
  };
  let style: HTMLStyleElement | null = null;
  // Identity belongs to this stage, never to its Element or earlier stages.
  const bypass = () => {
    if (node.dataset.effectStarted !== "false") {
      ++sequence; // A pending worker must not repaint a backward seek.
      lastTextInput = "";
      lastShaderInput = "";
      if (canvas) {
        canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.visibility = "hidden";
      }
      if (output) output.style.visibility = "hidden";
      if (original && textInputHidden) original.style.opacity = originalOpacity;
      textInputHidden = false;
      if (sourceContent) sourceContent.style.opacity = sourceOpacity;
      if (style) style.media = "not all";
      node.dataset.effectStarted = "false";
      publish();
    }
    node.dataset.effectReady = "true";
  };
  const diagnose = (error: unknown) => {
    node.dataset.effectError =
      error instanceof Error ? error.message : String(error);
    onDiagnostic?.(node.dataset.effectError);
    node.dataset.effectReady = "true";
    if (canvas) canvas.style.visibility = "hidden";
    if (output) output.style.visibility = "hidden";
    if (original && textInputHidden) original.style.opacity = originalOpacity;
    textInputHidden = false;
    if (sourceContent) sourceContent.style.opacity = sourceOpacity;
    lastShaderInput = "";
  };
  const draw = () => {
    // Element lifecycle gates visual work, independently of this Effect's clock.
    if (ownerAbsent()) return;
    if (!live) return;
    if (!timing.started) {
      bypass();
      return;
    }
    node.dataset.effectStarted = "true";
    if (style && style.media !== "all") style.media = "all";
    try {
      const params = Object.fromEntries(
        effectParameters(definition).map((p) => [
          p.key,
          consumedParameter(values[p.key], p),
        ]),
      );
      for (const [key, value] of Object.entries({
        ...params,
        t: timing.time * (definition.speed ?? 1),
        p: timing.progress ?? 1,
        slideTime: timing.slideTime,
        presentationTime: timing.presentationTime,
        stepTime: timing.stepTime,
        stepIndex: timing.stepIndex,
        active: Number(timing.active),
        duration: timing.duration,
      })) {
        const serialized = cssEffectValue(value);
        if (node.style.getPropertyValue(`--${key}`) !== serialized)
          node.style.setProperty(`--${key}`, serialized);
      }
      const styled =
        definition.kind === "css"
          ? node
          : definition.styleSource
            ? output
            : null;
      if (styled) {
        for (const animation of styled.getAnimations()) {
          animation.pause();
          const length = Number(
            animation.effect?.getComputedTiming().duration ?? 0,
          );
          animation.currentTime =
            timing.progress !== undefined && Number.isFinite(length)
              ? timing.progress * length
              : (typeof params.timeSeconds === "number"
                  ? params.timeSeconds
                  : timing.time * (definition.speed ?? 1)) * 1000;
        }
        const signature = node.style.cssText;
        if (signature !== lastCssOutput) {
          lastCssOutput = signature;
          publish();
        }
      }
      if (definition.kind === "text-js" && original && output) {
        // Consume the preceding text stage when present, including after a
        // backward seek. This stage owns only the opacity it applies itself.
        const incoming =
          Array.from(
            node.querySelectorAll<HTMLElement>("[data-effect-text-output]"),
          ).find(
            (candidate) =>
              candidate !== output &&
              candidate.style.visibility === "visible" &&
              candidate.closest("[data-element-id]") ===
                node.closest("[data-element-id]") &&
              candidate.closest<HTMLElement>("[data-effect-id]")?.dataset
                .effectStarted !== "false",
          ) ?? node.querySelector<HTMLElement>("[data-text-content]");
        if (incoming && incoming !== original) {
          if (textInputHidden) original.style.opacity = originalOpacity;
          textInputHidden = false;
          original = incoming;
          originalOpacity = incoming.style.opacity;
        }
        runner ??= createTextEffectRunner(definition.source);
        const input = {
          text: original.textContent ?? "",
          t: timing.time * (definition.speed ?? 1),
          p: timing.progress ?? 1,
          duration: timing.duration,
          slideTime: timing.slideTime,
          presentationTime: timing.presentationTime,
          stepTime: timing.stepTime,
          stepIndex: timing.stepIndex,
          active: timing.active,
          parameters: params,
        };
        const signature = JSON.stringify(
          refined ? [input.text, input.parameters, clockKey(timing)] : input,
        );
        if (signature === lastTextInput) return pending;
        lastTextInput = signature;
        const revision = ++sequence;
        pending = runner
          .render(input)
          .then((text) => {
            if (
              !live ||
              revision !== sequence ||
              text === null ||
              !output ||
              !original
            )
              return;
            if (ownerAbsent() || !timing.started) {
              lastTextInput = "";
              return;
            }
            const changed =
              output.textContent !== text ||
              output.style.visibility !== "visible";
            if (output.textContent !== text) output.textContent = text;
            output.style.visibility = "visible";
            original.style.opacity = "0";
            textInputHidden = true;
            if (node.dataset.effectError !== undefined) {
              delete node.dataset.effectError;
              onDiagnostic?.("");
            }
            node.dataset.effectReady = "true";
            if (changed) publish();
          })
          .catch((error) => {
            if (live && revision === sequence) diagnose(error);
          });
        return pending;
      } else if (definition.kind === "css") {
        for (const [key, value] of Object.entries(params))
          node.style.setProperty(`--${key}`, String(value));
        node.style.setProperty("--duration", String(timing.duration));
      } else if (canvas) {
        const {
          gl,
          canvas: source,
          buffer,
          program,
          capabilities,
          textureSize,
          generation,
        } = shaderProgram(definition.source);
        if (!preparedSampling) prepareSampling();
        preparedSampling = false;
        if (samplingDensity <= 0) {
          node.dataset.effectReady = "false";
          return;
        }
        const allocation = shaderSamplingSize(
          logicalSize,
          heldDensity,
          definition.input === "content" || definition.input === "backdrop"
            ? {
                width: Math.min(capabilities.width, textureSize),
                height: Math.min(capabilities.height, textureSize),
              }
            : capabilities,
        );
        const { width, height } = allocation;
        node.dataset.effectRequestedSize = `${allocation.requestedWidth}x${allocation.requestedHeight}`;
        node.dataset.effectRasterSize = `${width}x${height}`;
        if (allocation.reduced)
          node.dataset.effectSamplingWarning = `Shader requested ${allocation.requestedWidth} × ${allocation.requestedHeight}; GPU texture/viewport/renderbuffer limits reduced it to ${width} × ${height}.`;
        else delete node.dataset.effectSamplingWarning;
        const previousStage =
          useGpu &&
          definition.input === "content" &&
          sourceContent?.children.length === 1
            ? (sourceContent.firstElementChild as HTMLElement)
            : null;
        const previousCanvas =
          previousStage?.querySelector<HTMLCanvasElement>(":scope > canvas");
        const previousInstance = content?.element.effects?.find(
          (effect) => effect.id === previousStage?.dataset.effectId,
        );
        const previousSurface = previousStage
          ? surfaces.get(previousStage)
          : undefined;
        const canChain = !!(
          previousStage &&
          previousCanvas &&
          sourceContent &&
          previousSurface &&
          previousInstance &&
          content?.resources[previousInstance.resourceId]?.input ===
            "content" &&
          previousStage.dataset.effectStarted !== "false" &&
          !previousStage.dataset.effectError &&
          neutralShaderBridge(
            sourceContent,
            previousStage,
            previousCanvas,
            logicalSize,
          )
        );
        const gpuInput = canChain ? previousSurface!.gpuOutput() : null;
        if (canChain && (!gpuInput || gpuInput.gl !== gl) && !rasterPending) {
          rasterPending = true;
          node.dataset.effectReady = "false";
          pending = Promise.resolve(previousSurface!.flush())
            .then(() => {
              rasterPending = false;
              if (live) void draw();
            })
            .catch((error) => {
              rasterPending = false;
              if (live) diagnose(error);
            });
          return pending;
        }
        if (rasterPending) {
          return pending;
        }
        if (refined && gpuInput && sourceLease) {
          sourceLease.release();
          sourceLease = null;
          raster = null;
          leaseKey = "";
          rasterPrepared = false;
        }
        if (!gpuInput && createRaster && !rasterPending) {
          const dom = needsDomRaster();
          if (refined && coordinator) {
            const key = `${definition.input === "backdrop" ? `backdrop:${content!.element.id}` : `content:${content!.element.id}:${instance.id}`}|${dom ? "dom" : "primitive"}|${width}x${height}|${logicalSize.width}x${logicalSize.height}`;
            if (key !== leaseKey) {
              sourceLease?.release();
              sourceLease = coordinator.sources.acquire(
                key,
                createRaster,
                schedule,
              );
              raster = sourceLease.source;
              leaseKey = key;
              rasterPrepared = false;
              lastShaderInput = "";
            }
          } else {
            if (raster && "backend" in raster !== dom) {
              raster.dispose();
              raster = null;
              rasterPrepared = false;
              lastShaderInput = "";
              if (texture) texture.revision = -1;
            }
            raster ??= createRaster(schedule);
          }
        }
        const captureKey = `${width}x${height}|${logicalSize.width}x${logicalSize.height}`;
        if (rasterPreparedKey !== captureKey) rasterPrepared = false;
        if (!rasterPrepared && !gpuInput) {
          const ready =
            raster &&
            ("backend" in raster
              ? raster.update(
                  width,
                  height,
                  logicalSize.width,
                  logicalSize.height,
                )
              : raster.update(width, height));
          if (ready instanceof Promise) {
            rasterPending = true;
            node.dataset.effectReady = "false";
            pending = ready
              .then(() => {
                rasterPending = false;
                if (!live) return;
                // Publish the completed snapshot even when a newer animation tick
                // arrived during paint. Retrying before publication would starve
                // continuously changing sources; the next update coalesces it.
                rasterPrepared = true;
                rasterPreparedKey = captureKey;
                void draw();
                if (raster && "isDirty" in raster && raster.isDirty) schedule();
              })
              .catch((error) => {
                rasterPending = false;
                if (live) diagnose(error);
              });
            return pending;
          }
        }
        rasterPrepared = false;
        const signature = JSON.stringify([
          params,
          refined ? clockKey(timing) : timing,
          width,
          height,
          raster?.revision,
          gpuInput?.revision,
          generation,
        ]);
        if (signature === lastShaderInput) {
          node.dataset.effectReady = "true";
          return;
        }
        if (source.width !== width || source.height !== height) {
          source.width = width;
          source.height = height;
          if (
            gl.drawingBufferWidth !== width ||
            gl.drawingBufferHeight !== height ||
            gl.getError() !== gl.NO_ERROR
          )
            throw new Error(
              `Cannot allocate ${width} × ${height} shader drawing buffer`,
            );
        }
        const context = !refined
          ? resizeRasterCanvas(canvas, width, height)
          : null;
        if (useGpu)
          shaderOutput = allocateShaderOutput(gl, width, height, shaderOutput);
        gl.bindFramebuffer(
          gl.FRAMEBUFFER,
          useGpu ? shaderOutput!.framebuffer : null,
        );
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        if (gpuInput) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpuInput.texture);
          gl.uniform1i(gl.getUniformLocation(program, "u_input"), 0);
          node.dataset.effectSourceBackend = "gpu";
          node.dataset.effectSourceRevision = String(gpuInput.revision);
        } else if (raster) {
          node.dataset.effectSourceBackend =
            "backend" in raster ? raster.backend : "primitive";
          if (refined && sourceLease) {
            sourceLease.upload(gl);
            node.dataset.effectSourceRevision = String(raster.revision);
          } else {
            if (!texture || texture.gl !== gl) {
              if (texture) texture.gl.deleteTexture(texture.value);
              const value = gl.createTexture();
              if (!value)
                throw new Error("Cannot allocate content shader texture");
              texture = { gl, value, revision: -1, width: 0, height: 0 };
            }
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture.value);
            if (texture.revision !== raster.revision) {
              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
              gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
              gl.texParameteri(
                gl.TEXTURE_2D,
                gl.TEXTURE_WRAP_S,
                gl.CLAMP_TO_EDGE,
              );
              gl.texParameteri(
                gl.TEXTURE_2D,
                gl.TEXTURE_WRAP_T,
                gl.CLAMP_TO_EDGE,
              );
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                raster.canvas,
              );
              if (texture.width !== width || texture.height !== height) {
                if (gl.getError() !== gl.NO_ERROR)
                  throw new Error(
                    `Cannot allocate ${width} × ${height} shader input texture`,
                  );
                texture.width = width;
                texture.height = height;
              }
              texture.revision = raster.revision;
              node.dataset.effectSourceRevision = String(raster.revision);
            }
          }
          gl.uniform1i(gl.getUniformLocation(program, "u_input"), 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const position = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(
          gl.getUniformLocation(program, "u_resolution"),
          width,
          height,
        );
        gl.uniform2f(
          gl.getUniformLocation(program, "u_size"),
          logicalSize.width,
          logicalSize.height,
        );
        for (const [key, value] of Object.entries({
          u_t: timing.time * (definition.speed ?? 1),
          u_p: timing.progress ?? 1,
          u_slideTime: timing.slideTime,
          u_presentationTime: timing.presentationTime,
          u_stepTime: timing.stepTime,
          u_stepIndex: timing.stepIndex,
          u_active: Number(timing.active),
          u_duration: timing.duration,
          ...params,
        }))
          if (typeof value === "number")
            gl.uniform1f(gl.getUniformLocation(program, key), value);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (useGpu && shaderOutput) {
          shaderOutput.revision++;
          if (!refined) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, shaderOutput.framebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            gl.blitFramebuffer(
              0,
              0,
              width,
              height,
              0,
              0,
              width,
              height,
              gl.COLOR_BUFFER_BIT,
              gl.NEAREST,
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
        }
        if (refined) {
          if (needsDomOutput()) materialize();
          else {
            canvas.width = canvas.height = 1;
            domRevision = -1;
          }
        } else {
          context!.clearRect(0, 0, width, height);
          context!.drawImage(source, 0, 0);
        }
        canvas.style.visibility = "visible";
        if (sourceContent) sourceContent.style.opacity = "0";
        lastShaderInput = signature;
        publish();
      }
      if (node.dataset.effectError !== undefined) {
        delete node.dataset.effectError;
        onDiagnostic?.("");
      }
      node.dataset.effectReady = "true";
    } catch (error) {
      diagnose(error);
    }
  };
  const dispose = () => {
    live = false;
    cancelFrame(draw);
    scheduled.delete(node);
    shaderRedraws.delete(schedule);
    observer?.disconnect();
    const root = sourceRoot;
    root?.removeEventListener("load", sourceChanged, true);
    root?.removeEventListener("loadeddata", sourceChanged, true);
    root?.removeEventListener("seeked", sourceChanged, true);
    root?.removeEventListener("timeupdate", sourceChanged, true);
    root?.removeEventListener("showme-effect-output", outputChanged);
    if (sourceLease) sourceLease.release();
    else raster?.dispose();
    if (coordinator) {
      coordinator.graph.remove(node);
      coordinator.nodes.delete(node);
      coordinator.compiled = false;
      nodeCoordinators.delete(node);
      if (!coordinator.nodes.size) {
        coordinator.observer.disconnect();
        liveCoordinators.delete(coordinator);
        coordinators.delete(sceneRoot);
      }
    }
    if (texture) texture.gl.deleteTexture(texture.value);
    if (shaderOutput) disposeShaderOutput(shaderOutput);
    if (sourceContent) sourceContent.style.opacity = sourceOpacity;
    surfaces.delete(node);
    runner?.dispose();
    output?.remove();
    if (original && textInputHidden) original.style.opacity = originalOpacity;
    node.getAnimations().forEach((animation) => animation.cancel());
    style?.remove();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  };

  try {
    if (definition.kind === "css") {
      const scope = `showme_effect_${++scopeId}`;
      node.dataset.effectScope = scope;
      style = document.createElement("style");
      style.media = "not all";
      style.textContent = compileEffectCss(definition.source, scope);
      node.append(style);
    } else if (definition.kind === "text-js") {
      original = node.querySelector<HTMLElement>("[data-text-content]");
      if (!original) throw new Error("Text effects require a text Element");
      originalOpacity = original.style.opacity;
      output = original.cloneNode(true) as HTMLElement;
      output.removeAttribute("data-text-content");
      output.dataset.effectTextOutput = "true";
      output.style.pointerEvents = "none";
      output.style.visibility = "hidden";
      output.setAttribute("aria-hidden", "true");
      node.append(output);
      sourceRoot = node;
      sourceRoot.addEventListener("showme-effect-output", outputChanged);
      if (definition.styleSource) {
        const scope = `showme_effect_${++scopeId}`;
        output.dataset.effectScope = scope;
        style = document.createElement("style");
        style.media = "not all";
        style.textContent = compileEffectCss(definition.styleSource, scope);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(definition.styleSource);
        for (const rule of sheet.cssRules)
          if (rule instanceof CSSStyleRule)
            for (const property of rule.style)
              output.style.removeProperty(property);
        node.append(style);
      }
    } else {
      const diagnostics = shaderDiagnostics(definition).filter(
        (message) => !message.includes("unused by GLSL"),
      );
      if (diagnostics.length) throw new Error(diagnostics.join("; "));
      shaderProgram(definition.source);
      if (definition.input === "content" || definition.input === "backdrop") {
        if (!content)
          throw new Error(
            "Pixel-input shaders require an Element raster source.",
          );
        sourceContent =
          (Array.from(node.children).find(
            (n) =>
              n instanceof HTMLElement && n.hasAttribute("data-effect-source"),
          ) as HTMLElement | undefined) ?? null;
        const root = node.closest<HTMLElement>("[data-element-id]");
        if (!root || (definition.input === "content" && !sourceContent))
          throw new Error("Content shader source is not mounted yet.");
        sourceOpacity = sourceContent?.style.opacity ?? "";
        sourceRoot =
          definition.input === "backdrop"
            ? root.closest<HTMLElement>(".slide-renderer")
            : root;
        if (!sourceRoot) throw new Error("Backdrop scene is not mounted yet.");
        const context = {
          root: sourceRoot,
          typographySource: content.scene
            ? () => content.scene!().deck
            : undefined,
          get resources() {
            return content.scene
              ? (content.scene().slide.effectResources ?? {})
              : content.resources;
          },
          beforeEffect: instance.id,
          flush: (dependency: HTMLElement) => {
            void surfaces.get(dependency)?.flush();
          },
        };
        const hasText = (elements: Element[]): boolean =>
          elements.some(
            (element) =>
              element.content?.type === "text" || hasText(element.children),
          );
        let sampledSlide: Slide | undefined,
          sampledResources: EffectResources | undefined;
        let sampledStylesheet: string | undefined,
          domInput = false,
          sampled = false;
        needsDomRaster = () => {
          const scene = content.scene?.(),
            resources = context.resources,
            stylesheet = scene?.deck.stylesheet;
          // Authority revisions provide immutable slide/resource identities.
          // Routing must follow those revisions without remounting the lens.
          if (
            !sampled ||
            scene?.slide !== sampledSlide ||
            resources !== sampledResources ||
            stylesheet !== sampledStylesheet
          ) {
            sampled = true;
            sampledSlide = scene?.slide;
            sampledResources = resources;
            sampledStylesheet = stylesheet;
            const inputElements =
              definition.input === "backdrop" && scene
                ? backdropPrefix(scene.slide, scene.deck, content.element.id)
                    .elements
                : [content.element];
            domInput =
              !!stylesheet ||
              hasText(inputElements) ||
              Object.values(resources).some(
                (resource) => resource.kind !== "fragment-glsl",
              );
          }
          return domInput;
        };
        const createPrimitiveRaster = (invalidate: () => void) => {
          if (definition.input === "backdrop") {
            if (!content.scene)
              throw new Error("Backdrop shaders require a slide scene.");
            return createBackdropRasterSource(
              content.element,
              content.scene,
              context,
              invalidate,
            );
          }
          return createElementRasterSource(
            content.element,
            context,
            invalidate,
          );
        };
        {
          const inputRoot =
            definition.input === "backdrop" ? sourceRoot : sourceContent!;
          let allowed = new Set<string>(),
            partial = new Set<string>();
          const prefixElements = new Map<string, Element>();
          const refreshPrefix = () => {
            if (definition.input !== "backdrop" || !content.scene) return;
            const { slide, deck } = content.scene();
            const prefix = backdropPrefix(slide, deck, content.element.id);
            partial = prefix.partial;
            allowed = new Set<string>();
            prefixElements.clear();
            const visit = (elements: Element[]) =>
              elements.forEach((element) => {
                allowed.add(element.id);
                prefixElements.set(element.id, element);
                visit(element.children);
              });
            visit(prefix.elements);
          };
          const createNativeRaster = (invalidate: () => void) =>
            createDomRasterSource(
              () => {
                refreshPrefix();
                return inputRoot;
              },
              (candidate) => {
                if (
                  refined &&
                  candidate !== inputRoot &&
                  candidate.hasAttribute("data-effect-source") &&
                  candidate.style.opacity === "0" &&
                  !partial.has(
                    candidate.closest<HTMLElement>("[data-element-id]")?.dataset
                      .elementId ?? "",
                  ) &&
                  candidate.parentElement?.dataset.effectStarted === "true" &&
                  !candidate.parentElement.dataset.effectError
                )
                  return false;
                if (candidate.closest('[data-presentation-absent="true"]'))
                  return false;
                const owner =
                  candidate.closest<HTMLElement>("[data-element-id]");
                if (
                  definition.input === "backdrop" &&
                  owner &&
                  !allowed.has(owner.dataset.elementId!)
                )
                  return false;
                if (owner && partial.has(owner.dataset.elementId!)) {
                  if (candidate.hasAttribute("data-element-stroke"))
                    return false;
                  const effectId =
                    candidate.closest<HTMLElement>("[data-effect-id]")?.dataset
                      .effectId;
                  const instance = prefixElements
                    .get(owner.dataset.elementId!)
                    ?.effects?.find((effect) => effect.id === effectId);
                  if (instance?.placement === "overlay") return false;
                  if (
                    candidate instanceof HTMLCanvasElement &&
                    instance &&
                    effectPlacement(
                      context.resources[instance.resourceId],
                      instance,
                    ) === "content"
                  )
                    return false;
                }
                return true;
              },
              (original, clone) => {
                // Shader source opacity is a display bypass, not source alpha.
                if (
                  original.hasAttribute("data-effect-source") &&
                  (original === sourceContent ||
                    partial.has(
                      original.closest<HTMLElement>("[data-element-id]")
                        ?.dataset.elementId ?? "",
                    ))
                )
                  clone.style.setProperty("opacity", "1", "important");
                if (original === inputRoot && definition.input === "backdrop") {
                  // The capture viewport carries the world-to-frame transform.
                  clone.style.setProperty("transform", "none", "important");
                  clone.style.setProperty(
                    "transform-origin",
                    "0 0",
                    "important",
                  );
                }
              },
              invalidate,
              async () => {
                refreshPrefix();
                const dependencies = Array.from(
                  inputRoot.querySelectorAll<HTMLElement>("[data-effect-id]"),
                ).reverse();
                for (const dependency of dependencies) {
                  if (dependency === node || dependency.contains(node))
                    continue;
                  const owner =
                    dependency.closest<HTMLElement>("[data-element-id]");
                  if (
                    definition.input === "backdrop" &&
                    owner &&
                    (!allowed.has(owner.dataset.elementId!) ||
                      partial.has(owner.dataset.elementId!))
                  )
                    continue;
                  const surface = surfaces.get(dependency);
                  if (!refined) await surface?.flush();
                  if (refined) {
                    let hidden = false;
                    for (
                      let ancestor = dependency.parentElement;
                      ancestor && ancestor !== inputRoot;
                      ancestor = ancestor.parentElement
                    ) {
                      if (
                        ancestor.hasAttribute("data-effect-source") &&
                        ancestor.style.opacity === "0" &&
                        !partial.has(
                          ancestor.closest<HTMLElement>("[data-element-id]")
                            ?.dataset.elementId ?? "",
                        )
                      ) {
                        hidden = true;
                        break;
                      }
                    }
                    if (!hidden) surface?.materialize();
                  }
                }
              },
              () =>
                definition.input === "backdrop"
                  ? elementWorldTransform(root, inputRoot).inverse()
                  : new DOMMatrix(),
              refined,
            );
          createRaster = (invalidate) =>
            needsDomRaster()
              ? createNativeRaster(invalidate)
              : createPrimitiveRaster(invalidate);
        }
        if (!refined && createRaster && !raster)
          raster = createRaster(schedule);
        observer = new MutationObserver((records) => {
          if (
            records.some(
              (r) =>
                r.type === "childList" ||
                r.type === "characterData" ||
                ((r.target instanceof HTMLElement ||
                  r.target instanceof SVGElement) &&
                  (definition.input === "backdrop" || r.target !== root) &&
                  !r.target.dataset.effectId &&
                  r.target.tagName !== "CANVAS" &&
                  !r.attributeName?.startsWith("data-effect")),
            )
          )
            sourceChanged();
        });
        observer.observe(sourceRoot, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        sourceRoot.addEventListener("load", sourceChanged, true);
        sourceRoot.addEventListener("loadeddata", sourceChanged, true);
        sourceRoot.addEventListener("seeked", sourceChanged, true);
        sourceRoot.addEventListener("timeupdate", sourceChanged, true);
        sourceRoot.addEventListener("showme-effect-output", outputChanged);
      }
    }
  } catch (error) {
    diagnose(error);
    return dispose;
  }
  const surface: Surface = {
    inputs: inputDependencies,
    materialize,
    gpuOutput() {
      return live &&
        node.dataset.effectStarted !== "false" &&
        !node.dataset.effectError &&
        !shaderOutput?.gl.isContextLost()
        ? shaderOutput
        : null;
    },
    setSampling(value) {
      sampling = value;
      heldDensity = 0;
      preparedSampling = false;
      if (definition.kind === "fragment-glsl" && timing.started)
        node.dataset.effectReady = "false";
      schedule();
    },
    prepareSampling,
    set(key, value) {
      if (values[key] === value) return;
      values[key] = value;
      schedule();
    },
    setTiming(value) {
      const previous = refined ? JSON.stringify(clockKey(timing)) : "";
      timing = {
        progress: value.progress,
        ...value,
        slideTime: value.slideTime ?? value.time,
        presentationTime: value.presentationTime ?? value.time,
        stepTime: value.stepTime ?? value.time,
        stepIndex: value.stepIndex ?? 0,
        active: value.active ?? true,
        running: value.running ?? false,
        started: value.started ?? true,
      };
      // Preserve the complete CSS clock API even when a static shader needs no
      // new GPU draw. Arbitrary stylesheet rules may consume inherited clocks.
      if (refined && definition.kind === "fragment-glsl" && !ownerAbsent()) {
        for (const [key, clock] of Object.entries({
          t: timing.time * (definition.speed ?? 1),
          p: timing.progress ?? 1,
          slideTime: timing.slideTime,
          presentationTime: timing.presentationTime,
          stepTime: timing.stepTime,
          stepIndex: timing.stepIndex,
          active: Number(timing.active),
          duration: timing.duration,
        })) {
          const serialized = cssEffectValue(clock);
          if (node.style.getPropertyValue(`--${key}`) !== serialized)
            node.style.setProperty(`--${key}`, serialized);
        }
      }
      if (!timing.started) bypass();
      if (refined && previous === JSON.stringify(clockKey(timing))) return;
      schedule();
    },
    async flush(cohort) {
      cancelFrame(draw);
      scheduled.delete(node);
      if (ownerAbsent()) return;
      if (coordinator) {
        compileCoordinator(coordinator);
        await coordinator.graph.flush(node, cohort);
        if (needsDomOutput()) {
          try {
            materialize();
          } catch (error) {
            diagnose(error);
          }
        }
        return;
      }
      void draw();
      // Await the frame requested by this call. Live video/animation can enqueue
      // another frame while it paints; chasing every replacement never settles.
      await pending;
    },
    reset() {
      Object.assign(values, base);
      timing = {
        time: 0,
        duration: 0,
        slideTime: 0,
        presentationTime: 0,
        stepTime: 0,
        stepIndex: 0,
        active: true,
        started: false,
        running: false,
        progress: undefined,
      };
      cancelFrame(draw);
      heldDensity = 0;
      schedule();
    },
  };
  surfaces.set(node, surface);
  if (coordinator) {
    coordinator.nodes.add(node);
    coordinator.graph.register(node, async () => {
      void draw();
      await pending;
    });
    coordinator.compiled = false;
    nodeCoordinators.set(node, coordinator);
  }
  if (definition.kind === "fragment-glsl") shaderRedraws.add(schedule);
  bypass();
  schedule();
  return dispose;
}
