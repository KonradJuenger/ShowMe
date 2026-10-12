import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";
import { createPowerPoint } from "../../../electron/export/pptx";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement, type TextContent } from "../../../src/core/text";

test("Text Style inspector applies, overrides, creates, updates, detaches and deletes without losing appearance", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const style = page.getByLabel("Text Style", { exact: true });
  await expect(style).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Rename Style", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rename Style", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete Style", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete Style", exact: true }),
  ).toBeDisabled();
  await style.selectOption({ label: "Heading" });
  await expect(
    page.getByRole("button", { name: "Reset style", exact: true }),
  ).toBeVisible();
  const size = page.getByLabel("Font size", { exact: true });
  await size.fill("72");
  await size.blur();
  await expect(style.locator("option:checked")).toHaveText("Heading+");
  await page
    .getByRole("button", { name: "Reset style", exact: true })
    .click();
  await expect(size).toHaveValue("64");
  await expect(style.locator("option:checked")).toHaveText("Heading");
  await size.fill("72");
  await size.blur();
  await page
    .getByRole("button", {
      name: "Create Text Style from selection",
      exact: true,
    })
    .click();
  await page.getByLabel("Text Style name", { exact: true }).fill("Caption");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(style.locator("option:checked")).toHaveText("Caption");
  await page
    .getByRole("button", {
      name: "Create Text Style from selection",
      exact: true,
    })
    .click();
  await page.getByLabel("Text Style name", { exact: true }).fill(" caption ");
  await expect(page.getByRole("alert")).toHaveText(
    "A Text Style with this name already exists.",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Rename Style", exact: true }).click();
  await page.getByLabel("Text Style name", { exact: true }).fill("HEADING");
  await expect(page.getByRole("alert")).toHaveText(
    "A Text Style with this name already exists.",
  );
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(style.locator("option:checked")).toHaveText("Caption");
  await size.fill("90");
  await size.blur();
  await expect(style.locator("option:checked")).toHaveText("Caption+");
  await page.getByRole("button", { name: "Update style", exact: true }).click();
  await expect(style.locator("option:checked")).toHaveText("Caption");
  const text = page.locator("[data-editor-canvas] [data-text-content]").first();
  await expect(text).toHaveCSS("font-size", "90px");
  await style.selectOption({ label: "None" });
  await expect(text).toHaveCSS("font-size", "90px");
  await style.selectOption({ label: "Caption" });
  await page.getByRole("button", { name: "Delete Style", exact: true }).click();
  await expect(style).toHaveValue("");
  await expect(text).toHaveCSS("font-size", "90px");
  await expect(style.locator("option")).toHaveText(["None", "Heading", "Text"]);
});

test("shared styles rerender an unchanged peer and atomically measure its auto-size frame", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const style = page.getByLabel("Text Style", { exact: true });
  await style.selectOption({ label: "Heading" });
  await page
    .getByRole("button", { name: "Auto size height", exact: true })
    .click();
  // A second text box uses the same style but is never directly edited by the update.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await style.selectOption({ label: "Heading" });
  const text = page.locator("[data-editor-canvas] [data-text-content]");
  await expect(text).toHaveCount(2);
  const before = await text
    .first()
    .evaluate((e) => e.getBoundingClientRect().height);
  await page.getByLabel("Font size", { exact: true }).fill("120");
  await page.getByLabel("Font size", { exact: true }).blur();
  await page.getByRole("button", { name: "Update style", exact: true }).click();
  await expect(text.first()).toHaveCSS("font-size", "120px");
  await expect(text.last()).toHaveCSS("font-size", "120px");
  await expect
    .poll(() => text.first().evaluate((e) => e.getBoundingClientRect().height))
    .toBeGreaterThan(before);
  await expect(style.locator("option:checked")).toHaveText("Heading");
});

