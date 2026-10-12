import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("template objects support clipboard shortcuts while the template thumbnail has focus", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: /Templates/ }).click();
  const template = page.getByRole("button", {
    name: "Edit Template A",
    exact: true,
  });
  await template.click();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const canvas = page.locator("[data-editor-canvas]");
  await expect(canvas).toHaveAttribute("data-selection-count", "1");
  await template.focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await expect(canvas.locator("[data-element-id]")).toHaveCount(2);
});

test("returning to a template and selecting its shader frame restores keyboard deletion", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: /Templates/ }).click();
  const template = page.getByRole("button", {
    name: "Edit Template A",
    exact: true,
  });
  await template.click();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  await page
    .getByRole("region", { name: "Applied Effects" })
    .getByRole("button", { name: "Glass Distortion", exact: true })
    .click();
  const canvas = page.locator("[data-editor-canvas]");
  await page.locator('[data-context-target="slide"]').first().click();
  await template.click();
  await canvas.locator("[data-element-id]").last().click();
  await expect(canvas).toHaveAttribute("data-selection-count", "1");
  await page.keyboard.press("Backspace");
  await expect(canvas.locator("[data-element-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page.locator('[data-context-target="slide"]').first().click();
  await template.click();
  await canvas.locator("[data-element-id]").last().click();
  await page.keyboard.press("Delete");
  await expect(canvas.locator("[data-element-id]")).toHaveCount(0);
});
