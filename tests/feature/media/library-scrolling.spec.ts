import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    mediaScrollHarness: typeof import("../../helpers/nativeMediaLibraryHarness");
  }
}

test("inserting enriched Library metadata still verifies bytes and rejects a changed managed asset", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness({ includeFolders: true, deferRefresh: false, rejectVerifiedAsset: true });
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  await panel.getByRole("button", { name: "Select item-000.png", exact: true }).dblclick();
  await expect(panel.getByText("Error: Asset hash mismatch: managed file changed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.mediaScrollHarness.verifiedLibraryAssetRequests)).toEqual(["a".repeat(64)]);
  expect(await page.evaluate(() => window.mediaScrollHarness.insertedLibraryAssets)).toEqual([]);
});

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

  await expect(
    panel.getByRole("option", { name: "Audio", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("option", { name: "Other", exact: true }),
  ).toHaveCount(0);
  await panel.getByLabel("Media type filter").selectOption("video");
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

test("Media actions stay above a stable scrolling viewport during selection and folder commands", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness({
      includeFolders: true,
      deferRefresh: false,
    });
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  const list = panel.getByLabel("Media Library", { exact: true });
  const folder = panel.getByRole("button", {
    name: "Select folder Brand Assets",
    exact: true,
  });
  await expect(folder).toBeVisible();

  for (const width of [240, 280, 320, 360]) {
    await panel.evaluate((node, value) => {
      node.style.width = `${value}px`;
    }, width);
    await expect
      .poll(() => panel.evaluate((node) => node.clientWidth))
      .toBe(width);
    const before = await list.boundingBox();
    await folder.click();
    expect((await list.boundingBox())?.y).toBe(before?.y);
    await panel.getByLabel("Selected item actions", { exact: true }).click();
    const commands = panel.getByRole("group", { name: "Item commands" });
    await expect(commands).toBeVisible();
    const bounds = await panel.boundingBox();
    const menu = await commands.boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width,
    );
    expect((await list.boundingBox())?.y).toBe(before?.y);
    await commands
      .getByRole("button", { name: "Move to Folder…", exact: true })
      .click();
    await expect(panel.getByLabel("Destination folder")).toBeFocused();
    expect((await list.boundingBox())?.y).toBe(before?.y);
    await page.keyboard.press("Escape");
    await expect(
      panel.getByLabel("Selected item actions", { exact: true }),
    ).toBeFocused();
    await panel.getByLabel("Selected item actions", { exact: true }).click();
    await panel
      .getByRole("button", { name: "New Folder with Selection…", exact: true })
      .click();
    await expect(
      panel.getByRole("textbox", { name: "Folder name" }),
    ).toBeFocused();
    expect((await list.boundingBox())?.y).toBe(before?.y);
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "Close item actions" }).click();
    expect((await list.boundingBox())?.y).toBe(before?.y);
  }

  await panel
    .getByRole("button", { name: "Actions for Brand Assets", exact: true })
    .click();
  await expect(
    panel.getByRole("group", { name: "Item commands" }),
  ).toBeVisible();
  await expect(
    panel.getByLabel("Selected item actions", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await folder.click();
  await panel
    .getByRole("button", { name: "Select folder Photos", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText("2 selected");
  const header = panel.getByRole("region", { name: "Selected Library items" });
  const beforeScroll = await header.boundingBox();
  await list.evaluate((node) => {
    node.scrollTop = 500;
  });
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect((await header.boundingBox())?.y).toBe(beforeScroll?.y);
  await expect(header).toBeVisible();
});

test("Folder names are visible at rest and folders and media support normal double-click and keyboard activation", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness({
      includeFolders: true,
      deferRefresh: false,
    });
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  const folder = panel.getByRole("button", {
    name: "Select folder Brand Assets",
    exact: true,
  });
  await expect(folder.getByText("Brand Assets", { exact: true })).toBeVisible();
  await expect(
    panel
      .getByRole("button", { name: "Select folder Photos", exact: true })
      .getByText("Photos", { exact: true }),
  ).toBeVisible();
  await folder.dblclick();
  const breadcrumbs = panel.getByRole("navigation", { name: "Current folder" });
  await expect(
    breadcrumbs.getByRole("button", { name: "Brand Assets", exact: true }),
  ).toBeVisible();
  await breadcrumbs
    .getByRole("button", { name: "Images", exact: true })
    .click();
  await folder.focus();
  await page.keyboard.press("Enter");
  await expect(
    breadcrumbs.getByRole("button", { name: "Brand Assets", exact: true }),
  ).toBeVisible();
  await breadcrumbs
    .getByRole("button", { name: "Images", exact: true })
    .click();
  const media = panel.getByRole("button", {
    name: "Select item-000.png",
    exact: true,
  });
  await media.dblclick();
  await media.focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => window.mediaScrollHarness.insertedLibraryAssets),
  ).toEqual(["item-000.png", "item-000.png"]);
});

test("Compact Media navigation keeps ancestor links and stable layout without redundant folder controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/tests/helpers/nativeMediaLibraryHarness.tsx";
    window.mediaScrollHarness = await import(/* @vite-ignore */ modulePath);
    window.mediaScrollHarness.mountNativeMediaLibraryHarness({
      includeFolders: true,
      deferRefresh: false,
    });
  });
  const panel = page.getByRole("region", { name: "Media scroll test" });
  const list = panel.getByLabel("Media Library", { exact: true });
  const folder = panel.getByRole("button", {
    name: "Select folder Brand Assets",
    exact: true,
  });
  await expect(folder).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Up one folder", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByLabel("Browse folders", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("navigation", { name: "Current folder" }),
  ).toHaveCount(0);
  const initial = await list.boundingBox();
  await folder.dblclick();
  await panel
    .getByRole("button", { name: "Select folder Logos", exact: true })
    .dblclick();
  const breadcrumbs = panel.getByRole("navigation", { name: "Current folder" });
  await expect(
    breadcrumbs.getByRole("button", { name: "Logos", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(
    panel.getByRole("button", { name: "Select folder Exports", exact: true }),
  ).toBeVisible();
  expect((await list.boundingBox())?.y).toBe(initial?.y);
  await breadcrumbs
    .getByRole("button", { name: "Brand Assets", exact: true })
    .click();
  await expect(
    breadcrumbs.getByRole("button", { name: "Brand Assets", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await breadcrumbs
    .getByRole("button", { name: "Images", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Select folder Photos", exact: true }),
  ).toBeVisible();
  expect((await list.boundingBox())?.y).toBe(initial?.y);
});
