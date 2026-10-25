import { expect, it } from "vitest";
import { EffectSources } from "../../../src/components/effectSources";

it("compatible pixel leases share invalidation and release their source only after the last consumer", () => {
  const sources = new EffectSources();
  let creates = 0,
    disposals = 0,
    a = 0,
    b = 0;
  let invalidate!: () => void;
  const create = (callback: () => void) => {
    creates++;
    invalidate = callback;
    return {
      canvas: {} as HTMLCanvasElement,
      revision: 1,
      markDirty() {},
      dispose() {
        disposals++;
      },
    };
  };
  const first = sources.acquire("same-prefix", create, () => {
    a++;
  });
  const second = sources.acquire("same-prefix", create, () => {
    b++;
  });
  expect(creates).toBe(1);
  expect(first.source).toBe(second.source);
  invalidate();
  expect([a, b]).toEqual([1, 1]);
  first.release();
  first.release();
  expect(disposals).toBe(0);
  invalidate();
  expect([a, b]).toEqual([1, 2]);
  second.release();
  expect(disposals).toBe(1);
  const other = sources.acquire("different-prefix", create, () => {});
  expect(creates).toBe(2);
  other.release();
  expect(disposals).toBe(2);
});

function textureContext() {
  const live = new Set<object>();
  const calls = { allocations: 0, uploads: 0, deletions: 0 };
  const canvas = new EventTarget();
  const gl = {
    canvas,
    createTexture() {
      calls.allocations++;
      const value = {};
      live.add(value);
      return value;
    },
    isTexture() {
      throw new Error("Owned texture validity must use the context generation");
    },
    deleteTexture(value: object) {
      calls.deletions++;
      live.delete(value);
    },
    activeTexture() {},
    bindTexture() {},
    pixelStorei() {},
    texParameteri() {},
    texImage2D() {
      calls.uploads++;
    },
    getError: () => 0,
    NO_ERROR: 0,
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    lose: () => {
      live.clear();
      canvas.dispatchEvent(new Event("webglcontextlost"));
    },
  };
}

it("shared scene pixels retain one upload per context across alternating consumers and context restoration", () => {
  const sources = new EffectSources();
  const a = textureContext(),
    b = textureContext();
  let revision = 1;
  const source = {
    canvas: { width: 20, height: 10 } as HTMLCanvasElement,
    get revision() {
      return revision;
    },
    markDirty() {},
    dispose() {},
  };
  const first = sources.acquire(
    "pixels",
    () => source,
    () => {},
  );
  const second = sources.acquire(
    "pixels",
    () => source,
    () => {},
  );
  for (let frame = 0; frame < 20; frame++) {
    first.upload(a.gl);
    second.upload(b.gl);
  }
  expect(a.calls).toEqual({ allocations: 1, uploads: 1, deletions: 0 });
  expect(b.calls).toEqual({ allocations: 1, uploads: 1, deletions: 0 });
  expect(sources.textureBytes).toBe(20 * 10 * 4 * 2);
  revision++;
  first.upload(a.gl);
  second.upload(b.gl);
  expect([a.calls.uploads, b.calls.uploads]).toEqual([2, 2]);
  a.lose();
  first.upload(a.gl);
  second.upload(b.gl);
  expect([a.calls.allocations, b.calls.allocations]).toEqual([2, 1]);
  first.release();
  expect(b.calls.deletions).toBe(0);
  second.release();
  expect(sources.textureBytes).toBe(0);
  expect(b.calls.deletions).toBe(1);
});

it("retained sources replace capture machinery with pixels and drop context textures on last release", () => {
  const sources = new EffectSources(2);
  const context = textureContext();
  let captureDisposals = 0,
    pixelDisposals = 0;
  const capture = {
    canvas: { width: 10, height: 10 } as HTMLCanvasElement,
    revision: 1,
    markDirty() {},
    dispose() {
      captureDisposals++;
    },
  };
  const pixels = {
    ...capture,
    dispose() {
      pixelDisposals++;
    },
  };
  const first = sources.acquire(
    "static",
    () => capture,
    () => {},
  );
  first.replaceSource(pixels);
  expect(captureDisposals).toBe(1);
  first.upload(context.gl);
  first.release();
  expect(context.calls.deletions).toBe(1);
  expect(sources.textureBytes).toBe(0);
  const revisit = sources.acquire(
    "static",
    () => {
      throw new Error("Retained pixels must bypass capture creation");
    },
    () => {},
  );
  expect(revisit.source).toBe(pixels);
  expect(revisit.reused).toBe(true);
  revisit.release();
  expect(pixelDisposals).toBe(0);
});
