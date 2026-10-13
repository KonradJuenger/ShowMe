import { expect, it } from "vitest";
import {
  createDragSnapAxis,
  defaultDragSnapSettings,
} from "../../../src/core/dragSnapping";
import { createMoveGesture } from "../../../src/core/transformInteraction";
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

it("capture distances remain constant in screen pixels at different zoom levels", () => {
  const target = [
    { position: 200, source: "slide" as const, kind: "end" as const },
  ];
  const axis = createDragSnapAxis(0, target, 0.5, defaultDragSnapSettings);
  expect(axis.resolve(188).guide).toBeUndefined();
  expect(axis.resolve(191).guide).toBe(200);
});

it("intent latch ignores fast passes, holds its target against competitors and releases continuously", () => {
  const axis = createDragSnapAxis(
    0,
    [100, 105].map((position) => ({
      position,
      source: "objects" as const,
      kind: "start" as const,
    })),
    1,
    {
      ...defaultDragSnapSettings,
    },
  );
  expect(axis.resolve(99, 900)).toEqual({ value: 99 });
  expect(axis.resolve(99, 100).guide).toBe(100);
  expect(axis.resolve(105, 100)).toEqual({
    value: 100,
    guide: 100,
    source: "objects",
  });
  expect(axis.resolve(108, 900).value).toBe(100);
  expect(axis.resolve(108.001, 900).value).toBeCloseTo(100, 5);
  expect(axis.resolve(112, 900).guide).toBeUndefined();
  expect(axis.resolve(112, 900).value).toBe(106);
  expect(axis.resolve(116, 900)).toEqual({ value: 116 });
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
  const snapped = move({ x: 129, y: 180 }, 1000);
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
    { ...defaultDragSnapSettings },
    0,
  );
  const captured = move({ x: 158, y: 180 }, 1000);
  expect(findElement(captured.snapshot.slide, "a")!.frame.x).toBe(180);
  const held = move({ x: 166.5, y: 180 }, 1100);
  expect(findElement(held.snapshot.slide, "a")!.frame.x).toBe(180);
  const bypass = move({ x: 166.5, y: 180 }, 1200, true);
  expect(findElement(bypass.snapshot.slide, "a")!.frame.x).toBe(186.5);
  const released = move({ x: 166.5, y: 180 }, 1300);
  expect(findElement(released.snapshot.slide, "a")!.frame.x).toBe(186.5);
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
    y: 180,
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
  const settings = { ...defaultDragSnapSettings };
  const fast = createMoveGesture(initial, ["a"], scope, options, settings, 0);
  expect(
    findElement(fast({ x: 158, y: 180 }, 16).snapshot.slide, "a")!.frame.x,
  ).toBe(178);
  expect(
    findElement(fast({ x: 159, y: 180 }, 300).snapshot.slide, "a")!.frame.x,
  ).toBe(180);
  const slow = createMoveGesture(initial, ["a"], scope, options, settings, 0);
  expect(
    findElement(slow({ x: 158, y: 180 }, 1000).snapshot.slide, "a")!.frame.x,
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
  session.apply(move({ x: 129, y: 180 }, 1000).snapshot, false);
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

it("intent uses matching canvas boundaries and object centers instead of unrelated cross-anchor midpoints", () => {
  const settings = { ...defaultDragSnapSettings };
  const canvas = createDragSnapAxis(
    400,
    [
      { position: 0, source: "slide", kind: "start" },
      { position: 540, source: "slide", kind: "center" },
      { position: 1080, source: "slide", kind: "end" },
    ],
    1,
    settings,
  );
  expect(canvas.resolve(540).guide).toBeUndefined();
  canvas.reset();
  expect(canvas.resolve(-200).guide).toBeUndefined();
  canvas.reset();
  expect(canvas.resolve(683)).toEqual({
    value: 680,
    guide: 1080,
    source: "slide",
  });
  const center = createDragSnapAxis(
    100,
    [
      {
        position: 250,
        source: "objects",
        kind: "center",
        span: { start: 0, end: 100 },
      },
    ],
    1,
    settings,
  );
  const context = { start: 0, end: 100, pixelsPerUnit: 1 };
  expect(center.resolve(249, 100, context)).toEqual({ value: 249 });
  center.reset();
  expect(center.resolve(201, 100, context).guide).toBe(250);
});

it("intent rejects distant objects and prunes dense equal-coordinate clutter by perpendicular proximity", () => {
  const axis = createDragSnapAxis(
    100,
    Array.from({ length: 20000 }, (_, index) => ({
      position: 1000,
      source: "objects" as const,
      kind: "start" as const,
      span: { start: index * 100, end: index * 100 + 30 },
    })),
    1,
    { ...defaultDragSnapSettings },
  );
  const far = { start: -1000, end: -900, pixelsPerUnit: 1 };
  expect(axis.resolve(999, 100, far)).toEqual({ value: 999 });
  const near = { start: 1234500, end: 1234530, pixelsPerUnit: 1 };
  expect(axis.resolve(999, 100, near).guide).toBe(1000);
  // A remote object latch fades out if movement along the line leaves its span.
  expect(axis.resolve(999, 100, far)).toEqual({ value: 999 });
});

it("a stronger canvas edge replaces a weaker object latch while equal-priority objects stay stable", () => {
  const settings = { ...defaultDragSnapSettings };
  const axis = createDragSnapAxis(
    400,
    [
      {
        position: 1090,
        source: "objects",
        kind: "start",
        span: { start: 0, end: 500 },
      },
      { position: 1080, source: "slide", kind: "end" },
    ],
    1,
    settings,
  );
  const context = { start: 0, end: 500, pixelsPerUnit: 1 };
  expect(axis.resolve(692, 100, context)).toEqual({
    value: 690,
    guide: 1090,
    source: "objects",
  });
  expect(axis.resolve(684, 100, context)).toEqual({
    value: 680,
    guide: 1080,
    source: "slide",
  });
  expect(axis.resolve(686, 100, context).guide).toBe(1080);
});

it("deliberate sampled crossings capture an alignment while fast crossings remain free", () => {
  const settings = { ...defaultDragSnapSettings };
  const axis = createDragSnapAxis(
    400,
    [{ position: 1080, source: "slide", kind: "end" }],
    1,
    settings,
  );
  expect(axis.resolve(672, 300)).toEqual({ value: 672 });
  expect(axis.resolve(688, 300)).toEqual({
    value: 680,
    guide: 1080,
    source: "slide",
  });
  axis.reset();
  expect(axis.resolve(672, 900)).toEqual({ value: 672 });
  expect(axis.resolve(688, 900)).toEqual({ value: 688 });
});

it("a left-edge latch permits bottom-edge capture despite distant screenshot-like object clutter", () => {
  const initial = fixture();
  const a = findElement(initial.slide, "a")!;
  const target = findElement(initial.slide, "target")!;
  a.frame = { ...a.frame, x: 100, y: 600, width: 550, height: 400 };
  target.frame = { ...target.frame, x: 1440, y: 300, width: 480, height: 600 };
  initial.slide.nodes[0].children = [a, target];
  const scope = initial.slide.nodes[0].id;
  const snapOptions = { ...options, toSlide: true, scale: 0.57 };
  const settings = { ...defaultDragSnapSettings };
  const move = createMoveGesture(
    initial,
    ["a"],
    scope,
    snapOptions,
    settings,
    0,
  );
  const left = move({ x: -99, y: 101 }, 1000);
  expect(left.scopeGuides.x).toBe(0);
  expect(left.scopeGuides.y).toBeUndefined();
  expect(findElement(left.snapshot.slide, "a")!.frame.y).toBe(701);
  const corner = move({ x: -99, y: 83 }, 1100);
  expect(corner.scopeGuides).toEqual({ x: 0, y: 1080 });
  expect(findElement(corner.snapshot.slide, "a")!.frame).toMatchObject({
    x: 0,
    y: 680,
  });

  const reverse = createMoveGesture(
    initial,
    ["a"],
    scope,
    snapOptions,
    settings,
    0,
  );
  expect(reverse({ x: 0, y: 83 }, 1000).scopeGuides.y).toBe(1080);
  const bottomThenLeft = reverse({ x: -99, y: 83 }, 1100);
  expect(bottomThenLeft.scopeGuides).toEqual({ x: 0, y: 1080 });
});

it("axis capture uses its own speed while the perpendicular axis moves quickly", () => {
  const initial = fixture();
  initial.slide.nodes[0].children = [findElement(initial.slide, "a")!];
  const scope = initial.slide.nodes[0].id;
  const move = createMoveGesture(
    initial,
    ["a"],
    scope,
    { ...options, toSlide: true },
    { ...defaultDragSnapSettings },
    0,
  );
  move({ x: 800, y: -10 }, 1000);
  const result = move({ x: 900, y: -17 }, 1020);
  expect(result.scopeGuides.y).toBe(0);
  expect(findElement(result.snapshot.slide, "a")!.frame.y).toBe(0);
  expect(findElement(result.snapshot.slide, "a")!.frame.x).toBe(920);
});

it("zero holding distance captures once then releases without recapturing until a fresh approach", () => {
  const axis = createDragSnapAxis(
    100,
    [{ position: 200, source: "slide", kind: "end" }],
    1,
    { ...defaultDragSnapSettings, intentRelease: 0 },
  );
  expect(axis.resolve(103, 100)).toEqual({
    value: 100,
    guide: 200,
    source: "slide",
  });
  expect(axis.resolve(103, 0).guide).toBe(200);
  expect(axis.resolve(103.25, 100)).toEqual({ value: 103.25 });
  expect(axis.resolve(104, 100)).toEqual({ value: 104 });
  expect(axis.resolve(107, 100)).toEqual({ value: 107 });
  expect(axis.resolve(103, 100).guide).toBe(200);
});

it("holding distance can be smaller than capture distance and zero hold keeps stationary axes independent", () => {
  const axis = createDragSnapAxis(
    100,
    [{ position: 200, source: "slide", kind: "end" }],
    1,
    { ...defaultDragSnapSettings, intentRelease: 1 },
  );
  expect(axis.resolve(105, 100).guide).toBe(200);
  expect(axis.resolve(106, 100)).toEqual({ value: 106 });
  const initial = fixture();
  const a = findElement(initial.slide, "a")!;
  a.frame = { ...a.frame, x: 100, y: 600, width: 550, height: 400 };
  initial.slide.nodes[0].children = [a];
  const move = createMoveGesture(
    initial,
    ["a"],
    initial.slide.nodes[0].id,
    { ...options, toSlide: true },
    { ...defaultDragSnapSettings, intentRelease: 0 },
    0,
  );
  expect(move({ x: -99, y: 80 }, 1000).scopeGuides).toEqual({ x: 0, y: 1080 });
  const movingAlongLeft = move({ x: -99, y: 85 }, 1100);
  expect(movingAlongLeft.scopeGuides.x).toBe(0);
  expect(movingAlongLeft.scopeGuides.y).toBeUndefined();
  expect(findElement(movingAlongLeft.snapshot.slide, "a")!.frame).toMatchObject(
    { x: 0, y: 685 },
  );
});
