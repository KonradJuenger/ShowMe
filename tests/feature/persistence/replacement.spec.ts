import { expect, test, type Page } from "@playwright/test";
import pptxgen from "pptxgenjs";
import { readyEditor } from "../../helpers/startup";

async function editNotes(page: Page) {
  return page.evaluate(async () => {
    const { platform } = await import(/* @vite-ignore */ String("/src/platform/index.ts"));
    const { EditorSession } = await import(/* @vite-ignore */ String("/src/core/editorSession.ts"));
    const { editorTransport } = await import(/* @vite-ignore */ String("/src/platform/editorTransport.ts"));
    const { setSlideNotes } = await import(/* @vite-ignore */ String("/src/core/editorCommands.ts"));
    const id = document.querySelector("[data-document-id]")!.getAttribute("data-document-id")!;
    const session = new EditorSession(id, editorTransport(platform));
    try {
      await session.loadProjection();
      session.apply(setSlideNotes(session.snapshot!, "Keep these notes"));
      await session.flush();
    } finally {
      session.dispose();
    }
    return id;
  });
}

async function upload(page: Page, buffer: Buffer) {
  await page.getByLabel("Import PowerPoint file").setInputFiles({
    name: "Imported.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer,
  });
}

test("untouched new decks can be replaced without a save prompt", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await page.locator("[data-document-id]").getAttribute("data-document-id");
  page.on("dialog", () => { throw new Error("Untouched deck prompted to save"); });
  await page.getByRole("button", { name: "Presentation menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "New presentation", exact: true }).click();
  await page.getByRole("button", { name: "Create presentation", exact: true }).click();
  await expect(page.locator("[data-document-id]")).not.toHaveAttribute("data-document-id", id!);
});

test("canceling the save decision blocks PowerPoint import before creating a replacement", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await editNotes(page);
  const prompts: string[] = [];
  page.on("dialog", async dialog => {
    prompts.push(dialog.message());
    await dialog.dismiss();
  });
  await upload(page, Buffer.from("Invalid PowerPoint should never be parsed"));
  await expect(page.getByRole("dialog", { name: "Importing PowerPoint", exact: true })).not.toBeVisible();
  await expect.poll(() => prompts.length).toBe(2);
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id);
  await expect(page.getByText(/PowerPoint should never/)).toHaveCount(0);
});

test("PowerPoint import saves modified work before opening the imported deck", async ({ page }) => {
  const pptx = new pptxgen();
  pptx.addSlide().addText("Imported slide", { x: 1, y: 1, w: 4, h: 1 });
  const buffer = Buffer.from(await pptx.write({ outputType: "uint8array" }) as Uint8Array);
  await page.goto("/");
  await readyEditor(page);
  const id = await editNotes(page);
  let prompts = 0;
  page.on("dialog", async dialog => { prompts++; await dialog.accept(); });
  await upload(page, buffer);
  await expect(page.locator("[data-document-id]")).not.toHaveAttribute("data-document-id", id);
  expect(prompts).toBe(1);
  const saved = await page.evaluate(async id => {
    const { platform } = await import(/* @vite-ignore */ String("/src/platform/index.ts"));
    const projection = await platform.documentProjection!(id);
    return { revision: projection.revision, savedRevision: projection.savedRevision, notes: projection.slide.notes };
  }, id);
  expect(saved).toMatchObject({ revision: 1, savedRevision: 1, notes: "Keep these notes" });
});

test("save failures block PowerPoint replacement and retain the current document", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await editNotes(page);
  await page.evaluate(async () => {
    const { browser } = await import(/* @vite-ignore */ String("/src/platform/browser.ts"));
    browser.saveDocument = async () => { throw new Error("Save failed before import"); };
  });
  page.on("dialog", dialog => dialog.accept());
  await upload(page, Buffer.from("Invalid PowerPoint should never be parsed"));
  await expect(page.getByRole("alert").filter({ hasText: "Save failed before import" })).toBeVisible();
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id);
});

test("untouched decks import PowerPoint without a prompt and failed parsing preserves the deck", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await page.locator("[data-document-id]").getAttribute("data-document-id");
  page.on("dialog", () => { throw new Error("Untouched deck prompted to save"); });
  await upload(page, Buffer.from("Invalid PowerPoint"));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id!);
  const pptx = new pptxgen();
  pptx.addSlide().addText("Imported", { x: 1, y: 1, w: 4, h: 1 });
  await upload(page, Buffer.from(await pptx.write({ outputType: "uint8array" }) as Uint8Array));
  await expect(page.locator("[data-document-id]")).not.toHaveAttribute("data-document-id", id!);
});

test("canceling replacement protects modified work for both New and Recent", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const { platform } = await import(/* @vite-ignore */ String("/src/platform/index.ts"));
    await platform.createDocument("Recent target");
  });
  const id = await editNotes(page);
  page.on("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Presentation menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "New presentation", exact: true }).click();
  await page.getByRole("button", { name: "Create presentation", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New presentation", exact: true })).not.toBeVisible();
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id);
  await page.getByRole("button", { name: "Presentation menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Recent target", exact: true }).click();
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id);
});

test("canceling Save As blocks PowerPoint replacement", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await editNotes(page);
  await page.evaluate(async () => {
    const { browser } = await import(/* @vite-ignore */ String("/src/platform/browser.ts"));
    browser.saveDocument = async () => null;
  });
  let prompts = 0;
  page.on("dialog", async dialog => { prompts++; await dialog.accept(); });
  await upload(page, Buffer.from("Invalid PowerPoint should never be parsed"));
  await expect.poll(() => prompts).toBe(1);
  await expect(page.getByRole("dialog", { name: "Importing PowerPoint", exact: true })).not.toBeVisible();
  await expect(page.locator("[data-document-id]")).toHaveAttribute("data-document-id", id);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
