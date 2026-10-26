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
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";
import {
  readStoredZipFile,
  readArchiveEntry,
} from "../../../electron/packageArchive";
import { createTextElement } from "../../../src/core/text";
import type { HtmlExportPayload } from "../../../src/export/html/types";
import { readyEditor } from "../../helpers/startup";

test("shared font-file export keeps animated HTML text and packages complete fonts after the license reminder", async ({
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
  const cssFontBytes = await readFile(
    "tests/fixtures/fonts/AsapCondensed-BoldItalic.ttf",
  );
  for (const [file, weight, italic] of [
    ["Regular", 400, false],
    ["BoldItalic", 700, true],
  ] as const) {
    const bytes = await readFile(
      `tests/fixtures/fonts/AsapCondensed-${file}.ttf`,
    );
    const id = createHash("sha256").update(bytes).digest("hex");
    await writeFile(
      path.join(
        fonts,
        `Asap Condensed-${weight}${italic ? "-italic" : ""}__${id}.ttf`,
      ),
      bytes,
    );
  }
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
    await editor
      .getByRole("button", { name: "Presentation menu", exact: true })
      .click();
    await editor.getByRole("menuitem", { name: "Settings…" }).click();
    const setting = editor.getByRole("combobox", {
      name: "Export font embedding",
    });
    await setting.selectOption("file");
    await expect
      .poll(() =>
        editor.evaluate(() => window.desktop!.getExportFontEmbedding!()),
      )
      .toBe("file");
    await editor.screenshot({
      path: info.outputPath("shared-font-setting.png"),
    });
    await editor.getByRole("button", { name: "Close settings" }).click();
    const effect = {
      ...blankEffect("css-js"),
      kind: "text-js" as const,
      target: "text" as const,
      styleSource:
        ':scope { font-family: "Asap Condensed" !important; font-weight: 700 !important; font-style: italic !important; }',
      source:
        "function render({text,t}) { return text + (t > 0 ? ' XYZ 123' : ''); }",
    };
    const text = createTextElement("animated-text"),
      plain = createTextElement("static-text");
    for (const item of [text, plain]) {
      if (item.content?.type !== "text" || item.content.format.kind !== "local")
        throw Error("Text required");
      item.content.text = item === text ? "Hi" : "Static";
      item.content.placeholder = false;
      Object.assign(item.content.format.typography, {
        fontFamily: "Abel",
        fontSize: 40,
      });
    }
    plain.frame.y += 250;
    text.effects = [newEffectInstance("animated", effect, "content")];
    const id = await editor.evaluate(
      async ({ text, plain, effect }) => {
        const desktop = window.desktop!,
          id =
            document.querySelector<HTMLElement>("[data-editor]")!.dataset
              .documentId!;
        const before = await desktop.documentProjection!(id),
          parentId = before.slide.nodes[0].id;
        const lease = await desktop.documentAcquireLeases!(id, [
          { kind: "deck" },
          { kind: "slide", slideId: before.slide.id },
          { kind: "structure", slideId: before.slide.id, parentId },
        ]);
        if (lease.denied) throw Error("Lease denied");
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
                type: "deck.properties.set",
                changes: {
                  stylesheet: effect.styleSource.replace(
                    ":scope",
                    '[data-element-id="animated-text"] [data-text-content]',
                  ),
                },
              },
              {
                type: "slide.effects.set",
                slideId: before.slide.id,
                resources: { animated: effect },
              },
              {
                type: "elements.insert",
                slideId: before.slide.id,
                parentId,
                elements: [text, plain],
              },
            ],
          });
        } finally {
          await desktop.documentReleaseLeases!(id, tokens);
        }
        return id;
      },
      { text, plain, effect },
    );
    const before = await editor.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      id,
    );
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as {
        cancelFontExport: boolean;
        licenseMessages: string[];
      };
      state.cancelFontExport = true;
      state.licenseMessages = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as {
          title?: string;
          message: string;
          detail?: string;
        };
        if (options.title === "Embed font files") {
          state.licenseMessages.push(options.message + " " + options.detail);
          return {
            response: state.cancelFontExport ? 1 : 0,
            checkboxChecked: false,
          };
        }
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const htmlFile = path.join(directory, "font-file.html");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, htmlFile);
    expect(
      await editor.evaluate(
        (id) => window.desktop!.exportPresentation!(id, "html"),
        id,
      ),
    ).toBeNull();
    await expect(readFile(htmlFile)).rejects.toMatchObject({ code: "ENOENT" });
    await app.evaluate(() => {
      (
        globalThis as unknown as { cancelFontExport: boolean }
      ).cancelFontExport = false;
    });
    expect(
      await editor.evaluate(
        (id) => window.desktop!.exportPresentation!(id, "html"),
        id,
      ),
    ).toEqual({ warnings: [] });
    const html = await readFile(htmlFile, "utf8");
    await writeFile(info.outputPath("font-file.html"), html);
    const payload = JSON.parse(
      html.match(
        /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
      )![1],
    ) as HtmlExportPayload;
    expect(payload.fonts).toHaveLength(2);
    const cssFamily = payload.fonts.find(
      (family) => family.family === "Asap Condensed",
    )!;
    expect(
      cssFamily.sources.map((source) => [source.weight, source.italic]),
    ).toEqual(
      expect.arrayContaining([
        [400, false],
        [700, true],
      ]),
    );
    expect(
      Buffer.from(
        cssFamily.sources.find(
          (source) => source.weight === 700 && source.italic,
        )!.data,
        "base64",
      ),
    ).toEqual(cssFontBytes);
    expect(Buffer.from(payload.fonts[0].sources[0].data, "base64")).toEqual(
      fontBytes,
    );
    expect(payload.document.slides[0].nodes[0].children[0].content).toEqual(
      text.content,
    );
    expect(payload.document.slides[0].effectResources!.animated).toEqual(
      effect,
    );
    await page.context().setOffline(true);
    await page.goto(pathToFileURL(htmlFile).href);
    await expect(page.locator("main")).toHaveAttribute(
      "data-awaiting-audience",
      "false",
    );
    await expect(
      page.locator('[data-active-slide] [data-element-id="animated-text"]'),
    ).toContainText("Hi XYZ 123");
    expect(await page.evaluate(() => document.fonts.check('40px "Abel"'))).toBe(
      true,
    );
    expect(
      await page
        .locator('[data-element-id="animated-text"] [data-text-content]')
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.fontFamily, style.fontWeight, style.fontStyle];
        }),
    ).toEqual(['"Asap Condensed"', "700", "italic"]);
    expect(
      await page.evaluate(() =>
        document.fonts.check('italic 700 40px "Asap Condensed"'),
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("animated-font-file.png") });
    const packageTarget = path.join(directory, "font-file.smp");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, packageTarget);
    await app.evaluate(() => {
      (
        globalThis as unknown as { cancelFontExport: boolean }
      ).cancelFontExport = true;
    });
    expect(
      await editor.evaluate((id) => window.desktop!.packageDocument!(id), id),
    ).toBeNull();
    await app.evaluate(() => {
      (
        globalThis as unknown as { cancelFontExport: boolean }
      ).cancelFontExport = false;
    });
    const packageFile = (await editor.evaluate(
      (id) => window.desktop!.packageDocument!(id),
      id,
    ))!;
    const archive = await readStoredZipFile(packageFile);
    try {
      const manifest = JSON.parse(
        (
          await readArchiveEntry(archive.entries.get("manifest.json")!)
        ).toString(),
      );
      expect(manifest.fonts.length).toBeGreaterThanOrEqual(3);
      const cssFace = manifest.fonts.find(
        (face: { family: string; weight: number; italic: boolean }) =>
          face.family === "Asap Condensed" &&
          face.weight === 700 &&
          face.italic,
      );
      expect(
        await readArchiveEntry(archive.entries.get(cssFace.originalPath)!),
      ).toEqual(cssFontBytes);
      expect(
        await readArchiveEntry(
          archive.entries.get(manifest.fonts[0].originalPath)!,
        ),
      ).toEqual(fontBytes);
      const document = JSON.parse(
        (
          await readArchiveEntry(archive.entries.get(manifest.documentPath)!)
        ).toString(),
      );
      expect(
        Object.values(
          document.slides as Record<
            string,
            { nodes: Array<{ children: (typeof text)[] }> }
          >,
        )[0].nodes[0].children[0].content,
      ).toEqual(text.content);
    } finally {
      await archive.dispose();
    }
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { licenseMessages: string[] })
            .licenseMessages,
      ),
    ).toHaveLength(4);
    expect(
      (
        await app.evaluate(
          () =>
            (globalThis as unknown as { licenseMessages: string[] })
              .licenseMessages,
        )
      )[0],
    ).toContain("must have a license");
    await editor.evaluate(() => window.desktop!.setExportFontEmbedding!("svg"));
    const svgTarget = path.join(directory, "svg.smp");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, svgTarget);
    const svgPackage = (await editor.evaluate(
      (id) => window.desktop!.packageDocument!(id),
      id,
    ))!;
    const svgArchive = await readStoredZipFile(svgPackage);
    try {
      const manifest = JSON.parse(
        (
          await readArchiveEntry(svgArchive.entries.get("manifest.json")!)
        ).toString(),
      );
      expect(manifest.fonts).toEqual([]);
      // Deck CSS deliberately leaves both objects live in SVG mode.
      expect(manifest.assets).toHaveLength(0);
      const document = JSON.parse(
        (
          await readArchiveEntry(svgArchive.entries.get(manifest.documentPath)!)
        ).toString(),
      );
      const children = Object.values(
        document.slides as Record<
          string,
          { nodes: Array<{ children: (typeof text)[] }> }
        >,
      )[0].nodes[0].children;
      expect(children[0].content?.type).toBe("text");
      expect(children[1].content?.type).toBe("text");
    } finally {
      await svgArchive.dispose();
    }
    await editor.evaluate(() =>
      window.desktop!.setExportFontEmbedding!("none"),
    );
    const noneTarget = path.join(directory, "none.smp");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as typeof dialog.showSaveDialog;
    }, noneTarget);
    const nonePackage = (await editor.evaluate(
      (id) => window.desktop!.packageDocument!(id),
      id,
    ))!;
    const noneArchive = await readStoredZipFile(nonePackage);
    try {
      const manifest = JSON.parse(
        (
          await readArchiveEntry(noneArchive.entries.get("manifest.json")!)
        ).toString(),
      );
      expect(manifest.fonts).toEqual([]);
      expect(manifest.assets).toEqual([]);
    } finally {
      await noneArchive.dispose();
    }
    const after = await editor.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      id,
    );
    expect(after.slide).toEqual(before.slide);
    expect(after.revision).toBe(before.revision);
    expect((await temps()).filter((name) => !beforeTemps.has(name))).toEqual(
      [],
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await page.goto("about:blank");
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
