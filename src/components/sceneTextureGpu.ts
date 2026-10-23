import { backdropPrefix } from "./elementRaster";
import { createLegacySceneTextureProvider } from "./sceneTextureLegacy";
import { gpuGeneration } from "./gpuGeneration";
import {
  allocateShaderOutput,
  disposeShaderOutput,
  type ShaderOutput,
} from "./shaderOutput";
import type { Element } from "../core/element";
import type {
  SceneTexture,
  SceneTextureContext,
  SceneTextureProvider,
  SceneTextureRequest,
  SceneTextureSampling,
} from "./sceneTexture";

let enabled = true;
export function setGpuSceneTextureForTests(value: boolean) {
  enabled = value;
}
const metrics = { providers: 0, assemblies: 0, backgroundTransfers: 0 };
export function gpuSceneTextureDiagnostics() {
  return { ...metrics };
}

function translated(element: Element) {
  const f = element.frame;
  return (
    !f.rotation && f.scaleX === 1 && f.scaleY === 1 && !f.flipX && !f.flipY
  );
}

/** Intentionally narrow: one flat generated background followed by static native
 * text/shapes. Every other composition keeps the existing native capture path. */
export function createGpuSceneTextureProvider(
  request: SceneTextureRequest,
  context: SceneTextureContext,
): SceneTextureProvider | null {
  const scene = context.scene?.();
  if (
    !enabled ||
    !context.refined ||
    request.kind !== "backdrop" ||
    !scene ||
    scene.deck.stylesheet ||
    scene.slide.motion ||
    !translated(context.element)
  )
    return null;
  const prefix = backdropPrefix(scene.slide, scene.deck, request.elementId);
  const [background, ...staticElements] = prefix.elements;
  const effects = background?.effects?.filter((e) => e.enabled) ?? [];
  const definition =
    effects.length === 1 ? context.resources()[effects[0].resourceId] : null;
  if (
    !background ||
    prefix.partial.size ||
    !translated(background) ||
    background.children.length ||
    background.content ||
    background.geometry.type !== "rect" ||
    background.appearance.fill ||
    background.appearance.radius ||
    background.appearance.strokeWidth ||
    background.appearance.opacity !== 1 ||
    effects[0]?.placement !== "background" ||
    definition?.kind !== "fragment-glsl" ||
    definition.input !== "none" ||
    !staticElements.length ||
    staticElements.some(
      (e) =>
        e.children.length ||
        e.effects?.some((f) => f.enabled) ||
        (e.content && e.content.type !== "text"),
    )
  )
    return null;
  // Only top-level target frames are supported; no ancestor transforms/clipping.
  if (
    !scene.slide.nodes.some((layer) =>
      layer.children.some((e) => e.id === request.elementId),
    )
  )
    return null;
  const owner = [
    ...context.inputRoot.querySelectorAll<HTMLElement>("[data-element-id]"),
  ].find((n) => n.dataset.elementId === background.id);
  const stage =
    owner &&
    [...owner.querySelectorAll<HTMLElement>("[data-effect-id]")].find(
      (n) => n.dataset.effectId === effects[0].id,
    );
  const canvas = stage?.querySelector<HTMLCanvasElement>(":scope > canvas");
  if (!stage || !canvas || !CSS.supports("color", scene.slide.background))
    return null;
  const color = document.createElement("canvas").getContext("2d")!;
  color.fillStyle = scene.slide.background;
  color.fillRect(0, 0, 1, 1);
  const rgba = [...color.getImageData(0, 0, 1, 1).data].map((v) => v / 255);
  const staticProvider = createLegacySceneTextureProvider(
    request,
    context,
    new Set([background.id]),
    true,
  );
  let fallback: SceneTextureProvider | null = null;
  let disposed = false,
    revision = 0,
    signature = "";
  const resources = new Map<
    WebGL2RenderingContext,
    {
      generation: number;
      program: WebGLProgram;
      vao: WebGLVertexArrayObject;
      source: WebGLTexture;
      output: ShaderOutput | null;
      locations: Map<string, WebGLUniformLocation | null>;
      backgroundRevision: string;
      signature: string;
    }
  >();
  metrics.providers++;
  const current = () => {
    const next = context.scene!();
    return (
      !next.deck.stylesheet &&
      !next.slide.motion &&
      next.slide === scene.slide &&
      next.deck === scene.deck &&
      !stage.dataset.effectError &&
      stage.dataset.effectStarted === "true" &&
      !stage.closest('[data-presentation-absent="true"]')
    );
  };
  const legacy = () =>
    (fallback ??= createLegacySceneTextureProvider(request, context));
  function release() {
    for (const [gl, r] of resources) {
      if (r.output) disposeShaderOutput(r.output);
      if (r.generation === gpuGeneration(gl)) {
        gl.deleteProgram(r.program);
        gl.deleteVertexArray(r.vao);
        gl.deleteTexture(r.source);
      }
    }
    resources.clear();
  }
  function assemble(
    gl: WebGL2RenderingContext,
    sampling: SceneTextureSampling,
    overlay: SceneTexture,
    key: string,
  ) {
    let r = resources.get(gl);
    if (r && r.generation !== gpuGeneration(gl)) {
      if (r.output) disposeShaderOutput(r.output);
      resources.delete(gl);
      r = undefined;
    }
    if (!r) {
      const program = gl.createProgram()!,
        vao = gl.createVertexArray()!,
        source = gl.createTexture()!;
      const shaders: WebGLShader[] = [];
      try {
        for (const [kind, text] of [
          [
            gl.VERTEX_SHADER,
            `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
          ],
          [
            gl.FRAGMENT_SHADER,
            `#version 300 es
precision highp float;
uniform sampler2D background; uniform sampler2D overlay;
uniform vec2 outputSize; uniform vec4 target; uniform vec4 sourceRect;
uniform vec2 slideSize; uniform vec4 baseColor; out vec4 color;
void main(){vec2 uv=gl_FragCoord.xy/outputSize;vec2 world=target.xy+vec2(uv.x,1.-uv.y)*target.zw;
if(any(lessThan(world,vec2(0)))||any(greaterThanEqual(world,slideSize))){color=vec4(0);return;}
vec4 b=vec4(baseColor.rgb*baseColor.a,baseColor.a);vec2 p=(world-sourceRect.xy)/sourceRect.zw;
if(all(greaterThanEqual(p,vec2(0)))&&all(lessThan(p,vec2(1)))){vec4 s=texture(background,vec2(p.x,1.-p.y));b=s+b*(1.-s.a);}
vec4 t=texture(overlay,uv);color=t+b*(1.-t.a);}`,
          ],
        ] as const) {
          const shader = gl.createShader(kind)!;
          shaders.push(shader);
          gl.shaderSource(shader, text);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw Error(
              gl.getShaderInfoLog(shader) ??
                "SceneTexture shader compilation failed",
            );
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw Error(
            gl.getProgramInfoLog(program) ?? "SceneTexture link failed",
          );
        r = {
          generation: gpuGeneration(gl),
          program,
          vao,
          source,
          output: null,
          locations: new Map(
            [
              "background",
              "overlay",
              "outputSize",
              "target",
              "sourceRect",
              "slideSize",
              "baseColor",
            ].map((k) => [k, gl.getUniformLocation(program, k)]),
          ),
          backgroundRevision: "",
          signature: "",
        };
        resources.set(gl, r);
      } catch (error) {
        gl.deleteProgram(program);
        gl.deleteVertexArray(vao);
        gl.deleteTexture(source);
        throw error;
      } finally {
        shaders.forEach((s) => gl.deleteShader(s));
      }
    }
    if (r.signature === key) return;
    overlay.bind(gl);
    // Keep both bounded contexts: Chromium imports the presented shader bitmap;
    // no CPU pixel readback or animated DOM mirror capture is requested here.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, r.source);
    const backgroundRevision = stage!.dataset.effectRevision ?? "";
    if (r.backgroundRevision !== backgroundRevision) {
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
        canvas!,
      );
      if (gl.getError() !== gl.NO_ERROR)
        throw Error("Cannot transfer shader background");
      r.backgroundRevision = backgroundRevision;
      metrics.backgroundTransfers++;
    }
    r.output = allocateShaderOutput(
      gl,
      sampling.width,
      sampling.height,
      r.output,
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, r.source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.output.framebuffer);
    gl.viewport(0, 0, sampling.width, sampling.height);
    gl.useProgram(r.program);
    gl.bindVertexArray(r.vao);
    gl.disable(gl.BLEND);
    const u = (key: string) => r!.locations.get(key)!;
    gl.uniform1i(u("background"), 1);
    gl.uniform1i(u("overlay"), 0);
    gl.uniform2f(u("outputSize"), sampling.width, sampling.height);
    const t = context.element.frame,
      b = background.frame;
    gl.uniform4f(
      u("target"),
      t.x,
      t.y,
      sampling.logicalWidth,
      sampling.logicalHeight,
    );
    gl.uniform4f(u("sourceRect"), b.x, b.y, b.width, b.height);
    gl.uniform2f(u("slideSize"), scene!.deck.width, scene!.deck.height);
    gl.uniform4fv(u("baseColor"), rgba);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    r.signature = key;
    metrics.assemblies++;
  }
  return {
    prepare(sampling) {
      return current()
        ? staticProvider.prepare(sampling)
        : legacy().prepare(sampling);
    },
    acquire(sampling) {
      if (!current()) return legacy().acquire(sampling);
      const acquired = staticProvider.acquire(sampling);
      const result = (overlay: SceneTexture): SceneTexture => {
        const key = JSON.stringify([
          stage.dataset.effectRevision,
          overlay.revision,
          sampling,
        ]);
        if (key !== signature) {
          signature = key;
          revision++;
        }
        return {
          revision,
          prepareGpu(gl) {
            assemble(gl, sampling, overlay, key);
          },
          bind(gl) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, resources.get(gl)!.output!.texture);
          },
        };
      };
      return acquired instanceof Promise
        ? acquired.then(result)
        : result(acquired);
    },
    invalidate() {
      if (!current()) {
        staticProvider.invalidate();
        legacy().invalidate();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      staticProvider.dispose();
      fallback?.dispose();
      release();
      metrics.providers--;
    },
  };
}
