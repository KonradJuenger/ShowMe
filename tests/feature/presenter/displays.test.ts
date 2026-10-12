import { beforeEach, expect, it, vi } from "vitest";
import { BrowserWindow, screen, type Display } from "electron";
import { PresentationRuntime } from "../../../electron/presentationRuntime";
import { newPresentationDocument } from "../../../src/core/document";
import {
  assignPresentationView,
  resolvePresentationDisplays,
} from "../../../src/core/presentationDisplays";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    webContents = { send: vi.fn(), capturePage: async () => {} };
    destroyed = false;
    fullscreen = false;
    bounds: object;
    constructor(options: object = {}) {
      super();
      this.bounds = options;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMaximized() {
      return false;
    }
    unmaximize() {}
    maximize() {}
    setBounds(bounds: object) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
    setFullScreen(value: boolean) {
      this.fullscreen = value;
      if (value) this.emit("enter-full-screen");
    }
    setMenu() {}
    show() {}
    focus() {}
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    BrowserWindow: Window,
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: vi.fn(),
      getPrimaryDisplay: vi.fn(),
    }),
  };
});
vi.mock("../../../electron/windowing", () => ({
  windowOptions: () => ({}),
  secureWindow: () => {},
  loadWindow: async () => {},
}));

const main = {
  id: 7,
  label: "Laptop",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
} as Display;
const projector = {
  ...main,
  id: 8,
  label: "Projector",
  bounds: { x: -3840, y: 0, width: 3840, height: 2160 },
  workArea: { x: -3840, y: 0, width: 3840, height: 2120 },
  size: { width: 3840, height: 2160 },
  scaleFactor: 2,
} as Display;
const third = { ...main, id: 9, label: "Monitor" } as Display;

beforeEach(() => {
  screen.removeAllListeners();
  vi.mocked(screen.getAllDisplays).mockReturnValue([projector, main, third]);
  vi.mocked(screen.getPrimaryDisplay).mockReturnValue(main);
});

it("defaults to the primary screen and first external regardless of editor location or enumeration order", () => {
  expect(
    resolvePresentationDisplays([projector, main, third], main.id),
  ).toEqual({ presenterDisplayId: 7, audienceDisplayId: 8 });
  expect(resolvePresentationDisplays([main], main.id)).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 7,
  });
});

it("dragging either view onto its occupied screen swaps while a third screen leaves the other view alone", () => {
  const initial = { presenterDisplayId: 7, audienceDisplayId: 8 };
  expect(assignPresentationView(initial, "presenter", 8)).toEqual({
    presenterDisplayId: 8,
    audienceDisplayId: 7,
  });
  expect(assignPresentationView(initial, "audience", 7)).toEqual({
    presenterDisplayId: 8,
    audienceDisplayId: 7,
  });
  expect(assignPresentationView(initial, "audience", 9)).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 9,
  });
  expect(assignPresentationView(initial, "presenter", 7)).toEqual(initial);
});

it("native configuration publishes geometry, rejects unavailable or shared screens and refreshes preparation before starting", () => {
  const changed = vi.fn();
  const runtime = new PresentationRuntime(
    async () => newPresentationDocument("Screens").deck,
    undefined,
    changed,
  );
  const editor = new BrowserWindow();
  runtime.setEditor(editor);
  runtime.setPresentationDisplays({
    presenterDisplayId: 8,
    audienceDisplayId: 7,
  });
  expect(runtime.displays().find((display) => display.id === 8)).toMatchObject({
    presenter: true,
    audience: false,
    bounds: projector.bounds,
    scaleFactor: 2,
  });
  expect(editor.webContents.send).toHaveBeenCalledWith(
    "presentation-displays",
    runtime.displays(),
  );
  expect(changed).toHaveBeenCalledOnce();
  expect(() =>
    runtime.setPresentationDisplays({
      presenterDisplayId: 7,
      audienceDisplayId: 123,
    }),
  ).toThrow();
  expect(() =>
    runtime.setPresentationDisplays({
      presenterDisplayId: 7,
      audienceDisplayId: 7,
    }),
  ).toThrow();
  runtime.setPresentationDisplays(null);
  expect(runtime.assignment).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 8,
  });
});

