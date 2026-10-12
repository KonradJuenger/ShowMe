import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import {
  createTextElement,
  updateText,
  type TextContent,
} from "../../../src/core/text";
import {
  applyTextStyle,
  setTextStyle,
} from "../../../src/core/textStyleCommands";
import { resolveTextTypography } from "../../../src/core/textTypography";
import {
  captureElementsClipboard,
  parseElementsClipboardText,
  serializeElementsClipboard,
  pasteElements,
} from "../../../src/core/clipboard";
import {
  createSlideTransferBundle,
  prepareSlideTransferImport,
  parseSlideTransferBundle,
} from "../../../src/core/slideTransfer";
import { applyDocumentOperations } from "../../../src/core/documentOperations";
import { editorOperations } from "../../../src/core/editorChange";
import type { EditorSnapshot } from "../../../src/core/editorCommands";
import { importTextStyles } from "../../../src/core/textStyles";

function fixture() {
  const document = newPresentationDocument("Styles");
  const slide = document.slides[document.deck.slideIds[0]];
  slide.nodes[0].children = [createTextElement("a")];
  const snapshot = {
    deck: document.deck,
    slide,
    templates: document.templates,
  };
  const heading = document.deck.textStyles[0];
  const edited = setTextStyle(snapshot, {
    styleId: heading.id,
    value: { ...heading, typography: { ...heading.typography, fontSize: 80 } },
  });
  const linked = updateText(applyTextStyle(edited, ["a"], heading.id), "a", {
    color: "#ff0000",
  });
  const accepted = applyDocumentOperations(document, editorOperations(linked));
  return {
    snapshot: {
      deck: accepted.deck,
      slide: accepted.slides[slide.id],
      templates: accepted.templates,
    },
    document: accepted,
  };
}
function text(snapshot: EditorSnapshot) {
  return snapshot.slide.nodes[0].children.at(-1)!.content as TextContent;
}
function ids() {
  let cursor = 0;
  return () => `imported-${cursor++}`;
}

it("same-document clipboard preserves references and overrides with a strict current-only payload", () => {
  const { snapshot } = fixture();
  const payload = captureElementsClipboard(snapshot, {
    elementIds: ["a"],
    scopeId: snapshot.slide.nodes[0].id,
  })!;
  expect(payload.textStyles).toHaveLength(1);
  expect(payload.version).toBe(1);
  const serialized = serializeElementsClipboard(payload);
  expect(serialized.startsWith("show-me-elements:v1:")).toBe(true);
  expect(parseElementsClipboardText(serialized)).toEqual(payload);
  expect(
    parseElementsClipboardText(serialized.replace("v1:", "v2:")),
  ).toBeNull();
  const pasted = pasteElements(
    snapshot,
    snapshot.slide.nodes[0].id,
    payload,
    ids(),
  ).snapshot;
  expect(text(pasted).format).toEqual(text(snapshot).format);
  expect(pasted.deck.textStyles).toEqual(snapshot.deck.textStyles);
});

it("cross-document clipboard imports different same-name typography and preserves appearance and overrides", () => {
  const { snapshot } = fixture();
  const payload = captureElementsClipboard(snapshot, {
    elementIds: ["a"],
    scopeId: snapshot.slide.nodes[0].id,
  })!;
  const document = newPresentationDocument("Destination");
  const destination = {
    deck: document.deck,
    slide: document.slides[document.deck.slideIds[0]],
    templates: document.templates,
  };
  const pasted = pasteElements(
    destination,
    destination.slide.nodes[0].id,
    payload,
    ids(),
  ).snapshot;
  expect(pasted.deck.textStyles).toHaveLength(3);
  expect(pasted.deck.textStyles.at(-1)).toMatchObject({ name: "Heading 2" });
  expect(pasted.deck.textStyles.at(-1)!.defaultKind).toBeUndefined();
  expect(
    pasted.deck.textStyles.filter((s) => s.defaultKind === "heading"),
  ).toEqual([destination.deck.textStyles[0]]);
  const format = text(pasted).format;
  expect(format).toMatchObject({
    kind: "style",
    overrides: { color: "#ff0000" },
  });
  expect(format.kind === "style" && format.styleId).not.toBe(
    destination.deck.textStyles[0].id,
  );
  expect(resolveTextTypography(pasted.deck, text(pasted))).toEqual(
    resolveTextTypography(snapshot.deck, text(snapshot)),
  );
  expect(() =>
    applyDocumentOperations(document, editorOperations(pasted)),
  ).not.toThrow();
  const again = pasteElements(
    pasted,
    pasted.slide.nodes[0].id,
    payload,
    ids(),
  ).snapshot;
  expect(again.deck.textStyles).toHaveLength(3);
  expect(text(again).format).toEqual(text(pasted).format);
});

