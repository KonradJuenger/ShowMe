import type { EffectParameterValue } from "../core/effects";
type Input = {
  text: string;
  t: number;
  p: number;
  duration: number;
  slideTime?: number;
  presentationTime?: number;
  stepTime?: number;
  stepIndex?: number;
  active?: boolean;
  parameters: Record<string, EffectParameterValue>;
};

/** User code has no DOM or Electron bridge and cannot block the renderer thread. */
export function createTextEffectRunner(source: string) {
  if (source.length > 100000)
    throw new Error("Text effect source exceeds 100,000 characters");
  const bootstrap = `
const send = self.postMessage.bind(self);
const now = performance.now.bind(performance);
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "Worker", "SharedWorker", "indexedDB", "caches"]) {
  Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false });
}
const random = seed => {
  let n = (Number(seed) | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
};
try {
  const render = (${source});
  if (typeof render !== "function") throw new Error("Text code must define function render(input)");
  self.onmessage = ({ data }) => {
    try {
      send({ started: data.id });
      const started = now();
      const text = render({ ...data.input, random });
      if (now() - started > 500) throw new Error("Text effect exceeded its execution budget");
      if (typeof text !== "string" || text.length > 100000) throw new Error("render must return a string of at most 100,000 characters");
      send({ id: data.id, text });
    } catch (error) { send({ id: data.id, error: String(error) }); }
  };
  send({ ready: true });
} catch (error) { send({ error: String(error) }); }
`;
  const url = URL.createObjectURL(
    new Blob([bootstrap], { type: "text/javascript" }),
  );
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  type Job = {
    id: number;
    input: Input;
    resolve(value: string | null): void;
    reject(error: Error): void;
  };
  let ready = false,
    closed = false,
    activeStarted = false,
    id = 0,
    active: Job | null = null,
    queued: Job | null = null;
  let failure: Error | null = null;
  let timer = setTimeout(() => fail("Text effect startup timed out"), 1500);
  function fail(message: string) {
    failure ??= new Error(message);
    closed = true;
    clearTimeout(timer);
    worker.terminate();
    active?.reject(failure);
    queued?.reject(failure);
    active = queued = null;
  }
  function pump() {
    if (!ready || active || !queued || closed) return;
    active = queued;
    activeStarted = false;
    queued = null;
    // The worker acknowledges dispatch before the code-execution watchdog starts.
    timer = setTimeout(
      () => fail("Text effect dispatch timed out"),
      1500,
    );
    worker.postMessage({ id: active.id, input: active.input });
  }
  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data.ready && !ready) {
      clearTimeout(timer);
      ready = true;
      pump();
    } else if (active && data.started === active.id && !activeStarted) {
      activeStarted = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => fail("Text effect exceeded its execution budget"),
        500,
      );
    } else if (data.error && (!active || data.id === active.id))
      fail(data.error);
    else if (active && data.id === active.id && typeof data.text === "string") {
      if (data.text.length > 100000) {
        fail("Text output exceeds 100,000 characters");
        return;
      }
      clearTimeout(timer);
      active.resolve(data.text);
      active = null;
      pump();
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message || "Text effect failed");
  };
  return {
    render(input: Input): Promise<string | null> {
      if (input.text.length > 100000)
        return Promise.reject(
          new Error("Text effect input exceeds 100,000 characters"),
        );
      if (closed)
        return Promise.reject(failure ?? new Error("Text effect is unavailable"));
      queued?.resolve(null);
      return new Promise((resolve, reject) => {
        queued = { id: ++id, input, resolve, reject };
        pump();
      });
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      worker.terminate();
      active?.resolve(null);
      queued?.resolve(null);
      active = queued = null;
    },
  };
}
