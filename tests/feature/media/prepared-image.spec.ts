import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { readyEditor } from "../../helpers/startup";

async function importImage(page: Page) {
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
    .setInputFiles({ name: "Shared.png", mimeType: "image/png", buffer });
  const image = page
    .locator("[data-editor-stage] [data-media-asset-id] img")
    .first();
  await expect(image).toHaveAttribute("data-source-width", "2048");
  await expect(
    page.locator('[data-editor-stage] [data-media-loading="true"]'),
  ).toHaveCount(0);
  return image;
}

test("editor reuses the audience variant and canvas zoom creates no additional image variants", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const image = await importImage(page);
  const shared = await page.evaluate(async () => {
    const { platform } = (await import(
      "/src/platform/index.ts" as string
    )) as typeof import("../../../src/platform");
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await platform.documentProjection!(id);
    const profile = await platform.audienceImageProfile!(id);
    const editor = await platform.preparedSlideImages!(id, projection.slide.id);
    const audience = await platform.preparedSlideImages!(
      id,
      projection.slide.id,
      profile,
    );
    const first = Object.keys(editor)[0];
    const result = {
      editor: editor[first],
      audience: audience[first],
      jobs: (await platform.presentationImageDiagnostics!()).jobs,
    };
    for (const images of [editor, audience])
      for (const url of new Set(
        Object.values(images).flatMap((image) => (image ? [image.url] : [])),
      ))
        platform.releaseUrl(url);
    return result;
  });
  expect(shared.editor).not.toBeNull();
  expect(shared.editor!.hash).toBe(shared.audience!.hash);
  await expect(image).toHaveAttribute("src", shared.editor!.url);
  expect(
    await image.evaluate((node: HTMLImageElement) => [
      node.naturalWidth,
      node.naturalHeight,
    ]),
  ).toEqual([shared.audience!.width, shared.audience!.height]);
  const canvas = page.locator("[data-editor-stage] .slide-renderer");
  const before = (await canvas.boundingBox())!.width;
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect
    .poll(async () => (await canvas.boundingBox())!.width)
    .not.toBe(before);
  await expect(
    page.locator('[data-editor-stage] [data-media-loading="true"]'),
  ).toHaveCount(0);
  await expect(image).toHaveAttribute("src", shared.editor!.url);
  expect(
    await page.evaluate(async () => {
      const { platform } = (await import(
        "/src/platform/index.ts" as string
      )) as typeof import("../../../src/platform");
      return (await platform.presentationImageDiagnostics!()).jobs;
    }),
  ).toBe(shared.jobs);
});

test("editor follows audience output changes and shares its exact image dimensions", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("showme-image-cache-format", "jpg"));
  const image = await importImage(page);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const audience = await popup;
  await audience.setViewportSize({ width: 1111, height: 777 });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { platform } = (await import(
          "/src/platform/index.ts" as string
        )) as typeof import("../../../src/platform");
        const id = document
          .querySelector("[data-editor]")!
          .getAttribute("data-document-id")!;
        return platform.audienceImageProfile!(id);
      }),
    )
    .toEqual({ width: 1111, height: 777 });
  const expected = await page.evaluate(async () => {
    const { platform } = (await import(
      "/src/platform/index.ts" as string
    )) as typeof import("../../../src/platform");
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await platform.documentProjection!(id);
    const images = await platform.preparedSlideImages!(id, projection.slide.id);
    const image = Object.values(images).find((image) => image)!;
    const result = [image.width, image.height];
    for (const url of new Set(
      Object.values(images).flatMap((image) => (image ? [image.url] : [])),
    ))
      platform.releaseUrl(url);
    return result;
  });
  const dimensions = (node: HTMLImageElement) => [
    node.naturalWidth,
    node.naturalHeight,
  ];
  await expect.poll(() => image.evaluate(dimensions)).toEqual(expected);
  const audienceImage = audience
    .locator("[data-active-slide] [data-media-asset-id] img")
    .first();
  await expect.poll(() => audienceImage.evaluate(dimensions)).toEqual(expected);
});

async function harness(page: Page) {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/tests/helpers/preparedImageHarness.tsx";
    const {
      mountPreparedImageHarness,
    }: typeof import("../../helpers/preparedImageHarness") = await import(
      /* @vite-ignore */ path
    );
    mountPreparedImageHarness();
  });
  await expect(page.getByLabel("Requests")).toHaveText("1");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Displayed resolution")).toHaveText("100");
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

test("image cache format setting changes displayed variants, reuses PNG on switching back and persists", async ({ page }) => {
  const image = await importImage(page);
  const mime = () => image.evaluate(async (node: HTMLImageElement) => (await fetch(node.src)).headers.get("content-type"));
  await expect.poll(mime).toBe("image/png");
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page.getByRole("menuitem", { name: "Settings…", exact: true }).click();
  const setting = page.getByRole("combobox", { name: "Image cache format" });
  await expect(setting).toHaveValue("png");
  await setting.selectOption("jpg");
  await expect(setting).toHaveValue("jpg");
  await expect.poll(mime).toBe("image/jpeg");
  const jobs = await page.evaluate(async () => {
    const { platform } = await import("/src/platform/index.ts" as string) as typeof import("../../../src/platform");
    return (await platform.presentationImageDiagnostics!()).jobs;
  });
  await setting.selectOption("png");
  await expect.poll(mime).toBe("image/png");
  expect(await page.evaluate(async () => {
    const { platform } = await import("/src/platform/index.ts" as string) as typeof import("../../../src/platform");
    return (await platform.presentationImageDiagnostics!()).jobs;
  })).toBe(jobs);
  await setting.selectOption("jpg");
  await expect.poll(mime).toBe("image/jpeg");
  await page.reload();
  await readyEditor(page);
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page.getByRole("menuitem", { name: "Settings…", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Image cache format" })).toHaveValue("jpg");
});
