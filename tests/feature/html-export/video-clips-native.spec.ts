import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMediaElement } from "../../../src/core/media";
import type { HtmlExportPayload } from "../../../src/export/html/types";
import { readyEditor } from "../../helpers/startup";

test("native HTML export embeds a cropped video using its bundled executable", async ({
  page,
}) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "showme-native-clip-test-"),
  );
  const root = path.join(directory, "root");
  await mkdir(root);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  Object.assign(env, {
    SHOWME_TESTING: "1",
    SHOWME_TEST_ROOT_SELECTION: root,
    SHOWME_DOCUMENT_DIR: root,
  });
  const executable = process.env.SHOWME_HTML_TEST_EXECUTABLE;
  const app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [] : [path.resolve(".")]),
      `--user-data-dir=${path.join(directory, "profile")}`,
    ],
    env,
  });
  try {
    const editor = await app.firstWindow();
    await readyEditor(editor);
    const fixture = path.resolve("tests/fixtures/media/native-motion.webm");
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as typeof dialog.showOpenDialog;
    }, fixture);
    const [asset] = await editor.evaluate(() => window.desktop!.importAssets());
    const video = createMediaElement("trimmed-video", {
      ...asset,
      width: 80,
      height: 40,
    });
    if (video.content?.type !== "video") throw Error("Video fixture required");
    Object.assign(video.content, { startTime: 0.2, endTime: 0.6, loop: true });
    const id = await editor.evaluate(async (video) => {
      const desktop = window.desktop!,
        id =
          document.querySelector<HTMLElement>("[data-editor]")!.dataset
            .documentId!;
      const before = await desktop.documentProjection!(id),
        parentId = before.slide.nodes[0].id;
      const lease = await desktop.documentAcquireLeases!(id, [
        { kind: "structure", slideId: before.slide.id, parentId },
      ]);
      if (lease.denied) throw Error("Fixture lease denied");
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
              elements: [video],
            },
          ],
        });
      } finally {
        await desktop.documentReleaseLeases!(id, tokens);
      }
      return id;
    }, video);
    const file = path.join(directory, "presentation.html");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, file);
    expect(
      await editor.evaluate(
        (id) => window.desktop!.exportPresentation!(id, "html"),
        id,
      ),
    ).toEqual({ warnings: [] });
    const html = await readFile(file, "utf8");
    const payload = JSON.parse(
      html.match(
        /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
      )![1],
    ) as HtmlExportPayload;
    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]).toMatchObject({ mime: "video/mp4" });
    expect(
      payload.document.slides[0].nodes[0].children[0].content,
    ).toMatchObject({
      type: "video",
      startTime: 0,
      assetId: payload.assets[0].id,
    });
    const projection = await editor.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      id,
    );
    expect(projection.slide.nodes[0].children[0].content).toMatchObject({
      assetId: asset.id,
      startTime: 0.2,
      endTime: 0.6,
    });
    const media = path.join(root, "ShowMe Library", "video");
    const original = (await readdir(media)).find((name) =>
      name.includes(asset.id),
    )!;
    expect(await readFile(path.join(media, original))).toEqual(
      await readFile(fixture),
    );
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(file).href);
    await expect(page.locator("main")).toHaveAttribute(
      "data-awaiting-audience",
      "false",
    );
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate(
            (node: HTMLVideoElement) => node.readyState >= 2 && !node.paused,
          ),
      )
      .toBe(true);
    expect(
      await page
        .locator("video")
        .evaluate((node: HTMLVideoElement) => node.duration),
    ).toBeCloseTo(0.4, 2);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await page.goto("about:blank");
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
