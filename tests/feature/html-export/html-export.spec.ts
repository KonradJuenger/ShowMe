import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { createHtmlExport } from "../../../electron/export/html";
import {
  htmlExportFixture,
  hostileText,
} from "../../helpers/htmlExportFixture";

test.beforeAll(() => {
  execFileSync(process.execPath, [
    path.resolve("node_modules/vite/bin/vite.js"),
    "build",
    "--config",
    "vite.html-export.config.ts",
  ]);
});

test("standalone file renders canonical text, worker, GLSL and embedded media offline across click stages and restart", async ({
  page,
}, info) => {
  const dir = info.outputPath("standalone");
  await mkdir(dir, { recursive: true });
  const svg = path.join(info.outputPath(), "fixture.svg");
  const png = path.join(info.outputPath(), "fixture.png");
  await sharp({
    create: { width: 320, height: 180, channels: 4, background: "red" },
  })
    .png()
    .toFile(png);
  await writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>',
  );
  const result = await createHtmlExport({
    document: htmlExportFixture(),
    runtimeVersion: "test",
    runtimeDirectory: path.resolve("dist-html-export"),
    managedFonts: async () => [],
    resolveAsset: async (id) =>
      id === "video"
        ? {
            file: path.resolve("tests/fixtures/media/native-motion.webm"),
            mime: "video/webm",
          }
        : id === "image"
          ? { file: png, mime: "image/png" }
          : { file: svg, mime: "image/svg+xml" },
  });
  expect(
    result.warnings.filter(
      (w) => w.code === "unsupported-browser-scene-texture",
    ),
  ).toEqual([]);
  const file = path.join(dir, "presentation.html");
  await writeFile(file, result.html);
  expect(await readdir(dir)).toEqual(["presentation.html"]);
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.context().setOffline(true);
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (!blocked) {
        blocked = true;
        return Promise.reject(
          new DOMException("Autoplay requires a gesture", "NotAllowedError"),
        );
      }
      return play.call(this);
    };
  });
  await page.goto(pathToFileURL(file).href);
  expect(
    await page.evaluate(() => ({
      desktop: typeof window.desktop,
      require: typeof (globalThis as Record<string, unknown>).require,
    })),
  ).toEqual({ desktop: "undefined", require: "undefined" });
  await expect(page.locator("#showme-html-payload")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start presentation" }),
  ).toHaveCount(0);
  const main = page.locator("main");
  await expect(main).toHaveAttribute("data-awaiting-audience", "false");
  await expect(
    page.locator('[data-active-slide] [data-element-id="text"]'),
  ).toContainText(hostileText + " worker");
  const before = await page
    .locator('[data-active-slide] [data-element-id="text"]')
    .evaluate((n) => getComputedStyle(n).transform);
  await page.keyboard.press("ArrowRight");
  await expect(main).toHaveAttribute("data-index", "0");
  await expect
    .poll(() =>
      page
        .locator('[data-active-slide] [data-element-id="text"]')
        .evaluate((n) => getComputedStyle(n).transform),
    )
    .not.toBe(before);
  await page.keyboard.press("ArrowRight");
  await expect(main).toHaveAttribute("data-index", "1");
  await expect(main).toHaveAttribute("data-awaiting-audience", "false");
  await expect(
    page.locator('[data-active-slide] [data-effect-ready="true"] canvas'),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "Play video" }).click();
  await expect
    .poll(() =>
      page
        .locator("[data-active-slide] video")
        .evaluate((n: HTMLVideoElement) => ({
          ready: n.readyState >= 2,
          muted: n.muted,
          playing: !n.paused,
        })),
    )
    .toEqual({ ready: true, muted: true, playing: true });
  await expect(
    page.locator('[data-active-slide] [data-media-asset-id="svg"] img'),
  ).toBeVisible();
  await page.keyboard.press("r");
  await expect
    .poll(() =>
      page
        .locator("[data-active-slide] video")
        .evaluate((n: HTMLVideoElement) => !n.paused && n.readyState >= 2),
    )
    .toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(main).toHaveAttribute("data-index", "0");
  await expect(main).toHaveAttribute("data-awaiting-audience", "false");
  await page.keyboard.press("Escape");
  await expect(main).toHaveAttribute("data-index", "-1");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Start presentation" }),
  ).toHaveCount(0);
  await expect(main).toHaveAttribute("data-awaiting-audience", "false");
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await page.screenshot({ path: info.outputPath("standalone.png") });
});

test("initial SVG decoding holds canonical clocks and input until preparation completes", async ({
  page,
}, info) => {
  const document = htmlExportFixture();
  const svg = structuredClone(document.slides[1].nodes[0].children[1]);
  document.slides[0].nodes[0].children.push(svg);
  const file = info.outputPath("delayed.html"),
    asset = info.outputPath("image.svg");
  await writeFile(
    asset,
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>',
  );
  const result = await createHtmlExport({
    document,
    runtimeVersion: "test",
    runtimeDirectory: path.resolve("dist-html-export"),
    managedFonts: async () => [],
    resolveAsset: async (id) =>
      id === "video"
        ? {
            file: path.resolve("tests/fixtures/media/native-motion.webm"),
            mime: "video/webm",
          }
        : { file: asset, mime: "image/svg+xml" },
  });
  await writeFile(file, result.html);
  await page.addInitScript(() => {
    const original = HTMLImageElement.prototype.decode;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(window, { releaseHtmlImages: release });
    HTMLImageElement.prototype.decode = async function () {
      await gate;
      await original.call(this);
    };
  });
  await page.goto(pathToFileURL(file).href);
  await expect(
    page.getByRole("button", { name: "Start presentation" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-active-slide] [data-media-loading="true"]'),
  ).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("main")).toHaveAttribute(
    "data-awaiting-audience",
    "true",
  );
  await expect(page.locator("main")).toHaveAttribute("data-index", "0");
  const clock = () =>
    page
      .locator("[data-active-slide] [data-effect-id]")
      .first()
      .evaluate((n) => (n as HTMLElement).style.getPropertyValue("--t"));
  expect(Number(await clock())).toBe(0);
  await page.evaluate(() =>
    (window as unknown as { releaseHtmlImages(): void }).releaseHtmlImages(),
  );
  await expect(page.locator("main")).toHaveAttribute(
    "data-awaiting-audience",
    "false",
  );
  await expect.poll(clock).not.toBe("0");
});
