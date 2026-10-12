import { expect, it } from "vitest";
import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../src/core/document";
import { parseRuntimeDocument } from "../../src/core/documentRuntime";
import {
  createEmptyFrame,
  createBasicShape,
} from "../../src/core/elementFactory";
import {
  insertElements,
  translateElements,
  removeElements,
  reparentElements,
  createSlide,
  reorderSlides,
  deleteSlide,
} from "../../src/core/editorCommands";
import { findElement, getParentId, getWorldMatrix } from "../../src/core/scene";
import { resolveSlide } from "../../src/core/templates";
import { getPresentationSlideIds } from "../../src/core/presentationSequence";
import { editing, insertShape } from "../helpers/document";

it("creates a valid canonical document with an editable slide", () => {
  const document = newPresentationDocument("New deck");
  expect(document.version).toBe(1);
  expect(document.deck.version).toBe(1);
  expect(
    Object.values(document.slides).every((slide) => slide.version === 1),
  ).toBe(true);
  expect(
    Object.values(document.templates).every(
      (template) => template.version === 1,
    ),
  ).toBe(true);
  expect(presentationDocumentSchema.parse(document)).toEqual(document);
  expect(() =>
    parseRuntimeDocument(JSON.stringify({ ...document, version: 2 })),
  ).toThrow("Unsupported");
  expect(document.documentId).toBe(document.deck.id);
  expect(document.slides[document.deck.slideIds[0]].nodes[0].id).toBe(
    document.deck.layers[0].id,
  );
});

it("accepts an editor insertion through the document authority", async () => {
  const { session, runtime, slideId } = await editing();
  const shape = await insertShape(session);
  expect(
    findElement(runtime.authority.document.slides[slideId], shape.id),
  ).toEqual(shape);
  expect(session.revision).toBe(1);
});

it("commits transform changes as canonical element state", async () => {
  const { session, runtime, slideId } = await editing();
  const shape = await insertShape(session);
  session.apply(translateElements(session.snapshot!, [shape.id], 30, -15));
  await session.flush();
  expect(
    findElement(runtime.authority.document.slides[slideId], shape.id)!.frame,
  ).toMatchObject({ x: shape.frame.x + 30, y: shape.frame.y - 15 });
});

it("undo restores the prior accepted document state", async () => {
  const { session, runtime, slideId } = await editing();
  await insertShape(session);
  await session.undo();
  await session.flush();
  expect(
    findElement(runtime.authority.document.slides[slideId], "shape"),
  ).toBeNull();
  expect(session.canRedo).toBe(true);
});

it("redo reapplies the undone semantic edit", async () => {
  const { session, runtime, slideId } = await editing();
  const shape = await insertShape(session);
  await session.undo();
  await session.flush();
  await session.undo(true);
  await session.flush();
  expect(
    findElement(runtime.authority.document.slides[slideId], shape.id),
  ).toEqual(shape);
});

it("deletes an element through an editor operation", async () => {
  const { session, runtime, slideId } = await editing();
  await insertShape(session);
  session.apply(removeElements(session.snapshot!, ["shape"]));
  await session.flush();
  expect(
    findElement(runtime.authority.document.slides[slideId], "shape"),
  ).toBeNull();
});

it("creates, reorders and deletes slides without dangling metadata", async () => {
  const { session, runtime, slideId } = await editing();
  const slide = { ...structuredClone(session.snapshot!.slide), id: "second" };
  session.apply(
    createSlide(
      session.snapshot!,
      slide,
      { templateId: null, name: "Second", section: "", hidden: false },
      slideId,
    ),
  );
  await session.flush();
  expect(runtime.authority.document.deck.slideIds).toEqual([slideId, "second"]);
  session.apply(reorderSlides(session.snapshot!, "second", null));
  await session.flush();
  expect(runtime.authority.document.deck.slideIds).toEqual(["second", slideId]);
  session.apply(deleteSlide(session.snapshot!, "second"));
  await session.flush();
  expect(runtime.authority.document.deck.slideIds).toEqual([slideId]);
  expect(runtime.authority.document.slides.second).toBeUndefined();
  expect(runtime.authority.document.deck.slideMeta.second).toBeUndefined();
});

it("serializes and parses accepted current-format document state", async () => {
  const { session, runtime } = await editing();
  await insertShape(session);
  expect(
    parseRuntimeDocument(JSON.stringify(runtime.authority.document)),
  ).toEqual(runtime.authority.document);
});

it("reparenting into a rotated frame preserves the world transform", async () => {
  const { session, runtime, slideId, layerId } = await editing();
  const parent = createEmptyFrame("parent", { x: 500, y: 300 });
  parent.frame.rotation = 30;
  const child = createBasicShape("child", "rectangle", { x: 50, y: 80 });
  session.apply(insertElements(session.snapshot!, [parent, child], layerId));
  await session.flush();
  const before = getWorldMatrix(
    runtime.authority.document.slides[slideId],
    child.id,
  );
  session.apply(reparentElements(session.snapshot!, [child.id], parent.id));
  await session.flush();
  const slide = runtime.authority.document.slides[slideId];
  expect(getParentId(slide, child.id)).toBe(parent.id);
  const after = getWorldMatrix(slide, child.id);
  before.forEach((value, index) => expect(after[index]).toBeCloseTo(value));
});

it("resolves inherited template content without persisting the resolved tree", () => {
  const document = newPresentationDocument("Templates");
  const slideId = document.deck.slideIds[0];
  const template = document.templates[document.deck.defaultTemplateId];
  template.background = "#123456";
  template.nodes[0].children.push(createBasicShape("inherited", "ellipse"));
  const before = structuredClone(document);
  const resolved = resolveSlide(document, slideId);
  expect(resolved.slide.background).toBe("#123456");
  expect(findElement(resolved.slide, "inherited")).not.toBeNull();
  expect(document).toEqual(before);
  expect(findElement(document.slides[slideId], "inherited")).toBeNull();
});

it("presentation follows visible section order without changing stored order", () => {
  const { deck } = newPresentationDocument("Sequence");
  deck.slideIds = ["section", "end", "child", "hidden"];
  deck.slideMeta = Object.fromEntries(
    deck.slideIds.map((id) => [
      id,
      {
        templateId: null,
        name: id,
        section: id === "child" ? "section" : "",
        hidden: id === "hidden",
      },
    ]),
  );
  expect(getPresentationSlideIds(deck)).toEqual(["section", "child", "end"]);
  expect(deck.slideIds).toEqual(["section", "end", "child", "hidden"]);
});

it("a failed durable write cannot advance the accepted revision", async () => {
  const { session, runtime } = await editing(async () => {
    throw new Error("Disk unavailable");
  });
  const before = structuredClone(runtime.authority.document);
  await expect(insertShape(session)).rejects.toThrow("Disk unavailable");
  expect(runtime.authority.revision).toBe(0);
  expect(runtime.authority.document).toEqual(before);
});
