import { createTextEffectRunner } from "./textEffectRunner";
import { frame, cancelFrame } from "motion";
import {
  affineSamplingDensity,
  shaderSamplingSize,
  type RenderDensity,
  type ShaderCapabilities,
} from "../core/renderProfile";
import {
  createSceneTextureProvider,
  sceneTextureTextureBytes,
  type SceneTextureProvider,
  type SceneTexture,
} from "./sceneTexture";
import { flushCompositionOutputs } from "./compositionReadiness";
import {
  allocateShaderOutput,
  disposeShaderOutput,
  type ShaderOutput,
} from "./shaderOutput";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import { getWorldMatrix } from "../core/scene";
import type { EffectResources } from "../core/effects";
import {
  consumedParameter,
  effectDependencies,
  cssEffectValue,
  type EffectParameterValue,
  effectParameters,
  shaderDiagnostics,
  type EffectDefinition,
  type ElementEffect,
} from "../core/effects";

export interface EffectSampling extends RenderDensity {
  root?: HTMLElement | null;
  retain?: boolean;
  envelope?: number;
}
type Surface = {
  materialize(): void;
  gpuOutput(): ShaderOutput | null;
  setSampling(value: EffectSampling): void;
  prepareSampling(): void;
  setTransport(matrix: DOMMatrixReadOnly): void;
  set(key: string, value: EffectParameterValue): void;
  setTiming(value: {
    time: number;
    duration: number;
    slideTime?: number;
    presentationTime?: number;
    stepTime?: number;
    stepIndex?: number;
    slideIndex?: number;
    slideCount?: number;
    slideSeed?: number;
    previousSlideIndex?: number;
    previousSlideSeed?: number;
    active?: boolean;
    started?: boolean;
    running?: boolean;
    progress?: number;
  }): void;
  flush(): void | Promise<void>;
  gpuContext(): WebGL2RenderingContext | null;
  reset(): void;
};
const surfaces = new WeakMap<HTMLElement, Surface>();
const scheduled = new Map<HTMLElement, { prepare(): void; draw(): unknown }>();
export type EffectExecutionMode = "naive" | "refined";
let executionMode: EffectExecutionMode = "refined";
/** Regression reference control. Production uses the refined renderer. */
export function setEffectExecutionForTests(mode: EffectExecutionMode) {
  executionMode = mode;
}
export function effectSourceTextureBytes() {
  return sceneTextureTextureBytes();
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
  const pending = work.map(([, value]) => value.draw());
  void Promise.all(pending).then(() =>
    flushCompositionOutputs(
      work.map(
        ([node]) => node.closest<HTMLElement>(".slide-renderer") ?? node,
      ),
    ),
  );
}
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
  for (const node of nodes) await surfaces.get(node)?.flush();
  const compositionReady = await flushCompositionOutputs(
    nodes.map((node) => node.closest<HTMLElement>(".slide-renderer") ?? node),
  );
  return (
    compositionReady &&
    !Array.from(root.querySelectorAll('[data-effect-ready="false"]')).some(
      (node) => !node.closest('[data-presentation-absent="true"]'),
    )
  );
}

/** Bind a mounted semantic tree once; Motion must not rediscover it per sample. */
export function bindEffectSurfaceFlusher(root: HTMLElement) {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-effect-id]"),
  ).sort(dependencyOrder);
  return async () => {
    nodes.forEach((node) => surfaces.get(node)?.prepareSampling());
    for (const node of nodes) await surfaces.get(node)?.flush();
  };
}

