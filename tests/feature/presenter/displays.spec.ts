import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("screen popup supports dragging, keyboard assignments, reset and locks when Present starts", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/tests/helpers/presentationDisplaysHarness.tsx";
    const {
      mountPresentationDisplaysHarness,
    }: typeof import("../../helpers/presentationDisplaysHarness") =
      await import(/* @vite-ignore */ path);
    mountPresentationDisplaysHarness();
  });
  const setup = page.getByRole("button", { name: "Presentation screen setup" });
  await setup.click();
  const dialog = page.getByRole("dialog", { name: "Presentation screens" });
  const laptop = dialog.getByLabel("Screen 1: Laptop", { exact: true });
  const projector = dialog.getByLabel("Screen 2: Projector", { exact: true });
  const monitor = dialog.getByLabel("Screen 3: Monitor", { exact: true });
  await expect(laptop.getByText("Presenter", { exact: true })).toBeVisible();
  await expect(projector.getByText("Audience", { exact: true })).toBeVisible();
  await projector.getByText("Audience", { exact: true }).dragTo(laptop);
  await expect(dialog.getByLabel("Audience view")).toHaveValue("7");
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("8");
  await laptop.getByText("Audience", { exact: true }).dragTo(monitor);
  await expect(dialog.getByLabel("Audience view")).toHaveValue("9");
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("8");
  await dialog.getByLabel("Presenter view").selectOption("9");
  await expect(dialog.getByLabel("Audience view")).toHaveValue("8");
  await dialog
    .getByRole("button", { name: "Reset to default screens" })
    .click();
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("7");
  await expect(dialog.getByLabel("Audience view")).toHaveValue("8");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(setup).toBeFocused();
  await setup.click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(setup).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(setup).toBeEnabled();
});

test("presenter resizing reuses rasters while audience resolution upgrades exactly", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/tests/helpers/presenterImagesHarness.tsx";
    const {
      mountPresenterImagesHarness,
    }: typeof import("../../helpers/presenterImagesHarness") = await import(
      /* @vite-ignore */ path
    );
    mountPresenterImagesHarness();
  });
  const presenter = page
    .getByRole("region", { name: "Presenter raster" })
    .locator("img");
  const audience = page
    .getByRole("region", { name: "Audience raster" })
    .locator("img");
  await expect
    .poll(() =>
      presenter.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(600);
  await expect
    .poll(() =>
      audience.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(600);
  await expect(page.getByLabel("Image requests")).toHaveText("2");
  const source = await presenter.getAttribute("src");
  await page.getByRole("button", { name: "Resize presenter preview" }).click();
  await expect(page.getByLabel("Preview scale")).toHaveText("0.5");
  await expect(page.getByLabel("Image requests")).toHaveText("2");
  await expect(presenter).toHaveAttribute("src", source!);
  await page.getByRole("button", { name: "Choose 4K audience screen" }).click();
  // This fixture's 600-unit frame doubles at 3840/1920 audience scale.
  // The expected 1200 pixels are a derived sample size, not a product limit.
  await expect
    .poll(() =>
      audience.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1200);
  // Audience sampling is exact. The presenter may retain a softer raster or
  // reuse a larger one, provided it still displays decoded source content.
  await expect
    .poll(() =>
      presenter.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(presenter).toBeVisible();
  await expect(presenter).toHaveAttribute("data-source-width", "4096");
});
