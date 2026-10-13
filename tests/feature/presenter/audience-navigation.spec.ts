import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

async function settleAudience(page: Page) {
  await expect
    .poll(async () => {
      await page.clock.runFor(80);
      return page.evaluate(
        () => window.audienceNavigationHarness.snapshot().awaitingAudience,
      );
    })
    .toBe(false);
}

test("a late slide with a new image is prepared during the preceding slide instead of blocking audience navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await readyEditor(page);
  await page.clock.install();
  await page.evaluate(async () => {
    const path = "/tests/helpers/audienceNavigationHarness.tsx";
    const {
      mountAudienceNavigationHarness,
    }: typeof import("../../helpers/audienceNavigationHarness") = await import(
      /* @vite-ignore */ path
    );
    mountAudienceNavigationHarness();
  });
  await settleAudience(page);
  // Early navigation reuses the same already-prepared image.
  await page.evaluate(() => window.audienceNavigationHarness.jump(1));
  await settleAudience(page);
  const early = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );

  await page.evaluate(() => window.audienceNavigationHarness.jump(23));
  await settleAudience(page);
  await page.clock.runFor(1000);
  await page.evaluate(() => window.audienceNavigationHarness.releaseImages());
  await page.clock.runFor(160);
  const beforeLateEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await page.evaluate(() => window.audienceNavigationHarness.jump(24));
  await expect(
    page.locator("[data-active-slide] .slide-renderer"),
  ).toHaveAttribute(
    "data-slide-id",
    await page.evaluate(
      () => window.audienceNavigationHarness.snapshot().slideId,
    ),
  );
  await page.clock.runFor(3000);
  const lateEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await page.evaluate(() => window.audienceNavigationHarness.releaseImages());
  await settleAudience(page);
  await page.evaluate(() => window.audienceNavigationHarness.jump(23));
  await settleAudience(page);
  await page.evaluate(() => window.audienceNavigationHarness.jump(24));
  await settleAudience(page);
  const warmEntry = await page.evaluate(() =>
    window.audienceNavigationHarness.snapshot(),
  );
  await testInfo.attach("synthetic-audience-navigation.json", {
    body: JSON.stringify(
      { early, beforeLateEntry, lateEntry, warmEntry },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(early.pendingVariants).toBe(0);
  expect(warmEntry.pendingVariants).toBe(0);
  expect(warmEntry.coldVariants).toBe(lateEntry.coldVariants);
  expect(
    lateEntry.coldVariants - beforeLateEntry.coldVariants,
    "Slide 25 must not start uncached image work after navigation; prepare and decode it while slide 24 is shown",
  ).toBe(0);
  expect(
    lateEntry.awaitingAudience,
    "Entering a prepared neighbour must not wait for image IO",
  ).toBe(false);
});
