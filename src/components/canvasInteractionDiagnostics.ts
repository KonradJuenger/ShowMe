/** Opt-in, renderer-local evidence for intermittent canvas interaction failures. */
const recordingKey = "showme.canvas-interaction-recording";
// Keep recent evidence across canvas remounts. Only the opt-in flag survives a
// window reload; document evidence remains in renderer memory.
const entries: unknown[] = [];
let recordingEnabled = false;

function readRecordingPreference() {
  try {
    return sessionStorage.getItem(recordingKey) === "1";
  } catch {
    return recordingEnabled;
  }
}

function setRecordingPreference(enabled: boolean) {
  recordingEnabled = enabled;
  try {
    if (enabled) sessionStorage.setItem(recordingKey, "1");
    else sessionStorage.removeItem(recordingKey);
  } catch {
    // Recording still works in memory if browser storage is unavailable.
  }
}

export function installCanvasInteractionDiagnostics(
  getStage: () => HTMLElement | null,
  readState: () => unknown,
) {
  let enabled = readRecordingPreference();
  let lastMove = 0;
  let disposed = false;
  let lastPoint: { x: number; y: number } | null = null;
  const pointers = new Set<number>();
  const describe = (node: Element) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      tag: node.tagName,
      elementId:
        node.closest<HTMLElement>("[data-element-id]")?.dataset.elementId,
      effectId: node.closest<HTMLElement>("[data-effect-id]")?.dataset.effectId,
      selectionOverlay: !!node.closest("[data-selection-overlay]"),
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      display: style.display,
      transform: style.transform,
      inert: !!node.closest("[inert]"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const snapshot = () => {
    const stage = getStage();
    return {
      state: readState(),
      stageConnected: !!stage?.isConnected,
      hitStack: lastPoint
        ? document
            .elementsFromPoint(lastPoint.x, lastPoint.y)
            .slice(0, 12)
            .map(describe)
        : [],
      elements: stage
        ? Array.from(
            stage.querySelectorAll<HTMLElement>("[data-element-id]"),
          ).map((node) => ({
            ...describe(node),
            inlineStyle: node.getAttribute("style"),
            capturedPointers: [...pointers].filter((id) =>
              node.hasPointerCapture(id),
            ),
            effects: Array.from(
              node.querySelectorAll<HTMLElement>("[data-effect-id]"),
            )
              .filter((effect) => effect.closest("[data-element-id]") === node)
              .map((effect) => ({
                id: effect.dataset.effectId,
                ready: effect.dataset.effectReady,
              })),
          }))
        : [],
      stageCapturedPointers: stage
        ? [...pointers].filter((id) => stage.hasPointerCapture(id))
        : [],
    };
  };
  const record = (type: string, details: unknown = null) => {
    if (!enabled || disposed) return;
    entries.push({ time: performance.now(), type, details, ...snapshot() });
    if (entries.length > 200) entries.shift();
  };
  const pointer = (event: Event) => {
    if (!enabled || !(event instanceof PointerEvent)) return;
    const stage = getStage();
    if (
      !pointers.has(event.pointerId) &&
      !(event.target instanceof Node && stage?.contains(event.target))
    )
      return;
    if (event.type === "pointermove") {
      if (performance.now() - lastMove < 150) return;
      lastMove = performance.now();
    }
    pointers.add(event.pointerId);
    lastPoint = { x: event.clientX, y: event.clientY };
    const details = {
      pointerId: event.pointerId,
      buttons: event.buttons,
      x: event.clientX,
      y: event.clientY,
      target: event.target instanceof Element ? describe(event.target) : null,
    };
    record(event.type, details);
    if (event.type !== "pointermove") {
      // Observe React handlers and async gesture completion after dispatch too.
      setTimeout(() => record(`${event.type}:after`, details), 0);
    }
    if (
      event.type === "pointerup" ||
      event.type === "pointercancel" ||
      event.type === "lostpointercapture"
    )
      pointers.delete(event.pointerId);
  };
  const error = (event: ErrorEvent) =>
    record("error", {
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  const rejection = (event: PromiseRejectionEvent) =>
    record("unhandledrejection", {
      message: String(event.reason),
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
    });
  const blur = () => record("window:blur");
  const api = {
    enable() {
      enabled = true;
      setRecordingPreference(true);
      record("enabled");
      return "Canvas interaction recording enabled";
    },
    disable() {
      enabled = false;
      setRecordingPreference(false);
      return "Canvas interaction recording disabled";
    },
    clear() {
      entries.length = 0;
    },
    report() {
      return {
        version: 1,
        capturedAt: new Date().toISOString(),
        enabled,
        current: snapshot(),
        entries: [...entries],
      };
    },
  };
  const host = window as Window & { __showmeInteractions?: typeof api };
  host.__showmeInteractions = api;
  const events = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
  ];
  for (const name of events) document.addEventListener(name, pointer, true);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  window.addEventListener("blur", blur);
  record("recorder:mounted");
  return () => {
    disposed = true;
    for (const name of events)
      document.removeEventListener(name, pointer, true);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    window.removeEventListener("blur", blur);
    if (host.__showmeInteractions === api) delete host.__showmeInteractions;
  };
}
