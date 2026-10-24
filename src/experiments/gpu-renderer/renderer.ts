import type { Deck, Slide } from "../../core/document";
import {
  IDENTITY,
  inverse,
  localMatrix,
  multiply,
  resolveMediaFrame,
  transformPoint,
  type Element,
  type Matrix,
} from "../../core/element";
import {
  consumedParameter,
  effectProperty,
  effectTiming,
  numericEffectParameters,
  type EffectClocks,
  type EffectDefinition,
  type ElementEffect,
} from "../../core/effects";
import { motionElement, resolveMotion, type MotionOverlay } from "../../core/motion";
import { presenceElement, sampleElementPresence } from "../../core/presence";
import {
  compileGpuRenderGraph,
  type GpuRenderGraph,
  type GpuRenderGroup,
  type GpuRenderOperation,
} from "./graph";
import type {
  GpuNativeRasterSource,
  GpuNativeRasterSourceFactory,
} from "./nativeRaster";

export type GpuMediaSourceResolver = (
  element: Element,
) => TexImageSource | null | Promise<TexImageSource | null>;

export type GpuRendererFrame = {
  stageIndex: number;
  timeMs: number;
  clocks?: EffectClocks;
};

export type GpuRendererOptions = {
  pixelRatio?: number;
  mediaSource?: GpuMediaSourceResolver;
  nativeTextSource?: GpuNativeRasterSourceFactory;
  onDiagnostic?: (message: string) => void;
};

export class GpuRendererUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuRendererUnsupportedError";
  }
}

type Bounds = { x: number; y: number; width: number; height: number };
type RenderTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  bounds: Bounds;
  inUse: boolean;
  lastFrame: number;
};
type SceneLayer = { target: RenderTarget; world: Matrix; opacity: number };
type Program = {
  value: WebGLProgram;
  attributes: Map<string, number>;
  uniforms: Map<string, WebGLUniformLocation | null>;
};
type SourceTexture = {
  texture: WebGLTexture;
  revision: string | number;
  width: number;
  height: number;
  bytes: number;
};
type NativeTexture = SourceTexture & { source: GpuNativeRasterSource };
type SampledElement = { element: Element; present: boolean };

type RenderContext = {
  group: GpuRenderGroup;
  target: RenderTarget;
  world: Matrix;
  ancestorLayers: readonly SceneLayer[];
};

const fullRect = (element: Element): Bounds => ({
  x: 0,
  y: 0,
  width: element.frame.width,
  height: element.frame.height,
});
const finiteBounds = (value: Bounds): Bounds => ({
  x: Number.isFinite(value.x) ? value.x : 0,
  y: Number.isFinite(value.y) ? value.y : 0,
  width: Math.max(1e-6, Number.isFinite(value.width) ? value.width : 1),
  height: Math.max(1e-6, Number.isFinite(value.height) ? value.height : 1),
});
function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
function transformedBounds(bounds: Bounds, matrix: Matrix): Bounds {
  const points = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => transformPoint(matrix, point));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}
function matrixData(matrix: Matrix) {
  return new Float32Array([
    matrix[0],
    matrix[1],
    0,
    matrix[2],
    matrix[3],
    0,
    matrix[4],
    matrix[5],
    1,
  ]);
}
function percentile(values: readonly number[], p: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
}

class GpuRenderTargetPool {
  private readonly targets: RenderTarget[] = [];
  allocations = 0;
  resizes = 0;
  private frame = 0;

  beginFrame() {
    this.frame++;
  }

