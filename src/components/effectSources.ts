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
  width: number;
  height: number;
};
/** One lease owns both the captured pixels and their GPU upload. Compatible
 * consumers share them; the final release frees every representation. */
export class EffectSources<Source extends PixelSource> {
  private entries = new Map<
    string,
    {
      source: Source;
      texture: Texture | null;
      users: Set<() => void>;
      lastUsed: number;
    }
  >();
  constructor(private readonly maxIdleEntries = 0) {}

  private disposeEntry(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.source.dispose();
    if (entry.texture) entry.texture.gl.deleteTexture(entry.texture.value);
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
        texture: null,
        users,
        lastUsed: performance.now(),
      };
      this.entries.set(key, entry);
    }
    entry.users.add(invalidate);
    entry.lastUsed = performance.now();
    this.trimIdle();
    const owned = entry;
    let released = false;
    return {
      source: owned.source,
      reused,
      upload(gl: WebGL2RenderingContext) {
        if (
          !owned.texture ||
          owned.texture.gl !== gl ||
          !gl.isTexture(owned.texture.value)
        ) {
          if (owned.texture?.gl.isTexture(owned.texture.value))
            owned.texture.gl.deleteTexture(owned.texture.value);
          const value = gl.createTexture();
          if (!value) throw new Error("Cannot allocate shader input texture");
          owned.texture = { gl, value, revision: -1, width: 0, height: 0 };
        }
        const texture = owned.texture,
          canvas = owned.source.canvas;
        gl.activeTexture(gl.TEXTURE0);
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
        }
      },
      release: () => {
        if (released) return;
        released = true;
        owned.users.delete(invalidate);
        owned.lastUsed = performance.now();
        if (!owned.users.size && !this.maxIdleEntries) this.disposeEntry(key);
        else this.trimIdle();
      },
    };
  }
  get textureBytes() {
    return [...this.entries.values()].reduce(
      (sum, entry) =>
        sum +
        (entry.texture ? entry.texture.width * entry.texture.height * 4 : 0),
      0,
    );
  }
}
