import { expect, it } from "vitest";
import {
  createDragSnapAxis,
  defaultDragSnapSettings,
} from "../../../src/core/dragSnapping";
import {
  createMoveGesture,
  previewMove,
} from "../../../src/core/transformInteraction";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement } from "../../../src/core/text";
import { findElement } from "../../../src/core/scene";
import {
  scopeSnapTargets,
  elementBoundsInScope,
  scopeVectorToWorld,
  selectionWorldGeometry,
} from "../../../src/core/selectionGeometry";
import type { EditorSnapshot } from "../../../src/core/editorCommands";
import { insertElements } from "../../../src/core/editorCommands";
import { editing } from "../../helpers/document";

const options = {
  enabled: true,
  toObjects: true,
  toGuides: true,
  toSlide: false,
  scale: 1,
};

function fixture(): EditorSnapshot {
  const document = newPresentationDocument("Snapping");
  const slide = document.slides[document.deck.slideIds[0]];
  const a = createTextElement("a");
  const b = createTextElement("b");
  const target = createTextElement("target");
  a.frame = { ...a.frame, x: 20, y: 20, width: 20, height: 20 };
  b.frame = { ...b.frame, x: 50, y: 50, width: 20, height: 20 };
  target.frame = { ...target.frame, x: 200, y: 200, width: 100, height: 100 };
  slide.nodes[0].children = [a, b, target];
  return { deck: document.deck, slide, templates: document.templates };
}

it("magnetic movement is continuous and monotone through attraction, exact capture and dense target switches", () => {
  const axis = createDragSnapAxis(
    0,
    { objects: [100, 112, 130] },
    1,
    defaultDragSnapSettings,
  );
  let previous = axis.resolve(85).value;
  for (let x = 85.01; x <= 145; x += 0.01) {
    const value = axis.resolve(x).value;
    expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
    expect(value - previous).toBeLessThan(0.04);
    previous = value;
  }
  expect(axis.resolve(100.5)).toEqual({
    value: 100,
    guide: 100,
    source: "objects",
  });
  expect(axis.resolve(106)).toEqual({ value: 106 });
  expect(axis.resolve(150.25)).toEqual({ value: 150.25 });
  expect(axis.resolve(94).guide).toBeUndefined();
});

it("indexed anchors preserve source priority and deterministic nearest alignment in large target sets", () => {
  const axis = createDragSnapAxis(
    20,
    {
      objects: Array.from({ length: 20000 }, (_, index) => index * 100),
      slide: [1234500],
      persistent: [1234500, 1234500],
    },
    1,
    defaultDragSnapSettings,
  );
  expect(axis.targetCount).toBe(60000);
  expect(axis.resolve(1234490.5)).toEqual({
    value: 1234490,
    guide: 1234500,
    source: "persistent",
  });
  expect(axis.resolve(1234480.5)).toEqual({
    value: 1234480,
    guide: 1234500,
    source: "persistent",
  });
});

it("magnetic and intent capture distances remain constant in screen pixels at different zoom levels", () => {
  const normal = createDragSnapAxis(
    0,
    { slide: [100] },
    1,
    defaultDragSnapSettings,
  );
  const zoomed = createDragSnapAxis(
    0,
    { slide: [200] },
    0.5,
    defaultDragSnapSettings,
  );
  expect(zoomed.resolve(186).value * 0.5).toBeCloseTo(normal.resolve(93).value);
  const settings = { ...defaultDragSnapSettings, mode: "intent" as const };
  const intent = createDragSnapAxis(0, { slide: [200] }, 0.5, settings);
  expect(intent.resolve(192).guide).toBeUndefined();
  expect(intent.resolve(195).guide).toBe(200);
});

