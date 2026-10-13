import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { readyEditor } from "../../helpers/startup";

declare global {
  interface Window {
    canvasImageChanges: string[];
    canvasImageRequests: number;
  }
}

test("small production canvas resizes neither request nor replace the displayed variant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await readyEditor(page);
  const buffer = await sharp({
    create: {
      width: 2048,
      height: 1200,
      channels: 4,
      background: { r: 220, g: 80, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await page
    .getByTestId("import-files")
    .setInputFiles({ name: "Resize.png", mimeType: "image/png", buffer });
  const image = page
    .locator("[data-editor-stage] [data-media-asset-id] img")
    .first();
  await expect(image).toHaveAttribute("data-source-width", "2048");
  await expect(
    page.locator('[data-editor-stage] [data-media-loading="true"]'),
  ).toHaveCount(0);
  const original = await image.getAttribute("src");
  await image.evaluate((node) => {
    window.canvasImageChanges = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "src" &&
          mutation.target === node
        )
          window.canvasImageChanges.push("source changed");
        if (!node.isConnected) window.canvasImageChanges.push("image removed");
      }
    });
    observer.observe(document.querySelector("[data-editor-stage]")!, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  });
  await page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    const prepare = platform.preparedSlideImages!;
    window.canvasImageRequests = 0;
    platform.preparedSlideImages = (...args) => {
      if (args[2]?.sampling === "canvas") window.canvasImageRequests++;
      return prepare(...args);
    };
  });
  const handle = page.locator('[data-selection-handle="se"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 2, {
    steps: 3,
  });
  await page.mouse.up();
  await expect(
    page.locator('[data-editor-stage] [data-media-loading="true"]'),
  ).toHaveCount(0);
  await expect(image).toHaveAttribute("src", original!);
  expect(await page.evaluate(() => window.canvasImageRequests)).toBe(0);
  expect(await page.evaluate(() => window.canvasImageChanges)).toEqual([]);
});

async function harness(page: Page, canvasSampling = false) {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async (canvasSampling) => {
    const path = "/tests/helpers/preparedImageHarness.tsx";
    const {
      mountPreparedImageHarness,
    }: typeof import("../../helpers/preparedImageHarness") = await import(
      /* @vite-ignore */ path
    );
    mountPreparedImageHarness(canvasSampling);
  }, canvasSampling);
  await expect(page.getByLabel("Requests")).toHaveText("1");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Displayed resolution")).toHaveText(
    canvasSampling ? "256" : "100",
  );
}

test("resize retains the displayed image and requests the final resolution only after release", async ({
  page,
}) => {
  await harness(page);
  const image = page.getByRole("img", { name: "Canvas image" });
  const original = await image.getAttribute("src");
  await page.getByRole("button", { name: "Begin resize" }).click();
  await page.getByRole("button", { name: "Enlarge" }).click();
  await page.getByRole("button", { name: "Enlarge" }).click();
  await expect(page.getByLabel("Gesture")).toHaveText("resizing");
  await expect(page.getByLabel("Requests")).toHaveText("1");
  await expect(image).toHaveAttribute("src", original!);
  await page.getByRole("button", { name: "End resize" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("2");
  await expect(image).toHaveAttribute("src", original!);
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Displayed resolution")).toHaveText("300");
  await expect(image).not.toHaveAttribute("src", original!);
  await expect(page.getByLabel("Displayed URL releases")).toHaveText("0");
});

test("canvas reuses its decoded image within a tier and upgrades upwards across the boundary", async ({
  page,
}) => {
  await harness(page, true);
  const image = page.getByRole("img", { name: "Canvas image" });
  const original = await image.getAttribute("src");
  await page.getByRole("button", { name: "Begin resize" }).click();
  await page.getByRole("button", { name: "Enlarge" }).click();
  await page.getByRole("button", { name: "End resize" }).click();
  await expect(page.getByLabel("Gesture")).toHaveText("idle");
  await expect(page.getByLabel("Requests")).toHaveText("1");
  await expect(page.getByLabel("Released images")).toHaveText("0");
  await expect(page.getByLabel("Displayed resolution")).toHaveText("256");
  await expect(image).toHaveAttribute("src", original!);
  await page.getByRole("button", { name: "Begin resize" }).click();
  await page.getByRole("button", { name: "Enlarge" }).click();
  await page.getByRole("button", { name: "End resize" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("2");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Displayed resolution")).toHaveText("512");
  await expect(image).not.toHaveAttribute("src", original!);
});

test("an in-flight upgrade cannot replace the displayed image during resize", async ({
  page,
}) => {
  await harness(page);
  await page.getByRole("button", { name: "Enlarge" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("2");
  await page.getByRole("button", { name: "Begin resize" }).click();
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Released images")).toHaveText("1");
  await expect(page.getByLabel("Displayed resolution")).toHaveText("100");
  await page.getByRole("button", { name: "End resize" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("3");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Displayed resolution")).toHaveText("200");
});

test("explicit cache invalidation still rechecks a retained canvas tier", async ({
  page,
}) => {
  await harness(page, true);
  await page.getByRole("button", { name: "Clear cache" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("2");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Released images")).toHaveText("1");
  await expect(page.getByLabel("Displayed URL releases")).toHaveText("0");
  await expect(page.getByLabel("Displayed resolution")).toHaveText("256");
});

test("exact presentation rechecks retain identical decoded pixels and release only the redundant URL", async ({
  page,
}) => {
  await harness(page);
  const source = await page
    .getByRole("img", { name: "Canvas image" })
    .getAttribute("src");
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    const counter = document.createElement("output");
    counter.setAttribute("aria-label", "Repeated decodes");
    counter.textContent = "0";
    document.body.append(counter);
    let calls = 0;
    HTMLImageElement.prototype.decode = function () {
      counter.textContent = String(++calls);
      return decode.call(this);
    };
  });
  await page.getByRole("button", { name: "Clear cache" }).click();
  await expect(page.getByLabel("Requests")).toHaveText("2");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Released images")).toHaveText("1");
  await expect(page.getByLabel("Displayed URL releases")).toHaveText("0");
  await expect(page.getByRole("img", { name: "Canvas image" })).toHaveAttribute(
    "src",
    source!,
  );
  await expect(page.getByLabel("Repeated decodes")).toHaveText("0");
});
