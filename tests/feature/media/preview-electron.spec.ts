import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createBasicShape } from "../../../src/core/elementFactory";
import { readyEditor } from "../../helpers/startup";
import { imageIdentity, planPresentationImages } from "../../../src/core/presentationImages";
import { newPresentationDocument } from "../../../src/core/document";
import { createMediaElement } from "../../../src/core/media";
import { DocumentStorage } from "../../../electron/storage";
import { blankEffect } from "../../../src/core/effectAuthoring";

test("closing the editor destroys effect thumbnails and prevents queued previews from recreating hidden windows", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-effect-close-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  Object.assign(env, { SHOWME_TESTING: "1", SHOWME_TEST_ROOT_SELECTION: folder, SHOWME_DOCUMENT_DIR: path.join(folder, "presentations") });
  const app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`], env });
  let output = "";
  app.process().stdout?.on("data", chunk => { output += String(chunk); });
  app.process().stderr?.on("data", chunk => { output += String(chunk); });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    const definition = blankEffect("css-js");
    expect(await page.evaluate(definition => window.desktop!.effectThumbnail!(definition), definition)).toMatch(/^data:image\/png;base64,/);
    const preview = app.windows().find(window => window.url().includes("slidePreview=1"))!;
    await preview.evaluate(() => {
      Object.assign(window, {
        queuedEffectStarted: false,
        composeEffectThumbnail: async () => {
          Object.assign(window, { queuedEffectStarted: true });
          await new Promise(() => {});
        },
      });
    });
    const jobs = page.evaluate(async definition => Promise.all(Array.from({ length: 12 }, (_, index) =>
      window.desktop!.effectThumbnail!({ ...definition, name: `Pending ${index}` }).catch(() => null))), definition).catch(() => null);
    await expect.poll(() => preview.evaluate(() => (window as unknown as { queuedEffectStarted: boolean }).queuedEffectStarted)).toBe(true);
    await app.evaluate(({ app, BrowserWindow }) => {
      const editor = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes("slidePreview=1"))!;
      let closed = false;
      editor.once("closed", () => { closed = true; });
      app.on("browser-window-created", () => {
        if (closed) process.stdout.write("SHOWME_PREVIEW_RECREATED_AFTER_CLOSE\n");
      });
    });
    const exited = app.waitForEvent("close", { timeout: 10000 });
    // Exercise accepted teardown with the scripted discard of this untitled
    // fixture, rather than waiting for a native unsaved-changes dialog.
    let closeResult: unknown;
    const closeCommand = page.evaluate(() => window.desktop!.requestClose!(document.querySelector("[data-editor]")!.getAttribute("data-document-id")!))
      .then(result => { closeResult = result; }, error => { closeResult = String(error); });
    try {
      await exited;
    } catch (error) {
      console.log("Windows remaining after close:", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), visible: window.isVisible() }))));
      console.log("Editor:", await page.locator("body").innerText().catch(() => "closed"));
      console.log("Close command:", closeResult);
      console.log(output);
      throw error;
    }
    await closeCommand;
    await jobs;
    expect(output).not.toContain("SHOWME_PREVIEW_RECREATED_AFTER_CLOSE");
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});

test("opening a cold presentation caches every slide before navigation and keeps readiness green on later slides", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-open-images-"));
  const userData = path.join(folder, "user");
  const storage = new DocumentStorage(path.join(userData, "assets"), path.join(folder, "fixture-cache"), "keep-all");
  await storage.init();
  const model = newPresentationDocument("Cold presentation");
  const first = model.slides[model.deck.slideIds[0]], meta = model.deck.slideMeta[first.id];
  model.deck.slideIds = [];
  model.deck.slideMeta = {};
  model.slides = {};
  for (let index = 0; index < 20; index++) {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3,
      background: { r: index * 10, g: 100, b: 200 } } }).png().toBuffer();
    const asset = { ...await storage.importAssetData(`Image${index}.png`, bytes), width: 64, height: 64 };
    await storage.updateAsset(asset);
    const slide = { ...structuredClone(first), id: `slide${index}` };
    slide.nodes[0].children = [createMediaElement("image", asset)];
    model.deck.slideIds.push(slide.id);
    model.deck.slideMeta[slide.id] = { ...meta, name: `Slide ${index + 1}`, hidden: index === 19 };
    model.slides[slide.id] = slide;
  }
  const file = path.join(folder, "Cold presentation.sme");
  await writeFile(file, JSON.stringify(model));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({ args: [path.resolve("."), file, `--user-data-dir=${userData}`], env });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    await expect.poll(() => page.evaluate(id => window.desktop!.imageReadiness!(id), model.documentId))
      .toMatchObject({ total: 20, completed: 20, state: "ready" });
    await expect(page.locator(".readiness-indicator")).toHaveAttribute("data-state", "ready");
    const before = await page.evaluate(() => window.desktop!.presentationImageDiagnostics!());
    expect(before.jobs).toBe(20);
    await page.evaluate(() => {
      const states: Array<string | null> = [];
      Object.assign(window, { observedImageStates: states });
      const indicator = document.querySelector(".readiness-indicator")!;
      new MutationObserver(() => states.push(indicator.getAttribute("data-state")))
        .observe(indicator, { attributes: true, attributeFilter: ["data-state"] });
    });
    for (const index of [18, 8, 0]) {
      await page.getByRole("tree", { name: "Slides", exact: true }).evaluate((tree, index) => {
        tree.scrollTop = tree.scrollHeight * index / 20;
      }, index);
      await page.getByRole("button", { name: `Slide ${index + 1}`, exact: true }).click();
      await expect(page.locator("[data-editor-stage] .slide-renderer")).toHaveAttribute("data-slide-id", `slide${index}`);
      await expect.poll(() => page.locator("[data-editor-stage] img").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    expect(await page.evaluate(() => window.desktop!.presentationImageDiagnostics!())).toMatchObject({ jobs: before.jobs });
    expect(await page.evaluate(() => (window as unknown as { observedImageStates: string[] }).observedImageStates.every(state => state === "ready")))
      .toBe(true);
    await expect(page.locator(".readiness-indicator")).toHaveAttribute("data-state", "ready");
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});

test("native cache format persists and serves opaque JPG while preserving transparent PNG", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-native-format-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const args = [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`];
  let app = await electron.launch({ args, env });
  try {
    let page = await app.firstWindow();
    await readyEditor(page);
    const opaque = await sharp({ create: { width: 128, height: 96, channels: 4, background: "#33aaee" } }).png().toBuffer();
    const alpha = await sharp({ create: { width: 128, height: 96, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const opaqueId = createHash("sha256").update(opaque).digest("hex"), alphaId = createHash("sha256").update(alpha).digest("hex");
    await page.getByTestId("import-files").setInputFiles([{ name: "Opaque.png", mimeType: "image/png", buffer: opaque }, { name: "Alpha.png", mimeType: "image/png", buffer: alpha }]);
    const opaqueImage = page.locator(`[data-editor-stage] [data-media-asset-id="${opaqueId}"] img`);
    const alphaImage = page.locator(`[data-editor-stage] [data-media-asset-id="${alphaId}"] img`);
    await expect(opaqueImage).toHaveAttribute("src", /\.png$/);
    await page.getByRole("button", { name: "Presentation menu" }).click();
    await page.getByRole("menuitem", { name: "Settings…", exact: true }).click();
    await page.getByRole("combobox", { name: "Image cache format" }).selectOption("jpg");
    await expect(opaqueImage).toHaveAttribute("src", /\.jpg$/);
    await expect(alphaImage).toHaveAttribute("src", /\.png$/);
    const jpeg = await opaqueImage.evaluate(async (node: HTMLImageElement) => {
      const response = await fetch(node.src);
      return { type: response.headers.get("content-type"), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    });
    expect(jpeg.type).toBe("image/jpeg");
    expect((await sharp(Buffer.from(jpeg.bytes)).metadata()).chromaSubsampling).toBe("4:4:4");
    const png = await alphaImage.evaluate(async (node: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(node.src)).arrayBuffer())));
    const pixels = await sharp(Buffer.from(png)).raw().toBuffer();
    expect(pixels[3]).toBeGreaterThan(0);
    expect(pixels[3]).toBeLessThan(255);
    await app.evaluate(({ app }) => app.exit(0));
    await app.close().catch(() => {});
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(path.join(folder, "user", "settings.json"), "utf8")).imageCacheFormat).toBe("jpg");
    app = await electron.launch({ args, env });
    page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.desktop!.getImageCacheFormat!())).toBe("jpg");
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});

