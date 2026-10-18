import { BrowserWindow, clipboard, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { z } from "zod";
import type { PresenterState } from "../src/platform/api";
import type { ContextMenuSelection } from "../src/platform/contextMenu";
import { COMMAND_IDS, type CommandId } from "../src/core/commandRegistry";
import { idSchema } from "../src/core/ids";

const contextMenuCommandSchema = z.object({
  type: z.literal("command"),
  commandId: z
    .string()
    .refine((id) => Object.values(COMMAND_IDS).includes(id as CommandId)),
  label: z.string().min(1).max(100),
  enabled: z.boolean(),
  accelerator: z.string().max(80).optional(),
  value: z.string().max(100).optional(),
});
const contextMenuSeparatorSchema = z.object({ type: z.literal("separator") });
const contextMenuSubmenuSchema = z.object({
  type: z.literal("submenu"),
  label: z.string().min(1).max(100),
  enabled: z.boolean(),
  items: z
    .array(z.union([contextMenuSeparatorSchema, contextMenuCommandSchema]))
    .max(80),
});
const contextMenuSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  items: z
    .array(
      z.union([
        contextMenuSeparatorSchema,
        contextMenuCommandSchema,
        contextMenuSubmenuSchema,
      ]),
    )
    .max(80),
});

interface IpcRouterDependencies {
  operations: Record<string, (...args: any[]) => any>;
  getEditor: () => BrowserWindow | null;
  getExportWindow: () => BrowserWindow | null;
  getPreviewWindow: () => BrowserWindow | null;
  getPreviewDocumentId: () => string | null;
  getAudienceWindow: () => BrowserWindow | null;
  getPresenterConsole: () => BrowserWindow | null;
  getPresentationState: () => PresenterState | null;
  getActiveDocumentId: () => string | null;
  getCollaborationClientStatus: () => string;
}

