import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createBasicShape } from "../../../src/core/elementFactory";
import { readyEditor } from "../../helpers/startup";
import { imageIdentity, planPresentationImages } from "../../../src/core/presentationImages";

test("native image thumbnails prepare their small derivative instead of falling back to full originals", async () => {
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
    const requirement = planPresentationImages(projection.deck, [projection.slide], profile)[0];
    const hash = createHash("sha256").update(imageIdentity(requirement.assetId, Math.min(4096, requirement.width), Math.min(2160, requirement.height))).digest("hex");
    const data = await page.evaluate(({ projection, profile }) => window.desktop!.capturePreview!(projection, profile.width, profile.height), { projection, profile });
    expect(data).toMatch(/^data:image\/png;base64,/);
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
