import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("font selections apply before blur and weights reflect installed faces", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "queryLocalFonts", {
      value: async () => [
        { family: "Arial", style: "Regular" },
        { family: "Arial", style: "Bold" },
        { family: "Verdana", style: "Regular" },
        { family: "Verdana", style: "Bold" },
      ],
    });
  });
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const weight = page.getByLabel("Font weight", { exact: true });
  await weight.focus();
  await expect(weight.locator("option")).toHaveText([
    "Regular (400)",
    "Bold (700)",
  ]);
  const font = page.getByRole("combobox", { name: "Font family", exact: true });
  await font.click();
  await page.getByRole("option", { name: "Verdana", exact: true }).click();
  await expect(font).toBeFocused();
  await expect(
    page.locator('[data-element-id] [style*="font-family: Verdana"]'),
  ).not.toHaveCount(0);
  await expect(weight.locator("option")).toHaveText([
    "Regular (400)",
    "Bold (700)",
  ]);
  await font.click();
  await font.fill("Ar");
  await expect(
    page.locator('[data-element-id] [style*="font-family: Verdana"]'),
  ).not.toHaveCount(0);
  await font.press("Escape");
  await expect(font).toHaveValue("Verdana");
});