it("clipboard and slide transfer preserve distinct semantic styles with identical typography and reuse equivalent names", () => {
  const { snapshot } = fixture();
  const typography = snapshot.deck.textStyles[1].typography;
  snapshot.deck.textStyles.push(
    { id: "caption", name: "Caption", typography },
    { id: "footnote", name: "Footnote", typography },
  );
  snapshot.slide.nodes[0].children.push(createTextElement("b"));
  const source = applyTextStyle(
    applyTextStyle(snapshot, ["a"], "caption"),
    ["b"],
    "footnote",
  );
  const payload = captureElementsClipboard(source, {
    elementIds: ["a", "b"],
    scopeId: source.slide.nodes[0].id,
  })!;
  const document = newPresentationDocument("Destination");
  // Cross-document ID equality is deliberately unrelated to identity.
  document.deck.textStyles.push({ id: "caption", name: "Other", typography });
  document.deck.textStyles.push({
    id: "existing",
    name: "caption",
    typography,
  });
  const destination = {
    deck: document.deck,
    slide: document.slides[document.deck.slideIds[0]],
    templates: document.templates,
  };
  const pasted = pasteElements(
    destination,
    destination.slide.nodes[0].id,
    payload,
    ids(),
  ).snapshot;
  expect(pasted.deck.textStyles).toHaveLength(5);
  const formats = pasted.slide.nodes[0].children.map(
    (e) => (e.content as TextContent).format,
  );
  expect(formats[0]).toMatchObject({ styleId: "existing" });
  expect(formats[1]).not.toEqual(formats[0]);
  const caption = pasted.deck.textStyles.find((s) => s.id === "existing")!;
  const changed = setTextStyle(pasted, {
    styleId: caption.id,
    value: { ...caption, typography: { ...typography, fontSize: 123 } },
  });
  expect(
    resolveTextTypography(
      changed.deck,
      changed.slide.nodes[0].children[0].content as TextContent,
    ).fontSize,
  ).toBe(123);
  expect(
    resolveTextTypography(
      changed.deck,
      changed.slide.nodes[0].children[1].content as TextContent,
    ).fontSize,
  ).toBe(32);
  const bundle = createSlideTransferBundle(
    source.deck.id,
    source.deck,
    [source.slide],
    source.templates,
  );
  const prepared = prepareSlideTransferImport(bundle, destination.deck, ids());
  expect(prepared.textStyles).toHaveLength(5);
  expect(
    prepared.slides[0].nodes[0].children.map(
      (e) => (e.content as TextContent).format,
    ),
  ).toEqual(formats);
});

it("slide transfer includes referenced template styles and remaps visually different same-name definitions", () => {
  const { snapshot, document } = fixture();
  const template = document.templates[document.deck.defaultTemplateId];
  const element = createTextElement("template-title");
  element.content = {
    ...(element.content as TextContent),
    format: {
      kind: "style",
      styleId: document.deck.textStyles[1].id,
      overrides: {},
    },
  };
  template.nodes[0].children = [element];
  const bundle = createSlideTransferBundle(
    document.documentId,
    document.deck,
    [snapshot.slide],
    document.templates,
  );
  expect(bundle.source.textStyles).toHaveLength(2);
  const destination = newPresentationDocument("Destination");
  const prepared = prepareSlideTransferImport(bundle, destination.deck, ids());
  expect(prepared.textStyles).toHaveLength(3);
  const deck = { ...destination.deck, textStyles: prepared.textStyles };
  const contents = prepared.slides[0].nodes[0].children.map(
    (e) => e.content as TextContent,
  );
  expect(contents).toHaveLength(2);
  expect(
    contents
      .map((c) => resolveTextTypography(deck, c).fontSize)
      .sort((a, b) => a - b),
  ).toEqual([32, 80]);
  expect(prepared.slideMeta[prepared.slides[0].id].templateId).toBeNull();
  expect(() => parseSlideTransferBundle({ ...bundle, version: 2 })).toThrow();
});

