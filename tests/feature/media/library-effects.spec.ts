import { expect, test } from "@playwright/test";

test("clicking Library Effects applies once while selection mode and malformed files remain management actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness();
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  await expect(
    panel.getByRole("button", { name: "Select item-000.png", exact: true }),
  ).toBeVisible();
  await panel.getByLabel("Media type filter").selectOption("Effects");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mediaScrollHarness.mediaLibraryRequests.filter(
            (offset) => offset === 0,
          ).length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    window.mediaScrollHarness.finishMediaInventoryRefresh(),
  );
  const apply = panel.getByRole("button", {
    name: "Apply effect Library Glow",
    exact: true,
  });
  await apply.click();
  expect(
    await page.evaluate(() =>
      window.mediaScrollHarness.appliedLibraryEffects.map(
        (definition) => definition.name,
      ),
    ),
  ).toEqual(["Library Glow"]);
  await apply.dblclick();
  expect(
    await page.evaluate(
      () => window.mediaScrollHarness.appliedLibraryEffects.length,
    ),
  ).toBe(2);
  await panel
    .getByRole("button", { name: "Select broken.txt", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => window.mediaScrollHarness.appliedLibraryEffects.length,
    ),
  ).toBe(2);
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await panel
    .getByRole("button", { name: "Select Library Glow", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("1 selected");
  expect(
    await page.evaluate(
      () => window.mediaScrollHarness.appliedLibraryEffects.length,
    ),
  ).toBe(2);
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await panel
    .getByRole("button", { name: "Actions for Library Glow", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => window.mediaScrollHarness.appliedLibraryEffects.length,
    ),
  ).toBe(2);
});