test("PowerPoint round trip exports effective styled typography and imports text as complete local formatting", async ({
  page,
}) => {
  const document = newPresentationDocument("Round Trip");
  const slide = document.slides[document.deck.slideIds[0]];
  const heading = document.deck.textStyles[0];
  heading.typography.fontSize = 96;
  const text = createTextElement("a");
  text.content = {
    ...(text.content as TextContent),
    text: "Imported title",
    placeholder: false,
    format: {
      kind: "style",
      styleId: heading.id,
      overrides: { color: "#ff0000" },
    },
  };
  slide.nodes[0].children = [text];
  const { pptx } = await createPowerPoint(
    { deck: document.deck, slides: [slide] },
    async () => null,
  );
  const bytes = Array.from(
    (await pptx.write({ outputType: "uint8array" })) as Uint8Array,
  );
  await page.goto("/");
  const imported = await page.evaluate(async (bytes) => {
    const parserPath = "/src/core/powerpointImport.ts";
    const documentPath = "/src/core/document.ts";
    const elementsPath = "/src/core/element.ts";
    const {
      parsePowerPoint,
    }: typeof import("../../../src/core/powerpointImport") = await import(
      /* @vite-ignore */ parserPath
    );
    const {
      newPresentationDocument,
    }: typeof import("../../../src/core/document") = await import(
      /* @vite-ignore */ documentPath
    );
    const { walkElements }: typeof import("../../../src/core/element") =
      await import(/* @vite-ignore */ elementsPath);
    const slides = await parsePowerPoint(
      new File([Uint8Array.from(bytes)], "roundtrip.pptx"),
    );
    return {
      defaults: newPresentationDocument("Imported").deck.textStyles.map(
        (s) => s.name,
      ),
      contents: slides
        .flatMap((s) => walkElements(s.elements))
        .flatMap((e) => (e.content?.type === "text" ? [e.content] : [])),
    };
  }, bytes);
  expect(imported.defaults).toEqual(["Heading", "Text"]);
  expect(imported.contents.length).toBeGreaterThan(0);
  for (const content of imported.contents) {
    expect(content.format.kind).toBe("local");
    if (content.format.kind !== "local")
      throw new Error("PowerPoint text must remain local");
    expect(content.format.typography).toMatchObject({
      color: "#ff0000",
      bold: true,
    });
  }
});

