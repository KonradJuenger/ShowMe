import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createTextElement } from "../../../src/core/text";
import type { HtmlExportPayload } from "../../../src/export/html/types";
import { readyEditor } from "../../helpers/startup";

test("native SVG font export preserves static text without font files and reports progress with none, cancel and failure paths", async ({
  page,
}, info) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "showme-native-svg-test-"),
  );
  const root = path.join(directory, "root");
  const fonts = path.join(root, "ShowMe Library", "fonts");
  await mkdir(fonts, { recursive: true });
  const fontBytes = await readFile("tests/fixtures/fonts/Abel-Regular.ttf");
  const hash = createHash("sha256").update(fontBytes).digest("hex");
  await writeFile(path.join(fonts, `Abel-400__${hash}.ttf`), fontBytes);
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
  const temps = () =>
    readdir(os.tmpdir()).then((names) =>
      names.filter((name) => /^showme-html-(text|images|video)-/.test(name)),
    );
  const beforeTemps = new Set(await temps());
  try {
    const editor = await app.firstWindow();
    await readyEditor(editor);
    expect(
      await editor.evaluate(() => window.desktop!.getHtmlFontEmbedding!()),
    ).toBe("svg");
    await editor
      .getByRole("button", { name: "Presentation menu", exact: true })
      .click();
    await editor.getByRole("menuitem", { name: "Settings…" }).click();
    const select = editor.getByRole("combobox", {
      name: "HTML export font embedding",
    });
    await expect(select).toHaveValue("svg");
    await select.selectOption("none");
    await expect
      .poll(() =>
        editor.evaluate(() => window.desktop!.getHtmlFontEmbedding!()),
      )
      .toBe("none");
    await select.selectOption("svg");
    await expect
      .poll(() =>
        editor.evaluate(() => window.desktop!.getHtmlFontEmbedding!()),
      )
      .toBe("svg");
    await editor.screenshot({ path: info.outputPath("settings.png") });
    await editor.getByRole("button", { name: "Close settings" }).click();
    await expect(
      editor.evaluate(() =>
        window.desktop!.setHtmlFontEmbedding!("invalid" as "none"),
      ),
    ).rejects.toThrow();
    const text = createTextElement("outline-text");
    if (text.content?.type !== "text" || text.content.format.kind !== "local")
      throw Error("Text required");
    text.content.text =
      "office ffi Ág\nCustom fonts work, even on another computer.";
    text.content.placeholder = false;
    text.content.autoSize = "none";
    Object.assign(text.frame, { width: 420, height: 240 });
    Object.assign(text.content.format.typography, {
      fontFamily: "Abel",
      fontSize: 40,
      align: "center",
      verticalAlign: "middle",
      color: "#254DA0",
    });
    const id = await editor.evaluate(async (text) => {
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
              elements: [text],
            },
          ],
        });
      } finally {
        await desktop.documentReleaseLeases!(id, tokens);
      }
      return id;
    }, text);
    const output = path.join(directory, "svg.html");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, output);
    await editor.evaluate(() => {
      (window as unknown as { exportStages: string[] }).exportStages = [];
      window.desktop!.onHtmlExportProgress!((progress) => {
        if (progress)
          (window as unknown as { exportStages: string[] }).exportStages.push(
            progress.stage,
          );
      });
    });
    const exporting = editor.evaluate(
      (id) => window.desktop!.exportPresentation!(id, "html"),
      id,
    );
    const popup = editor.getByRole("dialog", { name: "Exporting HTML" });
    await expect(popup).toBeVisible();
    await expect(
      popup.getByRole("progressbar", { name: "HTML export progress" }),
    ).toBeVisible();
    await editor.screenshot({ path: info.outputPath("progress.png") });
    expect(await exporting).toEqual({ warnings: [] });
    await expect(popup).not.toBeVisible();
    expect(
      await editor.evaluate(
        () => (window as unknown as { exportStages: string[] }).exportStages,
      ),
    ).toEqual(
      expect.arrayContaining([
        "fonts",
        "videos",
        "images",
        "embedding",
        "writing",
        "complete",
      ]),
    );
    const payload = JSON.parse(
      (await readFile(output, "utf8")).match(
        /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
      )![1],
    ) as HtmlExportPayload;
    expect(payload.fonts).toEqual([]);
    expect(payload.assets).toHaveLength(1);
    const svg = Buffer.from(payload.assets[0].data, "base64").toString("utf8");
    expect(svg).toContain("<path ");
    expect(svg).not.toMatch(/<text|font-family|<image/);
    expect(
      payload.document.slides[0].nodes[0].children[0].content,
    ).toMatchObject({ type: "svg", assetId: payload.assets[0].id });
    const projection = await editor.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      id,
    );
    expect(projection.slide.nodes[0].children[0].content).toEqual(text.content);
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(output).href);
    await expect(page.locator("main")).toHaveAttribute(
      "data-awaiting-audience",
      "false",
    );
    expect(await page.evaluate(() => document.fonts.size)).toBe(0);
    await page.screenshot({ path: info.outputPath("offline-svg.png") });
    await editor.evaluate(() => window.desktop!.setHtmlFontEmbedding!("none"));
    const none = path.join(directory, "none.html");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, none);
    const noneResult = await editor.evaluate(
      (id) => window.desktop!.exportPresentation!(id, "html"),
      id,
    );
    expect(
      noneResult!.warnings.some(
        (warning) => warning.code === "font-not-embedded",
      ),
    ).toBe(true);
    const nonePayload = JSON.parse(
      (await readFile(none, "utf8")).match(
        /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
      )![1],
    ) as HtmlExportPayload;
    expect(nonePayload.fonts).toEqual([]);
    expect(nonePayload.assets).toEqual([]);
    expect(nonePayload.document.slides[0].nodes[0].children[0].content).toEqual(
      text.content,
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "profile", "settings.json"),
          "utf8",
        ),
      ).htmlFontEmbedding,
    ).toBe("none");
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({
        canceled: true,
        filePath: "",
      })) as typeof dialog.showSaveDialog;
    });
    expect(
      await editor.evaluate(
        (id) => window.desktop!.exportPresentation!(id, "html"),
        id,
      ),
    ).toBeNull();
    await expect(popup).not.toBeVisible();
    await editor.evaluate(() => window.desktop!.setHtmlFontEmbedding!("svg"));
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, directory);
    await expect(
      editor.evaluate(
        (id) => window.desktop!.exportPresentation!(id, "html"),
        id,
      ),
    ).rejects.toThrow();
    await expect(popup).not.toBeVisible();
    expect((await temps()).filter((name) => !beforeTemps.has(name))).toEqual(
      [],
    );
    expect(await readFile(path.join(fonts, `Abel-400__${hash}.ttf`))).toEqual(
      fontBytes,
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await page.goto("about:blank");
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