it("clipboard and transfer reject dangling styles and duplicate style IDs instead of accepting unresolved text", () => {
  const { snapshot, document } = fixture();
  const payload = captureElementsClipboard(snapshot, {
    elementIds: ["a"],
    scopeId: snapshot.slide.nodes[0].id,
  })!;
  expect(() =>
    serializeElementsClipboard({ ...payload, textStyles: [] }),
  ).toThrow("Dangling");
  expect(() =>
    serializeElementsClipboard({
      ...payload,
      textStyles: [...payload.textStyles, ...payload.textStyles],
    }),
  ).toThrow("Duplicate");
  const bundle = createSlideTransferBundle(
    document.documentId,
    document.deck,
    [snapshot.slide],
    document.templates,
  );
  expect(() =>
    parseSlideTransferBundle({
      ...bundle,
      source: { ...bundle.source, textStyles: [] },
    }),
  ).toThrow("Dangling");
});

it("same-document paste follows the live style identity after its shared definition changes", () => {
  const { snapshot } = fixture();
  const payload = captureElementsClipboard(snapshot, {
    elementIds: ["a"],
    scopeId: snapshot.slide.nodes[0].id,
  })!;
  const style = snapshot.deck.textStyles[0];
  const updated = setTextStyle(snapshot, {
    styleId: style.id,
    value: { ...style, typography: { ...style.typography, fontSize: 100 } },
  });
  const pasted = pasteElements(
    updated,
    updated.slide.nodes[0].id,
    payload,
    ids(),
  ).snapshot;
  expect(pasted.deck.textStyles).toHaveLength(2);
  expect(text(pasted).format).toEqual(text(snapshot).format);
  expect(resolveTextTypography(pasted.deck, text(pasted)).fontSize).toBe(100);
});

it("import mapping reuses source IDs once and disambiguates case-insensitive names deterministically", () => {
  const { deck } = newPresentationDocument("Names");
  const typography = deck.textStyles[1].typography;
  deck.textStyles.push(
    {
      id: "existing-caption",
      name: "CAPTION",
      typography: { ...typography, fontSize: 70 },
    },
    {
      id: "existing-caption-two",
      name: "caption 2",
      typography: { ...typography, fontSize: 80 },
    },
  );
  const source = { id: "source-caption", name: " Caption ", typography };
  const first = importTextStyles(deck, [source, source], ids());
  expect(first.textStyles.at(-1)).toMatchObject({
    name: "Caption 3",
    id: "imported-0",
  });
  expect(first.remap.size).toBe(1);
  expect(first.textStyles).toHaveLength(5);
  const second = importTextStyles(
    { ...deck, textStyles: first.textStyles },
    [source],
    () => {
      throw new Error("Should reuse");
    },
  );
  expect(second.remap).toEqual(first.remap);
  expect(second.textStyles).toEqual(first.textStyles);
  expect(deck.textStyles.map((s) => s.name)).toEqual([
    "Heading",
    "Text",
    "CAPTION",
    "caption 2",
  ]);
});

it("same-document slide transfer preserves live style IDs and current definitions", () => {
  const { snapshot, document } = fixture();
  const bundle = createSlideTransferBundle(
    document.documentId,
    snapshot.deck,
    [snapshot.slide],
    snapshot.templates,
  );
  const heading = snapshot.deck.textStyles[0];
  const deck = {
    ...snapshot.deck,
    textStyles: snapshot.deck.textStyles.map((s) =>
      s.id === heading.id
        ? { ...s, typography: { ...s.typography, fontSize: 123 } }
        : s,
    ),
  };
  const prepared = prepareSlideTransferImport(bundle, deck, ids());
  expect(prepared.textStyles).toEqual(deck.textStyles);
  const content = prepared.slides[0].nodes[0].children[0]
    .content as TextContent;
  expect(content.format).toMatchObject({ styleId: heading.id });
  expect(resolveTextTypography(deck, content).fontSize).toBe(123);
});
