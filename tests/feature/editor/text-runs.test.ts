import { expect, it } from "vitest";
import {
  effectTextRuns,
  formatTextRuns,
  normalizeTextRuns,
  plainText,
  replaceTextRuns,
  runFontWeight,
  textRunsSchema,
  typingFontWeight,
} from "../../../src/core/textRuns";
import { DEFAULT_TEXT_TYPOGRAPHY } from "../../../src/core/textTypography";
import {
  createTextElement,
  patchTextContent,
  updateText,
  type TextContent,
} from "../../../src/core/text";
import {
  collectUsedFontUsages,
  fontWeightMatchScore,
} from "../../../src/core/fonts";
import { insertElements } from "../../../src/core/editorCommands";
import { editing } from "../../helpers/document";
import { newPresentationDocument } from "../../../src/core/document";
import { parseRuntimeDocument } from "../../../src/core/documentRuntime";
import { upgradeV1TextPayload } from "../../../src/core/textV1Upgrade";
import {
  clientMessageSchema,
  COLLAB_DOCUMENT_VERSION,
  COLLAB_PROTOCOL_VERSION,
} from "../../../src/core/collaboration/protocol";

it("normalizes runs without storing a duplicate string and rejects noncanonical persisted runs", () => {
  expect(
    normalizeTextRuns([
      { text: "a\r\nb" },
      { text: "" },
      { text: "c" },
      { text: "d", fontWeight: 700 },
    ]),
  ).toEqual([{ text: "a\nbc" }, { text: "d", fontWeight: 700 }]);
  expect(textRunsSchema.safeParse([{ text: "a" }, { text: "b" }]).success).toBe(
    false,
  );
  expect(textRunsSchema.safeParse([{ text: "" }]).success).toBe(false);
  expect(
    textRunsSchema.safeParse([
      { text: "a".repeat(100000) },
      { text: "b", fontWeight: 700 },
    ]).success,
  ).toBe(false);
  expect(textRunsSchema.parse([{ fontWeight: 700, text: "a" }])).toEqual([
    { text: "a", fontWeight: 700 },
  ]);
});

it("formats individual characters across runs and preserves unselected formatting", () => {
  const runs = [
    { text: "Hello " },
    { text: "world", fontWeight: 900 },
    { text: "!" },
  ];
  expect(formatTextRuns(runs, 4, 8, 700)).toEqual([
    { text: "Hell" },
    { text: "o wo", fontWeight: 700 },
    { text: "rld", fontWeight: 900 },
    { text: "!" },
  ]);
  expect(formatTextRuns(runs, 6, 11, 400)[1]).toEqual({
    text: "world",
    fontWeight: 400,
  });
});

it("replaces selected text across runs and preserves newlines and typing inheritance", () => {
  const runs = [
    { text: "abc" },
    { text: "DEF", fontWeight: 700 },
    { text: "ghi" },
  ];
  expect(
    replaceTextRuns(runs, 2, 7, [{ text: "\nX", fontWeight: 400 }]),
  ).toEqual([{ text: "ab" }, { text: "\nX", fontWeight: 400 }, { text: "hi" }]);
  expect(typingFontWeight(runs, 3)).toBeUndefined();
  expect(typingFontWeight(runs, 4)).toBe(700);
  expect(replaceTextRuns(runs, 0, 9, [])).toEqual([]);
});

it("keeps emoji and combining sequences intact when formatting a partial grapheme", () => {
  expect(formatTextRuns([{ text: "a👩‍💻éz" }], 2, 3, 700)).toEqual([
    { text: "a" },
    { text: "👩‍💻", fontWeight: 700 },
    { text: "éz" },
  ]);
  expect(() => replaceTextRuns([{ text: "a" }], -1, 0, [])).toThrow(
    "selection",
  );
});