test("native image thumbnails reuse audience variants without generating thumbnail image derivatives", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-image-preview-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`], env });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    const buffer = await sharp({ create: { width: 4096, height: 2160, channels: 4, background: "#00ff00" } }).png().toBuffer();
    await page.getByTestId("import-files").setInputFiles({ name: "Large.png", mimeType: "image/png", buffer });
    await expect(page.locator("[data-editor-stage] img").first()).toHaveAttribute("data-source-width", "4096");
    const projection = await page.evaluate(() => window.desktop!.documentProjection!(document.querySelector("[data-editor]")!.getAttribute("data-document-id")!));
    await expect(page.locator(".empty-thumb > img").first()).toBeVisible();
    const thumbnail = await page.locator(".empty-thumb > img").first().elementHandle();
    await app.evaluate(({ BrowserWindow }, documentId) => {
      const editor = BrowserWindow.getAllWindows().find(window =>
        !/[?&](present|slidePreview|export)=/.test(window.webContents.getURL()))!;
      editor.webContents.send("document-invalidated", { documentId });
    }, projection.documentId);
    await page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await thumbnail!.evaluate(image => image instanceof HTMLImageElement && image.isConnected && image.complete && image.naturalWidth > 0),
      "The last decoded thumbnail stays visible during resource recapture").toBe(true);
    const profile = { width: 321, height: 181 };
    const audienceProfile = await page.evaluate(id => window.desktop!.audienceImageProfile!(id), projection.documentId);
    const requirement = planPresentationImages(projection.deck, [projection.slide], audienceProfile)[0];
    const jobs = await page.evaluate(async () => (await window.desktop!.presentationImageDiagnostics!()).jobs);
    const hash = createHash("sha256").update(imageIdentity(requirement.assetId, Math.min(4096, requirement.width), Math.min(2160, requirement.height))).digest("hex");
    const data = await page.evaluate(({ projection, profile }) => window.desktop!.capturePreview!(projection, profile.width, profile.height), { projection, profile });
    expect(data).toMatch(/^data:image\/png;base64,/);
    expect(await page.evaluate(async () => (await window.desktop!.presentationImageDiagnostics!()).jobs)).toBe(jobs);
    const files = await readdir(path.join(folder, "user", "image-cache"), { recursive: true });
    expect(files.some((file) => path.basename(file) === hash + ".png")).toBe(true);
    const result = await sharp(Buffer.from(data!.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
    expect(result.info).toMatchObject(profile);
    const center = (90 * 321 + 160) * result.info.channels;
    expect([...result.data.subarray(center, center + 3)]).toEqual([0, 255, 0]);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});

test("native rail composition captures canonical custom CSS pixels, excludes editor overlays and releases the surface", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-preview-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  Object.assign(env, { SHOWME_TESTING: "1", SHOWME_TEST_ROOT_SELECTION: folder });
  const app = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    const shape = createBasicShape("custom-preview", "rectangle", {
      x: 0,
      y: 0,
    });
    shape.frame.width = 1920;
    shape.frame.height = 1080;
    const projection = await page.evaluate(async (shape) => {
      const desktop = window.desktop!,
        id = document
          .querySelector("[data-editor]")!
          .getAttribute("data-document-id")!;
      const before = await desktop.documentProjection!(id),
        parentId = before.slide.nodes[0].id;
      const lease = await desktop.documentAcquireLeases!(id, [
        { kind: "structure", slideId: before.slide.id, parentId },
        { kind: "deck" },
      ]);
      if (lease.denied) throw new Error("Preview lease denied");
      const tokens = lease.grants.map((grant) => grant.token);
      try {
        await desktop.documentCommit!(id, {
          transactionId: crypto.randomUUID(),
          documentId: id,
          epoch: before.epoch,
          baseRevision: before.revision,
          leaseTokens: tokens,
          operations: [
            {
              type: "elements.insert",
              slideId: before.slide.id,
              parentId,
              elements: [shape],
            },
            {
              type: "deck.properties.set",
              changes: {
                stylesheet:
                  '[data-element-id="custom-preview"] * { background: rgb(0,255,0) !important; }',
              },
            },
          ],
        });
      } finally {
        await desktop.documentReleaseLeases!(id, tokens);
      }
      // Overlay would corrupt an editor-window screenshot.
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "red",
        zIndex: "999999",
      });
      document.body.append(overlay);
      return desktop.documentProjection!(id);
    }, shape);
    const data = await page.evaluate(
      (projection) => window.desktop!.capturePreview!(projection, 320, 180),
      projection,
    );
    expect(data).toMatch(/^data:image\/png;base64,/);
    const decoded = await sharp(Buffer.from(data!.split(",")[1], "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 320, height: 180 });
    const center = (90 * 320 + 160) * 4;
    expect([...decoded.data.subarray(center, center + 4)]).toEqual([
      0, 255, 0, 255,
    ]);
    const preview = app
      .windows()
      .find((window) => window.url().includes("slidePreview=1"))!;
    await expect(preview.locator(".slide-renderer")).toHaveCount(0);
    expect(
      await page.evaluate(
        (id) => window.desktop!.documentProjection!(id),
        projection.documentId,
      ),
    ).toEqual(projection);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});
