import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createBasicShape } from "../../../src/core/elementFactory";
import { readyEditor } from "../../helpers/startup";

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
