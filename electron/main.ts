import { presentationMotionStages } from "../src/core/documentRuntime";
import { acceptedImpact } from "../src/core/documentImpact";
import { fontStorageService } from "./fontIntegration";
import { EffectLibraryStorage } from "./effectLibrary";
import { effectLibraryRequestSchema } from "../src/core/libraryEffects";
import sharp from "sharp";
import { ImageWorkQueue } from "../src/core/imageWorkQueue";
import { nativeImageConcurrency } from "./imageProcessorPool";
import { resolveSlide } from "../src/core/templates";
import { randomUUID } from "node:crypto";
import {
  audienceImageProfile as outputImageProfile,
  MAX_PREPARED_IMAGE_PIXELS,
  type ImageOutputProfile,
  type ImageCacheFormat,
} from "../src/core/presentationImages";
import { ImagePreparationCoordinator } from "../src/core/imagePreparationCoordinator";
import {
  cleanupImageSessions,
  cleanupDiscardedImages,
  ImageVariantCache,
} from "./storage/imageVariantCache";
import { hashSchema } from "../src/core/assets";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  net,
  session,
  screen,
  shell,
  type WebContents,
} from "electron";

export function mayAccessLocalFonts(contents: WebContents | null) {
  return (
    !!contents && !contents.isDestroyed() && contents === editor?.webContents
  );
}
import { mediaResponse } from "./mediaResponse";
import path from "node:path";
import { promises as fs } from "node:fs";
import { exportPowerPoint } from "./export/pptx";
import {
  pdfSlides,
  type ExportDocument,
  type ExportWarning,
} from "../src/export/shared";
import { walkElements } from "../src/core/element";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DocumentStorage, atomicWrite } from "./storage";
import { digest } from "./storage/io";
import { CollaborationService } from "./collaboration/session";
import { lanInterfaces, selectedLanAddress } from "./collaboration/security";
import { resolveOriginalAsset } from "./assetServing";
import type { FileCommand, PresenterState } from "../src/platform/api";
import type { DocumentSummary } from "../src/core/documentSummary";
import { z } from "zod";
import { idSchema } from "../src/core/ids";
import { editScopeSchema } from "../src/core/documentAuthority";
import {
  documentTransactionSchema,
  transactionIdSchema,
} from "../src/core/documentTransactions";
import {
  discoverySchema,
  interactionPreviewSchema,
} from "../src/core/collaboration/protocol";
import {
  SHOWME_DOCUMENT_EXTENSION,
  SHOWME_PACKAGE_EXTENSION,
} from "../src/core/package";

import {
  cleanStaleSlideTransfers,
  readSlideTransferPaths,
  slideTransferIcon,
  writeSlideTransferDescriptor,
} from "./slideTransfer";
import {
  defaultImageCachePath,
  readSettings,
  showMeLibraryPath,
  validateShowMeRoot,
  writeSettings,
} from "./settings";
import {
  LibraryLifecycle,
  librarySavePath,
  isInsideRoot,
  documentLibraryHashes,
} from "./libraryLifecycle";
import type { LibraryLifecycleMode } from "../src/core/libraryLifecycle";
import { registerIpcRouter } from "./ipcRouter";
import { PresentationRuntime } from "./presentationRuntime";
import {
  loadWindow as load,
  secureWindow as secure,
  windowOptions,
} from "./windowing";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Native browser painting at mixed CSS/media/shader boundaries. The renderer
// checks API availability before creating a capture surface.
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "studio",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let storage: DocumentStorage | null = null;
let editor: BrowserWindow | null = null;
let presentation: PresentationRuntime | null = null;
let exportWindow: BrowserWindow | null = null;
let exportReadyResolve: ((error: string | null) => void) | null = null;
let launchDocument: DocumentSummary | null = null;
let pendingOpenPath: string | null = null;
let activeDocumentId: string | null = null;
let allowEditorClose = false;
let closeRequestPending = false;
let effectLibraryQueue = Promise.resolve();
let lifecycleMode: LibraryLifecycleMode | null = null;
let lifecycle: LibraryLifecycle | null = null;
let showMeRoot = "";
function configureLifecycle() {
  const storage = requireStorage();
  const root = showMeRoot;
  const libraryRoot = storage.assetRoot;
  lifecycle = new LibraryLifecycle(
    root,
    () => {
      const remote = collaboration.clientDocument();
      return [...storage.openDocuments(), ...(remote ? [remote] : [])];
    },
    storage.openProtection,
    async (file) => {
      const trashRoot = path.join(libraryRoot, "Trash", "assets");
      if (!isInsideRoot(trashRoot, file))
        throw new Error("Unsafe Library Trash deletion");
      await fs.rm(file, { recursive: true, force: true });
    },
    Date.now,
    async () => {
      const settings = await readSettings(app.getPath("userData"), {
        requireExisting: true,
      });
      return (
        (settings.libraryLifecycleMode ?? "managed") === "managed" &&
        Boolean(settings.showMeRootPath) &&
        path.resolve(settings.showMeRootPath!) === path.resolve(root) &&
        path.resolve(showMeLibraryPath(root)) === path.resolve(libraryRoot)
      );
    },
  );
}
async function runLibraryScan(cleanup = false, expire = false) {
  if (lifecycleMode === "portable")
    throw new Error("Portable presentations do not use Library cleanup");
  if ((cleanup || expire) && lifecycleMode !== "managed")
    throw new Error("Automatic cleanup is disabled");
  configureLifecycle();
  const result = await lifecycle!.scan(
    cleanup,
    expire,
    lifecycleMode === "managed",
  );
  if (result.errors.length)
    console.error("Library scan incomplete", result.errors);
  return result;
}
async function getLibraryLifecycle() {
  await refreshLifecycleSettings();
  return {
    mode: lifecycleMode,
    root: showMeRoot,
    library: requireStorage().assetRoot,
  };
}
async function documentLibraryState(id: string) {
  await refreshLifecycleSettings();
  const storage = requireStorage();
  idSchema.parse(id);
  if (collaboration.isGuest(id) || !storage.hasDocument(id))
    return { displaced: false, location: "" };
  const summary = storage.summary(idSchema.parse(id));
  const dependent =
    documentLibraryHashes(
      storage.assetRoot,
      storage.documentRuntime(id).authority.document,
    ).length > 0;
  return {
    displaced:
      dependent &&
      !storage.isPackaged(id).packaged &&
      Boolean(summary.location) &&
      !isInsideRoot(showMeRoot, summary.location),
    location: summary.location,
  };
}
async function refreshLifecycleSettings() {
  const settings = await readSettings(app.getPath("userData"), {
    requireExisting: true,
  });
  if (!settings.showMeRootPath)
    throw new Error("ShowMe root is not configured");
  const configuredRoot = await validateShowMeRoot(settings.showMeRootPath);
  if (
    path.resolve(showMeLibraryPath(configuredRoot)) !==
    path.resolve(requireStorage().assetRoot)
  )
    throw new Error("ShowMe root changed outside the app; choose it again");
  showMeRoot = configuredRoot;
  lifecycleMode = settings.libraryLifecycleMode ?? "managed";
  requireStorage().lifecycleMode = lifecycleMode ?? "managed";
}

const recentEntrySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  location: z.string().min(1),
  openedAt: z.string(),
});
type RecentEntry = z.infer<typeof recentEntrySchema>;

const collaborationDiscoveryRecordSchema = discoverySchema.extend({
  address: z.string().min(1).max(64),
});
const collaborationAddressSchema = z.string().min(1).max(64);

const requireStorage = () => {
  if (!storage) throw new Error("Document storage is not ready");
  return storage;
};

const requirePresentation = () => {
  if (!presentation) throw new Error("Presentation runtime is not ready");
  return presentation;
};

