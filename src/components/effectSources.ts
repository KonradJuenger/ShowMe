import { gpuGeneration } from "./gpuGeneration";
export interface PixelSource {
  canvas: HTMLCanvasElement;
  readonly revision: number;
  markDirty(): void;
  dispose(): void;
}
type Texture = {
  gl: WebGL2RenderingContext;
  value: WebGLTexture;
  revision: number;
  generation: number;
  width: number;
  height: number;
  users: Set<symbol>;
};
const metrics = { allocations: 0, uploads: 0, liveTextures: 0 };
export function effectSourcesDiagnostics() {
  return { ...metrics };
}
/** One lease owns both the captured pixels and their GPU upload. Compatible
 * consumers share them; the final release frees every representation. */
export class EffectSources<Source extends PixelSource> {
  private entries = new Map<
    string,
    {
      source: Source;
      textures: Map<WebGL2RenderingContext, Texture>;
      users: Set<() => void>;
      lastUsed: number;
      retired: boolean;
    }
  >();
  constructor(private readonly maxIdleEntries = 0) {}

  private disposeEntry(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.source.dispose();
    for (const texture of entry.textures.values()) {
      if (texture.generation === gpuGeneration(texture.gl))
        texture.gl.deleteTexture(texture.value);
      metrics.liveTextures--;
    }
    entry.textures.clear();
    this.entries.delete(key);
  }

  private trimIdle() {
    if (!this.maxIdleEntries) return;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => !entry.users.size)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (idle.length > this.maxIdleEntries)
      this.disposeEntry(idle.shift()![0]);
  }
  acquire(
    key: string,
    create: (invalidate: () => void) => Source,
    invalidate: () => void,
  ) {
    let entry = this.entries.get(key);
    const reused = !!entry;
    if (!entry) {
      const users = new Set<() => void>();
      entry = {
        source: create(() => users.forEach((user) => user())),
        textures: new Map(),
        users,
        lastUsed: performance.now(),
        retired: false,
      };
      this.entries.set(key, entry);
    }
    entry.users.add(invalidate);
    entry.lastUsed = performance.now();
    this.trimIdle();
    const owned = entry;
    const token = Symbol();
    const contexts = new Set<WebGL2RenderingContext>();
    let released = false;
    return {
      get source() {
        return owned.source;
      },
      reused,
      isCurrent: () => !owned.retired,
      replaceSource(next: Source) {
        const previous = owned.source;
        owned.source = next;
        previous.dispose();
      },
      invalidate: () => {
        if (owned.retired) return;
        owned.retired = true;
        if (this.entries.get(key) === owned) this.entries.delete(key);
        [...owned.users].forEach((user) => user());
      },
      upload(gl: WebGL2RenderingContext, unit = 0) {
        if (released) throw new Error("Shader input lease was released");
        let texture = owned.textures.get(gl);
        if (!texture || texture.generation !== gpuGeneration(gl)) {
          const value = gl.createTexture();
          if (!value) throw new Error("Cannot allocate shader input texture");
          texture = {
            gl,
            value,
            revision: -1,
            generation: gpuGeneration(gl),
            width: 0,
            height: 0,
            users: texture?.users ?? new Set(),
          };
          if (!owned.textures.has(gl)) metrics.liveTextures++;
          owned.textures.set(gl, texture);
          metrics.allocations++;
        }
        texture.users.add(token);
        contexts.add(gl);
        const canvas = owned.source.canvas;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture.value);
        const uploaded = texture.revision !== owned.source.revision;
        if (uploaded) {
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
            canvas,
          );
          if (gl.getError() !== gl.NO_ERROR)
            throw new Error(
              `Cannot upload ${canvas.width} × ${canvas.height} shader input`,
            );
          texture.revision = owned.source.revision;
          texture.width = canvas.width;
          texture.height = canvas.height;
          metrics.uploads++;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        for (const gl of contexts) {
          const texture = owned.textures.get(gl);
          if (!texture) continue;
          texture.users.delete(token);
          if (!texture.users.size) {
            if (texture.generation === gpuGeneration(gl))
              gl.deleteTexture(texture.value);
            owned.textures.delete(gl);
            metrics.liveTextures--;
          }
        }
        contexts.clear();
        owned.users.delete(invalidate);
        owned.lastUsed = performance.now();
        if (!owned.users.size && owned.retired) owned.source.dispose();
        else if (!owned.users.size && !this.maxIdleEntries)
          this.disposeEntry(key);
        else this.trimIdle();
      },
    };
  }
  get textureBytes() {
    return [...this.entries.values()].reduce(
      (sum, entry) =>
        sum +
        [...entry.textures.values()].reduce(
          (bytes, texture) => bytes + texture.width * texture.height * 4,
          0,
        ),
      0,
    );
  }
  get pixelBytes() {
    return [...this.entries.values()].reduce(
      (bytes, entry) =>
        bytes + entry.source.canvas.width * entry.source.canvas.height * 4,
      0,
    );
  }
}
