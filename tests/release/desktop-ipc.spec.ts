import type { BaseWindow, SaveDialogOptions } from "electron";
import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  access,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { managedFilename } from "../../electron/mediaLibrary";
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
  const media = path.join(showMeRoot, "ShowMe Library");
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
    await expect(page.getByLabel("ShowMe root", { exact: true })).toHaveText(
      showMeRoot,
    );
    await expect(page.getByLabel("Library folder", { exact: true })).toHaveText(
      media,
    );
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
    await page
      .getByRole("navigation", { name: "Sidebar modes" })
      .getByRole("button", { name: "Media", exact: true })
      .click();
    const copiedBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
    );
    const copiedId = createHash("sha256").update(copiedBytes).digest("hex");
    const copiedFile = path.join(
      media,
      "images",
      managedFilename("copied.svg", copiedId),
    );
    await expect(
      page.getByRole("button", { name: "Select copied.svg", exact: true }),
    ).toHaveCount(0);
    await writeFile(copiedFile, copiedBytes);
    await expect(
      page.getByRole("button", { name: "Select copied.svg", exact: true }),
    ).toBeVisible();
    // The row appears before its async preview read completes. Delete only
    // after that read, so this tests filesystem observation rather than a
    // Windows unlink racing an active thumbnail reader.
    const copiedPreview = page.getByRole("button", {
      name: "Select copied.svg", exact: true,
    }).locator("img");
    await expect(copiedPreview).toHaveCount(1);
    await copiedPreview.evaluate((image: HTMLImageElement) => image.decode());
    await rm(copiedFile);
    await expect(
      page.getByRole("button", { name: "Select copied.svg", exact: true }),
    ).toHaveCount(0);
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
    const selectedLibrary = path.join(selectedRoot, "ShowMe Library");
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

    const portablePath = path.join(showMeRoot, "Native Portable.smp");
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

    // Reject unsafe candidates before the current Library or settings change.
    const unsafeRoot = path.join(root, "Unsafe Shared");
    const unsafeLibrary = path.join(unsafeRoot, "ShowMe Library");
    await mkdir(unsafeLibrary, { recursive: true });
    await symlink(
      path.join(selectedLibrary, "images"),
      path.join(unsafeLibrary, "images"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const beforeFailedSwitch = await readFile(settingsFile, "utf8");
    const beforeLibrary = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    const beforeAssets = await page.evaluate(() =>
      window.desktop!.listAssets("", 0, 100),
    );
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, unsafeRoot);
    await expect(
      page.evaluate(() => window.desktop!.chooseShowMeRoot!()),
    ).rejects.toThrow("Unsafe Library directory: images");
    expect(await readFile(settingsFile, "utf8")).toBe(beforeFailedSwitch);
    expect(
      await page.evaluate(() => window.desktop!.getLibraryLifecycle!()),
    ).toEqual(beforeLibrary);
    expect(
      await page.evaluate(() => window.desktop!.getMediaLibrary()),
    ).toMatchObject({ path: media });
    expect(
      await page.evaluate(() => window.desktop!.listAssets("", 0, 100)),
    ).toEqual(beforeAssets);
    expect(
      (await page.evaluate(() => window.desktop!.scanLibrary!())).complete,
    ).toBe(true);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, selectedRoot);

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
    expect(await readFile(path.join(media, "images", asset.filename))).toEqual(
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

    await page.evaluate(() =>
      window.desktop!.setLibraryLifecycleMode!("portable"),
    );
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

test("startup clean cutover ignores legacy storage settings until a ShowMe root is explicitly selected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "showme-cutover-"));
  const user = path.join(root, "user");
  const oldMedia = path.join(root, "old-media");
  const oldPresentations = path.join(root, "old-presentations");
  const selectedRoot = path.join(root, "selected-root");
  const oldAsset = path.join(oldMedia, "legacy.bin");
  const oldDeck = path.join(oldPresentations, "legacy.sme");
  await mkdir(user);
  await mkdir(oldMedia);
  await mkdir(oldPresentations);
  await mkdir(selectedRoot);
  await writeFile(oldAsset, "legacy asset");
  await writeFile(oldDeck, "legacy presentation");
  const assetBefore = await stat(oldAsset);
  const deckBefore = await stat(oldDeck);
  const settingsFile = path.join(user, "settings.json");
  await writeFile(
    settingsFile,
    JSON.stringify({
      mediaLibraryPath: oldMedia,
      presentationsFolderPath: oldPresentations,
      libraryLifecycleMode: "managed",
    }),
  );
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        ![
          "SHOWME_DOCUMENT_DIR",
          "ELECTRON_RUN_AS_NODE",
          "SHOWME_TESTING",
          "SHOWME_TEST_ROOT_SELECTION",
        ].includes(key) && value !== undefined,
    ),
  ) as Record<string, string>;
  const args = [path.resolve("."), `--user-data-dir=${user}`];

  const blocked = await electron.launch({
    args,
    env: {
      ...baseEnv,
      SHOWME_TESTING: "1",
      SHOWME_TEST_ROOT_SELECTION: "__blocked__",
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await blocked.windows()).toHaveLength(0);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({
      mediaLibraryPath: oldMedia,
      presentationsFolderPath: oldPresentations,
      libraryLifecycleMode: "managed",
    });
    await expect(
      access(path.join(selectedRoot, "ShowMe Library")),
    ).rejects.toThrow();
  } finally {
    await blocked.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await blocked.close().catch(() => {});
  }

  const configured = await electron.launch({
    args,
    env: {
      ...baseEnv,
      SHOWME_TESTING: "1",
      SHOWME_TEST_ROOT_SELECTION: selectedRoot,
    },
  });
  try {
    const page = await configured.firstWindow();
    await readyEditor(page);
    const lifecycle = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(lifecycle.root).toBe(selectedRoot);
    expect(lifecycle.library).toBe(path.join(selectedRoot, "ShowMe Library"));
    await expect(
      access(path.join(selectedRoot, "ShowMe Library")),
    ).resolves.toBeUndefined();

    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    expect(settings).toMatchObject({
      showMeRootPath: selectedRoot,
      libraryLifecycleMode: "managed",
    });
    expect(settings).not.toHaveProperty("mediaLibraryPath");
    expect(settings).not.toHaveProperty("presentationsFolderPath");

    expect(await readFile(oldAsset, "utf8")).toBe("legacy asset");
    expect(await readFile(oldDeck, "utf8")).toBe("legacy presentation");
    const assetAfter = await stat(oldAsset);
    const deckAfter = await stat(oldDeck);
    expect(assetAfter.size).toBe(assetBefore.size);
    expect(assetAfter.mtimeMs).toBe(assetBefore.mtimeMs);
    expect(deckAfter.size).toBe(deckBefore.size);
    expect(deckAfter.mtimeMs).toBe(deckBefore.mtimeMs);
    await expect(
      access(path.join(selectedRoot, "ShowMe Library", "legacy.bin")),
    ).rejects.toThrow();
    await expect(
      access(path.join(selectedRoot, "legacy.sme")),
    ).rejects.toThrow();
  } finally {
    await configured.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await configured.close().catch(() => {});
  }

  const relaunched = await electron.launch({ args, env: baseEnv });
  try {
    const page = await relaunched.firstWindow();
    await readyEditor(page);
    const lifecycle = await page.evaluate(() =>
      window.desktop!.getLibraryLifecycle!(),
    );
    expect(lifecycle.root).toBe(selectedRoot);
    expect(lifecycle.library).toBe(path.join(selectedRoot, "ShowMe Library"));
  } finally {
    await relaunched.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await relaunched.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