it("presentation opens on configured screens and locks assignments during loading and playback until End", async () => {
  const { deck } = newPresentationDocument("Screens");
  let load: ((value: typeof deck) => void) | undefined;
  const runtime = new PresentationRuntime(
    () =>
      new Promise((resolve) => {
        load = resolve;
      }),
  );
  runtime.setEditor(new BrowserWindow());
  runtime.setPresentationDisplays({
    presenterDisplayId: 8,
    audienceDisplayId: 7,
  });
  const started = runtime.present({
    deckId: deck.id,
    slideIds: deck.slideIds,
    index: 0,
  });
  expect(() => runtime.setPresentationDisplays(null)).toThrow(
    "End the presentation",
  );
  load!(deck);
  await started;
  expect(runtime.state).toMatchObject({
    presenterDisplayId: 8,
    audienceDisplayId: 7,
  });
  expect(runtime.audienceWindow?.getBounds()).toMatchObject(main.bounds);
  expect(runtime.presenterConsoleWindow?.getBounds()).toMatchObject({
    x: projector.workArea.x,
    y: projector.workArea.y,
  });
  expect(() =>
    runtime.setPresentationDisplays({
      presenterDisplayId: 7,
      audienceDisplayId: 8,
    }),
  ).toThrow("End the presentation");
  runtime.end();
  runtime.setPresentationDisplays(null);
  expect(runtime.assignment).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 8,
  });
});

it("unplugging an assigned display ends playback and restores valid defaults", async () => {
  const { deck } = newPresentationDocument("Screens");
  const runtime = new PresentationRuntime(async () => deck);
  runtime.setEditor(new BrowserWindow());
  await runtime.present({ deckId: deck.id, slideIds: deck.slideIds, index: 0 });
  vi.mocked(screen.getAllDisplays).mockReturnValue([main]);
  screen.emit("display-removed", {}, projector);
  expect(runtime.state).toBeNull();
  expect(runtime.assignment).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 7,
  });
});

it("attaching an external screen during single-screen playback keeps both views and preparation on the original screen", async () => {
  vi.mocked(screen.getAllDisplays).mockReturnValue([main]);
  const { deck } = newPresentationDocument("Screens");
  const runtime = new PresentationRuntime(async () => deck);
  runtime.setEditor(new BrowserWindow());
  await runtime.present({ deckId: deck.id, slideIds: deck.slideIds, index: 0 });
  vi.mocked(screen.getAllDisplays).mockReturnValue([main, projector]);
  screen.emit("display-added", {}, projector);
  expect(runtime.assignment).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 7,
  });
  expect(runtime.displays().find((display) => display.id === 7)).toMatchObject({
    audience: true,
    presenter: true,
  });
  expect(runtime.displays().find((display) => display.id === 8)).toMatchObject({
    audience: false,
    presenter: false,
  });
  runtime.end();
  expect(runtime.assignment).toEqual({
    presenterDisplayId: 7,
    audienceDisplayId: 8,
  });
});

it("notes and content refresh avoid metadata loads while motion refresh selects affected slides", async () => {
  const { deck } = newPresentationDocument("Refresh");
  const loadDeck = vi.fn(async () => deck),
    loadMotion = vi.fn(
      async (_id: string, _deck: typeof deck, _ids?: string[]) => ({
        [deck.slideIds[0]]: [],
      }),
    );
  const runtime = new PresentationRuntime(loadDeck, loadMotion);
  runtime.setEditor(new BrowserWindow());
  await runtime.present({ deckId: deck.id, slideIds: deck.slideIds, index: 0 });
  loadDeck.mockClear();
  loadMotion.mockClear();
  const revision = runtime.state!.contentRevision ?? 0;
  await runtime.refresh(deck.id, {
    presentation: "none",
    slides: [deck.slideIds[0]],
  });
  expect(runtime.state!.contentRevision ?? 0).toBe(revision);
  await runtime.refresh(deck.id, {
    presentation: "content",
    slides: [deck.slideIds[0]],
  });
  expect(loadDeck).not.toHaveBeenCalled();
  expect(loadMotion).not.toHaveBeenCalled();
  await runtime.refresh(deck.id, {
    presentation: "motion",
    slides: [deck.slideIds[0]],
  });
  expect(loadDeck).not.toHaveBeenCalled();
  expect(loadMotion).toHaveBeenCalledWith(deck.id, deck, [deck.slideIds[0]]);
  await runtime.refresh(deck.id);
  expect(loadDeck).toHaveBeenCalledTimes(1);
  runtime.end();
});