  endFrame(retained: RenderTarget) {
    for (const target of this.targets) target.inUse = target === retained;
  }

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly pixelRatio: number,
  ) {}

  acquire(bounds: Bounds): RenderTarget {
    bounds = finiteBounds(bounds);
    const width = Math.max(1, Math.ceil(bounds.width * this.pixelRatio));
    const height = Math.max(1, Math.ceil(bounds.height * this.pixelRatio));
    let target = this.targets.find(
      (candidate) => !candidate.inUse && candidate.width === width && candidate.height === height,
    );
    // Preserve this and the preceding frame's working set. Otherwise every
    // released group target is immediately resized for the next operation,
    // even for a completely static scene. Older idle targets can be recycled
    // across changing sizes; historical dimensions do not accumulate forever.
    target ??= this.targets.find(
      (candidate) => !candidate.inUse && candidate.lastFrame < this.frame - 1,
    );
    if (!target) {
      const texture = this.gl.createTexture();
      const framebuffer = this.gl.createFramebuffer();
      if (!texture || !framebuffer) {
        if (texture) this.gl.deleteTexture(texture);
        if (framebuffer) this.gl.deleteFramebuffer(framebuffer);
        throw new Error("Cannot allocate GPU renderer target");
      }
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texImage2D(
        this.gl.TEXTURE_2D,
        0,
        this.gl.RGBA8,
        width,
        height,
        0,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        null,
      );
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
      this.gl.framebufferTexture2D(
        this.gl.FRAMEBUFFER,
        this.gl.COLOR_ATTACHMENT0,
        this.gl.TEXTURE_2D,
        texture,
        0,
      );
      if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !== this.gl.FRAMEBUFFER_COMPLETE) {
        this.gl.deleteFramebuffer(framebuffer);
        this.gl.deleteTexture(texture);
        throw new Error(`Cannot allocate ${width} x ${height} GPU renderer target`);
      }
      target = { texture, framebuffer, width, height, bounds, inUse: true, lastFrame: this.frame };
      this.targets.push(target);
      this.allocations++;
    } else {
      if (target.width !== width || target.height !== height) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, target.texture);
        this.gl.texImage2D(
          this.gl.TEXTURE_2D,
          0,
          this.gl.RGBA8,
          width,
          height,
          0,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          null,
        );
        target.width = width;
        target.height = height;
        this.resizes++;
      }
      target.inUse = true;
      target.bounds = bounds;
    }
    target.lastFrame = this.frame;
    return target;
  }

  release(target: RenderTarget) {
    target.inUse = false;
  }

  diagnostics() {
    return {
      allocations: this.allocations,
      resizes: this.resizes,
      liveTargets: this.targets.length,
      activeTargets: this.targets.filter((target) => target.inUse).length,
      textureBytes: this.targets.reduce(
        (sum, target) => sum + target.width * target.height * 4,
        0,
      ),
    };
  }

  dispose() {
    for (const target of this.targets) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
    this.targets.length = 0;
  }
}

