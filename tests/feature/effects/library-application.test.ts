import { expect, it, vi } from "vitest";
import { editing, insertShape } from "../../helpers/document";
import { applySelectionEffect } from "../../../src/components/editor/useSelectionActions";
import {
  blankEffect,
  changeEffectAffects,
} from "../../../src/core/effectAuthoring";
import { findElement } from "../../../src/core/scene";

const center = { x: 960, y: 540 };

it("Library effect application updates selected objects without inserting a frame and undoes as one edit", async () => {
  const { session, layerId } = await editing();
  const shape = await insertShape(session);
  await insertShape(session, "other");
  const definition = {
    ...blankEffect("css-js"),
    name: "Library Glow",
    source: ":scope { opacity: 0.7; }",
  };
  const makeId = vi.fn(() => "unexpected-frame");
  const selection = { scopeId: layerId, elementIds: [shape.id] };
  const result = applySelectionEffect(
    session.snapshot!,
    selection,
    definition,
    center,
    makeId,
  );
  expect(makeId).not.toHaveBeenCalled();
  expect(result.selection).toEqual(selection);
  session.apply(result.snapshot);
  await session.flush();
  expect(session.snapshot!.slide.nodes[0].children).toHaveLength(2);
  const instance = findElement(session.snapshot!.slide, shape.id)!.effects![0];
  expect(session.snapshot!.slide.effectResources![instance.resourceId]).toEqual(
    definition,
  );
  expect(
    findElement(session.snapshot!.slide, "other")!.effects,
  ).toBeUndefined();
  definition.source = ":scope { opacity: 0.1; }";
  expect(
    session.snapshot!.slide.effectResources![instance.resourceId].source,
  ).toContain("0.7");
  await session.undo();
  await session.flush();
  expect(
    findElement(session.snapshot!.slide, shape.id)!.effects,
  ).toBeUndefined();
  expect(session.snapshot!.slide.nodes[0].children).toHaveLength(2);
});

it("with no selection Library application inserts a selected effect frame with its schedule in one authority transaction", async () => {
  const { session, runtime, layerId } = await editing();
  const definition = {
    ...blankEffect("css-js"),
    name: "Click Glow",
    source: ":scope { opacity: var(--p); }",
    timeControl: { start: "click" as const, stop: { mode: "none" as const } },
  };
  const revision = runtime.authority.revision;
  const result = applySelectionEffect(
    session.snapshot!,
    { scopeId: layerId, elementIds: [] },
    definition,
    center,
    () => "effect-frame",
    2,
  );
  expect(result.selection).toEqual({
    scopeId: layerId,
    elementIds: ["effect-frame"],
  });
  session.apply(result.snapshot);
  await session.flush();
  expect(runtime.authority.revision).toBe(revision + 1);
  const frame = findElement(session.snapshot!.slide, "effect-frame")!;
  expect(frame).toMatchObject({
    container: true,
    clipChildren: true,
    content: null,
    frame: { x: 640, y: 360, width: 640, height: 360 },
  });
  expect(
    session.snapshot!.slide.effectResources![frame.effects![0].resourceId],
  ).toEqual(definition);
  expect(session.snapshot!.slide.motion!.stages[2].blocks![0]).toMatchObject({
    binding: {
      kind: "effect",
      elementId: frame.id,
      effectInstanceId: frame.effects![0].id,
    },
    effectSchedule: { start: "click" },
  });
  await session.undo();
  await session.flush();
  expect(findElement(session.snapshot!.slide, "effect-frame")).toBeNull();
  expect(
    Object.keys(session.snapshot!.slide.effectResources ?? {}),
  ).toHaveLength(0);
  expect(session.snapshot!.slide.motion).toBeUndefined();
  await session.undo(true);
  await session.flush();
  expect(findElement(session.snapshot!.slide, "effect-frame")).toEqual(frame);
});

it("multi-selection receives independent effect instances without altering the Library definition", async () => {
  const { session, layerId } = await editing();
  await insertShape(session, "first");
  await insertShape(session, "second");
  const definition = blankEffect("shader");
  const result = applySelectionEffect(
    session.snapshot!,
    { scopeId: layerId, elementIds: ["first", "second"] },
    definition,
    center,
  );
  session.apply(result.snapshot);
  await session.flush();
  const instances = ["first", "second"].map(
    (id) => findElement(session.snapshot!.slide, id)!.effects![0],
  );
  expect(instances[0].id).not.toBe(instances[1].id);
  for (const instance of instances)
    expect(
      session.snapshot!.slide.effectResources![instance.resourceId],
    ).toEqual(definition);
  expect(session.snapshot!.slide.nodes[0].children).toHaveLength(2);
});

it("text-only Library effects create a text frame without selection and reject incompatible selected objects", async () => {
  const { session, layerId } = await editing();
  const definition = changeEffectAffects(blankEffect("css-js"), "text", true);
  const result = applySelectionEffect(
    session.snapshot!,
    { scopeId: layerId, elementIds: [] },
    definition,
    center,
    () => "text-frame",
  );
  session.apply(result.snapshot);
  await session.flush();
  expect(findElement(session.snapshot!.slide, "text-frame")).toMatchObject({
    container: true,
    content: { type: "text" },
    effects: [expect.objectContaining({ placement: "content" })],
  });
  await insertShape(session, "image-shape");
  const snapshot = session.snapshot!;
  const textStyle = {
    ...blankEffect("css-js"),
    target: "text" as const,
    source: ":scope { color: red; }",
  };
  expect(() =>
    applySelectionEffect(
      snapshot,
      { scopeId: layerId, elementIds: ["text-frame", "image-shape"] },
      textStyle,
      center,
    ),
  ).toThrow("Text target");
  expect(session.snapshot).toBe(snapshot);
  expect(findElement(snapshot.slide, "text-frame")!.effects).toHaveLength(1);
  expect(findElement(snapshot.slide, "image-shape")!.effects).toBeUndefined();
});

it("locked or missing selected objects fail without silently creating another frame", async () => {
  const { session, layerId } = await editing();
  const shape = await insertShape(session);
  const snapshot = structuredClone(session.snapshot!);
  snapshot.deck.layers[0].locked = true;
  const makeId = vi.fn(() => "unwanted-frame");
  const definition = blankEffect("css-js");
  expect(() =>
    applySelectionEffect(
      snapshot,
      { scopeId: layerId, elementIds: [shape.id] },
      definition,
      center,
      makeId,
    ),
  ).toThrow("hidden or locked");
  expect(() =>
    applySelectionEffect(
      session.snapshot!,
      { scopeId: layerId, elementIds: ["missing"] },
      definition,
      center,
      makeId,
    ),
  ).toThrow("direct siblings");
  expect(makeId).not.toHaveBeenCalled();
});
