import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import type { mountFramePaintHarness } from "../../helpers/framePaintHarness";
type PaintWindow = Window & {
  paint: ReturnType<typeof mountFramePaintHarness>;
};

async function mount(page: Page, mixed = false) {
  await page.goto("/");
  await page
    .locator("[data-editor]")
    .or(page.getByRole("main", { name: "First launch setup" }))
    .waitFor();
  await page.evaluate(async (mixed) => {
    const path = "/tests/helpers/framePaintHarness.tsx";
    const {
      mountFramePaintHarness,
    }: typeof import("../../helpers/framePaintHarness") = await import(
      /* @vite-ignore */ path
    );
    (window as unknown as PaintWindow).paint = mountFramePaintHarness(mixed);
  }, mixed);
  await page.locator('[data-element-id="left"]').waitFor();
}

async function seam(page: Page, dpr: number) {
  const bounds = await page.locator('[data-element-id="left"]').boundingBox();
  if (!bounds) throw new Error("Frame not rendered");
  const { data, info } = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const y = Math.floor((bounds.y + bounds.height / 2) * dpr);
  const rgb = (x: number) =>
    Array.from(
      data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3),
    );
  const interior = rgb(Math.floor((bounds.x + bounds.width / 4) * dpr));
  const edge = (bounds.x + bounds.width) * dpr;
  for (let x = Math.floor(edge) - 1; x <= Math.ceil(edge) + 1; x++)
    expect(rgb(x)).toEqual(interior);
}

test("adjacent translucent fills stay seamless through fractional pan, zoom and display density without saving rounded geometry", async ({
  browser,
}) => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    await mount(page);
    for (const scale of [0.25, 0.33, 0.67, 1.25])
      for (const pan of [0, 0.375, 0.625]) {
        await page.evaluate(
          ({ scale, pan }) =>
            (window as unknown as PaintWindow).paint.viewport(scale, pan),
          { scale, pan },
        );
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await seam(page, dpr);
        expect(
          await page.evaluate(() =>
            (window as unknown as PaintWindow).paint.inspect(),
          ),
        ).toMatchObject({ unchanged: true, writes: 0, revision: 0 });
      }
    await context.close();
  }
});

test("pixel paint preserves text layout and rotated objects while moving a fill through authority history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await mount(page, true);
  const text = page.locator('[data-element-id="text"] [data-text-content]');
  const font = await text.evaluate((node) => getComputedStyle(node).fontSize);
  await page.evaluate(() =>
    (window as unknown as PaintWindow).paint.viewport(0.67, 0.375),
  );
  expect(await text.evaluate((node) => getComputedStyle(node).fontSize)).toBe(
    font,
  );
  const left = page.locator('[data-element-id="left"]');
  const before = await page.evaluate(() =>
    (window as unknown as PaintWindow).paint.inspect(),
  );
  const bounds = await left.boundingBox();
  if (!bounds) throw new Error("Frame not rendered");
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y + 10, { steps: 4 });
  // Check the local preview before release commits the document transaction.
  await expect
    .poll(async () => {
      const fill = await left.boundingBox();
      const selection = await page.locator(".selection-bounds").boundingBox();
      if (!fill || !selection) return Infinity;
      return Math.max(
        Math.abs(fill.x - selection.x),
        Math.abs(fill.y - selection.y),
        Math.abs(fill.x - bounds.x - 20),
        Math.abs(fill.y - bounds.y - 10),
      );
    })
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() =>
      (window as unknown as PaintWindow).paint.inspect(),
    ),
  ).toMatchObject({ unchanged: true, writes: 0, revision: 0 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (window as unknown as PaintWindow).paint.inspect(),
          )
        ).revision,
    )
    .toBe(1);
  const moved = await page.evaluate(() =>
    (window as unknown as PaintWindow).paint.inspect(),
  );
  expect(moved.frames[0].width).toBe(before.frames[0].width);
  expect(moved.frames[0].x - before.frames[0].x).toBeCloseTo(20 / 0.67, 4);
  expect(moved.frames[2]).toEqual(before.frames[2]);
  expect(moved.frames[3]).toEqual(before.frames[3]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (window as unknown as PaintWindow).paint.inspect(),
          )
        ).frames[0],
    )
    .toEqual(before.frames[0]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (window as unknown as PaintWindow).paint.inspect(),
          )
        ).frames[0],
    )
    .toEqual(moved.frames[0]);
});