test("natural text measurement and shared style layout agree on large and portrait canvases with exact undo and redo", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const results = await page.evaluate(async () => {
    const paths = {
      document: "/src/core/document.ts",
      text: "/src/core/text.ts",
      commands: "/src/core/textStyleCommands.ts",
      layout: "/src/components/editor/textLayout.ts",
      styleLayout: "/src/components/editor/textStyleLayout.ts",
      platform: "/src/platform/index.ts",
      authority: "/src/core/documentRuntime.ts",
      typography: "/src/core/textTypography.ts",
    };
    const {
      newPresentationDocument,
    }: typeof import("../../../src/core/document") = await import(
      /* @vite-ignore */ paths.document
    );
    const {
      createTextElement,
      updateText,
    }: typeof import("../../../src/core/text") = await import(
      /* @vite-ignore */ paths.text
    );
    const {
      setTextStyle,
    }: typeof import("../../../src/core/textStyleCommands") = await import(
      /* @vite-ignore */ paths.commands
    );
    const {
      measureText,
    }: typeof import("../../../src/components/editor/textLayout") =
      await import(/* @vite-ignore */ paths.layout);
    const {
      prepareTextStyleLayout,
    }: typeof import("../../../src/components/editor/textStyleLayout") =
      await import(/* @vite-ignore */ paths.styleLayout);
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ paths.platform
    );
    const {
      DocumentRuntime,
    }: typeof import("../../../src/core/documentRuntime") = await import(
      /* @vite-ignore */ paths.authority
    );
    const {
      resolveTextTypography,
    }: typeof import("../../../src/core/textTypography") = await import(
      /* @vite-ignore */ paths.typography
    );
    const originalProjection = platform.documentProjection;
    const results = [];
    try {
      for (const [width, height] of [
        [3840, 2160],
        [1080, 1920],
      ]) {
        const document = newPresentationDocument("Layout");
        Object.assign(document.deck, { width, height });
        const slide = document.slides[document.deck.slideIds[0]];
        const heading = document.deck.textStyles[0];
        slide.nodes[0].children = ["a", "b"].map((id) => {
          const e = createTextElement(id);
          e.content = {
            ...(e.content as TextContent),
            text: "M".repeat(50),
            autoSize: "both",
            format: { kind: "style", styleId: heading.id, overrides: {} },
          };
          return e;
        });
        const runtime = new DocumentRuntime(document, {
          actorId: "local",
          durableCommit: async () => {},
        });
        const owner = runtime.authority;
        const projection = () =>
          runtime.projection(document.documentId, slide.id);
        const snapshot = await projection();
        const before = slide.nodes[0].children.map((e) => e.frame);
        const next = setTextStyle(snapshot, {
          styleId: heading.id,
          value: {
            ...heading,
            typography: { ...heading.typography, fontSize: 100 },
          },
        });
        platform.documentProjection = async (_id, pageId) =>
          runtime.projection(document.documentId, pageId);
        const operations = await prepareTextStyleLayout(snapshot, next);
        const acquired = owner.acquire("local", [
          { kind: "deck" },
          ...["a", "b"].map((elementId) => ({
            kind: "element" as const,
            slideId: slide.id,
            elementId,
          })),
        ]);
        if (acquired.denied) throw new Error("Lease denied");
        await owner.commit("local", {
          transactionId: crypto.randomUUID(),
          documentId: document.documentId,
          epoch: owner.epoch,
          baseRevision: owner.revision,
          leaseTokens: acquired.grants.map((g) => g.token),
          operations: [...operations],
        });
        owner.release(
          "local",
          acquired.grants.map((g) => g.token),
        );
        const updated = await projection();
        const frames = updated.slide.nodes[0].children.map((e) => e.frame);
        const local = updateText(snapshot, "a", { fontSize: 100 }, measureText)
          .slide.nodes[0].children[0].frame;
        const e = updated.slide.nodes[0].children[0];
        const measured = measureText(
          { ...e, content: e.content as TextContent },
          updated.deck,
        )!;
        await owner.undo("local");
        const undone = (await projection()).slide.nodes[0].children.map(
          (e) => e.frame,
        );
        await owner.redo("local");
        results.push({
          width,
          before,
          frames,
          local,
          measured,
          undone,
          redone: (await projection()).slide.nodes[0].children.map(
            (e) => e.frame,
          ),
          sizes: updated.slide.nodes[0].children.map(
            (e) =>
              resolveTextTypography(updated.deck, e.content as TextContent)
                .fontSize,
          ),
        });
      }
    } finally {
      platform.documentProjection = originalProjection;
    }
    return results;
  });
  for (const result of results) {
    expect(result.frames[0].width).toBeGreaterThan(1920);
    expect(result.frames[0].width).toBe(Math.ceil(result.measured.width) + 4);
    expect(result.frames[0]).toEqual(result.local);
    expect(result.frames[0]).toEqual(result.frames[1]);
    expect(result.undone).toEqual(result.before);
    expect(result.redone).toEqual(result.frames);
    expect(result.sizes).toEqual([100, 100]);
  }
  expect(results[0].frames).toEqual(results[1].frames);
});

test("PDF export resolves updated shared typography in the DOM before export readiness", async ({
  page,
}) => {
  const document = newPresentationDocument("PDF Styles");
  const slide = document.slides[document.deck.slideIds[0]];
  const heading = document.deck.textStyles[0];
  const element = createTextElement("pdf-text");
  element.content = {
    ...(element.content as TextContent),
    text: "Styled PDF",
    format: { kind: "style", styleId: heading.id, overrides: {} },
  };
  slide.nodes[0].children = [element];
  heading.typography = {
    ...heading.typography,
    fontSize: 137,
    italic: true,
    color: "#123456",
  };
  await page.addInitScript(
    ({ document, slide }) => {
      window.desktop = {
        documentProjection: async () => ({
          deck: document.deck,
          slide,
          templates: document.templates,
          revision: 0,
        }),
        managedFonts: async () => [],
        exportReady: async (error: string | null) => {
          const element = window.document.querySelector(
            ".pdf-export [data-text-content]",
          );
          const style = element && getComputedStyle(element);
          (window as unknown as { pdfReadiness: unknown }).pdfReadiness = {
            error,
            fontSize: style?.fontSize,
            fontStyle: style?.fontStyle,
            color: style?.color,
          };
        },
      } as unknown as typeof window.desktop;
    },
    { document, slide },
  );
  await page.goto(`/?exportPdf=${document.deck.id}`);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { pdfReadiness: unknown }).pdfReadiness,
      ),
    )
    .toEqual({
      error: null,
      fontSize: "137px",
      fontStyle: "italic",
      color: "rgb(18, 52, 86)",
    });
});
