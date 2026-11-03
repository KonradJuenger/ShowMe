import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

async function edit(page: Page) {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator("[data-editor-canvas] [data-text-content]")
    .dblclick({ force: true });
  const input = page.getByRole("textbox", { name: "Edit text on slide" });
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+a");
  await input.pressSequentially("Hello world");
  return input;
}

async function select(page: Page, start: number, end: number) {
  await page.locator("[data-text-editor]").evaluate(
    async (element, offsets) => {
      const path = "/src/components/editor/textRunDom.ts";
      const { writeTextDomSelection } = await import(/* @vite-ignore */ path);
      writeTextDomSelection(element, { start: offsets[0], end: offsets[1] });
      document.dispatchEvent(new Event("selectionchange"));
    },
    [start, end],
  );
}

test("selected-character bold survives typing, toolbar focus, undo, redo and browser recovery", async ({
  page,
}) => {
  const input = await edit(page);
  await select(page, 6, 11);
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await bold.click();
  await expect(input).toBeFocused();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(input.locator("span")).toHaveText("world");
  await expect(input.locator("span")).toHaveCSS("font-weight", "700");
  await input.press("ArrowRight");
  await input.pressSequentially("!");
  await expect(input).toHaveText("Hello world!");
  await input.press("Escape");
  const rendered = page.locator("[data-editor-canvas] [data-text-content]");
  await expect(rendered.locator("span")).toHaveText("world!");
  const positions = await rendered.evaluate((element) => {
    const first = document
      .createTreeWalker(element, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    const range = document.createRange();
    range.selectNodeContents(first);
    return {
      plain: range.getBoundingClientRect().top,
      bold: element.querySelector("span")!.getBoundingClientRect().top,
    };
  });
  expect(positions.bold).toBe(positions.plain);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(rendered).not.toHaveText("Hello world!");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(rendered.locator("span")).toHaveText("world!");
  const documentId = await page
    .locator("[data-editor]")
    .getAttribute("data-document-id");
  await page.reload();
  await readyEditor(page);
  const recovered = await page.evaluate(async (id) => {
    const path = "/src/platform/browser.ts";
    const { browser } = await import(/* @vite-ignore */ path);
    const projection = await browser.documentProjection(id);
    return projection.slide.nodes
      .flatMap(
        (root: { children: Array<{ content: unknown }> }) => root.children,
      )
      .map((element: { content: unknown }) => element.content);
  }, documentId);
  expect(recovered).toContainEqual(
    expect.objectContaining({
      runs: [{ text: "Hello " }, { text: "world!", fontWeight: 700 }],
    }),
  );
});

test("caret formatting controls subsequent input including composition and plain-text paste", async ({
  page,
}) => {
  const input = await edit(page);
  await select(page, 11, 11);
  await input.press("ControlOrMeta+b");
  await input.pressSequentially(" bold");
  await expect(input.locator("span")).toHaveText(" bold");
  await input.press("ControlOrMeta+b");
  await input.pressSequentially(" regular");
  await expect(input.locator("span").last()).toHaveCSS("font-weight", "400");
  await input.press("Enter");
  await input.press("ControlOrMeta+b");
  await input.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const selection = window.getSelection()!,
      range = selection.getRangeAt(0);
    range.deleteContents();
    const text = document.createTextNode("漢字");
    range.insertNode(text);
    selection.setBaseAndExtent(text, 2, text, 2);
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "漢字",
        isComposing: true,
      }),
    );
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "漢字" }),
    );
  });
  await expect(input.locator("span").last()).toHaveCSS("font-weight", "700");
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", " pasted");
    data.setData("text/html", "<b>unsafe</b>");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect(input).toContainText("漢字 pasted");
  await expect(input).not.toContainText("unsafe");
});

test("browser measurement and native rendering agree for inherited and explicit run weights", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const textPath = "/src/core/text.ts",
      layoutPath = "/src/components/editor/textLayout.ts",
      domPath = "/src/components/editor/textRunDom.ts";
    const { createTextElement, patchTextContent } = await import(
      /* @vite-ignore */ textPath
    );
    const { measureText, textMeasurementStyle, prepareTextFonts } =
      await import(/* @vite-ignore */ layoutPath);
    const { writeTextRunDom } = await import(/* @vite-ignore */ domPath);
    const element = createTextElement("measure");
    element.frame.width = 220;
    element.content = patchTextContent(element.content, {
      autoSize: "height",
      fontSize: 32,
      runs: [
        { text: "Hello " },
        { text: "world wrapping", fontWeight: 700 },
        { text: "\nregular", fontWeight: 400 },
      ],
    });
    await prepareTextFonts(element);
    const expected = measureText(element),
      host = document.createElement("div");
    Object.assign(host.style, textMeasurementStyle(element), {
      fontSize: "32px",
      width: "220px",
      lineHeight: "1.15",
      letterSpacing: "0px",
    });
    writeTextRunDom(host, element.content.runs);
    document.body.append(host);
    const actual = host.getBoundingClientRect();
    host.remove();
    return { expected, actual: { width: actual.width, height: actual.height } };
  });
  expect(result.actual).toEqual(result.expected);
});

test("native deletion preserves style inheritance and an empty editor remains empty content", async ({
  page,
}) => {
  const input = await edit(page);
  await select(page, 5, 6);
  await input.press("Backspace");
  await expect(input).toHaveText("Helloworld");
  const runs = await input.evaluate(async (element) => {
    const path = "/src/components/editor/textRunDom.ts";
    const { readTextRunDom } = await import(/* @vite-ignore */ path);
    return readTextRunDom(element);
  });
  expect(runs).toEqual([{ text: "Helloworld" }]);
  await input.press("ControlOrMeta+a");
  await input.press("Backspace");
  await expect(input).toBeEmpty();
  await input.press("Escape");
  await expect(
    page.locator("[data-editor-canvas] [data-text-content]"),
  ).toBeEmpty();
});

test("keyboard undo and redo during an active edit restore authority content without consuming redo on reentry", async ({
  page,
}) => {
  const input = await edit(page);
  await select(page, 6, 11);
  await input.press("ControlOrMeta+b");
  await expect(input.locator("span")).toHaveText("world");
  await input.press("ControlOrMeta+z");
  await expect(input).toBeFocused();
  await expect(input).not.toHaveText("Hello world");
  await input.press("ControlOrMeta+Shift+z");
  await expect(input).toBeFocused();
  await expect(input.locator("span")).toHaveText("world");
});
