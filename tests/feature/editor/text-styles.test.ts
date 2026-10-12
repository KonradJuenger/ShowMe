import { expect, it } from "vitest";
import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../../src/core/document";
import { contentSchema } from "../../../src/core/element";
import {
  createTextElement,
  updateText,
  type TextContent,
} from "../../../src/core/text";
import {
  resolveTextTypography,
  normalizeTextOverrides,
  textTypographySchema,
} from "../../../src/core/textTypography";
import {
  applyTextStyle,
  clearTextStyleOverrides,
  createTextStyleFromElement,
  setTextStyle,
  updateTextStyleFromElement,
} from "../../../src/core/textStyleCommands";
import { applyDocumentOperations } from "../../../src/core/documentOperations";
import { editorOperations } from "../../../src/core/editorChange";
import {
  duplicateElementsWithResult,
  resizeElements,
  type EditorSnapshot,
} from "../../../src/core/editorCommands";
import { addMotionPreset } from "../../../src/core/motion";
import { findElement } from "../../../src/core/scene";
import { setSelectionProperty } from "../../../src/core/elementProperties";
import {
  templateEditorPage,
  makeIndependentSlide,
} from "../../../src/core/templates";
import { collectUsedFontUsages } from "../../../src/core/fonts";
import { textOptions, coordinates } from "../../../electron/export/pptx";
import { IDENTITY } from "../../../src/core/element";
import { textMeasurementStyle } from "../../../src/components/editor/textLayout";

function fixture() {
  const document = newPresentationDocument("Text Styles");
  const slide = document.slides[document.deck.slideIds[0]];
  const a = createTextElement("a"),
    b = createTextElement("b"),
    c = createTextElement("c");
  slide.nodes[0].children = [a, b, c];
  const snapshot: EditorSnapshot = {
    deck: document.deck,
    slide,
    templates: document.templates,
  };
  return {
    document,
    snapshot,
    heading: document.deck.textStyles[0],
    text: document.deck.textStyles[1],
  };
}
function content(snapshot: EditorSnapshot, id = "a") {
  return findElement(snapshot.slide, id)!.content as TextContent;
}

it("creates exactly Heading and Text with stable unique IDs while new text is entirely local", () => {
  const { document, snapshot } = fixture();
  expect(document.deck.textStyles.map((s) => s.name)).toEqual([
    "Heading",
    "Text",
  ]);
  expect(new Set(document.deck.textStyles.map((s) => s.id)).size).toBe(2);
  expect(presentationDocumentSchema.parse(document).deck.textStyles).toEqual(
    document.deck.textStyles,
  );
  expect(newPresentationDocument("Another").deck.textStyles[0].id).not.toBe(
    document.deck.textStyles[0].id,
  );
  expect(content(snapshot).format.kind).toBe("local");
  expect(content(snapshot).autoSize).toBe("both");
  const a = findElement(snapshot.slide, "a")!;
  const moved = resizeElements(snapshot, ["a"], a.frame, {
    ...a.frame,
    x: a.frame.x + 20,
  });
  expect(content(moved).autoSize).toBe("both");
  const resized = resizeElements(snapshot, ["a"], a.frame, {
    ...a.frame,
    width: 300,
  });
  expect(content(resized).autoSize).toBe("none");
  const typed = updateText(resized, "a", { text: "Longer text" }, () => ({
    width: 900,
    height: 300,
  }));
  expect(findElement(typed.slide, "a")!.frame.width).toBe(300);
  const sized = setSelectionProperty(snapshot, ["a"], "transform.height", 200);
  expect(content(sized).autoSize).toBe("none");
  expect(
    textTypographySchema.safeParse(
      resolveTextTypography(snapshot.deck, content(snapshot)),
    ).success,
  ).toBe(true);
});

it("canonical validation rejects each style identity, name and default ownership violation", () => {
  const { document, heading, text } = fixture();
  const custom = {
    id: "caption",
    name: "Caption",
    typography: heading.typography,
  };
  const invalidLists = [
    [heading, text, { ...custom, id: heading.id }],
    [heading, text, custom, { ...custom, id: "other" }],
    [heading, text, custom, { ...custom, id: "other", name: " caption " }],
    [heading, text, { ...custom, name: "heading" }],
    [heading, text, { ...heading, id: "other" }],
    [heading, text, { ...text, id: "other" }],
    [text, custom],
    [heading, custom],
  ];
  for (const textStyles of invalidLists)
    expect(
      presentationDocumentSchema.safeParse({
        ...document,
        deck: { ...document.deck, textStyles },
      }).success,
    ).toBe(false);
});

