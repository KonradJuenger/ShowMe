import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBasicShape } from "../../../src/core/elementFactory";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { newEffectInstance } from "../../../src/core/effects";
import { readyEditor } from "../../helpers/startup";

test("native PDF uses explicit shader pixels at both display densities and preserves physical page size", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-pdf-"));
  const output = path.join(folder, "slide.pdf");
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
    const shape = createBasicShape("pdf-effect", "rectangle", { x: 0, y: 0 });
    shape.frame.width = 1920;
    shape.frame.height = 1080;
    const definition = blankEffect("shader");
    shape.effects = [newEffectInstance("pdf-source", definition, "content")];
    const id = await page.evaluate(
      async ({ shape, definition }) => {
        const desktop = window.desktop!;
        const id = document
          .querySelector("[data-editor]")!
          .getAttribute("data-document-id")!;
        const before = await desktop.documentProjection!(id);
        const parentId = before.slide.nodes[0].id;
        const lease = await desktop.documentAcquireLeases!(id, [
          { kind: "structure", slideId: before.slide.id, parentId },
          { kind: "slide", slideId: before.slide.id },
        ]);
        if (lease.denied) throw new Error("PDF fixture lease denied");
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
                type: "slide.effects.set",
                slideId: before.slide.id,
                resources: { "pdf-source": definition },
              },
              {
                type: "elements.insert",
                slideId: before.slide.id,
                parentId,
                elements: [shape],
              },
            ],
          });
        } finally {
          await desktop.documentReleaseLeases!(id, tokens);
        }
        return id;
      },
      { shape, definition },
    );
    await app.evaluate(({ app, dialog }, output) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: output,
      })) as typeof dialog.showSaveDialog;
      const state = globalThis as unknown as {
        pdfDpr: number;
        pdfSamples: unknown[];
      };
      state.pdfDpr = 1;
      state.pdfSamples = [];
      app.on("web-contents-created", (_event, contents) => {
        const print = contents.printToPDF.bind(contents);
        contents.printToPDF = async (options) => {
          const sample = await contents.executeJavaScript(`
            Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ${state.pdfDpr} });
            window.dispatchEvent(new Event('resize'));
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
              const canvas = document.querySelector('[data-effect-id] canvas');
              resolve({ width: canvas.width, height: canvas.height, dpr: devicePixelRatio,
                error: document.querySelector('[data-effect-error]')?.dataset.effectError ?? null });
            })))
          `);
          state.pdfSamples.push(sample);
          return print(options);
        };
      });
    }, output);
    const before = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      id,
    );
    const first = await page.evaluate(
      (id) => window.desktop!.exportPresentation!(id, "pdf"),
      id,
    );
    expect(first?.warnings).toEqual([]);
    await app.evaluate(() => {
      (globalThis as unknown as { pdfDpr: number }).pdfDpr = 2;
    });
    const second = await page.evaluate(
      (id) => window.desktop!.exportPresentation!(id, "pdf"),
      id,
    );
    expect(second?.warnings).toEqual([]);
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { pdfSamples: unknown[] }).pdfSamples,
      ),
    ).toEqual([
      { width: 4000, height: 2250, dpr: 1, error: null },
      { width: 4000, height: 2250, dpr: 2, error: null },
    ]);
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(bytes.toString("latin1")).toMatch(/\/MediaBox\s*\[0 0 960 540\]/);
    expect(
      (await page.evaluate((id) => window.desktop!.documentProjection!(id), id))
        .revision,
    ).toBe(before.revision);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});
