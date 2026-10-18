import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DocumentStorage } from "../../electron/storage";
import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../src/core/document";
import {
  createBasicShape,
  createEmptyFrame,
} from "../../src/core/elementFactory";
import { createMediaElement } from "../../src/core/media";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { projectAgentSlide } from "../../src/core/agentProjection";
import type {
  AgentPreviewRequest,
  AgentPreviewResult,
} from "../../src/core/agentPreview";
import { readyEditor } from "../helpers/startup";

async function launch() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-agent-preview-"));
  const root = path.join(folder, "root"),
    user = path.join(folder, "user");
  const library = path.join(root, "ShowMe Library");
  await mkdir(library, { recursive: true });
  await mkdir(user);
  const storage = new DocumentStorage(
    library,
    path.join(folder, "fixture-cache"),
    "keep-all",
  );
  await storage.init();
  const bytes = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 255, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const asset = {
    ...(await storage.importAssetData("Private image.png", bytes)),
    width: 64,
    height: 64,
  };
  await storage.updateAsset(asset);
  const model = newPresentationDocument("Preview fixture");
  model.deck.width = 640;
  model.deck.height = 360;
  const slide = model.slides[model.deck.slideIds[0]];
  const template = model.templates[model.deck.defaultTemplateId];
  template.background = "#112233";
  const band = createBasicShape("inherited", "rectangle", { x: 0, y: 340 });
  band.frame.width = 640;
  band.frame.height = 20;
  band.appearance.fill = "#ffcc00";
  template.nodes[0].children = [band];
  const group = createEmptyFrame("group", { x: 40, y: 40 });
  group.frame.width = 160;
  group.frame.height = 100;
  const red = createBasicShape("nested", "rectangle", { x: 0, y: 0 });
  red.frame.width = 160;
  red.frame.height = 100;
  red.appearance.fill = "#ff0000";
  group.effects = [
    {
      id: "css-instance",
      resourceId: "css",
      enabled: true,
      placement: "content",
      parameters: {},
    },
  ];
  group.children = [red];
  const shader = createBasicShape("shader", "rectangle", { x: 250, y: 40 });
  shader.frame.width = 100;
  shader.frame.height = 100;
  shader.effects = [
    {
      id: "shader-instance",
      resourceId: "shader",
      enabled: true,
      placement: "background",
      parameters: {},
    },
  ];
  shader.appearance.fill = null;
  const image = createMediaElement("image", asset, { x: 400, y: 40 });
  image.frame.width = 100;
  image.frame.height = 100;
  const missing = structuredClone(image);
  missing.id = "missing";
  missing.frame.x = 520;
  if (missing.content && missing.content.type !== "text")
    missing.content.assetId = "f".repeat(64);
  const text = createTextElement("text", { x: 40, y: 200 });
  text.frame.width = 400;
  text.frame.height = 90;
  if (text.content?.type === "text" && text.content.format.kind === "local") {
    text.content.text = "Preview title";
    text.content.format.typography.fontSize = 40;
    text.content.format.typography.color = "#ffffff";
    text.content.autoSize = "none";
  }
  const bad = createBasicShape("fallback", "rectangle", { x: 520, y: 200 });
  bad.frame.width = 80;
  bad.frame.height = 80;
  bad.effects = [
    {
      id: "bad-instance",
      resourceId: "bad",
      enabled: true,
      placement: "content",
      parameters: {},
    },
  ];
  slide.nodes[0].children = [group, shader, image, missing, text, bad];
  slide.effectResources = {
    css: { ...blankEffect("css-js"), source: ":scope { opacity: 0.5; }" },
    shader: {
      ...blankEffect("shader"),
      target: "background",
      input: "none",
      source:
        "#version 300 es\nprecision highp float;\nin vec2 v_uv; out vec4 outColor;\nvoid main() { outColor = vec4(0.0, 0.0, 1.0, 1.0); }",
    },
    bad: { ...blankEffect("shader"), source: "PRIVATE_INVALID_SHADER_SOURCE" },
  };
  slide.notes = "PRIVATE_SPEAKER_NOTES";
  const file = path.join(root, "Preview.sme");
  await writeFile(
    file,
    JSON.stringify(presentationDocumentSchema.parse(model)),
  );
  await writeFile(
    path.join(user, "settings.json"),
    JSON.stringify({
      showMeRootPath: root,
      libraryLifecycleMode: "keep-all",
      storageWarningSeen: true,
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        ![
          "ELECTRON_RUN_AS_NODE",
          "SHOWME_DOCUMENT_DIR",
          "SHOWME_DEV_URL",
        ].includes(key) && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    args: [path.resolve("."), file, `--user-data-dir=${user}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    return { app, page, folder, documentId: model.documentId };
  } catch (error) {
    await close(app, folder);
    throw error;
  }
}
async function close(app: ElectronApplication, folder: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
const capture = (page: Page, request: AgentPreviewRequest) =>
  page.evaluate((request) => window.desktop!.agentPreview!(request), request);
async function requestFor(
  page: Page,
  documentId: string,
): Promise<AgentPreviewRequest> {
  const projection = await page.evaluate(
    (id) => window.desktop!.renderProjection!(id),
    documentId,
  );
  return {
    documentId,
    epoch: projection.epoch,
    revision: projection.revision,
    slideId: projection.slide.id,
    width: 320,
    height: 180,
  };
}
function code(result: AgentPreviewResult) {
  if (result.ok) throw new Error("Expected preview rejection");
  expect(result).not.toHaveProperty("pngDataUrl");
  return result.error.code;
}

test("context inspection and native preview preserve production pixels diagnostics and live editor state", async () => {
  const { app, page, folder, documentId } = await launch();
  try {
    const request = await requestFor(page, documentId);
    expect(code(await capture(page, request))).toBe("MCP_DISABLED");
    await page
      .getByRole("button", { name: "Presentation menu", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Settings…", exact: true })
      .click();
    await page.getByLabel("Enable MCP", { exact: true }).check();
    await expect
      .poll(() =>
        page
          .evaluate(() => window.desktop!.agentContext!())
          .then((value) => value.availability),
      )
      .toBe("ready");
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    const context = await page.evaluate(() => window.desktop!.agentContext!());
    const projection = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      documentId,
    );
    expect(
      projectAgentSlide(projection).elements.find(
        ({ id }) => id === "inherited",
      )!.source,
    ).toBe("template");
    // A capture of the editor DOM would be completely red.
    await page.evaluate(() => {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        background: "red",
        zIndex: "999999",
      });
      document.body.append(overlay);
    });
    const result = await capture(page, request);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result).toMatchObject({
      documentId,
      epoch: request.epoch,
      revision: request.revision,
      slideId: request.slideId,
      width: 320,
      height: 180,
      mimeType: "image/png",
      state: "base",
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_MEDIA",
          elementIds: ["missing"],
        }),
        expect.objectContaining({
          code: "EFFECT_FALLBACK",
          effectInstanceIds: ["bad-instance"],
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|Private image|[A-Z]:\\/,
    );
    const decoded = await sharp(
      Buffer.from(result.pngDataUrl.split(",")[1], "base64"),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({
      width: 320,
      height: 180,
      channels: 4,
    });
    const pixel = (x: number, y: number) => [
      ...decoded.data.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4),
    ];
    expect(pixel(5, 5)).toEqual([17, 34, 51, 255]);
    expect(pixel(150, 45)).toEqual([0, 0, 255, 255]);
    // Native capture/downsampling can round a color channel by one 8-bit level.
    expect(
      pixel(20, 175).every(
        (value, index) => Math.abs(value - [255, 204, 0, 255][index]) <= 1,
      ),
    ).toBe(true);
    // CSS opacity and the alpha image both composite over the template background.
    expect(
      pixel(40, 45)
        .slice(0, 3)
        .every((value, index) => Math.abs(value - [136, 17, 26][index]) <= 1),
    ).toBe(true);
    expect(
      pixel(225, 45)
        .slice(0, 3)
        .every((value, index) => Math.abs(value - [8, 145, 25][index]) <= 1),
    ).toBe(true);
    const textPixels = await sharp(
      Buffer.from(result.pngDataUrl.split(",")[1], "base64"),
    )
      .extract({ left: 20, top: 100, width: 200, height: 45 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(
      [...textPixels].some(
        (_, i) =>
          i % 4 === 0 &&
          textPixels[i] > 220 &&
          textPixels[i + 1] > 220 &&
          textPixels[i + 2] > 220,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        (id) => window.desktop!.documentProjection!(id),
        documentId,
      ),
    ).toEqual(projection);
    const after = await page.evaluate(() => window.desktop!.agentContext!());
    expect(after.editor).toEqual(context.editor);
    expect(after.uiEpoch).toBe(context.uiEpoch);
    const preview = app
      .windows()
      .find((value) => value.url().includes("slidePreview=1"))!;
    const viewport = await preview.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    // Windows display scaling may round the native logical viewport by one pixel;
    // the PNG dimensions above remain exact and capture never uses deck resolution.
    expect(Math.abs(viewport.width - request.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(viewport.height - request.height)).toBeLessThanOrEqual(1);
    await expect(preview.locator(".slide-renderer")).toHaveCount(0);
    const denied = await preview.evaluate(async (request) => {
      try {
        await window.desktop!.agentPreview!(request);
        return "allowed";
      } catch (error) {
        return String(error);
      }
    }, request);
    expect(denied).toContain("Unauthorized window");
  } finally {
    await close(app, folder);
  }
});

test("native preview waits for surface readiness and discards revoked or stale in-flight output", async () => {
  const { app, page, folder, documentId } = await launch();
  try {
    await page.evaluate(() => window.desktop!.setMcpEnabled!(true));
    const request = await requestFor(page, documentId);
    expect((await capture(page, request)).ok).toBe(true);
    const preview = app
      .windows()
      .find((value) => value.url().includes("slidePreview=1"))!;
    // Model an Effect surface whose preparation completes after initial layout.
    // The capture must wait for readiness, without restarting the request.
    await preview.evaluate(() => {
      const host = document.getElementById("root")!;
      Object.assign(window, { readinessHeld: false });
      const observer = new MutationObserver(() => {
        if (!host.querySelector(".slide-renderer")) return;
        observer.disconnect();
        const pending = document.createElement("div");
        pending.dataset.effectId = "preparing-surface";
        pending.dataset.effectReady = "false";
        pending.style.display = "none";
        host.append(pending);
        Object.assign(window, {
          readinessHeld: true,
          releaseReadiness: () => pending.remove(),
        });
      });
      observer.observe(host, { childList: true, subtree: true });
    });
    await page.evaluate((request) => {
      Object.assign(window, {
        readinessComplete: false,
        readinessResult: window.desktop!.agentPreview!(request).then(
          (value) => {
            Object.assign(window, { readinessComplete: true });
            return value;
          },
        ),
      });
    }, request);
    await expect
      .poll(() =>
        preview.evaluate(
          () => (window as unknown as { readinessHeld: boolean }).readinessHeld,
        ),
      )
      .toBe(true);
    await preview.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { readinessComplete: boolean })
            .readinessComplete,
      ),
    ).toBe(false);
    await preview.evaluate(() =>
      (
        window as unknown as { releaseReadiness: () => void }
      ).releaseReadiness(),
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              readinessResult: Promise<AgentPreviewResult>;
            }
          ).readinessResult,
      ),
    ).toMatchObject({ ok: true });
    await preview.evaluate(() => {
      const compose = window.composeSlidePreview!;
      Object.assign(window, { previewEntered: false, releasePreview: null });
      window.composeSlidePreview = async (...args) => {
        Object.assign(window, { previewEntered: true });
        await new Promise<void>((resolve) =>
          Object.assign(window, { releasePreview: resolve }),
        );
        return compose(...args);
      };
    });
    const begin = async () => {
      await preview.evaluate(() =>
        Object.assign(window, { previewEntered: false }),
      );
      await page.evaluate((request) => {
        Object.assign(window, {
          pendingPreview: window.desktop!.agentPreview!(request),
        });
      }, request);
      await expect
        .poll(() =>
          preview.evaluate(
            () =>
              (window as unknown as { previewEntered: boolean }).previewEntered,
          ),
        )
        .toBe(true);
    };
    const finish = async () => {
      await preview.evaluate(() =>
        (window as unknown as { releasePreview: () => void }).releasePreview(),
      );
      return page.evaluate(
        () =>
          (window as unknown as { pendingPreview: Promise<AgentPreviewResult> })
            .pendingPreview,
      );
    };
    await begin();
    await page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(false);
      await window.desktop!.setMcpEnabled!(true);
    });
    expect(code(await finish())).toBe("MCP_ACCESS_CHANGED");
    await begin();
    await page.evaluate(async (id) => {
      const api = window.desktop!,
        projection = await api.documentProjection!(id);
      const grant = await api.documentAcquireLeases!(id, [
        { kind: "notes", slideId: projection.slide.id },
      ]);
      if (grant.denied) throw new Error("Fixture lease denied");
      const tokens = grant.grants.map(({ token }) => token);
      try {
        await api.documentCommit!(id, {
          documentId: id,
          epoch: projection.epoch,
          transactionId: crypto.randomUUID(),
          baseRevision: projection.revision,
          leaseTokens: tokens,
          operations: [
            {
              type: "slide.notes.set",
              slideId: projection.slide.id,
              notes: "Updated fixture notes",
            },
          ],
        });
      } finally {
        await api.documentReleaseLeases!(id, tokens);
      }
    }, documentId);
    expect(code(await finish())).toBe("REVISION_CONFLICT");
  } finally {
    await close(app, folder);
  }
});