const vertex = `#version 300 es
in vec2 position;
out vec2 v_uv;
void main() { v_uv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

type ShaderGpuState = {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  programs: Map<string, WebGLProgram>;
  buffer: WebGLBuffer;
  capabilities: ShaderCapabilities;
  textureSize: number;
  generation: number;
};

export type ShaderChain = {
  canvas: HTMLCanvasElement | null;
  state: ShaderGpuState | null;
  redraws: Set<() => void>;
  boundCanvas: HTMLCanvasElement | null;
  onLost: EventListener | null;
  onRestored: EventListener | null;
  lost: boolean;
};

const shaderMetrics = {
  contextsCreated: 0,
  shaderCompilations: 0,
  maxActiveContexts: 0,
  canvas2dPresentationCopies: 0,
};
const activeShaderChains = new Set<ShaderChain>();
let gpuGeneration = 0;

export function createShaderChain(): ShaderChain {
  return {
    canvas: null,
    state: null,
    redraws: new Set(),
    boundCanvas: null,
    onLost: null,
    onRestored: null,
    lost: false,
  };
}

export function shaderRuntimeDiagnostics() {
  return {
    ...shaderMetrics,
    activeContexts: [...activeShaderChains].filter(
      (chain) => !!chain.state && !chain.state.gl.isContextLost(),
    ).length,
  };
}

function bindShaderContextLifecycle(
  chain: ShaderChain,
  canvas: HTMLCanvasElement,
) {
  if (chain.boundCanvas === canvas) return;
  if (chain.boundCanvas && chain.onLost && chain.onRestored) {
    chain.boundCanvas.removeEventListener("webglcontextlost", chain.onLost);
    chain.boundCanvas.removeEventListener(
      "webglcontextrestored",
      chain.onRestored,
    );
  }
  const lost: EventListener = (event) => {
    event.preventDefault();
    chain.lost = true;
    chain.state = null;
  };
  const restored: EventListener = () => {
    chain.lost = false;
    chain.state = null;
    chain.redraws.forEach((redraw) => redraw());
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  chain.boundCanvas = canvas;
  chain.onLost = lost;
  chain.onRestored = restored;
}

function shaderGpu(chain: ShaderChain) {
  if (chain.state && !chain.state.gl.isContextLost()) return chain.state;
  const canvas = chain.canvas;
  if (!canvas) throw new Error("Shader output canvas is not mounted.");
  bindShaderContextLifecycle(chain, canvas);
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    // Static shader layers can be sampled later by an explicit SceneTexture.
    // Chromium may discard a non-preserved default framebuffer after presenting.
    preserveDrawingBuffer: true,
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
  const state: ShaderGpuState = {
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
  chain.state = state;
  activeShaderChains.add(chain);
  shaderMetrics.contextsCreated++;
  shaderMetrics.maxActiveContexts = Math.max(
    shaderMetrics.maxActiveContexts,
    activeShaderChains.size,
  );
  return state;
}

function disposeShaderChain(chain: ShaderChain) {
  const state = chain.state;
  if (state && !state.gl.isContextLost()) {
    for (const program of state.programs.values())
      state.gl.deleteProgram(program);
    state.gl.deleteBuffer(state.buffer);
  }
  if (chain.boundCanvas && chain.onLost && chain.onRestored) {
    chain.boundCanvas.removeEventListener("webglcontextlost", chain.onLost);
    chain.boundCanvas.removeEventListener(
      "webglcontextrestored",
      chain.onRestored,
    );
  }
  chain.state = null;
  chain.redraws.clear();
  chain.boundCanvas = null;
  chain.onLost = null;
  chain.onRestored = null;
  activeShaderChains.delete(chain);
}

let validationChain: ShaderChain | null = null;
function validationShaderChain() {
  if (!validationChain) {
    validationChain = createShaderChain();
    validationChain.canvas = document.createElement("canvas");
    validationChain.canvas.width = validationChain.canvas.height = 1;
  }
  return validationChain;
}

export function shaderProgram(source: string, chain = validationShaderChain()) {
  const state = shaderGpu(chain),
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
    shaderMetrics.shaderCompilations++;
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
  const collect = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSKeyframesRule)
        names.set(rule.name, `${scope}_${rule.name}`);
      else if (rule instanceof CSSSupportsRule) collect(rule.cssRules);
    }
  };
  collect(sheet.cssRules);
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
  const compile = (rules: CSSRuleList): string => {
    const output: string[] = [];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (rule.selectorText !== ":scope")
          throw new Error(
            "CSS effects support :scope and @keyframes rules only",
          );
        declarations(rule.style);
        output.push(`[data-effect-scope="${scope}"] { ${rule.style.cssText} }`);
      } else if (rule instanceof CSSKeyframesRule) {
        rule.name = names.get(rule.name)!;
        output.push(rule.cssText);
      } else if (rule instanceof CSSSupportsRule)
        output.push(
          `@supports ${rule.conditionText} { ${compile(rule.cssRules)} }`,
        );
      else
        throw new Error(
          "CSS effects support :scope, @keyframes and scoped @supports rules only",
        );
    }
    return output.join("\n");
  };
  return compile(sheet.cssRules);
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
  shaderChain?: ShaderChain,
  shaderIntermediate = false,
  directShaderInput = false,
  ownsShaderChain = false,
  ownedMediaInput = false,
) {
  const refined = executionMode === "refined";
  const dependencies = effectDependencies(definition);
  const cssSource = () =>
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
      ).test(source) || new RegExp(`--${key}(?![\\w-])`).test(cssSource());
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
      /@keyframes\b/.test(cssSource()) ? value.time : 0,
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
  let semanticTransform = (() => {
    if (!content?.scene) return new DOMMatrix();
    const matrix = getWorldMatrix(content.scene().slide, content.element.id);
    return new DOMMatrix([...matrix]);
  })();
  let semanticTransformKey = semanticTransform.toString();
  const prepareSampling = () => {
    if (!live || definition.kind !== "fragment-glsl") return;
    try {
      logicalSize = size;
      // Arbitrary document CSS may author dimensions outside the semantic frame.
      // Keep this discovery behind that explicit exceptional boundary.
      if (content?.scene?.().deck.stylesheet?.trim()) {
        const owner = node.closest<HTMLElement>("[data-element-id]");
        if (owner) {
          const style = getComputedStyle(owner);
          logicalSize = {
            width: parseFloat(style.width) || size.width,
            height: parseFloat(style.height) || size.height,
          };
        }
      }
      const next = Math.max(
        affineSamplingDensity(sampling, semanticTransform),
        sampling.envelope ?? 0,
      );
      if (!Number.isFinite(next))
        throw new Error("Invalid shader transform sampling");
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
    slideIndex: 0,
    slideCount: 1,
    slideSeed: 0,
    previousSlideIndex: 0,
    previousSlideSeed: 0,
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
  let inputPending = false;
  let sceneTexture: SceneTextureProvider | null = null;
  let sceneTextureFactory: (() => SceneTextureProvider) | null = null;
  let shaderOutput: ShaderOutput | null = null;
  let sourceContent: HTMLElement | null = null;
  let ownedMediaSources: Array<HTMLImageElement | HTMLVideoElement> = [];
  let sourceOpacity = "";
  let ownedMediaTexture: {
    gl: WebGL2RenderingContext;
    texture: WebGLTexture;
    source: HTMLImageElement | HTMLVideoElement;
    key: string;
    revision: number;
  } | null = null;
  let videoFrameId: number | null = null;
  let videoFrameNode: HTMLVideoElement | null = null;
  let ownedMediaChanged: ((event: Event) => void) | null = null;

  const disposeOwnedMediaTexture = () => {
    if (ownedMediaTexture?.gl.isTexture(ownedMediaTexture.texture))
      ownedMediaTexture.gl.deleteTexture(ownedMediaTexture.texture);
    ownedMediaTexture = null;
  };

  const currentOwnedMedia = () => {
    if (!sourceContent) return null;
    const video = ownedMediaSources.find(
      (source): source is HTMLVideoElement =>
        source instanceof HTMLVideoElement,
    );
    if (
      video &&
      video.style.visibility !== "hidden" &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      video.videoWidth &&
      video.videoHeight
    )
      return video;
    return (
      ownedMediaSources.find(
        (image): image is HTMLImageElement =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0,
      ) ?? null
    );
  };

  const resolveOwnedMediaTexture = (gl: WebGL2RenderingContext) => {
    const source = currentOwnedMedia();
    if (!source) return null;
    const key =
      source instanceof HTMLVideoElement
        ? `${source.currentSrc || source.src}:${source.currentTime}:${source.videoWidth}x${source.videoHeight}`
        : `${source.currentSrc || source.src}:${source.naturalWidth}x${source.naturalHeight}`;
    if (
      !ownedMediaTexture ||
      ownedMediaTexture.gl !== gl ||
      !gl.isTexture(ownedMediaTexture.texture)
    ) {
      disposeOwnedMediaTexture();
      const texture = gl.createTexture();
      if (!texture) throw new Error("Cannot allocate owned media texture");
      ownedMediaTexture = { gl, texture, source, key: "", revision: 0 };
    }
    const state = ownedMediaTexture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    if (state.source !== source || state.key !== key) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("Cannot upload owned media shader input");
      state.source = source;
      state.key = key;
      state.revision++;
    }
    return {
      kind:
        source instanceof HTMLVideoElement
          ? ("videoTexture" as const)
          : ("imageTexture" as const),
      texture: state.texture,
      revision: state.revision,
    };
  };
  const renderedSceneTexture = () => {
    if (!sceneTexture && sceneTextureFactory)
      sceneTexture = sceneTextureFactory();
    return sceneTexture;
  };
  const ownerAbsent = () => !!node.closest('[data-presentation-absent="true"]');
  const schedule = () => {
    if (live) {
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
  const materialize = () => {
    if (
      !canvas ||
      shaderIntermediate ||
      node.dataset.effectError ||
      node.dataset.effectStarted === "false"
    )
      return;
    canvas.style.visibility = "visible";
  };
  let style: HTMLStyleElement | null = null;
  // Identity belongs to this stage, never to its Element or earlier stages.
  const bypass = () => {
    if (node.dataset.effectStarted !== "false") {
      ++sequence; // A pending worker must not repaint a backward seek.
      lastTextInput = "";
      lastShaderInput = "";
      if (canvas) canvas.style.visibility = "hidden";
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
    if (shaderChain?.lost) {
      node.dataset.effectReady = "false";
      return;
    }
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
        if (!shaderChain) throw new Error("Shader surface has no GPU chain.");
        const { gl, buffer, program, capabilities, textureSize, generation } =
          shaderProgram(definition.source, shaderChain);
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
          directShaderInput && sourceContent?.children.length === 1
            ? (sourceContent.firstElementChild as HTMLElement)
            : null;
        const previousSurface = previousStage
          ? surfaces.get(previousStage)
          : undefined;
        const canChain = !!(directShaderInput && previousSurface);
        const gpuInput = canChain ? previousSurface!.gpuOutput() : null;
        if (canChain && (!gpuInput || gpuInput.gl !== gl) && !inputPending) {
          inputPending = true;
          node.dataset.effectReady = "false";
          pending = Promise.resolve(previousSurface!.flush())
            .then(() => {
              inputPending = false;
              if (!previousSurface!.gpuOutput())
                throw new Error("Previous shader output is unavailable.");
              if (live) return draw();
            })
            .catch((error) => {
              inputPending = false;
              if (live) diagnose(error);
            });
          return pending;
        }
        if (inputPending) {
          return pending;
        }
        let sceneInput: SceneTexture | null = null;
        const renderedInput =
          !gpuInput && !directShaderInput && !ownedMediaInput
            ? renderedSceneTexture()
            : null;
        if (renderedInput && !inputPending) {
          const acquired = renderedInput.acquire({
            width,
            height,
            logicalWidth: logicalSize.width,
            logicalHeight: logicalSize.height,
          });
          if (acquired instanceof Promise) {
            inputPending = true;
            node.dataset.effectReady = "false";
            pending = acquired
              .then(() => {
                inputPending = false;
                if (live) return draw();
              })
              .catch((error) => {
                inputPending = false;
                if (live) diagnose(error);
              });
            return pending;
          }
          sceneInput = acquired;
        }
        if (inputPending) return pending;
        const ownedMedia = ownedMediaInput
          ? resolveOwnedMediaTexture(gl)
          : null;
        if (ownedMediaInput && !ownedMedia) {
          node.dataset.effectReady = "false";
          return;
        }
        const resolvedInput = gpuInput
          ? { kind: "shaderTexture" as const, output: gpuInput }
          : ownedMedia
            ? ownedMedia
            : sceneInput
              ? { kind: "sceneTexture" as const, texture: sceneInput }
              : { kind: "none" as const };
        const signature = JSON.stringify([
          params,
          refined ? clockKey(timing) : timing,
          width,
          height,
          resolvedInput.kind,
          resolvedInput.kind === "shaderTexture"
            ? resolvedInput.output.revision
            : resolvedInput.kind === "sceneTexture"
              ? resolvedInput.texture.revision
              : resolvedInput.kind === "imageTexture" ||
                  resolvedInput.kind === "videoTexture"
                ? resolvedInput.revision
                : 0,
          generation,
        ]);
        if (signature === lastShaderInput) {
          node.dataset.effectReady = "true";
          return;
        }
        if (shaderIntermediate) {
          shaderOutput = allocateShaderOutput(gl, width, height, shaderOutput);
          gl.bindFramebuffer(gl.FRAMEBUFFER, shaderOutput.framebuffer);
        } else {
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          if (
            gl.drawingBufferWidth !== width ||
            gl.drawingBufferHeight !== height ||
            gl.getError() !== gl.NO_ERROR
          )
            throw new Error(
              `Cannot allocate ${width} × ${height} visible shader drawing buffer`,
            );
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        if (resolvedInput.kind === "shaderTexture") {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, resolvedInput.output.texture);
          gl.uniform1i(gl.getUniformLocation(program, "u_input"), 0);
          node.dataset.effectSourceBackend = "gpu";
          node.dataset.effectSourceRevision = String(
            resolvedInput.output.revision,
          );
        } else if (
          resolvedInput.kind === "imageTexture" ||
          resolvedInput.kind === "videoTexture"
        ) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, resolvedInput.texture);
          gl.uniform1i(gl.getUniformLocation(program, "u_input"), 0);
          node.dataset.effectSourceBackend =
            resolvedInput.kind === "videoTexture" ? "video" : "image";
          node.dataset.effectSourceRevision = String(resolvedInput.revision);
        } else if (resolvedInput.kind === "sceneTexture") {
          resolvedInput.texture.bind(gl);
          node.dataset.effectSourceBackend = "scene-texture";
          node.dataset.effectSourceRevision = String(
            resolvedInput.texture.revision,
          );
          gl.uniform1i(gl.getUniformLocation(program, "u_input"), 0);
        } else {
          node.dataset.effectSourceBackend = "none";
          delete node.dataset.effectSourceRevision;
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
          u_slideIndex: timing.slideIndex,
          u_slideCount: timing.slideCount,
          u_slideSeed: timing.slideSeed,
          u_previousSlideIndex: timing.previousSlideIndex,
          u_previousSlideSeed: timing.previousSlideSeed,
          u_active: Number(timing.active),
          u_duration: timing.duration,
          ...params,
        }))
          if (typeof value === "number")
            gl.uniform1f(gl.getUniformLocation(program, key), value);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (shaderIntermediate && shaderOutput) {
          shaderOutput.revision++;
          canvas.style.visibility = "hidden";
          canvas.width = canvas.height = 1;
        } else {
          canvas.style.visibility = "visible";
        }
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
    sceneTexture?.dispose();
    if (videoFrameNode && videoFrameId !== null)
      videoFrameNode.cancelVideoFrameCallback?.(videoFrameId);
    videoFrameNode = null;
    videoFrameId = null;
    if (sourceContent && ownedMediaChanged) {
      sourceContent.removeEventListener("load", ownedMediaChanged, true);
      sourceContent.removeEventListener("loadeddata", ownedMediaChanged, true);
      sourceContent.removeEventListener("timeupdate", ownedMediaChanged, true);
    }
    ownedMediaChanged = null;
    disposeOwnedMediaTexture();
    if (shaderOutput) disposeShaderOutput(shaderOutput);
    if (shaderChain) shaderChain.redraws.delete(schedule);
    if (ownsShaderChain && shaderChain) disposeShaderChain(shaderChain);
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
      if (!shaderChain) throw new Error("Shader surface has no GPU chain.");
      shaderProgram(definition.source, shaderChain);
      if (definition.input === "content" || definition.input === "backdrop") {
        if (!content)
          throw new Error(
            "Pixel-input shaders require an owned or SceneTexture source.",
          );
        sourceContent =
          (Array.from(node.children).find(
            (candidate) =>
              candidate instanceof HTMLElement &&
              candidate.hasAttribute("data-effect-source"),
          ) as HTMLElement | undefined) ?? null;
        const owner = node.closest<HTMLElement>("[data-element-id]");
        if (!owner || (definition.input === "content" && !sourceContent))
          throw new Error("Content shader source is not mounted yet.");
        sourceOpacity = sourceContent?.style.opacity ?? "";
        if (ownedMediaInput && sourceContent) {
          ownedMediaSources = Array.from(
            sourceContent.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
              "video, img",
            ),
          );
          ownedMediaChanged = (event) => {
            const media = event.target;
            if (
              (media instanceof HTMLImageElement ||
                media instanceof HTMLVideoElement) &&
              !ownedMediaSources.includes(media)
            )
              ownedMediaSources.push(media);
            schedule();
          };
          sourceContent.addEventListener("load", ownedMediaChanged, true);
          sourceContent.addEventListener("loadeddata", ownedMediaChanged, true);
          const video = sourceContent.querySelector<HTMLVideoElement>("video");
          if (video?.requestVideoFrameCallback) {
            videoFrameNode = video;
            const nextFrame = () => {
              if (!live || !videoFrameNode) return;
              schedule();
              videoFrameId =
                videoFrameNode.requestVideoFrameCallback(nextFrame);
            };
            videoFrameId = video.requestVideoFrameCallback(nextFrame);
          } else
            sourceContent.addEventListener(
              "timeupdate",
              ownedMediaChanged,
              true,
            );
        }
        if (
          (!directShaderInput && !ownedMediaInput) ||
          definition.input === "backdrop"
        ) {
          const inputRoot =
            definition.input === "backdrop"
              ? owner.closest<HTMLElement>(".slide-renderer")
              : sourceContent;
          if (!inputRoot)
            throw new Error("SceneTexture source is not mounted yet.");
          sceneTextureFactory = () =>
            createSceneTextureProvider(
              {
                kind: definition.input === "backdrop" ? "backdrop" : "element",
                elementId: content.element.id,
                effectId: instance.id,
              },
              {
                effectNode: node,
                owner,
                inputRoot,
                element: content.element,
                resources: () =>
                  content.scene
                    ? (content.scene().slide.effectResources ?? {})
                    : content.resources,
                scene: content.scene,
                refined,
                flushEffect: (dependency) => surfaces.get(dependency)?.flush(),
                materializeEffect: (dependency) =>
                  surfaces.get(dependency)?.materialize(),
                invalidate: schedule,
              },
            );
        }
      }
    }
  } catch (error) {
    diagnose(error);
    return dispose;
  }
  const surface: Surface = {
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
    setTransport(matrix) {
      const next = new DOMMatrix([
        matrix.a,
        matrix.b,
        matrix.c,
        matrix.d,
        matrix.e,
        matrix.f,
      ]);
      const key = next.toString();
      if (key === semanticTransformKey) return;
      semanticTransform = next;
      semanticTransformKey = key;
      preparedSampling = false;
      if (definition.input === "backdrop") sceneTexture?.invalidate();
      schedule();
    },
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
        slideIndex: value.slideIndex ?? 0,
        slideCount: value.slideCount ?? 1,
        slideSeed: value.slideSeed ?? 0,
        previousSlideIndex: value.previousSlideIndex ?? value.slideIndex ?? 0,
        previousSlideSeed: value.previousSlideSeed ?? value.slideSeed ?? 0,
        active: value.active ?? true,
        running: value.running ?? false,
        started: value.started ?? true,
      };
      // Preserve the complete CSS clock API even when a static shader needs no
      // new GPU draw. Arbitrary stylesheet rules may consume inherited clocks.
      let inheritedClockChanged = false;
      if (refined && definition.kind === "fragment-glsl" && !ownerAbsent()) {
        const stylesheet = content?.scene?.().deck.stylesheet ?? "";
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
          if (node.style.getPropertyValue(`--${key}`) !== serialized) {
            node.style.setProperty(`--${key}`, serialized);
            if (new RegExp(`--${key}(?![\\w-])`).test(stylesheet))
              inheritedClockChanged = true;
          }
        }
      }
      // The stage's variables are outside its captured subtree. Updating them
      // changes inherited paint without a mutation inside that source.
      if (inheritedClockChanged) sceneTexture?.invalidate();
      if (!timing.started) bypass();
      if (
        refined &&
        !inheritedClockChanged &&
        previous === JSON.stringify(clockKey(timing))
      )
        return;
      schedule();
    },
    async flush() {
      cancelFrame(draw);
      scheduled.delete(node);
      if (ownerAbsent()) return;
      void draw();
      // Await the frame requested by this call. Live video/animation can enqueue
      // another frame while it paints; chasing every replacement never settles.
      await pending;
    },
    gpuContext() {
      return shaderChain?.state?.gl ?? null;
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
        slideIndex: 0,
        slideCount: 1,
        slideSeed: 0,
        previousSlideIndex: 0,
        previousSlideSeed: 0,
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
  if (definition.kind === "fragment-glsl" && shaderChain)
    shaderChain.redraws.add(schedule);
  bypass();
  schedule();
  return dispose;
}