it("resolves inherited box weights and explicit regular overrides and collects every used face", () => {
  const document = newPresentationDocument("Fonts"),
    slide = document.slides[document.deck.slideIds[0]];
  const element = createTextElement("text");
  element.content = patchTextContent(element.content as TextContent, {
    runs: [{ text: "Bold" }, { text: " regular", fontWeight: 400 }],
    bold: true,
    fontWeight: 700,
  });
  slide.nodes[0].children = [element];
  expect(
    runFontWeight({ text: "x" }, { ...DEFAULT_TEXT_TYPOGRAPHY, bold: true }),
  ).toBe(700);
  expect(
    collectUsedFontUsages([slide], document.deck).map((usage) => usage.weight),
  ).toEqual([400, 700]);
});

it("commits formatting through authority history and restores runs with actor undo and redo", async () => {
  const { session, runtime, slideId } = await editing();
  const text = createTextElement("text");
  text.content = patchTextContent(text.content as TextContent, {
    text: "Hello world",
  });
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(
    updateText(session.snapshot!, text.id, {
      runs: [{ text: "Hello " }, { text: "world", fontWeight: 700 }],
    }),
  );
  await session.flush();
  const content = () =>
    runtime.authority.document.slides[slideId].nodes[0].children[0]
      .content as TextContent;
  expect(content().runs[1].fontWeight).toBe(700);
  session.undo();
  await session.flush();
  expect(content().runs).toEqual([{ text: "Hello world" }]);
  session.undo(true);
  await session.flush();
  expect(content().runs[1].fontWeight).toBe(700);
});

it("upgrades the supported v1 document while retaining box formatting and rejecting mixed or malformed versions", () => {
  const document = newPresentationDocument("Old"),
    slide = document.slides[document.deck.slideIds[0]];
  slide.nodes[0].children = [createTextElement("text")];
  const old = JSON.parse(JSON.stringify(document));
  old.version = old.deck.version = 1;
  for (const page of [
    ...Object.values(old.slides),
    ...Object.values(old.templates),
  ] as Array<{ version: number }>)
    page.version = 1;
  const content = old.slides[slide.id].nodes[0].children[0].content;
  content.text = plainText(content);
  delete content.runs;
  expect(parseRuntimeDocument(old)).toEqual(document);
  content.runs = [];
  expect(() => parseRuntimeDocument(old)).toThrow();
  delete content.runs;
  old.deck.version = 2;
  expect(() => parseRuntimeDocument(old)).toThrow();
  expect(() =>
    upgradeV1TextPayload({
      type: "text",
      format: {},
      autoSize: "height",
      text: 42,
    }),
  ).toThrow();
});

it("advertises the new collaboration versions and keeps network snapshots on the strict current schema", () => {
  expect(COLLAB_DOCUMENT_VERSION).toBe(2);
  expect(COLLAB_PROTOCOL_VERSION).toBe(2);
  expect(
    clientMessageSchema.safeParse({
      type: "hello",
      sessionId: "a".repeat(64),
      versions: { appVersion: "test", protocolVersion: 2, documentVersion: 2 },
    }).success,
  ).toBe(true);
});

it("preserves formatting in identity and reveal string Effects and inherits box styling for generated replacements", () => {
  const runs = [{ text: "Hello " }, { text: "world", fontWeight: 700 }];
  expect(effectTextRuns(runs, "Hello world")).toEqual(runs);
  expect(effectTextRuns(runs, "Hello wo")).toEqual([
    { text: "Hello " },
    { text: "wo", fontWeight: 700 },
  ]);
  expect(effectTextRuns(runs, "world")).toEqual([
    { text: "world", fontWeight: 700 },
  ]);
  expect(effectTextRuns(runs, "Generated")).toEqual([{ text: "Generated" }]);
});

it("matches missing static weights in CSS search order instead of choosing the numerically nearest face", () => {
  expect(fontWeightMatchScore(400, 500)).toBeLessThan(
    fontWeightMatchScore(400, 300),
  );
  expect(fontWeightMatchScore(450, 500)).toBeLessThan(
    fontWeightMatchScore(450, 400),
  );
  expect(fontWeightMatchScore(500, 400)).toBeLessThan(
    fontWeightMatchScore(500, 600),
  );
  expect(fontWeightMatchScore(600, 900)).toBeLessThan(
    fontWeightMatchScore(600, 500),
  );
  expect(fontWeightMatchScore(300, 100)).toBeLessThan(
    fontWeightMatchScore(300, 400),
  );
});
