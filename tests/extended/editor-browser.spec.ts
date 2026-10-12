import { test, expect } from "@playwright/test";
import { readyEditor } from "../helpers/startup";

test("footer commands remain reachable after shrinking a window with a wide inspector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await readyEditor(page);
  const separator = page.getByRole("separator", { name: "Sidebar width" });
  await separator.focus();
  for (let step = 0; step < 18; step++) await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "560");
  await page.setViewportSize({ width: 880, height: 620 });

  const footer = page.locator("footer");
  await expect
    .poll(async () =>
      footer.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll("button")).every((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.bottom <= window.innerHeight
          );
        });
      }),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Click Timeline", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Click Timeline", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Speaker Notes", exact: true })
    .click();
  await expect(
    page.getByLabel("Presenter notes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
});

test("browser storage reopens an editor-created presentation after reload", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page
    .getByRole("menuitem", { name: "New presentation", exact: true })
    .click();
  await page.getByLabel("New presentation name").fill("Browser lifecycle");
  await page
    .getByRole("button", { name: "Create presentation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const elements = page.locator("[data-editor-stage] [data-element-id]");
  await expect(elements).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Present", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page
    .getByRole("menuitem", { name: "Browser lifecycle", exact: true })
    .click();
  await expect(elements).toHaveCount(1);
});
