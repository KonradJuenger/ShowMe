import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    mediaScrollHarness: typeof import("../../helpers/nativeMediaLibraryHarness");
  }
}

test("Media scrolling survives a pending inventory refresh and paginated results while category navigation resets it", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness();
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  const list = panel.getByLabel("Media Library", { exact: true });
  await expect(
    panel.getByRole("button", { name: "Select item-000.png", exact: true }),
  ).toBeVisible();
  const top = await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight * 0.55;
    return node.scrollTop;
  });
  expect(top).toBeGreaterThan(1000);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        window.mediaScrollHarness.mediaLibraryRequests.includes(120),
      ),
    )
    .toBe(true);
  await expect(
    panel.getByRole("button", { name: "Select item-198.png", exact: true }),
  ).toBeVisible();

  await page.evaluate(async () =>
    window.mediaScrollHarness.notifyMediaInventoryChanged(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          window.mediaScrollHarness.mediaLibraryRequests.filter(
            (offset) => offset === 0,
          ).length,
      ),
    )
    .toBe(2);
  await expect(list).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(top, 0);
  await page.evaluate(async () =>
    window.mediaScrollHarness.finishMediaInventoryRefresh(),
  );
  await expect(
    panel.getByRole("button", { name: "Select item-198.png", exact: true }),
  ).toBeVisible();
  expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(top, 0);

  await panel.getByLabel("Media type filter").selectOption("audio");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mediaScrollHarness.mediaLibraryRequests.filter(
            (offset) => offset === 0,
          ).length,
      ),
    )
    .toBe(3);
  await page.evaluate(async () =>
    window.mediaScrollHarness.finishMediaInventoryRefresh(),
  );
  await expect(
    panel.getByRole("button", { name: "Select item-000.png", exact: true }),
  ).toBeVisible();
  expect(
    await panel
      .getByLabel("Media Library", { exact: true })
      .evaluate((node) => node.scrollTop),
  ).toBe(0);
});
