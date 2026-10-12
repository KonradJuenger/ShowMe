import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("editor errors copy their full text by click or Enter and report clipboard failures", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await readyEditor(page);
  const message = "Unable to prepare package\nDetails: media is unavailable";
  await page.evaluate(async (message) => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    platform.saveDocument = async () => {
      throw new Error(message);
    };
  }, message);
  await page.keyboard.press("Control+s");
  const error = page.getByRole("button", {
    name: /^Error: Unable to prepare package/,
  });
  await expect(error).toBeVisible();
  await error.click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.clipboard.readText()).replaceAll("\r\n", "\n"),
      ),
    )
    .toBe(`Error: ${message}`);
  await expect(
    page
      .getByRole("status")
      .getByText("Error copied to clipboard", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await error.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.clipboard.readText()).replaceAll("\r\n", "\n"),
      ),
    )
    .toBe(`Error: ${message}`);
  await page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    platform.writeTextClipboard = async () => {
      throw new Error("Clipboard unavailable");
    };
  });
  await error.click();
  await expect(
    page.getByText("Could not copy error to clipboard", { exact: true }),
  ).toBeVisible();
  await expect(error).toHaveText(`Error: ${message}`);
});
