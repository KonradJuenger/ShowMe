import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("failed browser Save leaves accepted edits dirty", async ({ page }) => {
  await page.goto("/");
  await readyEditor(page);
  const result = await page.evaluate(async () => {
    const browserPath = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ browserPath);
    const editorTransportPath = "/src/platform/editorTransport.ts";
    const {
      editorTransport,
    }: typeof import("../../../src/platform/editorTransport") = await import(
      /* @vite-ignore */ editorTransportPath
    );
    const EditorSessionPath = "/src/core/editorSession.ts";
    const { EditorSession }: typeof import("../../../src/core/editorSession") =
      await import(/* @vite-ignore */ EditorSessionPath);
    const setSlideNotesPath = "/src/core/editorCommands.ts";
    const { setSlideNotes }: typeof import("../../../src/core/editorCommands") =
      await import(/* @vite-ignore */ setSlideNotesPath);
    const document = (await browser.createDocument("Failed save"))!;
    const session = new EditorSession(document.id, editorTransport(browser));
    try {
      await session.loadProjection();
      session.apply(setSlideNotes(session.snapshot!, "Unsaved"));
      await session.flush();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (key === "document/" + document.id)
          throw new Error("Injected write failure");
        return put.call(this, value, key);
      };
      let failure = "";
      try {
        await browser.saveDocument!(document.id);
      } catch (error) {
        failure = String(error);
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      await session.refreshProjection();
      return {
        failure,
        dirty: session.isDirty,
        savedRevision: session.savedRevision,
        revision: session.revision,
      };
    } finally {
      session.dispose();
      await browser.closeDocument!(document.id);
    }
  });
  expect(result.failure).toContain("Injected write failure");
  expect(result).toMatchObject({ dirty: true, savedRevision: 0, revision: 1 });
});

test("second browser context refuses writing until the owner closes", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const id = await page.evaluate(async () => {
    const browserPath = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ browserPath);
    const document = (await browser.createDocument("Owned"))!;
    await browser.documentProjection!(document.id);
    return document.id;
  });
  const other = await context.newPage();
  await other.goto("/");
  await readyEditor(other);
  const denied = await other.evaluate(async (id) => {
    const browserPath = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ browserPath);
    try {
      await browser.documentProjection!(id);
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, id);
  expect(denied).toContain("already being edited in another tab");
  await page.evaluate(async (id) => {
    const browserPath = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ browserPath);
    await browser.closeDocument!(id);
  }, id);
  const revision = await other.evaluate(async (id) => {
    const browserPath = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ browserPath);
    return (await browser.documentProjection!(id)).revision;
  }, id);
  expect(revision).toBe(0);
});