const documentNotifications = new Map<string, () => void>();
function documentRuntime(documentId: string) {
  return requireStorage().documentRuntime(idSchema.parse(documentId));
}
function registerDocumentNotifications(documentId: string) {
  if (documentNotifications.has(documentId)) return;
  const unsubscribe = documentRuntime(documentId).subscribeAccepted(
    documentId,
    (accepted) => {
      try {
        const consoleWindow = presentation?.presenterConsoleWindow;
        if (consoleWindow && !consoleWindow.isDestroyed())
          consoleWindow.webContents.send("document-accepted", {
            documentId,
            accepted,
          });
        if (editor && !editor.isDestroyed())
          editor.webContents.send("document-accepted", {
            documentId,
            accepted,
          });
        const impact = acceptedImpact(
          accepted,
          documentRuntime(documentId).authority.document,
        );
        if (presentation)
          void presentation
            .refresh(documentId, impact)
            .catch((error) =>
              console.error("Presentation refresh failed", error),
            );
        if (impact.media) prepareImages(documentId, false, impact.slides);
        else imagePreparation.advanceRevision(documentId, accepted.revision);
        refreshDocumentWindow(documentId);
      } catch (error) {
        console.error("Renderer notification failed", error);
      }
    },
  );
  documentNotifications.set(documentId, unsubscribe);
  prepareImages(documentId);
}
const collaboration = new CollaborationService(
  documentRuntime,
  app.getVersion(),
);
collaboration.subscribe(
  () => {
    storage?.setExternalOpenDocument(collaboration.clientDocument());
    if (editor && !editor.isDestroyed())
      editor.webContents.send("collaboration-status", collaboration.status());
  },
  (records) => {
    if (editor && !editor.isDestroyed())
      editor.webContents.send("collaboration-discovery", records);
  },
  (actorId, preview) => {
    if (editor && !editor.isDestroyed())
      editor.webContents.send("collaboration-preview", { actorId, preview });
  },
  (accepted) => {
    const document = collaboration.clientDocument();
    storage?.setExternalOpenDocument(document, accepted);
    const impact = document && acceptedImpact(accepted, document);
    if (!impact || impact.media)
      prepareImages(accepted.documentId, false, impact?.slides);
    else
      imagePreparation.advanceRevision(accepted.documentId, accepted.revision);
    const consoleWindow = presentation?.presenterConsoleWindow;
    if (consoleWindow && !consoleWindow.isDestroyed())
      consoleWindow.webContents.send("document-accepted", {
        documentId: accepted.documentId,
        accepted,
      });
    if (editor && !editor.isDestroyed())
      editor.webContents.send("document-accepted", {
        documentId: accepted.documentId,
        accepted,
      });
    if (presentation)
      void presentation
        .refresh(accepted.documentId, impact ?? undefined)
        .catch((error) =>
          console.error("Guest presentation refresh failed", error),
        );
  },
  (documentId) => {
    storage?.setExternalOpenDocument(collaboration.clientDocument());
    prepareImages(documentId, true);
    if (editor && !editor.isDestroyed())
      editor.webContents.send("document-invalidated", { documentId });
    if (presentation)
      void presentation
        .refresh(documentId)
        .catch((error) =>
          console.error(
            "Guest presentation invalidation refresh failed",
            error,
          ),
        );
  },
  (documentId) => {
    imagePreparation.close(documentId);
    if (presentation?.state?.deckId === documentId) presentation.end();
  },
);

let imageCachingEnabled = true;
let imageCacheFormat: ImageCacheFormat = "png";
let deleteImageCacheOnClose = true;
let imageCacheFolder = "";
const imageCacheSession = randomUUID();
let cacheCleanupPending = false;
let cacheCleanupFinished = false;
const imageCacheCleanup = setTimeout(() => {
  void Promise.all([
    cleanupImageSessions(path.join(imageCacheFolder, "showme")),
    cleanupDiscardedImages(path.join(imageCacheFolder, "showme", "retained")),
  ]).catch((error) => console.error("Image cache maintenance failed", error));
}, 30000);
imageCacheCleanup.unref();
const imageCache = new ImageVariantCache(
  () => path.join(imageCacheFolder, "showme", imageCacheSession),
  path.join(__dirname, "imageWorker.cjs"),
  () => path.join(imageCacheFolder, "showme", "retained", "images"),
  () => !deleteImageCacheOnClose,
  () => imageCacheFormat,
);
let measuredAudienceProfile: ImageOutputProfile | null = null;
function imagePreparationProfile() {
  if (presentation?.state && measuredAudienceProfile) return measuredAudienceProfile;
  const displays = screen.getAllDisplays();
  const display =
    displays.find(
      (item) => item.id === presentation?.assignment.audienceDisplayId,
    ) ??
    displays.find((item) => item.id !== screen.getPrimaryDisplay().id) ??
    screen.getPrimaryDisplay();
  return outputImageProfile(display.size.width, display.size.height, display.scaleFactor);
}
const imagePreparation = new ImagePreparationCoordinator({
  concurrency: nativeImageConcurrency,
  slides: (id, slideIds) => {
    const document = collaboration.isGuest(id)
      ? collaboration.clientDocument()!
      : documentRuntime(id).authority.document;
    return slideIds.map((slideId) => resolveSlide(document, slideId).slide);
  },
  projection: (id, slideId) =>
    collaboration.isGuest(id)
      ? collaboration.projection(id, slideId)
      : documentRuntime(id).projection(id, slideId),
  profile: imagePreparationProfile,
  prepare: async (id, requirement, priority = 0) =>
    imageCache.prepare(
      collaboration.isGuest(id)
        ? await requireStorage().verifiedAssetPath(requirement.assetId)
        : await requireStorage().verifiedAssetPathForDocument(
            id,
            requirement.assetId,
          ),
      requirement.assetId,
      requirement.size,
      requirement.width,
      requirement.height,
      priority,
    ),
});
imagePreparation.subscribe((status) => {
  for (const window of [
    editor,
    presentation?.audienceWindow,
    presentation?.presenterConsoleWindow,
  ]) {
    if (
      window &&
      !window.isDestroyed() &&
      (window === editor || status.documentId === presentation?.state?.deckId)
    )
      window.webContents.send("image-readiness", status);
  }
});
function imageCacheFolderInfo() {
  const defaultPath = defaultImageCachePath(app.getPath("userData"));
  return {
    path: imageCacheFolder,
    defaultPath,
    isDefault: imageCacheFolder === defaultPath,
  };
}
async function assertLocalCacheFolder(cacheFolder: string, library: string) {
  await fs.mkdir(cacheFolder, { recursive: true });
  const realCache = await fs.realpath(cacheFolder);
  const realLibrary = canonicalFilesystemPath(library);
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  if (inside(realLibrary, realCache) || inside(realCache, realLibrary))
    throw new Error(
      "Choose an image cache folder outside the media library. Cache files are local to this computer.",
    );
}
async function changeImageCacheFolder(selected: string | null) {
  const next = selected ?? defaultImageCachePath(app.getPath("userData"));
  await assertLocalCacheFolder(next, requireStorage().assetRoot);
  imagePreparation.suspend();
  try {
    await imageCache.clear();
    const settings = await readSettings(app.getPath("userData"), {
      requireExisting: true,
    });
    settings.imageCachePath = selected;
    await writeSettings(app.getPath("userData"), settings);
    imageCacheFolder = next;
  } finally {
    if (imageCachingEnabled) imagePreparation.resume();
    notifyImageCacheChanged();
  }
  return imageCacheFolderInfo();
}
function notifyImageCacheChanged(documentIds?: readonly string[]) {
  for (const [window, id] of [
    [editor, activeDocumentId],
    [previewWindow, previewDocumentId],
    [presentation?.audienceWindow, presentation?.state?.deckId],
    [presentation?.presenterConsoleWindow, presentation?.state?.deckId],
  ] as const)
    if (
      window &&
      !window.isDestroyed() &&
      (!documentIds || (id && documentIds.includes(id)))
    )
      window.webContents.send("image-readiness", null);
}
function prepareImages(
  id: string,
  retry = false,
  affectedSlides?: readonly string[] | null,
) {
  void imagePreparation
    .reconcile(id, retry, affectedSlides)
    .catch((error) => console.error("Image preparation failed", error));
}

const recentFile = () =>
  path.join(app.getPath("userData"), "recent-documents.json");
async function readRecent(): Promise<RecentEntry[]> {
  try {
    const value = JSON.parse(await fs.readFile(recentFile(), "utf8"));
    return z.array(recentEntrySchema).max(100).parse(value);
  } catch {
    return [];
  }
}

async function rememberDocument(document: DocumentSummary) {
  if (!document.location) return;
  const location = document.location;
  const recent = await readRecent();
  const next: RecentEntry[] = [
    {
      id: document.id,
      name: document.name,
      location,
      openedAt: new Date().toISOString(),
    },
    ...recent.filter(
      (entry) => path.resolve(entry.location) !== path.resolve(location),
    ),
  ].slice(0, 30);
  await atomicWrite(recentFile(), JSON.stringify(next, null, 2) + "\n");
}

async function listDocuments() {
  const documents: DocumentSummary[] = [];
  for (const entry of await readRecent()) {
    try {
      documents.push(
        (await requireStorage().inspectDocument(entry.location)).summary,
      );
    } catch {
      // Missing or invalid recent files are non-authoritative catalog entries.
    }
  }
  return documents;
}

function updateDocumentWindow(document: DocumentSummary | null) {
  if (!editor || editor.isDestroyed()) return;
  if (!document) {
    editor.setDocumentEdited(false);
    editor.setTitle("ShowMe");
    return;
  }
  editor.setDocumentEdited(document.dirty);
  editor.setTitle(`${document.dirty ? "* " : ""}${document.name} - ShowMe`);
  if (document.location) editor.setRepresentedFilename(document.location);
}

function activateDocument(document: DocumentSummary) {
  prepareImages(document.id);
  activeDocumentId = document.id;
  requireStorage().setImportDocument(document.id);
  updateDocumentWindow(document);
}

function refreshDocumentWindow(documentId: string) {
  if (activeDocumentId !== documentId) return;
  const currentStorage = requireStorage();
  if (!currentStorage.hasDocument(documentId)) return;
  updateDocumentWindow(currentStorage.summary(documentId));
}

