import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement } from "../../../src/core/text";
import { setSelectionProperty } from "../../../src/core/elementProperties";
import { findElement } from "../../../src/core/scene";
import { type EditorSnapshot } from "../../../src/core/editorCommands";

function fixture(): EditorSnapshot {
  const document = newPresentationDocument("Scale");
  const slide = document.slides[document.deck.slideIds[0]];
  const a = createTextElement("a");
  const b = createTextElement("b");
  a.frame.scaleX = 0.5;
  a.frame.scaleY = 0.25;
  b.frame.scaleX = 2;
  b.frame.scaleY = 4;
  slide.nodes[0].children = [a, b];
  return { deck: document.deck, slide, templates: document.templates };
}

it("edits independent scale without changing typography or box size", () => {
  const snapshot = fixture();
  const before = findElement(snapshot.slide, "a")!;
  const next = setSelectionProperty(snapshot, ["a"], "transform.scaleX", 0.75);
  const after = findElement(next.slide, "a")!;
  expect(after.frame).toEqual({ ...before.frame, scaleX: 0.75 });
  expect(after.content).toEqual(before.content);
});

it("linked scale preserves each selected object's ratio on either axis", () => {
  const snapshot = fixture();
  const x = setSelectionProperty(
    snapshot,
    ["a", "b"],
    "transform.scaleX",
    1,
    true,
  );
  expect(findElement(x.slide, "a")!.frame).toMatchObject({
    scaleX: 1,
    scaleY: 0.5,
  });
  expect(findElement(x.slide, "b")!.frame).toMatchObject({
    scaleX: 1,
    scaleY: 2,
  });
  const y = setSelectionProperty(
    snapshot,
    ["a", "b"],
    "transform.scaleY",
    1,
    true,
  );
  expect(findElement(y.slide, "a")!.frame).toMatchObject({
    scaleX: 2,
    scaleY: 1,
  });
  expect(findElement(y.slide, "b")!.frame).toMatchObject({
    scaleX: 0.5,
    scaleY: 1,
  });
  expect(findElement(snapshot.slide, "a")!.frame.scaleX).toBe(0.5);
});

it("linked scale respects the format limit while retaining proportions", () => {
  const next = setSelectionProperty(
    fixture(),
    ["b"],
    "transform.scaleX",
    10000,
    true,
  );
  expect(findElement(next.slide, "b")!.frame).toMatchObject({
    scaleX: 5000,
    scaleY: 10000,
  });
});