it("intent latch ignores fast passes, holds its target against competitors and releases continuously", () => {
  const axis = createDragSnapAxis(0, { objects: [100, 105] }, 1, {
    ...defaultDragSnapSettings,
    mode: "intent",
  });
  expect(axis.resolve(99, 900)).toEqual({ value: 99 });
  expect(axis.resolve(99, 100).guide).toBe(100);
  expect(axis.resolve(105, 100)).toEqual({
    value: 100,
    guide: 100,
    source: "objects",
  });
  expect(axis.resolve(112, 900).value).toBe(100);
  expect(axis.resolve(112.001, 900).value).toBeCloseTo(100, 5);
  expect(axis.resolve(118, 900).guide).toBeUndefined();
  expect(axis.resolve(118, 900).value).toBe(109);
  expect(axis.resolve(124, 900)).toEqual({ value: 124 });
  expect(axis.resolve(125.25, 100)).toEqual({ value: 125.25 });
  axis.resolve(101, 0);
  axis.reset();
  expect(axis.resolve(105, 0).guide).toBe(105);
});

it("multi-selection snaps its aggregate bounds and keeps relative geometry without a movement grid", () => {
  const initial = fixture();
  const scope = initial.slide.nodes[0].id;
  const move = createMoveGesture(
    initial,
    ["a", "b"],
    scope,
    options,
    defaultDragSnapSettings,
    0,
  );
  const free = move({ x: 13.25, y: 7.75 }, 16);
  expect(findElement(free.snapshot.slide, "a")!.frame.x).toBe(33.25);
  expect(findElement(free.snapshot.slide, "b")!.frame.x).toBe(63.25);
  const snapped = move({ x: 129, y: 17.25 }, 1000);
  expect(snapped.scopeGuides.x).toBe(200);
  expect(findElement(snapped.snapshot.slide, "a")!.frame.x).toBe(150);
  expect(findElement(snapped.snapshot.slide, "b")!.frame.x).toBe(180);
  expect(initial.slide.nodes[0].children[0].frame.x).toBe(20);
});

it("gesture previews derive from the original snapshot, reset on bypass and commit the shown final position", () => {
  const initial = fixture();
  const scope = initial.slide.nodes[0].id;
  const move = createMoveGesture(
    initial,
    ["a"],
    scope,
    options,
    { ...defaultDragSnapSettings, mode: "intent" },
    0,
  );
  const captured = move({ x: 158, y: 0 }, 1000);
  expect(findElement(captured.snapshot.slide, "a")!.frame.x).toBe(180);
  const held = move({ x: 166, y: 0 }, 1100);
  expect(findElement(held.snapshot.slide, "a")!.frame.x).toBe(180);
  const bypass = move({ x: 166, y: 0 }, 1200, true);
  expect(findElement(bypass.snapshot.slide, "a")!.frame.x).toBe(186);
  const released = move({ x: 166, y: 0 }, 1300);
  expect(findElement(released.snapshot.slide, "a")!.frame.x).toBe(186);
  const geometry = selectionWorldGeometry(
    released.snapshot.slide,
    ["a"],
    scope,
  );
  expect(released.measurement).toMatchObject({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  });
  const disabled = createMoveGesture(
    initial,
    ["a"],
    scope,
    { ...options, enabled: false },
    defaultDragSnapSettings,
    0,
  );
  expect(
    findElement(disabled({ x: 158.5, y: 0 }, 100).snapshot.slide, "a")!.frame.x,
  ).toBe(178.5);
  const classic = previewMove(
    initial,
    ["a"],
    scope,
    { x: 13.25, y: 7.75 },
    options,
  );
  expect(findElement(classic.snapshot.slide, "a")!.frame.x).toBe(30);
});

