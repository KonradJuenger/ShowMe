import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newPresentationDocument } from "../../../src/core/document";
import { readyEditor } from "../../helpers/startup";

async function launchFixture(configured: boolean | "missing", testMode = true) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-test-mode-"));
  const userData = path.join(folder, "user");
  await mkdir(userData);
  const root = path.join(folder, "configured-root");
  if (configured) {
    if (configured !== "missing")
      await mkdir(path.join(root, "ShowMe Library"), { recursive: true });
    await writeFile(
      path.join(userData, "settings.json"),
      JSON.stringify({
        showMeRootPath: root,
        libraryLifecycleMode: "keep-all",
      }),
    );
  }
  const model = newPresentationDocument("External fixture");
  const file = path.join(folder, "external.sme");
  await writeFile(file, JSON.stringify(model));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [
      path.resolve("."),
      `--user-data-dir=${userData}`,
      ...(testMode ? ["--test-mode", file] : []),
    ],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForURL(/\/dist\/index\.html(?:\?|$)/);
  await page.waitForLoadState("domcontentloaded");
  return { app, page, folder, userData, root, file, model };
}

test("explicit test mode starts without root settings and opens an external native deck without persisting the bypass", async () => {
  const fixture = await launchFixture(false);
  let closed = false;
  try {
    const page = fixture.page;
    await readyEditor(page);
    await expect(page.locator("[data-editor]")).toHaveAttribute(
      "data-document-id",
      fixture.model.documentId,
    );
    const settings = await readFile(
      path.join(fixture.userData, "settings.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => ({}));
    expect(settings.showMeRootPath).toBeUndefined();
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async (id) => {
          const projection = await window.desktop!.documentProjection!(id);
          return projection.revision > projection.savedRevision;
        }, fixture.model.documentId),
      )
      .toBe(true);
    const exited = fixture.app.waitForEvent("close", { timeout: 10000 });
    void page
      .evaluate(
        (id) => window.desktop!.requestClose!(id),
        fixture.model.documentId,
      )
      .catch(() => undefined);
    await exited;
    closed = true;
    expect(await readFile(fixture.file, "utf8")).toBe(
      JSON.stringify(fixture.model),
    );
  } finally {
    if (!closed) await fixture.app.close();
    await rm(fixture.folder, { recursive: true, force: true });
  }
});

test("test mode permits external files with a configured root while normal launches retain root enforcement", async () => {
  const fixture = await launchFixture(true);
  try {
    const page = fixture.page;
    await readyEditor(page);
    await expect(page.locator("[data-editor]")).toHaveAttribute(
      "data-document-id",
      fixture.model.documentId,
    );
  } finally {
    await fixture.app.close();
    await rm(fixture.folder, { recursive: true, force: true });
  }
  const normal = await launchFixture(true, false);
  try {
    const page = normal.page;
    await readyEditor(page);
    const error = await page.evaluate(async (file) => {
      try {
        await window.desktop!.openDocumentFile!(file);
        return "accepted";
      } catch (error) {
        return String(error);
      }
    }, normal.file);
    expect(error).toContain("must live inside the selected ShowMe root");
  } finally {
    // Normal launches deliberately retain dirty-close dialogs. This fixture's
    // blank startup document is disposable; do not exercise that dialog here.
    const exited = normal.app.waitForEvent("close");
    await normal.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await exited;
    await rm(normal.folder, { recursive: true, force: true });
  }
});

test("test mode replaces an unavailable configured root without changing the saved root setting", async () => {
  const fixture = await launchFixture("missing");
  try {
    const page = fixture.page;
    await readyEditor(page);
    await expect(page.locator("[data-editor]")).toHaveAttribute(
      "data-document-id",
      fixture.model.documentId,
    );
    const settings = JSON.parse(
      await readFile(path.join(fixture.userData, "settings.json"), "utf8"),
    );
    expect(settings.showMeRootPath).toBe(fixture.root);
  } finally {
    await fixture.app.close();
    await rm(fixture.folder, { recursive: true, force: true });
  }
});