async function chooseRecoveryAction(file: string) {
  const candidate = await requireStorage().recoveryCandidate(file);
  if (!candidate) return "saved" as const;
  const options = {
    type: "question" as const,
    buttons: ["Recover", "Discard Recovery", "Open Saved Version"],
    defaultId: 0,
    cancelId: 2,
    title: "Recover unsaved changes",
    message: "ShowMe found newer unsaved work for this presentation.",
    detail: `Recovery updated ${new Date(candidate.updatedAt).toLocaleString()}. The saved .sme file will not be changed unless you choose Save.`,
  };
  const result = editor
    ? await dialog.showMessageBox(editor, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) return "recover" as const;
  if (result.response === 1)
    await requireStorage().discardRecoveryForPath(file);
  return "saved" as const;
}

async function openDocumentPath(file: string) {
  const resolved = path.resolve(file);
  const extension = path.extname(resolved).toLowerCase();
  if (
    extension !== SHOWME_DOCUMENT_EXTENSION &&
    extension !== SHOWME_PACKAGE_EXTENSION
  )
    throw new Error("Unsupported ShowMe file type");
  const document =
    extension === SHOWME_PACKAGE_EXTENSION
      ? await requireStorage().openPackage(resolved)
      : await requireStorage().openDocument(
          resolved,
          await chooseRecoveryAction(resolved),
        );
  registerDocumentNotifications(document.id);
  await rememberDocument(document);
  activateDocument(document);
  return document;
}

async function recoverUntitledAtLaunch() {
  const candidates = await requireStorage().listUntitledRecoveries();
  for (const candidate of candidates) {
    const result = await dialog.showMessageBox({
      type: "question",
      buttons: ["Recover", "Discard Recovery", "Not Now"],
      defaultId: 0,
      cancelId: 2,
      title: "Recover unsaved presentation",
      message: `ShowMe found unsaved work for “${candidate.name}”.`,
      detail: `Recovery updated ${new Date(candidate.updatedAt).toLocaleString()}. Recovering opens it as an unsaved presentation; the recovery data stays protected until you Save or discard it.`,
    });
    if (result.response === 0) {
      const document = await requireStorage().recoverUntitled(
        candidate.documentId,
      );
      registerDocumentNotifications(document.id);
      activateDocument(document);
      return document;
    }
    if (result.response === 1) {
      const recovered = await requireStorage().recoverUntitled(
        candidate.documentId,
      );
      await requireStorage().discardDocumentChanges(recovered.id);
      continue;
    }
    break;
  }
  return null;
}

function safeFileName(name: string) {
  const forbidden = new Set('<>:"/\\|?*');
  const safe = Array.from(name.trim(), (character) =>
    forbidden.has(character) || character.charCodeAt(0) < 32 ? "_" : character,
  ).join("");
  return safe || "Untitled";
}

async function nextTestPath(name: string, extension: string) {
  const directory = process.env.SHOWME_DOCUMENT_DIR;
  if (!directory) return null;
  await fs.mkdir(directory, { recursive: true });
  const base = safeFileName(name);
  for (let index = 1; index < 10000; index++) {
    const suffix = index === 1 ? "" : ` ${index}`;
    const file = path.join(directory, base + suffix + extension);
    try {
      await fs.access(file);
    } catch {
      return file;
    }
  }
  throw new Error("Could not allocate a presentation filename");
}