export function registerIpcRouter({
  operations,
  getEditor,
  getExportWindow,
  getPreviewWindow,
  getPreviewDocumentId,
  getAudienceWindow,
  getPresenterConsole,
  getPresentationState,
  getActiveDocumentId,
  getCollaborationClientStatus,
}: IpcRouterDependencies) {
  let activeContextMenu: Menu | null = null;

  for (const method of ["readTextClipboard", "writeTextClipboard"] as const)
    ipcMain.handle("showme:" + method, (event, value: unknown) => {
      const editor = getEditor();
      if (!editor || event.sender !== editor.webContents ||
          event.senderFrame !== editor.webContents.mainFrame)
        throw new Error("Unauthorized window");
      if (method === "readTextClipboard") return clipboard.readText();
      return clipboard.writeText(z.string().parse(value));
    });

  ipcMain.handle("showme:closeContextMenu", (event) => {
    const editor = getEditor();
    if (!editor || event.sender !== editor.webContents)
      throw new Error("Unauthorized window");
    activeContextMenu?.closePopup(editor);
  });

  ipcMain.handle("showme:showContextMenu", (event, input: unknown) => {
    const editor = getEditor();
    if (
      !editor ||
      event.sender !== editor.webContents ||
      event.senderFrame !== editor.webContents.mainFrame
    )
      throw new Error("Unauthorized window");
    const request = contextMenuSchema.parse(input);
    const owner = editor;
    activeContextMenu?.closePopup(owner);
    return new Promise<ContextMenuSelection | null>((resolve) => {
      let chosen: ContextMenuSelection | null = null;
      const itemTemplate = (
        item:
          | z.infer<typeof contextMenuCommandSchema>
          | z.infer<typeof contextMenuSeparatorSchema>,
      ): MenuItemConstructorOptions =>
        item.type === "separator"
          ? { type: "separator" }
          : {
              id: item.commandId,
              label: item.label,
              enabled: item.enabled,
              accelerator: item.accelerator,
              registerAccelerator: false,
              click: () => {
                chosen = {
                  commandId: item.commandId as CommandId,
                  ...(item.value === undefined ? {} : { value: item.value }),
                };
              },
            };
      const menu = Menu.buildFromTemplate(
        request.items.map((item): MenuItemConstructorOptions =>
          item.type === "submenu"
            ? {
                label: item.label,
                enabled: item.enabled,
                submenu: item.items.map(itemTemplate),
              }
            : itemTemplate(item),
        ),
      );
      activeContextMenu = menu;
      const finish = () => {
        if (activeContextMenu === menu) activeContextMenu = null;
        owner.removeListener("closed", finish);
        resolve(chosen);
      };
      owner.once("closed", finish);
      menu.popup({
        window: owner,
        x: Math.round(request.x),
        y: Math.round(request.y),
        callback: finish,
      });
    });
  });

  let queue = Promise.resolve();
  for (const [method, operation] of Object.entries(operations))
    ipcMain.handle("showme:" + method, (event, ...args) => {
      const editor = getEditor();
      const exportWindow = getExportWindow();
      const presenter = getAudienceWindow();
      const presenterConsole = getPresenterConsole();
      const state = getPresentationState();
      const activeDocumentId = getActiveDocumentId();
      const preview = getPreviewWindow();
      const isPreview = preview && event.sender.id === preview.webContents.id;
      const isEditor = editor && event.sender.id === editor.webContents.id;
      const isExport =
        exportWindow && event.sender.id === exportWindow.webContents.id;
      const isAudience =
        presenter && event.sender.id === presenter.webContents.id;
      const isConsole =
        presenterConsole && event.sender.id === presenterConsole.webContents.id;
      const readMethods = [
        "preparedImage",
        "preparedSlideImages",
        "audienceImageProfile",
        "imageReadiness",
        "documentProjection",
        "managedFonts",
        "assetUrl",
        "getAsset",
        "getPresentation",
      ];
      const audienceMethods = [
        ...readMethods,
        "prepareAudience",
        "presentationCommand",
        "closePresentation",
        "fullscreen",
      ];
      const presenterMethods = [
        "preparedImage",
        "preparedSlideImages",
        "audienceImageProfile",
        "imageReadiness",
        "documentProjection",
        "managedFonts",
        "displays",
        "thumbnail",
        "presentationCommand",
        "showPresenterConsole",
        "assetUrl",
        "getAsset",
        "getPresentation",
        "navigate",
        "setBlack",
        "restartPresentationMedia",
        "closePresentation",
        "fullscreen",
      ];
      if (
        (!isEditor && !isAudience && !isConsole && !isExport && !isPreview) ||
        (isPreview && !["assetUrl", "managedFonts", "preparedImage", "preparedSlideImages"].includes(method)) ||
        (isExport &&
          !["documentProjection", "assetUrl", "managedFonts", "exportReady"].includes(
            method,
          )) ||
        (isAudience && !audienceMethods.includes(method)) ||
        (isConsole && !presenterMethods.includes(method)) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Unauthorized window");
      if (
        ["connected", "lost"].includes(getCollaborationClientStatus()) &&
        [
          "createDocument",
          "openDocument",
          "openRecentDocument",
          "saveDocument",
          "saveDocumentAs",
          "packageDocument",
          "openDocumentFile",
          "recoverUntitled",
          "saveDocumentToFile",
        ].includes(method)
      )
        throw new Error("The host owns presentation files during collaboration");
      if (
        (isAudience || isConsole) &&
        ["thumbnail", "documentProjection", "preparedImage", "preparedSlideImages", "imageReadiness", "audienceImageProfile", "prepareAudience"].includes(method)
      ) {
        if (
          !state ||
          args[0] !== state.deckId ||
          (["documentProjection", "preparedSlideImages", "preparedImage"].includes(method) && !state.slideIds.includes(String(args[1])))
        )
          throw new Error("Outside presentation session");
      }
      if (
        isExport &&
        method === "documentProjection" &&
        args[0] !== activeDocumentId
      )
        throw new Error("Outside export document");
      if (method === "exportReady" && !isExport)
        throw new Error("Unauthorized export readiness");
      if (method === "managedFonts") {
        const scope = isPreview ? getPreviewDocumentId() : isAudience || isConsole ? state?.deckId : activeDocumentId;
        const requested = idSchema.optional().parse(args[0]);
        if (requested && requested !== scope)
          throw new Error("Outside font document scope");
        args[0] = requested ?? scope ?? undefined;
      }
      if (isPreview && ["preparedImage", "preparedSlideImages"].includes(method) && args[0] !== getPreviewDocumentId()) throw new Error("Outside preview document");
      if (method === "prepareAudience" && !isAudience) throw new Error("Unauthorized audience preparation");
      if (isAudience && method === "documentProjection") {
        return Promise.resolve(operation(...args)).then(
          (projection: import("../src/core/documentProjection").DocumentProjection) =>
            ({ ...projection, slide: { ...projection.slide, notes: "" } }),
        );
      }

      // Read-only Library browsing and previews must not hold the save queue.
      if (
        method === "libraryBrowser" &&
        ["list", "trash", "preview", "reveal"].includes(args[0]?.type)
      )
        return operation(...args);

      if (
        [
          "createDocument",
          "openDocumentFile",
          "setMcpEnabled",
          "setMcpEditingEnabled",
          "setImageCacheFormat",
          "setDeleteImageCacheOnClose",
          "setImageCachingEnabled",
          "setLibraryLifecycleMode",
          "libraryBrowser",
          "effectLibrary",
          "scanLibrary",
          "emptyOldLibraryTrash",
          "recoverUntitled",
          "saveDocumentToFile",
          "closeDocument",
          "openDocument",
          "openRecentDocument",
          "saveDocument",
          "saveDocumentAs",
          "packageDocument",
          "saveMediaAs",
          "requestClose",
          "updateAsset",
          "storePreview",
          "storeThumbnail",
          "importAssets",
          "importDroppedPaths",
          "importAssetData",
          "chooseShowMeRoot",
          "chooseImageCacheFolder",
          "resetImageCacheFolder",
          "clearPresentationImages",
        ].includes(method)
      ) {
        const result = queue.then(() => operation(...args));
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      }
      return operation(...args);
    });
}
