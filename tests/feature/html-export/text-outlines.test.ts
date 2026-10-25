import { it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHtmlExport } from "../../../electron/export/html";
import { htmlExportFixture } from "../../helpers/htmlExportFixture";
import type { HtmlExportPayload } from "../../../src/export/html/types";
import type { TextElement } from "../../../src/core/text";
import { hashFile } from "../../../electron/storage/io";

let directory: string, file: string, id: string;
beforeAll(async () => {
  directory = await mkdtemp(
    path.join(os.tmpdir(), "showme-svg-assembly-test-"),
  );
  await writeFile(path.join(directory, "runtime.js"), "void 0;");
  file = path.join(directory, "outlined.svg");
  await writeFile(
    file,
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="180"><path d="M0 0L10 10"/></svg>',
  );
  id = await hashFile(file);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const document = htmlExportFixture();
  document.slides = [document.slides[0]];
  document.deck.slideIds = [document.slides[0].id];
  document.slides[0].nodes[0].children[0].effects = [];
  return document;
}
function payload(html: string) {
  return JSON.parse(
    html.match(
      /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
    )![1],
  ) as HtmlExportPayload;
}
function input(document = fixture()) {
  return {
    document,
    runtimeVersion: "test",
    runtimeDirectory: directory,
    resolveAsset: async () => null,
    managedFonts: async () => [],
  };
}

it("converts only the export snapshot to SVG assets and retains frame, Motion and resolved Text Styles", async () => {
  const setup = input(),
    element = setup.document.slides[0].nodes[0].children[0];
  if (element.content?.type !== "text") throw Error("Text required");
  element.content.format = {
    kind: "style",
    styleId: setup.document.deck.textStyles[0].id,
    overrides: { color: "#123456" },
  };
  const before = structuredClone(setup.document);
  const prepared = vi.fn(async (element: TextElement) => ({
    file,
    mime: "image/svg+xml",
    id,
    local: {
      ...element.frame,
      x: -2,
      y: -3,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    },
  }));
  const progress = vi.fn();
  const exported = payload(
    (
      await createHtmlExport({
        ...setup,
        prepareText: prepared,
        onProgress: progress,
      })
    ).html,
  );
  expect(prepared).toHaveBeenCalledOnce();
  expect(prepared.mock.calls[0][0].content.format).toMatchObject({
    kind: "local",
    typography: { color: "#123456" },
  });
  const converted = exported.document.slides[0].nodes[0].children[0];
  expect(converted.content).toMatchObject({
    type: "svg",
    assetId: id,
    transform: { rule: "free", local: { x: -2, y: -3 } },
  });
  expect(converted.frame).toEqual(element.frame);
  expect(exported.document.slides[0].motion).toEqual(before.slides[0].motion);
  expect(exported.assets).toHaveLength(1);
  expect(exported.fonts).toEqual([]);
  expect(setup.document).toEqual(before);
  expect(progress.mock.calls).toContainEqual(["fonts", 1, 1]);
  expect(progress.mock.calls).toContainEqual(["embedding", 1, 1]);
});

it("keeps text with its own or ancestor Effects and deck CSS live with explicit warnings", async () => {
  const document = fixture(),
    element = document.slides[0].nodes[0].children[0];
  const effected = htmlExportFixture().slides[0].nodes[0].children[0];
  element.children = [
    { ...structuredClone(effected), id: "child", effects: [] },
  ];
  element.effects = effected.effects;
  const prepareText = vi.fn();
  const exported = await createHtmlExport({ ...input(document), prepareText });
  expect(prepareText).not.toHaveBeenCalled();
  expect(
    exported.warnings.filter(
      (warning) => warning.code === "text-svg-unavailable",
    ),
  ).toHaveLength(2);
  expect(
    payload(exported.html).document.slides[0].nodes[0].children[0].content
      ?.type,
  ).toBe("text");
  element.effects = [];
  element.children = [];
  document.deck.stylesheet = ".slide { color: red; }";
  const css = await createHtmlExport({ ...input(document), prepareText });
  expect(prepareText).not.toHaveBeenCalled();
  expect(
    css.warnings.some((warning) => warning.code === "text-svg-unavailable"),
  ).toBe(true);
});

it("reports unavailable outlines without losing live text or stopping media assembly", async () => {
  const setup = input(),
    before = structuredClone(setup.document);
  const exported = await createHtmlExport({
    ...setup,
    prepareText: async () => {
      throw Error("Font unavailable");
    },
  });
  expect(exported.warnings).toContainEqual(
    expect.objectContaining({
      code: "text-svg-unavailable",
      message: expect.stringContaining("Font unavailable"),
    }),
  );
  expect(
    payload(exported.html).document.slides[0].nodes[0].children[0].content,
  ).toEqual(before.slides[0].nodes[0].children[0].content);
  expect(setup.document).toEqual(before);
});
