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
  const showMeRoot = path.join(root, "Studio Shared");
  const media = path.join(showMeRoot, "Library");
  await mkdir(user);
  await mkdir(media, { recursive: true });
  await writeFile(
    path.join(user, "settings.json"),
    JSON.stringify({
      showMeRootPath: showMeRoot,
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
      page.getByLabel("ShowMe root", { exact: true }),
    ).toHaveText(showMeRoot);
    await expect(
      page.getByLabel("Library folder", { exact: true }),
    ).toHaveText(media);
    await collaboration.check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(
      page.getByRole("button", { name: "Colab", exact: true }),
    ).toBeVisible();
    const library = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(library.root).toBe(showMeRoot);
    expect(library.library).toBe(media);
    const nested = path.join(showMeRoot, "client", "project", "deep");
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
      (await page.evaluate(() => window.desktop!.scanLibrary!())).presentations,
    ).toBe(1);
    const settingsFile = path.join(user, "settings.json");
    const settingsBeforeCorruption = await readFile(settingsFile, "utf8");
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
    const selectedRoot = path.join(root, "Selected Shared");
    const selectedLibrary = path.join(selectedRoot, "Library");
    await mkdir(path.join(selectedLibrary, "images"), { recursive: true });
    await copyFile(
      path.join(media, "images", asset.filename),
      path.join(selectedLibrary, "images", asset.filename),
    );
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
    }, selectedRoot);

    await page.getByRole("button", { name: "Presentation menu" }).click();
    await page
      .getByRole("menuitem", { name: "Settings…", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Choose ShowMe Root…", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "save it as a portable .smp before changing the ShowMe root",
    );
    await expect(page.getByLabel("ShowMe root", { exact: true })).toHaveText(
      showMeRoot,
    );
    await page.getByRole("button", { name: "Close settings" }).click();

    const portablePath = path.join(selectedRoot, "Native.smp");
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: destination,
      });
    }, portablePath);
    const portableCurrent = await page.evaluate(
      (id) => window.desktop!.saveDocumentAs!(id),
      id,
    );
    expect(portableCurrent!.location).toBe(portablePath);
    expect(await readFile(file, "utf8")).toContain(id);

    await page.getByRole("button", { name: "Presentation menu" }).click();
    await page
      .getByRole("menuitem", { name: "Settings…", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Choose ShowMe Root…", exact: true })
      .click();
    await expect(page.getByLabel("ShowMe root", { exact: true })).toHaveText(
      selectedRoot,
    );
    await expect(page.getByLabel("Library folder", { exact: true })).toHaveText(
      selectedLibrary,
    );
    const changed = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(changed!.root).toBe(selectedRoot);
    expect(changed!.library).toBe(selectedLibrary);

    const persistedSettings = JSON.parse(
      await readFile(path.join(user, "settings.json"), "utf8"),
    );
    expect(persistedSettings).toMatchObject({
      showMeRootPath: selectedRoot,
      libraryLifecycleMode: "keep-all",
    });
    expect(persistedSettings).not.toHaveProperty("mediaLibraryPath");
    expect(persistedSettings).not.toHaveProperty("presentationsFolderPath");
    expect(await readFile(file, "utf8")).toContain(id);
    expect(
      await readFile(path.join(media, "images", asset.filename)),
    ).toEqual(
      await readFile(path.join(selectedLibrary, "images", asset.filename)),
    );
    await page.getByRole("button", { name: "Close settings" }).click();

    const externalNative = path.join(root, "external.sme");
    await copyFile(file, externalNative);
    await expect(
      page.evaluate(
        (outside) => window.desktop!.openDocumentFile!(outside),
        externalNative,
      ),
    ).rejects.toThrow("must live inside the selected ShowMe root");

    const nestedRootProject = path.join(selectedRoot, "project", "deep");
    await mkdir(nestedRootProject, { recursive: true });
    const rootNative = path.join(nestedRootProject, "Root Native.sme");
    const rootNativeSummary = await page.evaluate(async (destination) => {
      const desktop = window.desktop!;
      const created = await desktop.createDocument("Root Native");
      return desktop.saveDocumentToFile!(created!.id, destination);
    }, rootNative);
    expect(rootNativeSummary.location).toBe(rootNative);
    expect(
      (await page.evaluate(() => window.desktop!.scanLibrary!())).presentations,
    ).toBe(1);

    await page.evaluate(() => window.desktop!.setLibraryLifecycleMode!("portable"));
    const portable = await page.evaluate(async () => {
      const created = await window.desktop!.createDocument("Portable");
      return window.desktop!.saveDocumentAs!(created!.id);
    });
    expect(portable!.location.endsWith(".smp")).toBe(true);
    expect(await page.evaluate(() => window.desktop!.isTest)).toBe(false);
  } finally {
    // This contract concerns IPC, not the unsaved-close confirmation dialog.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
