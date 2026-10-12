import type { BaseWindow, SaveDialogOptions } from "electron";
import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readyEditor } from "../helpers/startup";
import {
  DOCUMENT_VERSION,
  PRESENTATION_FILE_VERSION,
} from "../../src/core/document";
import { createMediaElement } from "../../src/core/media";

test("production preload and IPC create and save a native current-format file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "showme-ipc-"));
  const user = path.join(root, "user");
  const media = path.join(user, "assets");
  const presentations = path.join(root, "presentations");
  await mkdir(user);
  await mkdir(presentations);
  await writeFile(
    path.join(user, "settings.json"),
    JSON.stringify({
      mediaLibraryPath: media,
      presentationsFolderPath: presentations,
      libraryLifecycleMode: "keep-all",
      storageWarningSeen: true,
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !["SHOWME_DOCUMENT_DIR", "ELECTRON_RUN_AS_NODE"].includes(key) &&
        value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${path.join(root, "user")}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    await expect(
      page.getByRole("button", { name: "Colab", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Presentation menu" }).click();
    await page
      .getByRole("menuitem", { name: "Settings…", exact: true })
      .click();
    const collaboration = page.getByLabel("Enable Collaboration", {
      exact: true,
    });
    await expect(collaboration).not.toBeChecked();
    await expect(
      page.getByText("Trusted LAN only. Traffic is not encrypted.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Media library folder", { exact: true }),
    ).toHaveText(media);
    await expect(
      page.getByLabel("Presentations folder", { exact: true }),
    ).toHaveText(presentations);
    await collaboration.check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(
      page.getByRole("button", { name: "Colab", exact: true }),
    ).toBeVisible();
    const library = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(library.root).toBe(media);
    expect(library.presentations).toBe(presentations);
    const nested = path.join(presentations, "client", "project");
    await mkdir(nested, { recursive: true });
    const file = path.join(nested, "Native.sme");
    const [asset] = await page.evaluate(() =>
      window.desktop!.importDroppedFiles([
        new File(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
          ],
          "path-check.svg",
          { type: "image/svg+xml" },
        ),
      ]),
    );
    const element = createMediaElement("path-check-image", {
      ...asset,
      width: 32,
      height: 32,
    });
    const id = await page.evaluate(
      async ({ file, element }) => {
        const desktop = window.desktop!;
        const created = await desktop.createDocument("Native");
        if (!created) throw new Error("Document creation cancelled");
        const projection = await desktop.documentProjection!(created.id);
        const lease = await desktop.documentAcquireLeases!(created.id, [
          { kind: "notes", slideId: projection.slide.id },
          { kind: "deck" },
          {
            kind: "structure",
            slideId: projection.slide.id,
            parentId: projection.slide.nodes[0].id,
          },
        ]);
        if (lease.denied) throw new Error("Native edit lease denied");
        const tokens = lease.grants.map((grant) => grant.token);
        try {
          await desktop.documentCommit!(created.id, {
            transactionId: crypto.randomUUID(),
            documentId: created.id,
            epoch: projection.epoch,
            baseRevision: projection.revision,
            leaseTokens: tokens,
            operations: [
              {
                type: "elements.insert",
                slideId: projection.slide.id,
                parentId: projection.slide.nodes[0].id,
                elements: [element],
              },
              {
                type: "text-style.set",
                styleId: projection.deck.textStyles[0].id,
                value: {
                  ...projection.deck.textStyles[0],
                  typography: {
                    ...projection.deck.textStyles[0].typography,
                    fontSize: 80,
                  },
                },
              },
              {
                type: "slide.notes.set",
                slideId: projection.slide.id,
                notes: "Native IPC notes",
              },
            ],
          });
        } finally {
          await desktop.documentReleaseLeases!(created.id, tokens);
        }
        await desktop.saveDocumentToFile!(created.id, file);
        return created.id;
      },
      { file, element },
    );
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.documentId).toBe(id);
    expect(persisted.kind).toBe("showme-presentation");
    expect(persisted.version).toBe(PRESENTATION_FILE_VERSION);
    expect(persisted.deck.version).toBe(DOCUMENT_VERSION);
    expect(
      persisted.deck.textStyles.map((style: { name: string }) => style.name),
    ).toEqual(["Heading", "Text"]);
    expect(persisted.deck.textStyles[0].typography.fontSize).toBe(80);
    expect(persisted.slides[persisted.deck.slideIds[0]].notes).toBe(
      "Native IPC notes",
    );
    expect(
      await page.evaluate((id) => window.desktop!.managedFonts!(id), id),
    ).toEqual(expect.any(Array));
    await expect(
      page.evaluate(() => window.desktop!.managedFonts!(crypto.randomUUID())),
    ).rejects.toThrow("Outside font document scope");
    await expect(
      page.evaluate(() => window.desktop!.managedFonts!("invalid/id")),
    ).rejects.toThrow();
    expect(
      (
        await page.evaluate(
          (id) => window.desktop!.documentLibraryState!(id),
          id,
        )
      ).displaced,
    ).toBe(false);
    expect(
      (await page.evaluate(() => window.desktop!.scanLibrary!())).presentations,
    ).toBe(1);
    const settingsFile = path.join(user, "settings.json");
    const settingsBeforeCorruption = await readFile(settingsFile, "utf8");
    await mkdir(path.join(user, "Presentations"));
    await writeFile(settingsFile, "{");
    await expect(
      page.evaluate(() => window.desktop!.scanLibrary!()),
    ).rejects.toThrow("Could not read ShowMe settings");
    expect(await readFile(settingsFile, "utf8")).toBe("{");
    await writeFile(settingsFile, settingsBeforeCorruption);
    const summary = await page.evaluate(
      (id) => window.desktop!.saveDocumentToFile!(id),
      id,
    );
    await app.evaluate(({ BrowserWindow }, document) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())!
        .webContents.send("document-opened", document);
    }, summary);
    await expect(page.locator("[data-editor]")).toHaveAttribute(
      "data-document-id",
      id,
    );
    const selectedPresentations = path.join(root, "selected-presentations");
    await mkdir(selectedPresentations);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
      dialog.showSaveDialog = async (
        ownerOrOptions: BaseWindow | SaveDialogOptions,
        options?: SaveDialogOptions,
      ) => ({
        canceled: false,
        filePath: (options ?? (ownerOrOptions as SaveDialogOptions))
          .defaultPath!,
      });
    }, selectedPresentations);
    await page.getByRole("button", { name: "Presentation menu" }).click();
    await page
      .getByRole("menuitem", { name: "Settings…", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Choose Presentations Folder…",
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel("Presentations folder", { exact: true }),
    ).toHaveText(selectedPresentations);
    const changed = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(changed!.root).toBe(media);
    expect(changed!.presentations).toBe(selectedPresentations);
    await page.getByRole("button", { name: "Close settings" }).click();
    const displaced = page.getByRole("complementary", {
      name: "Presentation outside the presentations folder",
    });
    await expect(displaced).toBeVisible();
    await displaced
      .getByRole("button", { name: "Move to Presentations Folder" })
      .click();
    await expect(displaced).toHaveCount(0);
    const saved = await page.evaluate(
      (id) => window.desktop!.saveDocumentAs!(id),
      id,
    );
    expect(saved!.location).toBe(
      path.join(selectedPresentations, "Native.sme"),
    );
    expect(JSON.parse(await readFile(saved!.location, "utf8")).documentId).toBe(
      id,
    );
    expect(
      JSON.parse(await readFile(path.join(user, "settings.json"), "utf8")),
    ).toMatchObject({
      mediaLibraryPath: media,
      presentationsFolderPath: selectedPresentations,
    });
    const selectedMedia = path.join(root, "selected-media");
    await mkdir(selectedMedia);
    await mkdir(path.join(selectedMedia, "images"));
    await copyFile(
      path.join(media, "images", asset.filename),
      path.join(selectedMedia, "images", asset.filename),
    );
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, selectedMedia);
    await page.evaluate(() => window.desktop!.chooseMediaLibrary());
    const independent = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(independent.root).toBe(selectedMedia);
    expect(independent.presentations).toBe(selectedPresentations);
    const portable = await page.evaluate(async () => {
      await window.desktop!.setLibraryLifecycleMode!("portable");
      const created = await window.desktop!.createDocument("Portable");
      return window.desktop!.saveDocumentAs!(created!.id);
    });
    expect(portable!.location).toBe(
      path.join(selectedPresentations, "Portable.smp"),
    );
    const reset = await page.evaluate(() =>
      window.desktop!.resetPresentationsFolder!(),
    );
    expect(reset.presentations).toBe(reset.defaultPresentations);
    expect(reset.root).toBe(selectedMedia);
    expect(await page.evaluate(() => window.desktop!.isTest)).toBe(false);
  } finally {
    // This contract concerns IPC, not the unsaved-close confirmation dialog.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