it("creation and rename reject trimmed case-insensitive collisions without changing IDs or references", () => {
  const { snapshot } = fixture();
  const caption = createTextStyleFromElement(
    snapshot,
    "a",
    " Caption ",
    "caption",
  );
  expect(caption.deck.textStyles.at(-1)!.name).toBe("Caption");
  for (const name of ["Caption", " caption ", "CAPTION", "heading", " Text "])
    expect(() => createTextStyleFromElement(caption, "b", name, "new")).toThrow(
      "already exists",
    );
  const footnote = createTextStyleFromElement(
    caption,
    "b",
    "Footnote",
    "footnote",
  );
  const before = structuredClone(footnote);
  expect(() =>
    setTextStyle(footnote, {
      styleId: "footnote",
      value: { ...footnote.deck.textStyles.at(-1)!, name: "caption" },
    }),
  ).toThrow("already exists");
  expect(footnote).toEqual(before);
  const renamed = setTextStyle(footnote, {
    styleId: "footnote",
    value: { ...footnote.deck.textStyles.at(-1)!, name: " Note " },
  });
  expect(renamed.deck.textStyles.at(-1)).toMatchObject({
    id: "footnote",
    name: "Note",
  });
  expect(content(renamed, "b").format).toEqual(content(footnote, "b").format);
});

it("auto-size uses natural width on large and portrait canvases and retains fixed width for height-only layout", () => {
  const { snapshot } = fixture();
  for (const [width, height] of [
    [3840, 2160],
    [1080, 1920],
    [1024, 768],
  ]) {
    const sized = { ...snapshot, deck: { ...snapshot.deck, width, height } };
    const result = updateText(sized, "a", { autoSize: "both" }, () => ({
      width: 3000.2,
      height: 100.1,
    }));
    expect(findElement(result.slide, "a")!.frame).toMatchObject({
      width: 3005,
      height: 105,
    });
    expect(
      textMeasurementStyle({
        ...findElement(result.slide, "a")!,
        content: content(result),
      }),
    ).toMatchObject({
      width: "max-content",
      whiteSpace: "pre",
      maxWidth: 99996,
    });
    const fixed = updateText(sized, "a", { autoSize: "height" }, () => ({
      width: 3000,
      height: 200,
    }));
    expect(findElement(fixed.slide, "a")!.frame).toMatchObject({
      width: 800,
      height: 204,
    });
    expect(
      textMeasurementStyle({
        ...findElement(fixed.slide, "a")!,
        content: content(fixed),
      }),
    ).toMatchObject({ width: 800, maxWidth: "none" });
  }
});

it("rejects dangling references, duplicate styles, missing defaults, mixed formats and invalid override keys", () => {
  const { document, snapshot, heading } = fixture();
  expect(
    presentationDocumentSchema.safeParse({
      ...document,
      deck: { ...document.deck, textStyles: [heading, heading] },
    }).success,
  ).toBe(false);
  const invalid = structuredClone(document);
  invalid.slides[snapshot.slide.id].nodes[0].children[0].content = {
    ...content(snapshot),
    format: { kind: "style", styleId: "missing", overrides: {} },
  };
  expect(presentationDocumentSchema.safeParse(invalid).success).toBe(false);
  expect(
    contentSchema.safeParse({ ...content(snapshot), fontSize: 40 }).success,
  ).toBe(false);
  expect(
    contentSchema.safeParse({
      ...content(snapshot),
      format: {
        kind: "style",
        styleId: heading.id,
        overrides: { autoSize: "both" },
      },
    }).success,
  ).toBe(false);
  expect(
    contentSchema.safeParse({
      ...content(snapshot),
      format: { kind: "local", typography: { fontSize: 40 } },
    }).success,
  ).toBe(false);
  expect(
    contentSchema.safeParse({
      ...content(snapshot),
      format: {
        kind: "style",
        styleId: heading.id,
        typography: heading.typography,
        overrides: {},
      },
    }).success,
  ).toBe(false);
});

