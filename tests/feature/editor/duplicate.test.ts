import { expect, it } from "vitest";
import { duplicateElementsWithResult } from "../../../src/core/editorCommands";
import { findElement } from "../../../src/core/scene";
import { editing, insertShape } from "../../helpers/document";

it("duplicate creates an independent editable identity with the requested offset", async () => {
  const { session, runtime, slideId } = await editing();
  const original = await insertShape(session);
  const result = duplicateElementsWithResult(
    session.snapshot!,
    [original.id],
    () => "copy",
    { x: 24, y: 12 },
  );
  session.apply(result.snapshot);
  await session.flush();
  const slide = runtime.authority.document.slides[slideId];
  expect(findElement(slide, "copy")!.frame).toMatchObject({
    x: original.frame.x + 24,
    y: original.frame.y + 12,
  });
  expect(findElement(slide, original.id)).toEqual(original);
});
