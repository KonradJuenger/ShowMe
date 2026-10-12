import { expect, it } from "vitest";
import { createPowerPoint } from "../../../electron/export/pptx";
import { formatExportWarnings } from "../../../src/export/shared";
import { addPresence } from "../../../src/core/presence";
import { addMotionPreset } from "../../../src/core/motion";
import { editing, insertShape } from "../../helpers/document";

it("PPTX reports Motion and Presence with object context and visible warning details", async () => {
  const { session, runtime, slideId } = await editing();
  const shape = await insertShape(session);
  const slide = structuredClone(runtime.authority.document.slides[slideId]);
  slide.motion = addPresence(
    addMotionPreset(undefined, 0, [shape.id], "Move"),
    0,
    [shape.id],
  );
  const { warnings } = await createPowerPoint(
    { deck: runtime.authority.document.deck, slides: [slide] },
    async () => null,
  );
  expect(warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        slideId,
        elementId: shape.id,
        code: "motion-omitted",
      }),
      expect.objectContaining({
        slideId,
        elementId: shape.id,
        code: "presence-omitted",
      }),
    ]),
  );
  const details = formatExportWarnings(warnings);
  expect(details).toContain(`Slide ${slideId} / Object ${shape.id}`);
  expect(details).toContain("Authored static properties");
  expect(details).toContain("Presence timing and transitions");
  expect(runtime.authority.document.slides[slideId].motion).toBeUndefined();
});
