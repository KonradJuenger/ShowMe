import { expect, it } from "vitest";
import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../../src/core/document";
import { setDeckProperties } from "../../../src/core/editorCommands";
import {
  presentationSizePresets,
  powerPointCanvasSize,
  presentationFormat,
  dimensionsForAspectRatio,
} from "../../../src/core/presentationDimensions";
import { createPowerPointSlides } from "../../../src/core/powerpointImportCommands";
import { editing, insertShape } from "../../helpers/document";

it("new presentations use 1920 by 1080 and current documents accept arbitrary positive canvas dimensions", () => {
  const document = newPresentationDocument("Size");
  expect(document.deck).toMatchObject({ width: 1920, height: 1080 });
  expect(
    presentationDocumentSchema.parse({
      ...document,
      deck: { ...document.deck, width: 800.5, height: 2400 },
    }).deck.width,
  ).toBe(800.5);
  expect(
    presentationDocumentSchema.safeParse({
      ...document,
      deck: { ...document.deck, width: 0 },
    }).success,
  ).toBe(false);
  expect(
    presentationDocumentSchema.safeParse({
      ...document,
      deck: { ...document.deck, height: Infinity },
    }).success,
  ).toBe(false);
});

it("format matching preserves imported unit conventions and fractional custom ratios", () => {
  const imported = { width: 1280, height: 720 };
  expect(presentationFormat(imported)?.name).toBe("16:9");
  expect(dimensionsForAspectRatio(imported, { width: 16, height: 9 })).toBe(
    imported,
  );
  expect(dimensionsForAspectRatio(imported, { width: 4, height: 3 })).toEqual({
    width: 960,
    height: 720,
  });
  expect(dimensionsForAspectRatio(imported, { width: 9, height: 16 })).toEqual({
    width: 720,
    height: 1280,
  });
  expect(
    dimensionsForAspectRatio(
      { width: 800.5, height: 2400 },
      { width: 1.25, height: 1 },
    ),
  ).toEqual({ width: 1000.625, height: 800.5 });
  expect(() =>
    dimensionsForAspectRatio(imported, { width: 0, height: 1 }),
  ).toThrow();
  expect(() =>
    dimensionsForAspectRatio(imported, {
      width: Number.MAX_VALUE,
      height: Number.MIN_VALUE,
    }),
  ).toThrow();
});

it("ratio changes are one authoritative undo step and selecting the current ratio creates none", async () => {
  const { session, runtime } = await editing();
  await insertShape(session);
  const before = structuredClone(runtime.authority.document);
  const unchanged = setDeckProperties(
    session.snapshot!,
    dimensionsForAspectRatio(session.snapshot!.deck, { width: 16, height: 9 }),
  );
  expect(unchanged).toBe(session.snapshot);
  session.apply(
    setDeckProperties(
      session.snapshot!,
      dimensionsForAspectRatio(session.snapshot!.deck, {
        width: 9,
        height: 16,
      }),
    ),
  );
  await session.flush();
  expect(runtime.authority.document.deck).toMatchObject({
    width: 1080,
    height: 1920,
  });
  expect(runtime.authority.document.slides).toEqual(before.slides);
  expect(runtime.authority.document.templates).toEqual(before.templates);
  expect(runtime.authority.document.deck.guideSets).toEqual(
    before.deck.guideSets,
  );
  await session.undo();
  await session.flush();
  expect(runtime.authority.document.deck).toMatchObject({
    width: 1920,
    height: 1080,
  });
});

it("canvas resize preserves slide and template geometry and guides, and participates in undo and redo", async () => {
  const { session, runtime } = await editing();
  await insertShape(session);
  const before = structuredClone(runtime.authority.document);
  session.apply(
    setDeckProperties(session.snapshot!, { width: 900, height: 1600 }),
  );
  await session.flush();
  const resized = runtime.authority.document;
  expect(resized.deck).toMatchObject({ width: 900, height: 1600 });
  expect(resized.slides).toEqual(before.slides);
  expect(resized.templates).toEqual(before.templates);
  expect(resized.deck.guideSets).toEqual(before.deck.guideSets);
  await session.undo();
  await session.flush();
  expect(runtime.authority.document.deck).toMatchObject({
    width: 1920,
    height: 1080,
  });
  await session.undo(true);
  await session.flush();
  expect(runtime.authority.document.deck).toMatchObject({
    width: 900,
    height: 1600,
  });
});

it("presets include wide, standard and portrait sizes and PowerPoint adopts physical source dimensions", async () => {
  expect(
    presentationSizePresets.map(({ width, height }) => width / height),
  ).toEqual([16 / 9, 4 / 3, 9 / 16, 3 / 4]);
  const size = powerPointCanvasSize(9144000, 6858000);
  expect(size).toEqual({ width: 960, height: 720, scale: 1 / 9525 });
  const { session } = await editing();
  const result = createPowerPointSlides(
    session.snapshot!,
    [
      {
        ...size,
        name: "Source",
        background: "#ffffff",
        notes: "",
        elements: [],
        media: [],
        warnings: [],
      },
    ],
    [],
    session.snapshot!.slide.id,
    true,
  );
  expect(result.snapshot.deck).toMatchObject({ width: 960, height: 720 });
});
