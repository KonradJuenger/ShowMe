import { expect, type Page } from "@playwright/test";

export async function readyEditor(page: Page) {
  const setup = page.getByRole("main", { name: "First launch setup" });
  await expect(page.locator("[data-editor]").or(setup)).toBeVisible();
  if (await setup.isVisible()) {
    await setup.getByLabel("Library mode").selectOption("keep-all");
    await setup.getByRole("button", { name: "Start creating" }).click();
  }
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
}
