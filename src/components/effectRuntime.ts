import { createTextEffectRunner } from "./textEffectRunner";
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
} from "./elementRaster";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";
import {
  consumedParameter,
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
  flush(): void | Promise<void>;
  reset(): void;
};
const surfaces = new WeakMap<HTMLElement, Surface>();
const scheduled = new Map<HTMLElement, { prepare(): void; draw(): unknown }>();
const shaderRedraws = new Set<() => void>();
function flushScheduled() {
  const work = [...scheduled.entries()].sort(([a], [b]) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1,
  );
  scheduled.clear();
  // Read all current transforms after Motion writes, before allocating/painting.
  work.forEach(([, value]) => value.prepare());
  work.forEach(([, value]) => value.draw());
}
export function effectSurface(node: HTMLElement) {
  return surfaces.get(node);
}
/** Readiness includes asynchronous text output and diagnosed fallback. */
export async function flushEffectSurfaces(root: ParentNode) {
  // Inner groups and earlier pipeline stages must finish before their consumers.
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("[data-effect-id]"),
  ).reverse();
  nodes.forEach((node) => surfaces.get(node)?.prepareSampling());
  for (const node of nodes) await surfaces.get(node)?.flush();
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
  const prepareSampling = () => {
    if (!live || definition.kind !== "fragment-glsl") return;
    try {
      const owner = node.closest<HTMLElement>("[data-element-id]");
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
  let raster: ReturnType<typeof createElementRasterSource> | null = null;
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
    if (live && !ownerAbsent()) {
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
      sourceRoot?.contains(event.target)
    )
      sourceChanged();
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
      }))
        node.style.setProperty(`--${key}`, cssEffectValue(value));
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
        const signature = JSON.stringify(input);
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
            output.textContent = text;
            output.style.visibility = "visible";
            original.style.opacity = "0";
            textInputHidden = true;
            if (node.dataset.effectError !== undefined) {
              delete node.dataset.effectError;
              onDiagnostic?.("");
            }
            node.dataset.effectReady = "true";
            publish();
          })
          .catch((error) => {
            if (live && revision === sequence) diagnose(error);
          });
        return pending;
      } else if (definition.kind === "css") {
        for (const [key, value] of Object.entries(params))
          node.style.setProperty(`--${key}`, String(value));
        node.style.setProperty("--duration", String(timing.duration));
        for (const animation of node.getAnimations()) {
          animation.pause();
          const length = Number(
            animation.effect?.getComputedTiming().duration ?? 0,
          );
          animation.currentTime =
            timing.progress !== undefined && Number.isFinite(length)
              ? timing.progress * length
              : (typeof params.timeSeconds === "number"
                  ? params.timeSeconds
                  : timing.time) * 1000;
        }
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
          size,
          heldDensity,
          raster
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
        raster?.update(width, height);
        const signature = JSON.stringify([
          params,
          timing,
          width,
          height,
          raster?.revision,
          generation,
        ]);
        if (signature === lastShaderInput) return;
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
        const context = resizeRasterCanvas(canvas, width, height);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        if (raster) {
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
          size.width,
          size.height,
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
        context.clearRect(0, 0, width, height);
        context.drawImage(source, 0, 0);
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
    raster?.dispose();
    if (texture) texture.gl.deleteTexture(texture.value);
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
        if (definition.input === "backdrop") {
          if (!content.scene)
            throw new Error("Backdrop shaders require a slide scene.");
          raster = createBackdropRasterSource(
            content.element,
            content.scene,
            context,
            schedule,
          );
        } else
          raster = createElementRasterSource(
            content.element,
            context,
            schedule,
          );
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
      values[key] = value;
      schedule();
    },
    setTiming(value) {
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
      if (!timing.started) bypass();
      schedule();
    },
    async flush() {
      cancelFrame(draw);
      scheduled.delete(node);
      if (ownerAbsent()) return;
      void draw();
      while (live) {
        const current = pending;
        await current;
        if (current === pending) return;
      }
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
  if (definition.kind === "fragment-glsl") shaderRedraws.add(schedule);
  bypass();
  schedule();
  return dispose;
}