it("applying a style discards local differences and detaching preserves exact effective typography", () => {
  const { snapshot, heading } = fixture();
  const local = updateText(snapshot, "a", {
    fontFamily: "Comic Sans MS",
    fontSize: 73,
    color: "#ff0000",
    align: "center",
  });
  const linked = applyTextStyle(local, ["a"], heading.id);
  expect(content(linked).format).toEqual({
    kind: "style",
    styleId: heading.id,
    overrides: {},
  });
  expect(resolveTextTypography(linked.deck, content(linked))).toEqual(
    heading.typography,
  );
  const overridden = updateText(linked, "a", { fontSize: 72 });
  const detached = applyTextStyle(overridden, ["a"], null);
  expect(content(detached).format).toEqual({
    kind: "local",
    typography: { ...heading.typography, fontSize: 72 },
  });
});

it("typography controls create only meaningful overrides while typing and auto-size remain element-local", () => {
  const { snapshot, heading } = fixture();
  const linked = applyTextStyle(snapshot, ["a"], heading.id);
  const edited = setSelectionProperty(
    linked,
    ["a"],
    "content.text.fontSize",
    72,
  );
  expect(content(edited).format).toEqual({
    kind: "style",
    styleId: heading.id,
    overrides: { fontSize: 72 },
  });
  const typed = updateText(edited, "a", { text: "typed", autoSize: "height" });
  expect(content(typed).format).toEqual(content(edited).format);
  expect(content(typed)).toMatchObject({
    text: "typed",
    placeholder: false,
    autoSize: "height",
  });
  const restored = updateText(edited, "a", {
    fontSize: heading.typography.fontSize,
  });
  expect(content(restored).format).toEqual(content(linked).format);
  expect(
    normalizeTextOverrides(heading.typography, {
      fontSize: heading.typography.fontSize,
      color: "#ff0000",
    }),
  ).toEqual({ color: "#ff0000" });
  expect(content(clearTextStyleOverrides(edited, ["a"])).format).toEqual(
    content(linked).format,
  );
});

it("updates the shared definition and normalizes references while preserving other intentional overrides and styles", () => {
  const { snapshot, heading, text } = fixture();
  let next = applyTextStyle(snapshot, ["a", "b"], heading.id);
  next = applyTextStyle(next, ["c"], text.id);
  next = updateText(next, "a", { fontSize: 72, color: "#ff0000" });
  next = updateText(next, "b", { fontSize: 72, italic: true });
  const result = updateTextStyleFromElement(next, "a");
  expect(result.deck.textStyles[0].typography).toMatchObject({
    fontSize: 72,
    color: "#ff0000",
  });
  expect(content(result).format).toEqual({
    kind: "style",
    styleId: heading.id,
    overrides: {},
  });
  expect(content(result, "b").format).toEqual({
    kind: "style",
    styleId: heading.id,
    overrides: { italic: true },
  });
  expect(
    resolveTextTypography(result.deck, content(result, "b")),
  ).toMatchObject({ fontSize: 72, color: "#ff0000", italic: true });
  expect(resolveTextTypography(result.deck, content(result, "c"))).toEqual(
    text.typography,
  );
});

it("creates a named shared style from effective selection and deletes it without changing any appearance", () => {
  const { document, snapshot, heading } = fixture();
  let next = updateText(applyTextStyle(snapshot, ["a"], heading.id), "a", {
    fontSize: 90,
  });
  next = createTextStyleFromElement(next, "a", "Custom", "custom-style");
  expect(next.deck.textStyles.at(-1)).toMatchObject({
    id: "custom-style",
    name: "Custom",
    typography: { fontSize: 90 },
  });
  expect(content(next).format).toEqual({
    kind: "style",
    styleId: "custom-style",
    overrides: {},
  });
  next = applyTextStyle(next, ["b"], "custom-style");
  next = updateText(next, "b", { color: "#0000ff" });
  const beforeA = resolveTextTypography(next.deck, content(next)),
    beforeB = resolveTextTypography(next.deck, content(next, "b"));
  const deleted = setTextStyle(next, { styleId: "custom-style", value: null });
  const accepted = applyDocumentOperations(document, editorOperations(deleted));
  expect(accepted.deck.textStyles).toHaveLength(2);
  expect(content(deleted).format).toEqual({
    kind: "local",
    typography: beforeA,
  });
  expect(content(deleted, "b").format).toEqual({
    kind: "local",
    typography: beforeB,
  });
  expect(() =>
    setTextStyle(next, { styleId: heading.id, value: null }),
  ).toThrow("Default Text Styles");
});

