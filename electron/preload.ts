import { contextBridge, ipcRenderer, webUtils } from "electron";

const methods = [
  "effectLibrary",
  "getLibraryLifecycle",
  "chooseShowMeRoot",
  "setLibraryLifecycleMode",
  "scanLibrary",
  "emptyOldLibraryTrash",
  "reviewLibraryTrash",
  "presentationImageDiagnostics",
  "imageReadiness",
  "preparedImage",
  "preparedSlideImages",
  "prepareAudience",
  "audienceImageProfile",
  "preparedAssetImage",
  "getImageCacheFolder",
  "chooseImageCacheFolder",
  "resetImageCacheFolder",
  "clearPresentationImages",
  "getImageCachingEnabled",
  "getImageCacheFormat",
  "setImageCacheFormat",
  "getDeleteImageCacheOnClose",
  "setDeleteImageCacheOnClose",
  "setImageCachingEnabled",
  "readTextClipboard",
  "writeTextClipboard",
  "openDocumentFile",
  "recoveryCandidate",
  "inspectDocument",
  "listUntitledRecoveries",
  "recoverUntitled",
  "saveDocumentToFile",
  "closeDocument",
  "documentProjection",
  "renderProjection",
  "documentCommit",
  "documentAcquireLeases",
  "documentRenewLeases",
  "documentReleaseLeases",
  "documentUndo",
  "documentRedo",
  "documentHistoryState",
  "collaborationStart",
  "collaborationInterfaces",
  "collaborationDiscover",
  "collaborationJoin",
  "collaborationStatus",
  "collaborationSelection",
  "collaborationPreview",
  "collaborationClearPreview",
  "collaborationApprove",
  "collaborationReject",
  "collaborationLeave",
  "collaborationStop",
  "getMediaLibrary",
  "openMediaLibrary",
  "managedFonts",
  "showContextMenu",
  "closeContextMenu",
  "createDocument",
  "openDocument",
  "openDocumentInNewWindow",
  "openRecentDocument",
  "listDocuments",
  "currentDocument",
  "saveDocument",
  "saveDocumentAs",
  "packageDocument",
  "exportPresentation",
  "exportReady",
  "packageMediaState",
  "saveMediaAs",
  "requestClose",
  "listAssets",
  "getAsset",
  "importAssets",
  "assetUrl",
  "updateAsset",
  "storePreview",
  "capturePreview",
  "thumbnail",
  "storeThumbnail",
  "displays",
  "presentationCommand",
  "showPresenterConsole",
  "setPresentationDisplays",
  "present",
  "updatePresentation",
  "getPresentation",
  "navigate",
  "setBlack",
  "restartPresentationMedia",
  "closePresentation",
  "fullscreen",
];

contextBridge.exposeInMainWorld("desktop", {
  isTest: Boolean(process.env.SHOWME_DOCUMENT_DIR),
  ...Object.fromEntries(
    methods.map((method) => [
      method,
      (...args: unknown[]) => ipcRenderer.invoke("showme:" + method, ...args),
    ]),
  ),
  importDroppedFiles: async (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    if (paths.every(Boolean))
      return ipcRenderer.invoke("showme:importDroppedPaths", paths);
    const assets = [];
    for (let index = 0; index < files.length; index++) {
      if (paths[index]) {
        assets.push(
          ...(await ipcRenderer.invoke("showme:importDroppedPaths", [
            paths[index],
          ])),
        );
      } else {
        assets.push(
          await ipcRenderer.invoke("showme:importAssetData", {
            name: files[index].name,
            bytes: new Uint8Array(await files[index].arrayBuffer()),
          }),
        );
      }
    }
    return assets;
  },
  readSlideTransfer: (files: File[]) => {
    const paths = files
      .map((file) => webUtils.getPathForFile(file))
      .filter((filePath) => filePath.length > 0);
    return ipcRenderer.invoke("showme:readSlideTransferPaths", paths);
  },
  startSlideDrag: (bundle: unknown) => {
    ipcRenderer.send("showme:startSlideDrag", bundle);
    return true;
  },
  releaseUrl: () => {},
  onFontInventoryChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("font-inventory-changed", listener);
    return () => ipcRenderer.removeListener("font-inventory-changed", listener);
  },
  onImageReadiness: (cb: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => cb(status);
    ipcRenderer.on("image-readiness", listener);
    return () => ipcRenderer.removeListener("image-readiness", listener);
  },
  onDocumentAccepted: (cb: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => cb(event);
    ipcRenderer.on("document-accepted", listener);
    return () => ipcRenderer.removeListener("document-accepted", listener);
  },
  onDocumentInvalidated: (cb: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => cb(event);
    ipcRenderer.on("document-invalidated", listener);
    return () => ipcRenderer.removeListener("document-invalidated", listener);
  },
  onDocumentOpened: (cb: (document: unknown) => void) => {
    const listener = (_: unknown, document: unknown) => cb(document);
    ipcRenderer.on("document-opened", listener);
    return () => ipcRenderer.removeListener("document-opened", listener);
  },
  onFileCommand: (cb: (command: unknown) => void) => {
    const listener = (_: unknown, command: unknown) => cb(command);
    ipcRenderer.on("file-command", listener);
    return () => ipcRenderer.removeListener("file-command", listener);
  },
  onDisplaysChanged: (cb: (displays: unknown) => void) => {
    const listener = (_: unknown, displays: unknown) => cb(displays);
    ipcRenderer.on("presentation-displays", listener);
    return () => ipcRenderer.removeListener("presentation-displays", listener);
  },
  onPresentation: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on("presentation", listener);
    return () => ipcRenderer.removeListener("presentation", listener);
  },
  onCollaborationStatus: (cb: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => cb(status);
    ipcRenderer.on("collaboration-status", listener);
    return () => ipcRenderer.removeListener("collaboration-status", listener);
  },
  onCollaborationDiscovery: (cb: (records: unknown) => void) => {
    const listener = (_: unknown, records: unknown) => cb(records);
    ipcRenderer.on("collaboration-discovery", listener);
    return () =>
      ipcRenderer.removeListener("collaboration-discovery", listener);
  },
  onCollaborationPreview: (cb: (message: unknown) => void) => {
    const listener = (_: unknown, message: unknown) => cb(message);
    ipcRenderer.on("collaboration-preview", listener);
    return () => ipcRenderer.removeListener("collaboration-preview", listener);
  },
});