it("transformed scopes preserve local alignments and measure attraction in screen distance", () => {
  const initial = fixture();
  const layer = initial.slide.nodes[0];
  const group = createTextElement("group");
  group.content = null;
  group.container = true;
  group.frame = {
    ...group.frame,
    rotation: 30,
    scaleX: 2,
    scaleY: 0.5,
    width: 400,
    height: 400,
  };
  group.children = layer.children;
  layer.children = [group];
  const moving = createMoveGesture(
    initial,
    ["a"],
    group.id,
    options,
    defaultDragSnapSettings,
    0,
  );
  const delta = scopeVectorToWorld(initial.slide, group.id, {
    x: 159.5,
    y: 13,
  });
  const result = moving(delta, 1000);
  expect(findElement(result.snapshot.slide, "a")!.frame.x).toBeCloseTo(180);
  expect(result.scopeGuides.x).toBeCloseTo(200);
  const actual = selectionWorldGeometry(result.snapshot.slide, ["a"], group.id);
  expect(result.measurement.x).toBeCloseTo(actual.x);
  expect(result.measurement.y).toBeCloseTo(actual.y);
  const targets = scopeSnapTargets(
    initial.slide,
    initial.deck,
    group.id,
    ["a"],
    { objects: true, guides: false, slide: false },
  );
  for (const element of group.children.filter(({ id }) => id !== "a")) {
    const bounds = elementBoundsInScope(initial.slide, element.id, group.id);
    expect(targets.x.objects!.some((x) => Math.abs(x - bounds.x) < 1e-7)).toBe(
      true,
    );
    expect(targets.y.objects!.some((y) => Math.abs(y - bounds.y) < 1e-7)).toBe(
      true,
    );
  }
});

it("intent speed gating uses elapsed time and axis screen distances instead of event counts", () => {
  const initial = fixture();
  const scope = initial.slide.nodes[0].id;
  const settings = { ...defaultDragSnapSettings, mode: "intent" as const };
  const fast = createMoveGesture(initial, ["a"], scope, options, settings, 0);
  expect(
    findElement(fast({ x: 158, y: 0 }, 16).snapshot.slide, "a")!.frame.x,
  ).toBe(178);
  expect(
    findElement(fast({ x: 159, y: 0 }, 300).snapshot.slide, "a")!.frame.x,
  ).toBe(180);
  const slow = createMoveGesture(initial, ["a"], scope, options, settings, 0);
  expect(
    findElement(slow({ x: 158, y: 0 }, 1000).snapshot.slide, "a")!.frame.x,
  ).toBe(180);
});

it("compiled sibling targets preserve rotated, mirrored and scaled bounds without including the selection", () => {
  const initial = fixture();
  const target = findElement(initial.slide, "target")!;
  target.frame = {
    ...target.frame,
    rotation: 27,
    flipX: true,
    scaleX: 1.7,
    scaleY: 0.4,
    originX: 0.2,
    originY: 0.8,
  };
  const scope = initial.slide.nodes[0].id;
  const compiled = scopeSnapTargets(
    initial.slide,
    initial.deck,
    scope,
    ["a", "b"],
    { objects: true, guides: false, slide: false },
  );
  const bounds = elementBoundsInScope(initial.slide, "target", scope);
  expect(compiled.x.objects).toEqual([
    bounds.x,
    bounds.x + bounds.width / 2,
    bounds.x + bounds.width,
  ]);
  expect(compiled.y.objects).toEqual([
    bounds.y,
    bounds.y + bounds.height / 2,
    bounds.y + bounds.height,
  ]);
});

it("refined previews commit through the existing authority with one undoable final move", async () => {
  const { session, runtime, slideId, layerId } = await editing();
  session.apply(
    insertElements(
      session.snapshot!,
      fixture().slide.nodes[0].children,
      layerId,
    ),
  );
  await session.flush();
  const before = runtime.authority.revision;
  const move = createMoveGesture(
    session.snapshot!,
    ["a", "b"],
    layerId,
    options,
    defaultDragSnapSettings,
    0,
  );
  session.apply(move({ x: 13.25, y: 7.75 }, 16).snapshot, false);
  session.apply(move({ x: 129, y: 17.25 }, 1000).snapshot, false);
  expect(runtime.authority.revision).toBe(before);
  session.commitPreview();
  await session.flush();
  expect(runtime.authority.revision).toBe(before + 1);
  expect(
    findElement(runtime.authority.document.slides[slideId], "a")!.frame.x,
  ).toBe(150);
  await session.undo();
  await session.flush();
  expect(findElement(session.snapshot!.slide, "a")!.frame.x).toBe(20);
  expect(findElement(session.snapshot!.slide, "b")!.frame.x).toBe(50);
  await session.undo(true);
  await session.flush();
  expect(findElement(session.snapshot!.slide, "a")!.frame.x).toBe(150);
  expect(findElement(session.snapshot!.slide, "b")!.frame.x).toBe(180);
});