it("templates and independent slides share deck styles and duplication preserves references", () => {
  const { document, snapshot, heading } = fixture();
  const templateId = snapshot.deck.defaultTemplateId;
  const page = document.templates[templateId];
  page.nodes[0].children = [createTextElement("template-title")];
  for (const element of [
    page.nodes[0].children[0],
    ...snapshot.slide.nodes[0].children,
  ]) {
    if (element.content?.type === "text") element.content.autoSize = "none";
  }
  const template = applyTextStyle(
    { ...snapshot, slide: templateEditorPage(page) },
    ["template-title"],
    heading.id,
  );
  const templateDocument = applyDocumentOperations(
    document,
    editorOperations(template),
  );
  const normal = applyTextStyle(
    { ...snapshot, deck: templateDocument.deck },
    ["a"],
    heading.id,
  );
  const linkedDocument = applyDocumentOperations(
    templateDocument,
    editorOperations(normal),
  );
  const independent = makeIndependentSlide(
    linkedDocument.deck,
    linkedDocument.slides[snapshot.slide.id],
    linkedDocument.templates,
  );
  expect(
    (independent.nodes[0].children[0].content as TextContent).format,
  ).toEqual({ kind: "style", styleId: heading.id, overrides: {} });
  const changed = applyDocumentOperations(linkedDocument, [
    {
      type: "text-style.set",
      styleId: heading.id,
      value: {
        ...heading,
        typography: { ...heading.typography, fontSize: 80 },
      },
    },
  ]);
  const templateText = changed.templates[templateId].nodes[0].children[0]
    .content as TextContent;
  expect(resolveTextTypography(changed.deck, templateText).fontSize).toBe(80);
  expect(
    resolveTextTypography(
      changed.deck,
      changed.slides[snapshot.slide.id].nodes[0].children[0]
        .content as TextContent,
    ).fontSize,
  ).toBe(80);
  const linked = applyTextStyle(snapshot, ["a"], heading.id);
  const duplicate = duplicateElementsWithResult(
    linked,
    ["a"],
    () => "duplicate",
  );
  expect(content(duplicate.snapshot, "duplicate").format).toEqual(
    content(linked).format,
  );
  expect(duplicate.snapshot.deck.textStyles).toEqual(linked.deck.textStyles);
});

it("font collection, measurement and PowerPoint options use effective typography", () => {
  const { snapshot, heading } = fixture();
  const changed = setTextStyle(snapshot, {
    styleId: heading.id,
    value: {
      ...heading,
      typography: {
        ...heading.typography,
        fontFamily: "Custom Face",
        fontSize: 80,
        verticalAlign: "bottom",
      },
    },
  });
  const linked = updateText(applyTextStyle(changed, ["a"], heading.id), "a", {
    color: "#ff0000",
  });
  const element = findElement(linked.slide, "a")!;
  expect(collectUsedFontUsages([linked.slide], linked.deck)).toContainEqual({
    family: "Custom Face",
    weight: 700,
    italic: false,
  });
  expect(
    textMeasurementStyle({ ...element, content: content(linked) }, linked.deck),
  ).toMatchObject({ fontFamily: "Custom Face", fontSize: 80 });
  expect(
    textOptions(element, IDENTITY, 1, coordinates(1920, 1080), linked.deck),
  ).toMatchObject({
    fontFace: "Custom Face",
    color: "ff0000",
    valign: "bottom",
    bold: true,
  });
});

it("auto-size receives resolved typography rather than the persistent style reference", () => {
  const { snapshot, heading } = fixture();
  const linked = applyTextStyle(snapshot, ["a"], heading.id);
  let measuredSize = 0;
  const result = updateText(
    linked,
    "a",
    { autoSize: "both", fontSize: 90 },
    (e) => {
      measuredSize = resolveTextTypography(undefined, e.content).fontSize;
      return { width: 350, height: measuredSize * 2 };
    },
  );
  expect(measuredSize).toBe(90);
  expect(findElement(result.slide, "a")!.frame).toMatchObject({
    width: 354,
    height: 184,
  });
});

it("applying and updating Text Styles retain existing Motion without making shared typography animatable", () => {
  const { snapshot, heading, document } = fixture();
  snapshot.slide.motion = addMotionPreset(undefined, 0, ["a"], "Move");
  const motion = structuredClone(snapshot.slide.motion);
  const next = updateTextStyleFromElement(
    updateText(applyTextStyle(snapshot, ["a"], heading.id), "a", {
      fontSize: 90,
    }),
    "a",
  );
  expect(
    applyDocumentOperations(document, editorOperations(next)).slides[
      snapshot.slide.id
    ].motion,
  ).toEqual(motion);
});