async function chooseSavePath(name: string) {
  await refreshLifecycleSettings();
  const portable = lifecycleMode === "portable";
  const testDirectory = process.env.SHOWME_DOCUMENT_DIR;
  const testExtension =
    portable ||
    (testDirectory &&
      !isInsideRoot(showMeRoot, path.join(testDirectory, name)))
      ? ".smp"
      : ".sme";
  const testPath = await nextTestPath(name, testExtension);
  if (testPath) return librarySavePath(showMeRoot, testPath, portable);
  const result = await dialog.showSaveDialog(editor!, {
    title: "Save presentation — .sme or portable .smp",
    defaultPath: path.join(
      showMeRoot,
      safeFileName(name) + (portable ? ".smp" : ".sme"),
    ),
    filters: [
      {
        name: "ShowMe Presentation",
        extensions: portable ? ["smp"] : ["sme", "smp"],
      },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  const target = librarySavePath(
    showMeRoot,
    result.filePath,
    portable,
  );
  if (target !== result.filePath) {
    const format = await dialog.showMessageBox(editor!, {
      type: "info",
      message: `Save as ${path.basename(target)}`,
      detail: target.endsWith(".smp")
        ? "Presentations saved outside the ShowMe root use a self-contained .smp package."
        : "Presentations saved inside the ShowMe root use a .sme document with assets stored in the Library.",
      buttons: ["Continue", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (format.response !== 0) return null;
    try {
      await fs.access(target);
      const response = await dialog.showMessageBox(editor!, {
        type: "question",
        message: `Replace ${path.basename(target)}?`,
        detail:
          "The destination uses a portable .smp package outside the ShowMe root and a .sme document inside it.",
        buttons: ["Replace", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response.response !== 0) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

async function choosePackagePath(name: string) {
  await refreshLifecycleSettings();
  const testPath = await nextTestPath(name, SHOWME_PACKAGE_EXTENSION);
  if (testPath) return testPath;
  const result = await dialog.showSaveDialog(editor!, {
    title: "Export ShowMe presentation",
    defaultPath: path.join(
      showMeRoot,
      safeFileName(name) + SHOWME_PACKAGE_EXTENSION,
    ),
    filters: [{ name: "ShowMe Packaged Presentation", extensions: ["smp"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath.toLowerCase().endsWith(SHOWME_PACKAGE_EXTENSION)
    ? result.filePath
    : result.filePath + SHOWME_PACKAGE_EXTENSION;
}

async function choosePackageMediaLock(
  action: "Export" | "Save",
  initial: boolean,
) {
  const result = await dialog.showMessageBox(editor!, {
    type: "question",
    title: `${action} packaged presentation`,
    message: "Packaged presentation options",
    detail:
      "Disable source-media export through ShowMe. This is a ShowMe UI restriction, not encryption or DRM. Package bytes can still be extracted with external tools.",
    buttons: [action, "Cancel"],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Disable media export in ShowMe",
    checkboxChecked: initial,
  });
  return result.response === 0 ? result.checkboxChecked : null;
}

async function chooseOpenPath() {
  const result = await dialog.showOpenDialog(editor!, {
    title: "Open ShowMe presentation",
    properties: ["openFile"],
    filters: [{ name: "ShowMe Presentation", extensions: ["sme", "smp"] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function findDocumentArgument(args: string[]) {
  const candidate = args.find((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower.endsWith(SHOWME_DOCUMENT_EXTENSION) ||
      lower.endsWith(SHOWME_PACKAGE_EXTENSION)
    );
  });
  return candidate ? path.resolve(candidate) : null;
}

async function openExternalDocument(file: string) {
  if (!storage) {
    pendingOpenPath = file;
    return;
  }
  if (activeDocumentId) {
    openInNewEditorWindow(file);
    return;
  }
  try {
    const document = await openDocumentPath(file);
    launchDocument = document;
    if (editor && !editor.isDestroyed()) {
      editor.webContents.send("document-opened", document);
      if (editor.isMinimized()) editor.restore();
      editor.show();
      editor.focus();
    }
  } catch (error) {
    if (editor && !editor.isDestroyed())
      dialog.showErrorBox(
        "Could not open presentation",
        error instanceof Error ? error.message : String(error),
      );
  }
}

const firstLaunchArgument = findDocumentArgument(process.argv.slice(1));
if (firstLaunchArgument) pendingOpenPath = firstLaunchArgument;

app.on("open-file", (event, file) => {
  event.preventDefault();
  void openExternalDocument(file);
});

async function getMediaLibraryInfo() {
  const current = requireStorage().assetRoot;
  return { path: current, isDefault: true, defaultPath: current };
}

async function explainStorageAndFonts(id: string, portable: boolean) {
  if (process.env.SHOWME_DOCUMENT_DIR) return;
  const settings = await readSettings(app.getPath("userData"), {
    requireExisting: true,
  });
  if (!settings.storageWarningSeen) {
    await dialog.showMessageBox(editor!, {
      type: "info",
      message: "Library documents and portable packages",
      detail:
        ".sme documents are not self-contained: their assets live in the Managed Library. .smp packages are portable. Cleanup scans .sme files recursively below the selected ShowMe root; unused assets go to Library Trash and may be permanently deleted after 10 days. Find this explanation again in Settings → Library / Storage.",
    });
    settings.storageWarningSeen = true;
    await writeSettings(app.getPath("userData"), settings);
  }
  const fonts = portable ? requireStorage().packageFontWarnings(id) : [];
  if (fonts.length)
    await dialog.showMessageBox(editor!, {
      type: "warning",
      message: "Typography may differ on another machine",
      detail:
        "These fonts are not included in this package: " +
        fonts.join(", ") +
        ". Arial, Times New Roman and Courier New are the initial portable font choices.",
    });
}

async function saveDocument(documentId: string, beforePersist?: () => void) {
  const id = idSchema.parse(documentId);
  if (collaboration.isGuest(id))
    throw new Error("Collaboration guests cannot save the host presentation");
  const before = requireStorage().summary(id);
  const destination = before.untitled
    ? await chooseSavePath(before.name)
    : undefined;
  if (before.untitled && !destination) return null;
  await explainStorageAndFonts(
    id,
    destination?.endsWith(".smp") ?? requireStorage().isPackaged(id).packaged,
  );
  beforePersist?.();
  const summary = destination?.endsWith(".smp")
    ? await requireStorage().savePackageAs(id, destination, false)
    : await requireStorage().saveDocument(id, destination ?? undefined);
  await rememberDocument(summary);
  activateDocument(summary);
  return summary;
}

async function saveDocumentAs(documentId: string) {
  const id = idSchema.parse(documentId);
  if (collaboration.isGuest(id))
    throw new Error("Collaboration guests cannot save the host presentation");
  const currentStorage = requireStorage();
  const current = currentStorage.summary(id);
  const packaged = currentStorage.isPackaged(id).packaged;
  const file = await chooseSavePath(current.name);
  if (!file) return null;
  const packageDestination = file.endsWith(".smp");
  await explainStorageAndFonts(id, packageDestination);
  const locked =
    packaged && packageDestination
      ? await choosePackageMediaLock(
          "Save",
          currentStorage.isPackaged(id).locked,
        )
      : null;
  if (packaged && packageDestination && locked === null) return null;
  const summary = packageDestination
    ? await currentStorage.savePackageAs(id, file, locked ?? false)
    : await currentStorage.saveDocument(id, file);
  await rememberDocument(summary);
  activateDocument(summary);
  return summary;
}

async function packageDocument(documentId: string) {
  const id = idSchema.parse(documentId);
  if (collaboration.isGuest(id))
    throw new Error(
      "Collaboration guests cannot package the host presentation",
    );
  const summary = requireStorage().summary(id);
  const file = await choosePackagePath(summary.name);
  if (!file) return null;
  const locked = await choosePackageMediaLock(
    "Export",
    requireStorage().isPackaged(id).locked,
  );
  if (locked === null) return null;
  await explainStorageAndFonts(id, true);
  const notes = await dialog.showMessageBox(editor!, {
    type: "question",
    title: "Share packaged presentation",
    message: "Speaker notes",
    detail:
      "Speaker notes are included by default. Remove them from the shared package without changing your presentation.",
    buttons: ["Create package", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Remove speaker notes",
    checkboxChecked: false,
  });
  if (notes.response !== 0) return null;
  return requireStorage().packageDocument(
    id,
    file,
    locked,
    notes.checkboxChecked,
  );
}

let exportBusy = false;
async function exportPresentation(documentId: string, format: "pdf" | "pptx") {
  if (exportBusy) throw new Error("An export is already in progress");
  exportBusy = true;
  try {
    return await performExportPresentation(documentId, format);
  } finally {
    exportBusy = false;
  }
}

async function performExportPresentation(
  documentId: string,
  format: "pdf" | "pptx",
) {
  const id = idSchema.parse(documentId);
  if (id !== activeDocumentId)
    throw new Error("Only the current presentation can be exported");
  const type = z.enum(["pdf", "pptx"]).parse(format);
  if (collaboration.isGuest(id))
    throw new Error(
      "Collaboration guests cannot export the host presentation because media ownership is local to the host",
    );
  const currentStorage = requireStorage();
  const snapshot = documentRuntime(id).fullSnapshot(id);
  const deck = snapshot.document.deck;
  const slides = deck.slideIds.map(
    (slideId) => resolveSlide(snapshot.document, slideId).slide,
  );
  const document: ExportDocument = { deck, slides };
  if (type === "pdf" && pdfSlides(document).length === 0)
    throw new Error("There are no slides to export");
  const result = await dialog.showSaveDialog(editor!, {
    title: type === "pdf" ? "Export as PDF" : "Export as PowerPoint",
    defaultPath: `${deck.name.replace(/[<>:"/\\|?*]/g, "_")}.${type === "pdf" ? "pdf" : "pptx"}`,
    filters: [
      {
        name: type === "pdf" ? "PDF" : "PowerPoint",
        extensions: [type === "pdf" ? "pdf" : "pptx"],
      },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  if (type === "pptx")
    return exportPowerPoint(
      document,
      async (assetId) => {
        try {
          const file = await currentStorage.verifiedAssetPathForDocument(
            id,
            assetId,
          );
          await fs.access(file);
          return file;
        } catch {
          return null;
        }
      },
      result.filePath,
      async (assetId) => {
        try {
          const file = currentStorage.previewPath(assetId);
          await fs.access(file);
          return file;
        } catch {
          return null;
        }
      },
      (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        return image.isEmpty() ? null : image.toPNG();
      },
      async (assetId) => {
        try {
          let image = nativeImage.createFromPath(
            await currentStorage.verifiedAssetPathForDocument(id, assetId),
          );
          if (image.isEmpty()) {
            try {
              image = nativeImage.createFromPath(
                currentStorage.previewPath(assetId),
              );
            } catch {
              return null;
            }
          }
          if (image.isEmpty()) return null;
          const size = image.getSize();
          return size.width > 0 && size.height > 0 ? size : null;
        } catch {
          return null;
        }
      },
    );
  const window = new BrowserWindow({
    ...windowOptions(),
    show: false,
    width: deck.width,
    height: deck.height,
    webPreferences: {
      ...windowOptions().webPreferences,
      backgroundThrottling: false,
    },
  });
  exportWindow = window;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(
        () => reject(new Error("PDF renderer did not become ready")),
        60000,
      );
      exportReadyResolve = (error) => {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = null;
        exportReadyResolve = null;
        if (error) reject(new Error(error));
        else resolve();
      };
    });
    window.once("closed", () =>
      exportReadyResolve?.(
        "PDF export window closed before rendering completed",
      ),
    );
    const devUrl = process.env.SHOWME_DEV_URL;
    if (devUrl && !app.isPackaged)
      await window.loadURL(`${devUrl}?exportPdf=${encodeURIComponent(id)}`);
    else
      await window.loadFile(path.join(__dirname, "../dist/index.html"), {
        query: { exportPdf: id },
      });
    await ready;
    const bytes = await window.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: {
        width: Math.round(((7.5 * deck.width) / deck.height) * 25400),
        height: Math.round(7.5 * 25400),
      },
      preferCSSPageSize: true,
    });
    await atomicWrite(result.filePath, bytes);
    const warnings: ExportWarning[] = await window.webContents
      .executeJavaScript(`
      Array.from(document.querySelectorAll('[data-effect-sampling-warning]')).map(node => ({
        slideId: node.closest('[data-slide-id]')?.dataset.slideId,
        elementId: node.closest('[data-element-id]')?.dataset.elementId,
        code: 'effect-sampling-reduced',
        message: node.dataset.effectSamplingWarning,
      }))
    `);
    const layers = new Map(deck.layers.map((layer) => [layer.id, layer]));
    for (const slide of pdfSlides(document)) {
      for (const root of slide.nodes) {
        if (layers.get(root.id)?.hidden) continue;
        for (const element of walkElements(root.children)) {
          const content = element.content;
          if (!content || content.type === "text") continue;
          try {
            await fs.access(
              await currentStorage.verifiedAssetPathForDocument(
                id,
                content.assetId,
              ),
            );
          } catch {
            warnings.push({
              slideId: slide.id,
              elementId: element.id,
              code: "missing-media",
              message:
                "Media could not be resolved and was rendered as missing",
            });
          }
        }
      }
    }
    return { warnings };
  } finally {
    if (readyTimer) clearTimeout(readyTimer);
    exportReadyResolve = null;
    exportWindow = null;
    if (!window.isDestroyed()) window.destroy();
  }
}

let previewWindow: BrowserWindow | null = null;
let previewDocumentId: string | null = null;
let previewQueue: Promise<void> = Promise.resolve();
let pendingPreviews = 0;

const operations: Record<string, (...args: any[]) => any> = {
  managedFonts: (documentId?: string) =>
    requireStorage().managedFonts(documentId),
  presentationImageDiagnostics: () => imageCache.diagnostics(),
  getImageCachingEnabled: () => imageCachingEnabled,
  getImageCacheFormat: () => imageCacheFormat,
  async setImageCacheFormat(value: unknown) {
    const format = z.enum(["png", "jpg"]).parse(value);
    if (format === imageCacheFormat) return;
    const settings = await readSettings(app.getPath("userData"), { requireExisting: true });
    settings.imageCacheFormat = format;
    await writeSettings(app.getPath("userData"), settings);
    imagePreparation.suspend();
    imageCacheFormat = format;
    if (imageCachingEnabled) imagePreparation.resume();
    notifyImageCacheChanged();
  },
  getDeleteImageCacheOnClose: () => deleteImageCacheOnClose,
  async setDeleteImageCacheOnClose(value: unknown) {
    const enabled = z.boolean().parse(value);
    const settings = await readSettings(app.getPath("userData"), {
      requireExisting: true,
    });
    settings.deleteImageCacheOnClose = enabled;
    await writeSettings(app.getPath("userData"), settings);
    deleteImageCacheOnClose = enabled;
  },
  async setImageCachingEnabled(value: unknown) {
    const enabled = z.boolean().parse(value);
    const settings = await readSettings(app.getPath("userData"), {
      requireExisting: true,
    });
    settings.imageCachingEnabled = enabled;
    await writeSettings(app.getPath("userData"), settings);
    imageCachingEnabled = enabled;
    if (enabled) imagePreparation.resume();
    else imagePreparation.suspend();
    notifyImageCacheChanged();
  },
  async imageReadiness(documentId: string, retry = false, slideId?: string) {
    if (!imageCachingEnabled) return null;
    const id = idSchema.parse(documentId);
    z.boolean().parse(retry);
    if (slideId) {
      idSchema.parse(slideId);
      await operations.documentProjection(id, slideId);
    }
    if (retry || !imagePreparation.status(id)) await imagePreparation.reconcile(id, retry);
    return imagePreparation.status(id);
  },
  audienceImageProfile(documentId: string) {
    idSchema.parse(documentId);
    return imagePreparationProfile();
  },
  async prepareAudience(documentId: string) {
    const id = idSchema.parse(documentId);
    const runtime = requirePresentation();
    await runtime.outputShown();
    const window = runtime.audienceWindow;
    if (runtime.state?.deckId !== id || !window || window.isDestroyed()) throw new Error("Audience session ended");
    const geometry: { width: number; height: number; pixelRatio: number } = await window.webContents.executeJavaScript(
      "({ width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio })",
    );
    const profile = outputImageProfile(geometry.width, geometry.height, geometry.pixelRatio);
    measuredAudienceProfile = profile;
    imagePreparation.prioritize(id, runtime.state.slideIds[runtime.state.index ?? 0]);
    await imagePreparation.reconcile(id);
    if (imageCachingEnabled) await imagePreparation.presentationReady(id, true);
    if (runtime.state?.deckId !== id) throw new Error("Audience session ended");
    for (const view of [editor, runtime.presenterConsoleWindow])
      if (view && !view.isDestroyed()) view.webContents.send("presentation-displays", runtime.displays());
    return profile;
  },
  async preparedSlideImages(documentId: string, slideId: string, outputProfile?: unknown) {
    if (!imageCachingEnabled) return {};
    const id = idSchema.parse(documentId);
    idSchema.parse(slideId);
    const profile = outputProfile === undefined ? imagePreparationProfile() : z.object({
      width: z.number().positive().max(100000), height: z.number().positive().max(100000),
    }).strict().parse(outputProfile);
    return imagePreparation.prepareSlide(id, slideId, profile, presentation?.state ? 0 : 1);
  },
  async preparedImage(
    documentId: string,
    slideId: string,
    elementId: string,
    outputProfile?: unknown,
  ) {
    if (!imageCachingEnabled) return null;
    const id = idSchema.parse(documentId);
    idSchema.parse(slideId);
    idSchema.parse(elementId);
    const profile: ImageOutputProfile =
      outputProfile === undefined
        ? imagePreparationProfile()
        : z
            .object({
              width: z.number().positive().max(100000),
              height: z.number().positive().max(100000),
            })
            .strict()
            .parse(outputProfile);
    return (await operations.preparedSlideImages(id, slideId, profile))[elementId] ?? null;
  },
  async preparedAssetImage(assetId: string, size: number) {
    if (!imageCachingEnabled) return null;
    hashSchema.parse(assetId);
    return imageCache.prepare(
      activeDocumentId && requireStorage().hasDocument(activeDocumentId)
        ? await requireStorage().verifiedAssetPathForDocument(
            activeDocumentId,
            assetId,
          )
        : await requireStorage().verifiedAssetPath(assetId),
      assetId,
      z.number().int().min(1).max(100000).parse(size),
    );
  },
  getImageCacheFolder: () => imageCacheFolderInfo(),
  async chooseImageCacheFolder() {
    const result = await dialog.showOpenDialog(editor!, {
      title: "Select Local Image Cache Directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return changeImageCacheFolder(path.resolve(result.filePaths[0]));
  },
  resetImageCacheFolder: () => changeImageCacheFolder(null),
  async clearPresentationImages() {
    imagePreparation.suspend();
    try {
      await imageCache.clear();
    } finally {
      if (imageCachingEnabled) imagePreparation.resume();
      notifyImageCacheChanged();
    }
  },
  recoveryCandidate: (file: unknown) =>
    requireStorage().recoveryCandidate(z.string().min(1).parse(file)),
  async openDocumentFile(file: unknown, mode: unknown = "saved") {
    const summary = await requireStorage().openDocument(
      z.string().min(1).parse(file),
      z.enum(["saved", "recover"]).parse(mode),
    );
    registerDocumentNotifications(summary.id);
    return summary;
  },
  listUntitledRecoveries: () => requireStorage().listUntitledRecoveries(),
  async recoverUntitled(documentId: string) {
    const summary = await requireStorage().recoverUntitled(
      idSchema.parse(documentId),
    );
    registerDocumentNotifications(summary.id);
    return summary;
  },
  saveDocumentToFile: async (id: string, destination?: unknown) => {
    await refreshLifecycleSettings();
    const parsed = idSchema.parse(id);
    if (collaboration.isGuest(parsed))
      throw new Error("Collaboration guests cannot save the host presentation");
    return requireStorage().saveDocument(
      parsed,
      destination === undefined
        ? undefined
        : librarySavePath(
            showMeRoot,
            z.string().min(1).parse(destination),
            lifecycleMode === "portable",
          ),
    );
  },
  async closeDocument(id: string) {
    const parsed = idSchema.parse(id);
    if (collaboration.isGuest(parsed)) {
      collaboration.leave();
      return;
    }
    documentNotifications.get(parsed)?.();
    documentNotifications.delete(parsed);
    imagePreparation.close(parsed);
    const storage = requireStorage();
    if (
      storage.summary(parsed).untitled &&
      storage.documentRuntime(parsed).authority.revision === 0
    )
      await storage.discardDocumentChanges(parsed);
    else storage.closeDocument(parsed);
  },
  documentProjection: (documentId: string, slideId?: string) => {
    const id = idSchema.parse(documentId);
    const parsedSlideId = slideId ? idSchema.parse(slideId) : undefined;
    return collaboration.isGuest(id)
      ? collaboration.projection(id, parsedSlideId)
      : documentRuntime(id).projection(id, parsedSlideId);
  },
  renderProjection: async (documentId: string, slideId?: string) => {
    const id = idSchema.parse(documentId);
    const pageId = slideId ? idSchema.parse(slideId) : undefined;
    if (!collaboration.isGuest(id))
      return documentRuntime(id).renderProjection(id, pageId);
    const projection = await collaboration.projection(id, pageId);
    const templateId =
      projection.deck.slideMeta[projection.slide.id]?.templateId;
    return {
      ...projection,
      templates:
        templateId && projection.templates[templateId]
          ? { [templateId]: projection.templates[templateId] }
          : {},
    };
  },
  documentCommit: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const transaction = documentTransactionSchema.parse(input);
    return collaboration.isGuest(id)
      ? collaboration.commitClient(id, transaction)
      : documentRuntime(id).commit(id, transaction);
  },
  documentAcquireLeases: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const scopes = z.array(editScopeSchema).min(1).max(256).parse(input);
    return collaboration.isGuest(id)
      ? collaboration.acquireClient(id, scopes)
      : documentRuntime(id).acquire(id, scopes);
  },
  documentRenewLeases: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const tokens = z.array(transactionIdSchema).min(1).max(256).parse(input);
    return collaboration.isGuest(id)
      ? collaboration.renewClient(id, tokens)
      : documentRuntime(id).renew(id, tokens);
  },
  documentReleaseLeases: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const tokens = z.array(transactionIdSchema).max(256).parse(input);
    if (collaboration.isGuest(id)) collaboration.releaseClient(id, tokens);
    else return documentRuntime(id).release(id, tokens);
  },
  documentUndo: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const tokens = z.array(transactionIdSchema).max(256).parse(input);
    return collaboration.isGuest(id)
      ? collaboration.undoClient(id)
      : documentRuntime(id).undo(id, tokens);
  },
  documentRedo: (documentId: string, input: unknown) => {
    const id = idSchema.parse(documentId);
    const tokens = z.array(transactionIdSchema).max(256).parse(input);
    return collaboration.isGuest(id)
      ? collaboration.redoClient(id)
      : documentRuntime(id).redo(id, tokens);
  },
  documentHistoryState: (documentId: string) => {
    const id = idSchema.parse(documentId);
    return collaboration.isGuest(id)
      ? collaboration.historyStateClient(id)
      : documentRuntime(id).historyState(id);
  },
  exportPresentation,
  exportReady: (error: unknown) => {
    exportReadyResolve?.(z.string().max(2000).nullable().parse(error));
  },
  collaborationInterfaces: () => {
    const recommended = selectedLanAddress();
    return lanInterfaces().map((entry) => ({
      ...entry,
      recommended: entry.address === recommended,
    }));
  },
  collaborationStart: async (id: string, address?: string) => {
    const parsed = idSchema.parse(id);
    if (parsed !== activeDocumentId)
      throw new Error("Only the current presentation can be shared");
    const parsedAddress =
      address === undefined
        ? undefined
        : collaborationAddressSchema.parse(address);
    return collaboration.start(parsed, parsedAddress);
  },
  collaborationDiscover: () => collaboration.discover(),
  collaborationJoin: (record: unknown, displayName: string) =>
    collaboration.join(
      collaborationDiscoveryRecordSchema.parse(record),
      z.string().min(1).max(100).parse(displayName),
    ),
  collaborationStatus: () => collaboration.status(),
  collaborationSelection: (
    slideId: string | null,
    selectionScopeId: string | null,
    elementIds: string[],
  ) =>
    collaboration.select(
      slideId === null ? null : idSchema.parse(slideId),
      selectionScopeId === null ? null : idSchema.parse(selectionScopeId),
      z.array(idSchema).max(100).parse(elementIds),
    ),
  collaborationPreview: (preview: unknown) =>
    collaboration.preview(interactionPreviewSchema.parse(preview)),
  collaborationClearPreview: () => collaboration.clearPreview(),
  collaborationApprove: (id: string) =>
    collaboration.approve(z.string().uuid().parse(id)),
  collaborationReject: (id: string) =>
    collaboration.reject(z.string().uuid().parse(id)),
  collaborationLeave: () => collaboration.leave(),
  collaborationStop: () => collaboration.stop(),
  async effectLibrary(raw: unknown) {
    const request = effectLibraryRequestSchema.parse(raw);
    const storage = new EffectLibraryStorage(
      path.join(requireStorage().assetRoot, "Effects"),
    );
    const result = effectLibraryQueue.then(async () => {
      if (request.type === "reveal") {
        shell.showItemInFolder(await storage.file(request.id));
        return storage.list();
      }
      return storage.run(request);
    });
    effectLibraryQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  },
  getMediaLibrary: getMediaLibraryInfo,
  async openMediaLibrary() {
    await shell.openPath(requireStorage().assetRoot);
  },
  getLibraryLifecycle,
  documentLibraryState,
  async moveDocumentIntoShowMeRoot(input: string) {
    const id = idSchema.parse(input);
    if (collaboration.isGuest(id))
      throw new Error("The host owns presentation files");
    const storage = requireStorage();
    const file = await chooseSavePath(storage.summary(id).name);
    if (!file) return null;
    if (!isInsideRoot(showMeRoot, file) || !file.endsWith(".sme"))
      throw new Error("Choose a location inside the ShowMe root");
    const original = await storage.assertNativeFileUnchanged(id);
    const summary = await storage.saveDocument(id, file);
    await rememberDocument(summary);
    activateDocument(summary);
    if (path.resolve(original.file) !== path.resolve(file)) {
      if (
        digest(await fs.readFile(original.file, "utf8")) !== original.revision
      )
        throw new Error(
          "Saved the ShowMe root copy, but the original changed during the move and was kept.",
        );
      await shell.trashItem(original.file);
    }
    return summary;
  },
  async saveDocumentAsPortable(input: string) {
    const id = idSchema.parse(input);
    if (collaboration.isGuest(id))
      throw new Error("The host owns presentation files");
    const storage = requireStorage();
    const file = await choosePackagePath(storage.summary(id).name);
    if (!file) return null;
    const summary = await storage.savePackageAs(id, file, false);
    await rememberDocument(summary);
    activateDocument(summary);
    return summary;
  },
  async setLibraryLifecycleMode(input: unknown) {
    const next = z.enum(["managed", "keep-all", "portable"]).parse(input);
    await refreshLifecycleSettings();
    if (next === "managed" && lifecycleMode !== "managed") {
      configureLifecycle();
      await lifecycle!.init();
      const analysis = await lifecycle!.scan(false, false, false);
      if (!analysis.complete) throw new Error(analysis.errors.join("\n"));
      const response = await dialog.showMessageBox(editor!, {
        type: "question",
        title: "Enable Managed Library",
        message: "Enable automatic unused asset cleanup?",
        detail: `${(analysis.unusedBytes / 1_000_000).toFixed(1)} MB is currently unreferenced. Unused assets will move to Library Trash, then system trash after 10 days. All .sme files below the ShowMe root are scanned recursively.`,
        buttons: ["Enable and clean up", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response.response !== 0) return getLibraryLifecycle();
    }
    const settings = await readSettings(app.getPath("userData"), {
      requireExisting: true,
    });
    settings.libraryLifecycleMode = next;
    await writeSettings(app.getPath("userData"), settings);
    await refreshLifecycleSettings();
    if (next !== "portable") {
      configureLifecycle();
      await lifecycle!.init();
    }
    if (next === "managed") await runLibraryScan(true, true);
    return getLibraryLifecycle();
  },
  async scanLibrary() {
    await refreshLifecycleSettings();
    return runLibraryScan(
      lifecycleMode === "managed",
      lifecycleMode === "managed",
    );
  },
  async emptyOldLibraryTrash() {
    await refreshLifecycleSettings();
    return runLibraryScan(false, true);
  },
  async reviewLibraryTrash() {
    await shell.openPath(path.join(requireStorage().assetRoot, "Trash"));
  },
  async chooseShowMeRoot() {
    const result = await dialog.showOpenDialog(editor!, {
      title: "Select ShowMe Root",
      defaultPath: showMeRoot,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = await validateShowMeRoot(path.resolve(result.filePaths[0]), {
      createLibrary: true,
    });
    const library = showMeLibraryPath(selected);
    await assertLocalCacheFolder(imageCacheFolder, library);
    const settings = await readSettings(app.getPath("userData"), {
      requireExisting: true,
    });
    await requireStorage().setAssetRoot(library);
    settings.showMeRootPath = selected;
    await writeSettings(app.getPath("userData"), settings);
    showMeRoot = selected;
    configureLifecycle();
    if (lifecycleMode !== "portable") await lifecycle!.init();
    imagePreparation.invalidate();
    return getLibraryLifecycle();
  },
  async createDocument(name: string) {
    const document = await requireStorage().createDocument(
      z.string().min(1).max(200).parse(name),
    );
    registerDocumentNotifications(document.id);
    activateDocument(document);
    return document;
  },
  async openDocument() {
    const file = await chooseOpenPath();
    return file ? openDocumentPath(file) : null;
  },
  async openDocumentInNewWindow() {
    const file = await chooseOpenPath();
    if (file) openInNewEditorWindow(file);
  },
  async openRecentDocument(location: string) {
    const resolved = path.resolve(z.string().min(1).parse(location));
    const recent = await readRecent();
    if (!recent.some((entry) => path.resolve(entry.location) === resolved))
      throw new Error("Presentation is not in the recent-document index");
    return openDocumentPath(resolved);
  },
  inspectDocument: (file: string) =>
    requireStorage().inspectDocument(z.string().min(1).parse(file)),
  listDocuments,
  currentDocument() {
    const document = launchDocument;
    launchDocument = null;
    return document;
  },
  saveDocument,
  saveDocumentAs,
  packageDocument,
  packageMediaState: (id: string) => requireStorage().isPackaged(id),
  async saveMediaAs(documentId: string, assetId: string) {
    if (requireStorage().isPackaged(documentId).locked)
      throw new Error("Media export is disabled in ShowMe for this package");
    const asset = await requireStorage().assetForDocument(documentId, assetId);
    const result = await dialog.showSaveDialog(editor!, {
      title: "Save Media As",
      defaultPath: asset.names[0] || asset.filename,
    });
    if (!result.canceled && result.filePath)
      await requireStorage().saveMediaAs(documentId, assetId, result.filePath);
  },
  async requestClose(documentId: string) {
    const id = idSchema.parse(documentId);
    if (collaboration.isGuest(id)) {
      collaboration.leave();
      return "closed";
    }
    const summary = requireStorage().summary(id);
    let response = summary.dirty ? 2 : 0;
    if (summary.dirty && !process.env.SHOWME_DOCUMENT_DIR) {
      const result = await dialog.showMessageBox(editor!, {
        type: "question",
        buttons: ["Save", "Don't Save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        title: "Unsaved changes",
        message: `Do you want to save changes to ${summary.name}?`,
      });
      response = result.response;
    } else if (summary.dirty) {
      response = 1;
    }
    if (response === 2) {
      closeRequestPending = false;
      return "canceled";
    }
    if (response === 0 && summary.dirty) {
      const saved = await saveDocument(id);
      if (!saved) {
        closeRequestPending = false;
        return "canceled";
      }
      documentNotifications.get(id)?.();
      documentNotifications.delete(id);
      requireStorage().closeDocument(id);
    } else if (response === 1 && summary.dirty) {
      documentNotifications.get(id)?.();
      documentNotifications.delete(id);
      await requireStorage().discardDocumentChanges(id);
    } else {
      documentNotifications.get(id)?.();
      documentNotifications.delete(id);
      if (summary.untitled) await requireStorage().discardDocumentChanges(id);
      else requireStorage().closeDocument(id);
    }
    allowEditorClose = true;
    closeRequestPending = false;
    editor?.close();
    return "closed";
  },
  readSlideTransferPaths: (input) =>
    readSlideTransferPaths(input, async (assetId, file) => {
      try {
        await requireStorage().verifiedAssetPath(assetId);
        return;
      } catch {}
      if (!file)
        throw new Error(`Slide transfer asset is unavailable: ${assetId}`);
      const imported = await requireStorage().importFile(file);
      if (imported.id !== assetId)
        throw new Error(
          `Slide transfer asset failed hash verification: ${assetId}`,
        );
    }),
  listAssets: (query, offset, limit) =>
    requireStorage().listAssets(
      String(query),
      Math.max(0, Number(offset) || 0),
      Math.max(1, Number(limit) || 100),
    ),
  getAsset: (id: string) =>
    activeDocumentId &&
    requireStorage().hasDocument(activeDocumentId) &&
    !collaboration.status().clientDocumentId
      ? requireStorage().assetForDocument(activeDocumentId, id)
      : requireStorage().asset(id),
  async importAssets() {
    const result = await dialog.showOpenDialog(editor!, {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Media",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "svg",
            "mp4",
            "webm",
          ],
        },
      ],
    });
    if (result.canceled) return [];
    const output = [];
    for (const file of result.filePaths)
      output.push(await requireStorage().importFile(file));
    return output;
  },
  async importDroppedPaths(input: unknown) {
    const paths = z.array(z.string()).max(500).parse(input);
    const output = [];
    for (const file of paths) {
      if (!path.isAbsolute(file)) continue;
      output.push(await requireStorage().importFile(file));
    }
    return output;
  },
  async importAssetData(input: unknown) {
    const { name, bytes } = z
      .object({
        name: z
          .string()
          .min(1)
          .max(500)
          .regex(/^[^/\\]+$/),
        bytes: z.instanceof(Uint8Array).refine((data) => data.length > 0),
      })
      .strict()
      .parse(input);
    return requireStorage().importAssetData(name, bytes);
  },
  async assetUrl(id: string, preview = false) {
    const currentStorage = requireStorage();
    let file: string;
    try {
      file =
        activeDocumentId &&
        currentStorage.hasDocument(activeDocumentId) &&
        !collaboration.status().clientDocumentId
          ? await currentStorage.verifiedAssetPathForDocument(
              activeDocumentId,
              id,
            )
          : await currentStorage.verifiedAssetPath(id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Asset not found:")
      )
        return null;
      throw error;
    }
    let variant = "original";
    if (preview) {
      try {
        await fs.access(currentStorage.previewPath(id));
        file = currentStorage.previewPath(id);
        variant = "preview";
      } catch {
        if (
          (
            await (activeDocumentId &&
            currentStorage.hasDocument(activeDocumentId) &&
            !collaboration.status().clientDocumentId
              ? currentStorage.assetForDocument(activeDocumentId, id)
              : currentStorage.asset(id))
          ).type === "video"
        )
          return null;
      }
    }
    if (preview && variant === "original") {
      try {
        const source = file;
        const target = currentStorage.previewPath(id);
        let pending = mediaPreviewJobs.get(target);
        if (!pending) {
          pending = mediaPreviewWork
            .run(0, async () => {
              const data = await sharp(source, {
                limitInputPixels: MAX_PREPARED_IMAGE_PIXELS,
              })
                .rotate()
                .resize(256, 256, { fit: "inside", withoutEnlargement: true })
                .flatten({ background: "white" })
                .jpeg({ quality: 80 })
                .toBuffer();
              await currentStorage.storePreview(id, data);
            })
            .finally(() => mediaPreviewJobs.delete(target));
          mediaPreviewJobs.set(target, pending);
        }
        await pending;
        file = target;
        variant = "preview";
      } catch {
        // Unsupported images retain the original-image fallback.
      }
    }
    try {
      await fs.access(file);
      return `studio://asset/${id}/${variant}`;
    } catch {
      return null;
    }
  },
  updateAsset: (asset) => requireStorage().updateAsset(asset),
  storePreview: (id, data) =>
    requireStorage().storePreview(id, new Uint8Array(data)),
  capturePreview(
    projection: import("../src/core/documentProjection").DocumentProjection,
    width: unknown,
    height: unknown,
  ) {
    // Capture an isolated canonical surface, never editor UI overlays.
    const requestedWidth = z.number().int().positive().max(2048).parse(width);
    const requestedHeight = z.number().int().positive().max(2048).parse(height);
    const documentId = idSchema.parse(projection.documentId),
      slideId = idSchema.parse(projection.slide.id);
    if (pendingPreviews >= 8) return Promise.resolve(null);
    pendingPreviews++;
    const task = previewQueue.then(async () => {
      const current = await operations.renderProjection(documentId, slideId);
      if (
        current.epoch !== projection.epoch ||
        current.revision !== projection.revision
      )
        return null;
      previewDocumentId = documentId;
      if (!previewWindow || previewWindow.isDestroyed()) {
        previewWindow = new BrowserWindow({
          ...windowOptions(),
          show: false,
          frame: false,
          useContentSize: true,
          minWidth: 1,
          minHeight: 1,
          width: requestedWidth,
          height: requestedHeight,
          // Keep a normal GPU compositor surface hidden. Offscreen copy requests
          // can fail with UnknownVizError even after renderer readiness.
          webPreferences: {
            ...windowOptions().webPreferences,
            backgroundThrottling: false,
          },
        });
        secure(previewWindow);
        const devUrl = process.env.SHOWME_DEV_URL;
        if (devUrl && !app.isPackaged)
          await previewWindow.loadURL(devUrl + "?slidePreview=1");
        else
          await previewWindow.loadFile(
            path.join(__dirname, "../dist/index.html"),
            { query: { slidePreview: "1" } },
          );
      }
      const window = previewWindow;
      window.setContentSize(requestedWidth, requestedHeight);
      try {
        const ready = await window.webContents.executeJavaScript(
          "window.composeSlidePreview(" +
            JSON.stringify(current) +
            "," +
            requestedWidth +
            "," +
            requestedHeight +
            ")",
        );
        if (!ready) return null;
        const image = await window.webContents.capturePage(undefined, {
          stayHidden: true,
        });
        return image
          .resize({
            width: requestedWidth,
            height: requestedHeight,
            quality: "best",
          })
          .toDataURL();
      } finally {
        await window.webContents
          .executeJavaScript("window.clearSlidePreview()")
          .catch(() => {});
      }
    });
    previewQueue = task.then(
      () => undefined,
      () => undefined,
    );
    void task
      .finally(() => {
        pendingPreviews--;
      })
      .catch(() => {});
    return task;
  },
  async thumbnail(documentId, slideId) {
    try {
      await fs.access(requireStorage().thumbnailPath(documentId, slideId));
      return `studio://thumbnail/${documentId}/${slideId}?v=${Date.now()}`;
    } catch {
      return null;
    }
  },
  storeThumbnail: (documentId, slideId, data) =>
    collaboration.status().clientDocumentId === documentId
      ? undefined
      : requireStorage().storeThumbnail(documentId, slideId, data),
  displays: () => requirePresentation().displays(),
  async present(input: PresenterState) {
    measuredAudienceProfile = null;
    await requirePresentation().present(input);
    const state = requirePresentation().state;
    if (state?.index !== null && state?.index !== undefined) {
      imagePreparation.prioritize(state.deckId, state.slideIds[state.index]);
      prepareImages(state.deckId);
    }
  },
  updatePresentation: (input: PresenterState) =>
    requirePresentation().update(input),
  getPresentation: () => requirePresentation().state,
  async presentationCommand(command) {
    await requirePresentation().command(command);
    const state = requirePresentation().state;
    if (state?.index !== null && state?.index !== undefined)
      imagePreparation.prioritize(state.deckId, state.slideIds[state.index]);
  },
  navigate: (index: number) => requirePresentation().navigate(index),
  setBlack: (value: boolean) => requirePresentation().setBlack(value),
  restartPresentationMedia: () => requirePresentation().restartMedia(),
  closePresentation: () => requirePresentation().end(),
  fullscreen: () => requirePresentation().fullscreen(),
  showPresenterConsole: () => requirePresentation().openPresenterConsole(),
  setPresentationDisplays: (
    assignment:
      | import("../src/core/presentationDisplays").PresentationDisplayAssignment
      | null,
  ) => requirePresentation().setPresentationDisplays(assignment),
};

ipcMain.on("showme:startSlideDrag", (event, input) => {
  if (!editor || event.sender.id !== editor.webContents.id) return;
  try {
    const { bundle, file } = writeSlideTransferDescriptor(
      input,
      (documentId, assetId) =>
        requireStorage().assetPathForDocument(documentId, assetId),
    );
    event.sender.startDrag({
      file,
      icon: slideTransferIcon(bundle.slides.length),
    });
  } catch (error) {
    console.error("Could not start slide drag", error);
  }
});

registerIpcRouter({
  operations,
  getEditor: () => editor,
  getExportWindow: () => exportWindow,
  getPreviewWindow: () => previewWindow,
  getPreviewDocumentId: () => previewDocumentId,
  getAudienceWindow: () => presentation?.audienceWindow ?? null,
  getPresenterConsole: () => presentation?.presenterConsoleWindow ?? null,
  getPresentationState: () => presentation?.state ?? null,
  getActiveDocumentId: () => activeDocumentId,
  getCollaborationClientStatus: () => collaboration.status().clientStatus,
});

function sendFileCommand(command: FileCommand) {
  if (editor && !editor.isDestroyed() && activeDocumentId)
    editor.webContents.send("file-command", command);
}

function openInNewEditorWindow(file: string) {
  const args = [
    ...(process.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
    `--user-data-dir=${app.getPath("userData")}`,
    ...(app.isPackaged ? [] : [path.resolve(".")]),
    path.resolve(file),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.once("error", (error) =>
    dialog.showErrorBox("Could not open presentation", error.message),
  );
  child.unref();
}

async function openFromMenu() {
  const file = await chooseOpenPath();
  if (!file) return;
  openInNewEditorWindow(file);
}

async function requireConfiguredShowMeRoot(
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<string | null> {
  if (settings.showMeRootPath) {
    try {
      return await validateShowMeRoot(settings.showMeRootPath);
    } catch (error) {
      dialog.showErrorBox(
        "ShowMe root unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    const intro = await dialog.showMessageBox({
      type: "info",
      title: "Choose ShowMe Root",
      message:
        "ShowMe now uses one root folder for presentations and the Media Library.",
      detail:
        "Choose the folder that contains, or should contain, your Library and all presentations that use it. Existing files will not be moved.",
      buttons: ["Choose ShowMe Root…", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (intro.response !== 0) {
      app.quit();
      return null;
    }
  }
  while (true) {
    const result = await dialog.showOpenDialog({
      title: "Choose ShowMe Root",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      app.quit();
      return null;
    }
    try {
      const root = await validateShowMeRoot(path.resolve(result.filePaths[0]), {
        createLibrary: true,
      });
      settings.showMeRootPath = root;
      await writeSettings(app.getPath("userData"), settings);
      return root;
    } catch (error) {
      dialog.showErrorBox(
        "Invalid ShowMe root",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

void app.whenReady().then(async () => {
  let settings: Awaited<ReturnType<typeof readSettings>>;
  try {
    settings = await readSettings(app.getPath("userData"));
  } catch (error) {
    dialog.showErrorBox(
      "Could not open ShowMe",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }
  lifecycleMode = settings.libraryLifecycleMode ?? "managed";
  imageCachingEnabled = settings.imageCachingEnabled !== false;
  imageCacheFormat = settings.imageCacheFormat ?? "png";
  deleteImageCacheOnClose = settings.deleteImageCacheOnClose !== false;
  imageCacheFolder =
    settings.imageCachePath && path.isAbsolute(settings.imageCachePath)
      ? settings.imageCachePath
      : defaultImageCachePath(app.getPath("userData"));
  if (!imageCachingEnabled) imagePreparation.suspend();
  const configuredShowMeRoot = await requireConfiguredShowMeRoot(settings);
  if (!configuredShowMeRoot) return;
  showMeRoot = configuredShowMeRoot;
  const assetRoot = showMeLibraryPath(showMeRoot);
  storage = new DocumentStorage(
    assetRoot,
    path.join(app.getPath("userData"), "cache"),
    lifecycleMode ?? "managed",
  );
  storage.fonts = fontStorageService;
  storage.onFontInventoryChanged = () => {
    for (const window of [
      editor,
      presentation?.presenterConsoleWindow,
      presentation?.audienceWindow,
    ])
      if (window && !window.isDestroyed())
        window.webContents.send("font-inventory-changed");
  };
  storage.onResourcesChanged = (ids) => {
    imagePreparation.invalidate(ids);
    notifyImageCacheChanged(ids);
    for (const window of [editor, presentation?.presenterConsoleWindow])
      if (window && !window.isDestroyed())
        for (const documentId of ids)
          window.webContents.send("document-invalidated", { documentId });
  };
  await storage.init();
  configureLifecycle();
  if (lifecycleMode !== "portable") await lifecycle!.init();

  await assertLocalCacheFolder(imageCacheFolder, storage.assetRoot);
  let preparedImageProfile = JSON.stringify(imagePreparationProfile());
  presentation = new PresentationRuntime(
    async (documentId) =>
      collaboration.isGuest(documentId)
        ? structuredClone(collaboration.clientDocument()!.deck)
        : documentRuntime(documentId).presentationDeck(documentId),
    async (documentId, _deck, slideIds) =>
      presentationMotionStages(
        collaboration.isGuest(documentId)
          ? collaboration.clientDocument()!
          : documentRuntime(documentId).authority.document,
        slideIds,
      ),
    () => {
      const next = JSON.stringify(imagePreparationProfile());
      if (next !== preparedImageProfile) {
        preparedImageProfile = next;
        imagePreparation.invalidate();
      }
    },
  );
  void cleanStaleSlideTransfers();

  if (pendingOpenPath) {
    const file = pendingOpenPath;
    pendingOpenPath = null;
    try {
      launchDocument = await openDocumentPath(file);
    } catch (error) {
      dialog.showErrorBox(
        "Could not open presentation",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (!launchDocument && !pendingOpenPath) {
    try {
      launchDocument = await recoverUntitledAtLaunch();
    } catch (error) {
      dialog.showErrorBox(
        "Could not recover unsaved presentation",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Open/recovered documents have established protection before destructive maintenance.
  // Destructive Library maintenance is explicit; launch performs no automatic GC.

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open...",
            accelerator: "CmdOrCtrl+O",
            click: () => void openFromMenu(),
          },
          { type: "separator" },
          {
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => sendFileCommand("save"),
          },
          {
            label: "Save As...",
            accelerator: "CmdOrCtrl+Shift+S",
            click: () => sendFileCommand("save-as"),
          },
          {
            label: "Export...",
            enabled: false,
            submenu: [
              {
                label: "ShowMe Package...",
                click: () => sendFileCommand("package"),
              },
              { label: "PDF...", click: () => sendFileCommand("export-pdf") },
              {
                label: "PowerPoint...",
                click: () => sendFileCommand("export-pptx"),
              },
            ],
          },
          { type: "separator" },
          { role: "close" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );

  protocol.handle("studio", async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const currentStorage = requireStorage();
      let file: string;
      let base: string;
      let contentType: string;
      if (url.hostname === "presentation-image" && parts.length === 1) {
        const match = /^([a-f0-9]{64})\.(png|jpg)$/.exec(parts[0]);
        if (!match) throw new Error("Invalid prepared image URL");
        base = imageCache.root;
        file = path.join(base, match[1] + "." + match[2]);
        contentType = match[2] === "jpg" ? "image/jpeg" : "image/png";
      } else if (url.hostname === "asset" && parts.length === 2) {
        if (parts[1] === "preview") {
          file = currentStorage.previewPath(parts[0]);
          base = currentStorage.cacheRoot;
          contentType = "image/jpeg";
        } else {
          const original = await resolveOriginalAsset(
            currentStorage,
            activeDocumentId &&
              currentStorage.hasDocument(activeDocumentId) &&
              !collaboration.status().clientDocumentId
              ? activeDocumentId
              : null,
            parts[0],
          );
          file = original.file;
          contentType = original.mime;
          base = file.startsWith(currentStorage.cacheRoot + path.sep)
            ? currentStorage.cacheRoot
            : currentStorage.assetRoot;
        }
      } else if (url.hostname === "thumbnail" && parts.length === 2) {
        file = currentStorage.thumbnailPath(parts[0], parts[1]);
        base = currentStorage.cacheRoot;
        contentType = "image/svg+xml";
      } else return new Response("Not found", { status: 404 });

      const real = await fs.realpath(file);
      const realBase = await fs.realpath(base);
      const isSub =
        process.platform === "win32"
          ? real.toLowerCase().startsWith((realBase + path.sep).toLowerCase())
          : real.startsWith(realBase + path.sep);
      if (!isSub) return new Response("Forbidden", { status: 403 });
      if (contentType.startsWith("video/") || contentType.startsWith("audio/"))
        return await mediaResponse(real, contentType, request);
      const response = await net.fetch(pathToFileURL(real).toString(), {
        headers: request.headers,
      });
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Content-Type", contentType);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Missing asset", { status: 404 });
    }
  });

  editor = new BrowserWindow(windowOptions());
  presentation.setEditor(editor);
  editor.setMenuBarVisibility(false);
  secure(editor);
  await load(editor);
  if (activeDocumentId) refreshDocumentWindow(activeDocumentId);
  editor.on("close", (event) => {
    if (allowEditorClose || !activeDocumentId) return;
    event.preventDefault();
    if (closeRequestPending) return;
    closeRequestPending = true;
    editor?.webContents.send("file-command", "prepare-close");
  });
  editor.on("closed", () => {
    previewWindow?.destroy();
    previewWindow = null;
    previewDocumentId = null;
    editor = null;
    activeDocumentId = null;
    presentation?.setEditor(null);
    presentation?.end();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => collaboration.close());
// All window close/save prompts have completed before will-quit fires.
app.on("will-quit", (event) => {
  if (!storage || cacheCleanupFinished) return;
  event.preventDefault();
  if (cacheCleanupPending) return;
  cacheCleanupPending = true;
  imagePreparation.suspend();
  void imageCache
    .releaseOnQuit(deleteImageCacheOnClose)
    .catch((error) => {
      console.error("Could not delete image cache on close:", error);
    })
    .finally(() => {
      cacheCleanupFinished = true;
      app.quit();
    });
});

const mediaPreviewWork = new ImageWorkQueue();
const mediaPreviewJobs = new Map<string, Promise<void>>();
