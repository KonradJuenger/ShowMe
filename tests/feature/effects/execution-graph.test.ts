import { expect, it } from "vitest";
import { EffectGraph } from "../../../src/components/effectGraph";
import { EffectSources } from "../../../src/components/effectSources";

it("replanned dependencies during capture defer the consumer until its new input is resolved", async () => {
  const graph = new EffectGraph<string>();
  let finish!: () => void;
  let ready = false,
    outputs = 0;
  graph.register(
    "old",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  graph.register("new", () => {
    ready = true;
  });
  graph.register("output", () => {
    expect(ready).toBe(true);
    outputs++;
  });
  graph.compile((key) => (key === "output" ? ["old"] : []));
  const pending = graph.resolve("output");
  await Promise.resolve();
  graph.compile((key) => (key === "output" ? ["new"] : []));
  finish();
  await pending;
  expect(outputs).toBe(0);
  expect(graph.isDirty("output")).toBe(true);
  await graph.flush("output");
  expect(outputs).toBe(1);
});

it("removed or replaced consumers never execute after an asynchronous dependency completes", async () => {
  const graph = new EffectGraph<string>();
  let finish!: () => void;
  let obsolete = 0,
    replacement = 0;
  graph.register(
    "input",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  graph.register("output", () => {
    obsolete++;
  });
  graph.compile((key) => (key === "output" ? ["input"] : []));
  const pending = graph.resolve("output");
  await Promise.resolve();
  graph.remove("output");
  graph.register("output", () => {
    replacement++;
  });
  finish();
  await pending;
  expect(obsolete).toBe(0);
  expect(replacement).toBe(0);
  await graph.resolve("output");
  expect(replacement).toBe(1);
});

it("changing dependency edges invalidates already settled consumers", async () => {
  const graph = new EffectGraph<string>();
  let outputs = 0;
  graph.register("a", () => {});
  graph.register("b", () => {});
  graph.register("output", () => {
    outputs++;
  });
  graph.compile((key) => (key === "output" ? ["a"] : []));
  await graph.resolve("output");
  graph.compile((key) => (key === "output" ? ["b"] : []));
  expect(graph.isDirty("output")).toBe(true);
  await graph.resolve("output");
  expect(outputs).toBe(2);
  graph.remove("b");
  expect(graph.isDirty("output")).toBe(true);
});

it("shared inputs execute once while independent terminals resolve without waiting", async () => {
  const graph = new EffectGraph<string>();
  let finish!: () => void;
  let calls = 0;
  graph.register("input", () => {
    calls++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  graph.register("a", () => {});
  graph.register("b", () => {});
  graph.register("independent", () => {});
  graph.compile((key) => (["a", "b"].includes(key) ? ["input"] : []));
  const a = graph.resolve("a"),
    b = graph.resolve("b");
  await graph.resolve("independent");
  expect(calls).toBe(1);
  expect(graph.isDirty("a")).toBe(true);
  finish();
  await Promise.all([a, b]);
  await graph.resolve("a");
  expect(calls).toBe(1);
});

it("invalidation during asynchronous work survives completion and propagates to consumers", async () => {
  const graph = new EffectGraph<string>();
  let finish!: () => void;
  let calls = 0;
  graph.register("input", () => {
    calls++;
    if (calls === 1)
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  graph.register("output", () => {});
  graph.compile((key) => (key === "output" ? ["input"] : []));
  const pending = graph.resolve("input");
  await Promise.resolve();
  graph.invalidate("input");
  finish();
  await pending;
  expect(graph.isDirty("input")).toBe(true);
  await graph.resolve("output");
  expect(calls).toBe(2);
  expect(graph.isDirty("output")).toBe(false);
});

it("dependency planning rejects cycles and removes disposed inputs", async () => {
  const graph = new EffectGraph<string>();
  graph.register("a", () => {});
  graph.register("b", () => {});
  expect(() => graph.compile((key) => (key === "a" ? ["b"] : ["a"]))).toThrow(
    /cycle/,
  );
  graph.remove("b");
  graph.compile(() => ["b"]);
  await graph.resolve("a");
  expect(graph.isDirty("a")).toBe(false);
});

it("interactive consumers may reuse published input during capture while an explicit flush still waits", async () => {
  const graph = new EffectGraph<string>();
  let finish!: () => void;
  let inputCalls = 0,
    outputCalls = 0;
  graph.register("input", () => {
    if (++inputCalls === 2)
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  graph.register("output", () => {
    outputCalls++;
  });
  graph.compile((key) => (key === "output" ? ["input"] : []));
  await graph.resolve("output");
  graph.invalidate("input");
  const capture = graph.resolve("input");
  await Promise.resolve();
  await graph.resolve("output", (key) => key === "input");
  expect(outputCalls).toBe(2);
  graph.invalidate("output");
  let complete = false;
  const flush = graph.flush("output").then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  finish();
  await Promise.all([capture, flush]);
  expect(complete).toBe(true);
});

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

it("one scene flush shares its dependency cohort and a subsequent flush resolves newer input", async () => {
  const graph = new EffectGraph<string>();
  let inputs = 0;
  graph.register("input", () => {
    inputs++;
  });
  graph.register("a", () => {});
  graph.register("b", () => {});
  graph.compile((key) => (key === "input" ? [] : ["input"]));
  const cohort = new Map<string, Promise<void>>();
  await graph.flush("a", cohort);
  graph.invalidate("input");
  await graph.flush("b", cohort);
  expect(inputs).toBe(1);
  await graph.flush("b");
  expect(inputs).toBe(2);
});

function textureContext() {
  const live = new Set<object>();
  const calls = { allocations: 0, uploads: 0, deletions: 0 };
  const gl = {
    createTexture() {
      calls.allocations++;
      const value = {};
      live.add(value);
      return value;
    },
    isTexture(value: object) {
      return live.has(value);
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
  return { gl, calls, lose: () => live.clear() };
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