const quadVertex = `#version 300 es
in vec2 a_position;
uniform vec4 u_rect;
uniform mat3 u_matrix;
uniform vec4 u_targetBounds;
out vec2 v_uv;
void main() {
  vec2 local = u_rect.xy + a_position * u_rect.zw;
  vec3 mapped = u_matrix * vec3(local, 1.0);
  vec2 target = (mapped.xy - u_targetBounds.xy) / u_targetBounds.zw;
  gl_Position = vec4(target.x * 2.0 - 1.0, 1.0 - target.y * 2.0, 0.0, 1.0);
  v_uv = vec2(a_position.x, 1.0 - a_position.y);
}`;
const textureFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
out vec4 outColor;
void main() { outColor = texture(u_texture, v_uv) * u_opacity; }`;
const solidFragment = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;
const effectVertex = `#version 300 es
in vec2 position;
out vec2 v_uv;
void main() {
  v_uv = vec2(position.x, 1.0 - position.y);
  gl_Position = vec4(position.x * 2.0 - 1.0, 1.0 - position.y * 2.0, 0.0, 1.0);
}`;

function shaderSourceDimensions(source: TexImageSource) {
  if (source instanceof HTMLImageElement)
    return { width: source.naturalWidth, height: source.naturalHeight };
  if (source instanceof HTMLVideoElement)
    return { width: source.videoWidth, height: source.videoHeight };
  if (source instanceof HTMLCanvasElement)
    return { width: source.width, height: source.height };
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return { width: source.width, height: source.height };
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return { width: source.width, height: source.height };
  return { width: 0, height: 0 };
}
function sourceRevision(source: TexImageSource) {
  if (source instanceof HTMLVideoElement)
    return `${source.currentSrc}:${source.currentTime}:${source.videoWidth}:${source.videoHeight}`;
  if (source instanceof HTMLImageElement)
    return `${source.currentSrc || source.src}:${source.naturalWidth}:${source.naturalHeight}`;
  if (source instanceof HTMLCanvasElement)
    return `${source.width}:${source.height}:${source.dataset.gpuRevision ?? "0"}`;
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return `${source.width}:${source.height}`;
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return `${source.width}:${source.height}`;
  return String(source);
}

/**
 * Isolated architecture experiment. It owns one WebGL2 context and composes the
 * existing ShowMe semantic graph without participating in the production slide renderer.
 */
export class GpuRendererExperiment {
  readonly graph: GpuRenderGraph;
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private readonly pool: GpuRenderTargetPool;
  private readonly scene: RenderTarget;
  private readonly programs = new Map<string, Program>();
  private readonly nativeTextures = new Map<string, NativeTexture>();
  private readonly mediaTextures = new Map<string, SourceTexture>();
  private readonly sampled = new Map<string, SampledElement>();
  private readonly boundsCache = new Map<string, Bounds>();
  private overlay: MotionOverlay = {};
  private readonly quadBuffer: WebGLBuffer;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly pixelRatio: number;
  private frameInput: GpuRendererFrame = { stageIndex: 0, timeMs: 0 };
  private disposed = false;
  private uploads = 0;
  private shaderPublications = 0;
  private outputPublications = 0;
  private readbacks = 0;
  private frameTimestamps: number[] = [];
  private shaderTimestamps: number[] = [];
  private readonly shaderByEffect = new Map<string, { total: number; timestamps: number[] }>();
  private rasterTimestamps: number[] = [];
  private frameIntervals: number[] = [];
  private lastFrameAt = 0;
  private errors: string[] = [];
  private readonly colorProbe = document.createElement("span");
  private readonly colorCache = new Map<string, readonly [number, number, number, number]>();

  constructor(
    canvas: HTMLCanvasElement,
    slide: Slide,
    deck: Deck,
    private readonly options: GpuRendererOptions = {},
  ) {
    this.canvas = canvas;
    this.graph = compileGpuRenderGraph(slide, deck);
    this.pixelRatio = Math.max(0.1, options.pixelRatio ?? devicePixelRatio ?? 1);
    canvas.width = Math.max(1, Math.round(deck.width * this.pixelRatio));
    canvas.height = Math.max(1, Math.round(deck.height * this.pixelRatio));
    canvas.style.width = `${deck.width}px`;
    canvas.style.height = `${deck.height}px`;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is unavailable for GPU renderer experiment");
    this.gl = gl;
    const quadBuffer = gl.createBuffer();
    const quadVao = gl.createVertexArray();
    if (!quadBuffer || !quadVao) {
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (quadVao) gl.deleteVertexArray(quadVao);
      throw new Error("Cannot allocate GPU renderer quad");
    }
    this.quadBuffer = quadBuffer;
    this.quadVao = quadVao;
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.pool = new GpuRenderTargetPool(gl, this.pixelRatio);
    this.scene = this.pool.acquire({ x: 0, y: 0, width: deck.width, height: deck.height });
    this.colorProbe.style.position = "fixed";
    this.colorProbe.style.left = "-100000px";
    document.body.append(this.colorProbe);
    this.program(quadVertex, textureFragment, "composite");
    this.program(quadVertex, solidFragment, "solid");
  }

  private program(vertex: string, fragment: string, key: string) {
    const existing = this.programs.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    let value: WebGLProgram | null = null;
    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error("Cannot allocate GPU renderer shader");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || "GPU renderer shader compilation failed");
      }
      value = gl.createProgram();
      if (!value) throw new Error("Cannot allocate GPU renderer program");
      shaders.forEach((shader) => gl.attachShader(value!, shader));
      gl.linkProgram(value);
      if (!gl.getProgramParameter(value, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(value) || "GPU renderer program link failed");
      const attributes = new Map<string, number>();
      const uniforms = new Map<string, WebGLUniformLocation | null>();
      for (let i = 0; i < gl.getProgramParameter(value, gl.ACTIVE_ATTRIBUTES); i++) {
        const active = gl.getActiveAttrib(value, i)!;
        attributes.set(active.name, gl.getAttribLocation(value, active.name));
      }
      for (let i = 0; i < gl.getProgramParameter(value, gl.ACTIVE_UNIFORMS); i++) {
        const active = gl.getActiveUniform(value, i)!;
        uniforms.set(active.name, gl.getUniformLocation(value, active.name));
      }
      const program = { value, attributes, uniforms };
      this.programs.set(key, program);
      return program;
    } catch (error) {
      if (value) gl.deleteProgram(value);
      throw error;
    } finally {
      shaders.forEach((shader) => gl.deleteShader(shader));
    }
  }

  private bindProgram(program: Program, attribute = "a_position") {
    const gl = this.gl;
    gl.useProgram(program.value);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const location = program.attributes.get(attribute) ?? -1;
    if (location >= 0) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    }
  }

  private clear(target: RenderTarget, color: readonly [number, number, number, number] = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(color[0], color[1], color[2], color[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private cssColor(value: string): readonly [number, number, number, number] {
    const cached = this.colorCache.get(value);
    if (cached) return cached;
    this.colorProbe.style.color = "";
    this.colorProbe.style.color = value;
    const resolved = getComputedStyle(this.colorProbe).color;
    const match = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/.exec(resolved);
    if (!match) throw new GpuRendererUnsupportedError(`Unsupported authored color: ${value}`);
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    const result = [
      (Number(match[1]) / 255) * alpha,
      (Number(match[2]) / 255) * alpha,
      (Number(match[3]) / 255) * alpha,
      alpha,
    ] as const;
    this.colorCache.set(value, result);
    return result;
  }

  private drawTexture(
    source: RenderTarget | SourceTexture,
    target: RenderTarget,
    rect: Bounds,
    matrix: Matrix = IDENTITY,
    opacity = 1,
  ) {
    const gl = this.gl;
    const program = this.programs.get("composite")!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.bindProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(program.uniforms.get("u_texture") ?? null, 0);
    gl.uniform1f(program.uniforms.get("u_opacity") ?? null, opacity);
    gl.uniform4f(program.uniforms.get("u_rect") ?? null, rect.x, rect.y, rect.width, rect.height);
    gl.uniform4f(
      program.uniforms.get("u_targetBounds") ?? null,
      target.bounds.x,
      target.bounds.y,
      target.bounds.width,
      target.bounds.height,
    );
    gl.uniformMatrix3fv(program.uniforms.get("u_matrix") ?? null, false, matrixData(matrix));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawSolid(
    target: RenderTarget,
    rect: Bounds,
    color: readonly [number, number, number, number],
  ) {
    const gl = this.gl;
    const program = this.programs.get("solid")!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.bindProgram(program);
    gl.uniform4f(program.uniforms.get("u_rect") ?? null, rect.x, rect.y, rect.width, rect.height);
    gl.uniform4f(
      program.uniforms.get("u_targetBounds") ?? null,
      target.bounds.x,
      target.bounds.y,
      target.bounds.width,
      target.bounds.height,
    );
    gl.uniformMatrix3fv(program.uniforms.get("u_matrix") ?? null, false, matrixData(IDENTITY));
    gl.uniform4f(program.uniforms.get("u_color") ?? null, color[0], color[1], color[2], color[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private sampleFrame(input: GpuRendererFrame) {
    this.frameInput = input;
    this.overlay = resolveMotion(this.graph.slide, input.stageIndex, input.timeMs);
    this.sampled.clear();
    this.boundsCache.clear();
    for (const group of this.graph.groups.values()) {
      const presence = sampleElementPresence(
        this.graph.slide.motion,
        group.id,
        input.stageIndex,
        input.timeMs,
        input.clocks,
      );
      const animated = motionElement(group.element, this.overlay);
      this.sampled.set(group.id, {
        element: presenceElement(animated, presence),
        present: presence.present,
      });
    }
  }

  private sampledElement(id: string) {
    const sample = this.sampled.get(id);
    if (!sample) throw new Error(`Unknown GPU renderer element ${id}`);
    return sample;
  }

  private groupBounds(group: GpuRenderGroup): Bounds {
    const cached = this.boundsCache.get(group.id);
    if (cached) return cached;
    const sampled = this.sampledElement(group.id);
    const element = sampled.element;
    if (element.clipChildren) {
      const bounds = fullRect(element);
      this.boundsCache.set(group.id, bounds);
      return bounds;
    }
    const hasOwnPaint =
      !!element.content ||
      !!element.appearance.fill ||
      element.appearance.strokeWidth > 0 ||
      (element.effects ?? []).some((effect) => effect.enabled);
    let bounds: Bounds | null = hasOwnPaint ? fullRect(element) : null;
    if (element.content && element.content.type !== "text") {
      const media = resolveMediaFrame(element);
      if (media)
        bounds = unionBounds(
          bounds,
          transformedBounds(
            { x: 0, y: 0, width: media.width, height: media.height },
            localMatrix(media),
          ),
        );
    }
    for (const childId of group.children) {
      const childSample = this.sampledElement(childId);
      if (!childSample.present) continue;
      const child = this.graph.groups.get(childId)!;
      bounds = unionBounds(
        bounds,
        transformedBounds(this.groupBounds(child), localMatrix(childSample.element.frame)),
      );
    }
    const resolved = finiteBounds(bounds ?? fullRect(element));
    this.boundsCache.set(group.id, resolved);
    return resolved;
  }

  private async nativeTexture(element: Element) {
    let entry = this.nativeTextures.get(element.id);
    if (!entry) {
      const source = this.options.nativeTextSource?.(element, this.graph.deck, () => {});
      if (!source)
        throw new GpuRendererUnsupportedError(
          "Native text requires an injected Chromium raster source",
        );
      const texture = this.gl.createTexture();
      if (!texture) {
        source.dispose();
        throw new Error("Cannot allocate native text texture");
      }
      entry = { source, texture, revision: -1, width: 0, height: 0, bytes: 0 };
      this.nativeTextures.set(element.id, entry);
    }
    entry.source.sync(element, this.graph.deck);
    const raster = await entry.source.rasterize(this.pixelRatio);
    if (raster.rasterized) this.rasterTimestamps.push(performance.now());
    if (entry.revision !== raster.revision) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, raster.canvas);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Cannot upload native text surface");
      entry.revision = raster.revision;
      entry.width = raster.canvas.width;
      entry.height = raster.canvas.height;
      entry.bytes = entry.width * entry.height * 4;
      this.uploads++;
    }
    return entry;
  }

  private async mediaTexture(element: Element) {
    const content = element.content;
    if (!content || content.type === "text") return null;
    const source = await this.options.mediaSource?.(element);
    if (!source) return null;
    const key = content.assetId;
    let entry = this.mediaTextures.get(key);
    if (!entry) {
      const texture = this.gl.createTexture();
      if (!texture) throw new Error("Cannot allocate media texture");
      entry = { texture, revision: "", width: 0, height: 0, bytes: 0 };
      this.mediaTextures.set(key, entry);
    }
    const revision = sourceRevision(source);
    if (entry.revision !== revision) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("Cannot upload direct media texture");
      const size = shaderSourceDimensions(source);
      entry.revision = revision;
      entry.width = size.width;
      entry.height = size.height;
      entry.bytes = size.width * size.height * 4;
      this.uploads++;
    }
    return entry;
  }

  private async drawSource(operation: Extract<GpuRenderOperation, { kind: "source" }>, context: RenderContext) {
    const sampled = this.sampledElement(operation.elementId).element;
    if (operation.source === "none") return;
    if (operation.source === "native-text") {
      const texture = await this.nativeTexture(context.group.element);
      this.drawTexture(texture, context.target, fullRect(sampled));
      return;
    }
    const texture = await this.mediaTexture(context.group.element);
    if (!texture || !texture.width || !texture.height) return;
    const media = resolveMediaFrame(sampled, { width: texture.width, height: texture.height });
    if (!media) return;
    this.drawTexture(
      texture,
      context.target,
      { x: 0, y: 0, width: media.width, height: media.height },
      localMatrix(media),
      sampled.content && sampled.content.type !== "text"
        ? sampled.content.opacity
        : 1,
    );
  }

  private drawStroke(element: Element, target: RenderTarget) {
    const width = Math.min(
      element.appearance.strokeWidth,
      element.frame.width / 2,
      element.frame.height / 2,
    );
    if (width <= 0) return;
    const color = this.cssColor(element.appearance.strokeColor);
    const w = element.frame.width;
    const h = element.frame.height;
    this.drawSolid(target, { x: 0, y: 0, width: w, height: width }, color);
    this.drawSolid(target, { x: 0, y: h - width, width: w, height: width }, color);
    this.drawSolid(target, { x: 0, y: width, width, height: Math.max(0, h - 2 * width) }, color);
    this.drawSolid(target, { x: w - width, y: width, width, height: Math.max(0, h - 2 * width) }, color);
  }

  private effectProgram(definition: EffectDefinition) {
    return this.program(effectVertex, definition.source, `effect:${definition.source}`);
  }

  private effectParameterValue(element: Element, instance: ElementEffect, key: string, fallback: number) {
    const animated = this.overlay[element.id]?.[effectProperty(instance.id, key)];
    const authored = instance.parameters[key];
    return typeof animated === "number"
      ? animated
      : typeof authored === "number"
        ? authored
        : fallback;
  }

  private runEffect(
    definition: EffectDefinition,
    instance: ElementEffect,
    element: Element,
    timing: ReturnType<typeof effectTiming>,
    input: RenderTarget | null,
    output: RenderTarget,
  ) {
    if (definition.kind !== "fragment-glsl")
      throw new GpuRendererUnsupportedError(
        `Native Effect ${definition.kind} must be rasterized by Chromium before GPU composition`,
      );
    const gl = this.gl;
    const program = this.effectProgram(definition);
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
    gl.viewport(0, 0, output.width, output.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.bindProgram(program, "position");
    if (input) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(program.uniforms.get("u_input") ?? null, 0);
    }
    gl.uniform2f(program.uniforms.get("u_resolution") ?? null, output.width, output.height);
    gl.uniform2f(
      program.uniforms.get("u_size") ?? null,
      output.bounds.width,
      output.bounds.height,
    );
    const params = Object.fromEntries(
      numericEffectParameters(definition).map((parameter) => [
        parameter.key,
        consumedParameter(
          this.effectParameterValue(element, instance, parameter.key, parameter.default),
          parameter,
        ),
      ]),
    );
    const values: Record<string, number | undefined> = {
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
      ...Object.fromEntries(
        Object.entries(params).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      ),
    };
    for (const [name, value] of Object.entries(values))
      if (typeof value === "number") gl.uniform1f(program.uniforms.get(name) ?? null, value);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.shaderPublications++;
    const publishedAt = performance.now();
    this.shaderTimestamps.push(publishedAt);
    const effectMetrics = this.shaderByEffect.get(instance.id) ?? { total: 0, timestamps: [] };
    effectMetrics.total++;
    effectMetrics.timestamps.push(publishedAt);
    this.shaderByEffect.set(instance.id, effectMetrics);
  }

  private async backdropInput(context: RenderContext) {
    const full = this.pool.acquire({
      x: 0,
      y: 0,
      width: this.graph.deck.width,
      height: this.graph.deck.height,
    });
    this.clear(full);
    this.drawTexture(this.scene, full, this.scene.bounds);
    // v1 backdrop is the element-entry prefix, never this element's fill,
    // earlier Effects, or content. Rebuild unfinished ancestors inside out so
    // their clip and group opacity remain ordinary composition operations.
    let partial: SceneLayer | undefined;
    for (const layer of [...context.ancestorLayers].reverse()) {
      const target = this.pool.acquire(layer.target.bounds);
      this.clear(target);
      this.drawTexture(layer.target, target, layer.target.bounds);
      if (partial) {
        this.drawTexture(
          partial.target,
          target,
          partial.target.bounds,
          multiply(inverse(layer.world), partial.world),
          partial.opacity,
        );
        this.pool.release(partial.target);
      }
      partial = { ...layer, target };
    }
    if (partial) {
      this.drawTexture(
        partial.target,
        full,
        partial.target.bounds,
        partial.world,
        partial.opacity,
      );
      this.pool.release(partial.target);
    }
    const local = this.pool.acquire(
      fullRect(this.sampledElement(context.group.id).element),
    );
    this.clear(local);
    this.drawTexture(full, local, full.bounds, inverse(context.world), 1);
    this.pool.release(full);
    return local;
  }

  private async renderEffect(
    operation: Extract<GpuRenderOperation, { kind: "effect" }>,
    context: RenderContext,
  ) {
    const definition = operation.definition;
    if (!definition)
      throw new Error(`Missing Effect resource ${operation.effect.resourceId}`);
    if (definition.kind !== "fragment-glsl")
      throw new GpuRendererUnsupportedError(
        `Experiment does not recreate ${definition.kind} Effects in WebGL`,
      );
    const element = this.sampledElement(operation.elementId).element;
    const timing = effectTiming(
      this.graph.slide.motion,
      this.frameInput.stageIndex,
      this.frameInput.timeMs,
      element.id,
      operation.effect.id,
      this.frameInput.clocks,
      definition.timeControl,
    );
    if (!timing.started) {
      if (operation.input) await this.renderOperation(operation.input, context);
      return;
    }
    let input: RenderTarget | null = null;
    if (operation.inputKind === "content") {
      input = this.pool.acquire(fullRect(element));
      this.clear(input);
      await this.renderOperation(operation.input!, {
        ...context,
        target: input,
      });
    } else if (operation.inputKind === "backdrop") input = await this.backdropInput(context);
    else if (operation.inputKind === "native")
      throw new GpuRendererUnsupportedError("Native Effect rasterization is not implemented in the first GPU prototype");
    const output = this.pool.acquire(fullRect(element));
    this.clear(output);
    this.runEffect(definition, operation.effect, element, timing, input, output);
    this.drawTexture(output, context.target, output.bounds);
    if (input) this.pool.release(input);
    this.pool.release(output);
  }

  private async renderChildren(context: RenderContext) {
    const layers = [...context.ancestorLayers, {
      target: context.target, world: context.world,
      opacity: this.sampledElement(context.group.id).element.appearance.opacity,
    }];
    for (const childId of context.group.children) {
      const sample = this.sampledElement(childId);
      if (!sample.present) continue;
      const child = this.graph.groups.get(childId)!;
      const rendered = await this.renderGroup(child, context.world, layers);
      this.drawTexture(
        rendered,
        context.target,
        rendered.bounds,
        localMatrix(sample.element.frame),
        sample.element.appearance.opacity,
      );
      this.pool.release(rendered);
    }
  }

  private async renderOperation(operation: GpuRenderOperation, context: RenderContext): Promise<void> {
    const sampled = this.sampledElement(context.group.id).element;
    switch (operation.kind) {
      case "sequence":
        for (const item of operation.items) await this.renderOperation(item, context);
        return;
      case "source":
        await this.drawSource(operation, context);
        return;
      case "fill":
        if (sampled.geometry.type !== "rect" || sampled.appearance.radius > 0)
          throw new GpuRendererUnsupportedError("First GPU prototype supports rectangular fill geometry only");
        if (sampled.appearance.fill)
          this.drawSolid(context.target, fullRect(sampled), this.cssColor(sampled.appearance.fill));
        return;
      case "stroke":
        if (sampled.geometry.type !== "rect" || sampled.appearance.radius > 0)
          throw new GpuRendererUnsupportedError("First GPU prototype supports rectangular stroke geometry only");
        this.drawStroke(sampled, context.target);
        return;
      case "children":
        await this.renderChildren(context);
        return;
      case "clip":
        if (sampled.geometry.type !== "rect" || sampled.appearance.radius > 0)
          throw new GpuRendererUnsupportedError("First GPU prototype supports rectangular clipping only");
        // A clipping group is allocated exactly to its local frame. FBO bounds
        // therefore implement the rectangle clip without a second mask pass.
        await this.renderOperation(operation.input, context);
        return;
      case "effect":
        await this.renderEffect(operation, context);
        return;
    }
  }

  private async renderGroup(
    group: GpuRenderGroup,
    parentWorld: Matrix,
    ancestorLayers: readonly SceneLayer[],
  ) {
    const sample = this.sampledElement(group.id);
    const target = this.pool.acquire(this.groupBounds(group));
    this.clear(target);
    if (!sample.present) return target;
    const world = multiply(parentWorld, localMatrix(sample.element.frame));
    await this.renderOperation(group.visual, { group, target, world, ancestorLayers });
    return target;
  }

  private trimMetrics(now: number) {
    const cutoff = now - 2000;
    this.frameTimestamps = this.frameTimestamps.filter((time) => time >= cutoff);
    this.shaderTimestamps = this.shaderTimestamps.filter((time) => time >= cutoff);
    this.rasterTimestamps = this.rasterTimestamps.filter((time) => time >= cutoff);
    for (const metrics of this.shaderByEffect.values())
      metrics.timestamps = metrics.timestamps.filter((time) => time >= cutoff);
    if (this.frameIntervals.length > 240) this.frameIntervals.splice(0, this.frameIntervals.length - 240);
  }

  async render(input: GpuRendererFrame) {
    if (this.disposed) throw new Error("GPU renderer experiment is disposed");
    const started = performance.now();
    try {
      this.pool.beginFrame();
      this.sampleFrame(input);
      this.clear(this.scene, this.cssColor(this.graph.slide.background));
      for (const rootId of this.graph.roots) {
        const sample = this.sampledElement(rootId);
        if (!sample.present) continue;
        const target = await this.renderGroup(this.graph.groups.get(rootId)!, IDENTITY, []);
        this.drawTexture(
          target,
          this.scene,
          target.bounds,
          localMatrix(sample.element.frame),
          sample.element.appearance.opacity,
        );
        this.pool.release(target);
      }
      const gl = this.gl;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scene.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0,
        0,
        this.scene.width,
        this.scene.height,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.outputPublications++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push(message);
      this.options.onDiagnostic?.(message);
      throw error;
    } finally {
      this.pool.endFrame(this.scene);
      const now = performance.now();
      if (this.lastFrameAt) this.frameIntervals.push(now - this.lastFrameAt);
      this.lastFrameAt = now;
      this.frameTimestamps.push(now);
      this.trimMetrics(now);
      void started;
    }
  }

  private gpuInfo() {
    const extension = this.gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: extension
        ? String(this.gl.getParameter(extension.UNMASKED_VENDOR_WEBGL))
        : String(this.gl.getParameter(this.gl.VENDOR)),
      renderer: extension
        ? String(this.gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
        : String(this.gl.getParameter(this.gl.RENDERER)),
    };
  }

  diagnostics() {
    const now = performance.now();
    this.trimMetrics(now);
    const pool = this.pool.diagnostics();
    const native = [...this.nativeTextures.values()].map((entry) => entry.source.diagnostics());
    const sourceBytes =
      [...this.nativeTextures.values()].reduce((sum, entry) => sum + entry.bytes, 0) +
      [...this.mediaTextures.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const activeSourceTextures = this.nativeTextures.size + this.mediaTextures.size;
    return {
      contexts: 1,
      gpu: this.gpuInfo(),
      frames: this.frameTimestamps.length,
      renderFramesPerSecond: this.frameTimestamps.filter((time) => time >= now - 1000).length,
      shaderPublications: this.shaderPublications,
      outputPublications: this.outputPublications,
      shaderPublicationsPerSecond: this.shaderTimestamps.filter((time) => time >= now - 1000).length,
      shaderByEffect: Object.fromEntries(
        [...this.shaderByEffect].map(([id, value]) => [
          id,
          {
            total: value.total,
            perSecond: value.timestamps.filter((time) => time >= now - 1000).length,
          },
        ]),
      ),
      textRasterizationsPerSecond: this.rasterTimestamps.filter((time) => time >= now - 1000).length,
      nativeRasterizations: native.reduce((sum, value) => sum + value.rasterizations, 0),
      nativeCacheHits: native.reduce((sum, value) => sum + value.cacheHits, 0),
      nativeInvalidations: native.reduce((sum, value) => sum + value.invalidations, 0),
      liveNativeSurfaces: native.filter((value) => value.live).length,
      gpuUploads: this.uploads,
      renderTargetAllocations: pool.allocations,
      renderTargetResizes: pool.resizes,
      activeTextures: pool.liveTargets + activeSourceTextures,
      activeFbos: pool.liveTargets,
      renderTargetTextureBytes: pool.textureBytes,
      sourceTextureBytes: sourceBytes,
      logicalTextureBytes: pool.textureBytes + sourceBytes,
      frameIntervalMs: {
        p50: percentile(this.frameIntervals, 0.5),
        p95: percentile(this.frameIntervals, 0.95),
        max: this.frameIntervals.length ? Math.max(...this.frameIntervals) : 0,
      },
      testReadbacks: this.readbacks,
      errors: [...this.errors],
    };
  }

  /** Test/parity helper only. The render loop itself performs no CPU readback. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const raw = new Uint8Array(this.scene.width * this.scene.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
    gl.readPixels(0, 0, this.scene.width, this.scene.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const topDown = new Uint8Array(raw.length);
    const row = this.scene.width * 4;
    for (let y = 0; y < this.scene.height; y++)
      topDown.set(raw.subarray(y * row, (y + 1) * row), (this.scene.height - 1 - y) * row);
    this.readbacks++;
    return topDown;
  }

  /** Test/parity helper only. The render loop itself performs no CPU readback. */
  readPixel(x: number, y: number): [number, number, number, number] {
    const gl = this.gl;
    const px = new Uint8Array(4);
    const sx = Math.max(0, Math.min(this.scene.width - 1, Math.floor(x * this.pixelRatio)));
    const sy = Math.max(
      0,
      Math.min(this.scene.height - 1, this.scene.height - 1 - Math.floor(y * this.pixelRatio)),
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
    gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.readbacks++;
    return [px[0], px[1], px[2], px[3]];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.nativeTextures.values()) {
      entry.source.dispose();
      this.gl.deleteTexture(entry.texture);
    }
    for (const entry of this.mediaTextures.values()) this.gl.deleteTexture(entry.texture);
    this.nativeTextures.clear();
    this.mediaTextures.clear();
    this.pool.dispose();
    for (const program of this.programs.values()) this.gl.deleteProgram(program.value);
    this.programs.clear();
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.quadVao);
    this.colorProbe.remove();
    this.canvas.width = this.canvas.height = 1;
  }
}
