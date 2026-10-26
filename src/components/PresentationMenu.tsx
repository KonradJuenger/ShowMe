import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./PresentationMenu.css";
import { MaterialIcon } from "./MaterialIcon";
import { platform } from "../platform";
import { type HtmlExportProgress, DEFAULT_HTML_EXPORT_JPEG_QUALITY } from "../export/html/types";
import { DEFAULT_FONT_EMBEDDING, type FontEmbedding } from "../export/fontEmbedding";
import { formatExportWarnings } from "../export/shared";
import { LibraryStorageSettings } from "./LibraryStorageSettings";
import { NewPresentationDialog } from "./NewPresentationDialog";
import type { ImageCacheFormat } from "../core/presentationImages";
import type { MediaLibraryInfo } from "../platform/api";

interface PresentationMenuProps {
  onNewPresentation?(name?: string): Promise<void>;
  onPresentationOpened?(
    document: import("../core/documentSummary").DocumentSummary,
    notice?: string,
  ): void;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  applicationSettings: ReactNode;
  deckId: string;
  flushTransactions(): Promise<void>;
  onError(error: unknown): void;
  onSave?: () => Promise<void>;
  onSaveAs?: () => Promise<void>;
}

interface MenuPosition {
  top: number;
  left: number;
}

export function PresentationMenu({
  settingsOpen,
  setSettingsOpen,
  applicationSettings,
  deckId,
  flushTransactions,
  onError,
  onSave,
  onSaveAs,
  onNewPresentation,
  onPresentationOpened,
}: PresentationMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0 });
  const settingsRef = useRef<HTMLElement>(null);
  const [imageCaching, setImageCaching] = useState(true);
  const [imageCacheFormat, setImageCacheFormat] = useState<ImageCacheFormat>("png");
  const [htmlQuality, setHtmlQuality] = useState(
    DEFAULT_HTML_EXPORT_JPEG_QUALITY,
  );
  const [htmlQualityDraft, setHtmlQualityDraft] = useState(
    String(DEFAULT_HTML_EXPORT_JPEG_QUALITY),
  );
  const [fontEmbedding, setFontEmbedding] = useState<FontEmbedding>(DEFAULT_FONT_EMBEDDING);
  const [fontBusy, setFontBusy] = useState(false);
  const [htmlProgress, setHtmlProgress] = useState<HtmlExportProgress | null>(null);
  const htmlProgressDialog = useRef<HTMLDialogElement>(null);
  const [htmlQualityBusy, setHtmlQualityBusy] = useState(false);
  const [deleteCacheOnClose, setDeleteCacheOnClose] = useState(true);
  const [cacheFolder, setCacheFolder] = useState<MediaLibraryInfo | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [mediaLibrary, setMediaLibrary] = useState<MediaLibraryInfo | null>(
    null,
  );
  const [recent, setRecent] = useState<
    import("../core/documentSummary").DocumentSummary[]
  >([]);
  const [newOpen, setNewOpen] = useState(false);
  const powerpointInput = useRef<HTMLInputElement>(null);
  const importingPowerPoint = useRef(false);
  const importProgress = useRef<HTMLDialogElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  useEffect(() => platform.onHtmlExportProgress?.(progress => {
    if (progress === null || progress.documentId === deckId) setHtmlProgress(progress);
  }), [deckId]);
  useEffect(() => {
    const dialog = htmlProgressDialog.current;
    if (htmlProgress && !dialog?.open) dialog?.showModal();
    else if (!htmlProgress) dialog?.close();
  }, [htmlProgress]);
  useEffect(() => {
    if (importBusy) importProgress.current?.showModal();
    else importProgress.current?.close();
  }, [importBusy]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void platform
      .listDocuments()
      .then((documents) => {
        if (live)
          setRecent(documents.filter((document) => document.id !== deckId));
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [open, deckId, onError]);

  function openMenu() {
    const bounds = buttonRef.current?.getBoundingClientRect();
    if (bounds)
      setPosition({
        top: bounds.bottom + 6,
        left: Math.max(8, bounds.left),
      });
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      )
        setOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const closeOnViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", closeOnPointer, true);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer, true);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [open]);

  useEffect(() => {
    if (!settingsOpen) return;
    let live = true;
    setCacheMessage("");
    setSettingsBusy(true);
    void Promise.all([
      platform.getMediaLibrary(),
      platform.getImageCachingEnabled?.() ?? Promise.resolve(true),
      platform.getDeleteImageCacheOnClose?.() ?? Promise.resolve(true),
      platform.getImageCacheFolder?.() ?? Promise.resolve(null),
      platform.getImageCacheFormat?.() ?? Promise.resolve<ImageCacheFormat>("png"),
      platform.getHtmlExportJpegQuality?.() ?? Promise.resolve(DEFAULT_HTML_EXPORT_JPEG_QUALITY),
      platform.getExportFontEmbedding?.() ?? Promise.resolve(DEFAULT_FONT_EMBEDDING),
    ])
      .then(([info, enabled, deleteOnClose, folder, format, quality, embedding]) => {
        if (live) {
          setMediaLibrary(info);
          setImageCaching(enabled);
          setDeleteCacheOnClose(deleteOnClose);
          setCacheFolder(folder);
          setImageCacheFormat(format);
          setHtmlQuality(quality);
          setFontEmbedding(embedding);
          setHtmlQualityDraft(String(quality));
        }
      })
      .catch(onError)
      .finally(() => {
        if (live) setSettingsBusy(false);
      });
    return () => {
      live = false;
    };
  }, [settingsOpen, onError]);

  useEffect(() => {
    if (!settingsOpen) return;
    const active = document.activeElement as HTMLElement | null;
    const opener = active === document.body ? buttonRef.current : active;
    settingsRef.current
      ?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSettingsOpen(false);
      } else if (event.key === "Tab") {
        const controls = Array.from(
          settingsRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [settingsOpen, setSettingsOpen]);

  function execute(task: () => Promise<void>) {
    setOpen(false);
    void task().catch(onError);
  }

  async function prepareReplacement() {
    await flushTransactions();
    return (await platform.confirmDocumentReplacement?.(deckId)) ?? true;
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className="presentation-menu-popover"
          role="menu"
          aria-label="Presentation"
          style={{ top: position.top, left: position.left }}
        >
          {onNewPresentation && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setNewOpen(true);
              }}
            >
              New presentation
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              execute(async () => {
                await platform.openDocumentInNewWindow?.();
              })
            }
          >
            <span>Open…</span>
            <span className="presentation-menu-shortcut">Ctrl/Cmd O</span>
          </button>
          {onPresentationOpened && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  powerpointInput.current?.click();
                }}
              >
                Import PPTX
              </button>
              {recent.length > 0 && (
                <div className="presentation-menu-heading">
                  Recent presentations
                </div>
              )}
              {recent.map((document) => (
                <button
                  type="button"
                  role="menuitem"
                  key={document.location}
                  title={document.location}
                  onClick={() =>
                    execute(async () => {
                      if (!(await prepareReplacement())) return;
                      onPresentationOpened(
                        await platform.openRecentDocument(document.location),
                      );
                    })
                  }
                >
                  {document.name}
                </button>
              ))}
            </>
          )}
          <div className="presentation-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              execute(async () => {
                await flushTransactions();
                if (onSave) await onSave();
                else await platform.saveDocument?.(deckId);
              })
            }
          >
            <span>Save</span>
            <span className="presentation-menu-shortcut">Ctrl/Cmd S</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              execute(async () => {
                await flushTransactions();
                if (onSaveAs) await onSaveAs();
                else await platform.saveDocumentAs?.(deckId);
              })
            }
          >
            <span>Save As…</span>
            <span className="presentation-menu-shortcut">Ctrl/Cmd Shift S</span>
          </button>
          {platform.packageDocument && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                execute(async () => {
                  await flushTransactions();
                  await platform.packageDocument?.(deckId);
                })
              }
            >
              <span>Export ShowMe Package…</span>
            </button>
          )}
          {platform.exportPresentation && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  execute(async () => {
                    await flushTransactions();
                    await platform.exportPresentation?.(deckId, "pdf");
                  })
                }
              >
                <span>Export as PDF…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  execute(async () => {
                    await flushTransactions();
                    let result;
                    try { result = await platform.exportPresentation?.(deckId, "html"); }
                    finally { setHtmlProgress(null); buttonRef.current?.focus(); }
                    if (result?.warnings.length)
                      window.alert(formatExportWarnings(result.warnings));
                  })
                }
              >
                <span>Export HTML…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  execute(async () => {
                    await flushTransactions();
                    const result = await platform.exportPresentation?.(
                      deckId,
                      "pptx",
                    );
                    if (result?.warnings.length)
                      window.alert(
                        formatExportWarnings(result.warnings),
                      );
                  })
                }
              >
                <span>Export as PowerPoint…</span>
              </button>
            </>
          )}
          <div className="presentation-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            <span>Settings…</span>
          </button>
        </div>,
        document.body,
      )
    : null;

  const settings = settingsOpen
    ? createPortal(
        <div
          className="settings-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            ref={settingsRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
          >
            <header className="settings-dialog-header">
              <div>
                <h2 id="settings-dialog-title">Settings</h2>
                <p>Library storage, collaboration, image caching, and HTML export.</p>
              </div>
              <button
                type="button"
                className="settings-dialog-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="settings-dialog-body">
              <div className="settings-section">
                <h3>Image cache</h3>
                <label><input type="checkbox" checked={imageCaching} disabled={cacheBusy || settingsBusy} onChange={event => {
                  const enabled = event.target.checked;
                  setCacheBusy(true);
                  void platform.setImageCachingEnabled?.(enabled).then(() => setImageCaching(enabled)).catch(onError).finally(() => setCacheBusy(false));
                }} /> Enable image caching</label>
                <p>Prepare whole images at the resolution needed by the editor, thumbnails and presentation. Originals retain all their detail.</p>
                {platform.setImageCacheFormat && <>
                  <label>Image cache format{" "}
                    <select aria-label="Image cache format" value={imageCacheFormat} disabled={cacheBusy || settingsBusy} onChange={event => {
                      const format = event.target.value as ImageCacheFormat;
                      setCacheBusy(true);
                      void platform.setImageCacheFormat!(format).then(() => setImageCacheFormat(format)).catch(onError).finally(() => setCacheBusy(false));
                    }}>
                      <option value="png">PNG (lossless)</option>
                      <option value="jpg">JPG (maximum quality)</option>
                    </select>
                  </label>
                  <p>JPG uses maximum quality. Images with transparency or high bit depth always use PNG. Originals are unchanged.</p>
                </>}
                {platform.setDeleteImageCacheOnClose && <label><input type="checkbox" checked={deleteCacheOnClose} disabled={cacheBusy || settingsBusy} onChange={event => {
                  const enabled = event.target.checked;
                  setCacheBusy(true);
                  void platform.setDeleteImageCacheOnClose!(enabled).then(() => setDeleteCacheOnClose(enabled)).catch(onError).finally(() => setCacheBusy(false));
                }} /> Delete image cache on close</label>}
                {platform.setDeleteImageCacheOnClose && <p>Delete prepared images when ShowMe exits. Original images are kept. This cache is local to this computer and separate from the media library.</p>}
                <button type="button" disabled={cacheBusy} onClick={() => {
                  setCacheBusy(true); setCacheMessage("");
                  void platform.clearPresentationImages?.().then(() => setCacheMessage("Image cache deleted.")).catch(onError).finally(() => setCacheBusy(false));
                }}>Delete image cache</button>
                {platform.chooseImageCacheFolder && <>
                  <div className="settings-path" aria-label="Image cache folder" title={cacheFolder?.path}>{cacheFolder?.path ?? (settingsBusy ? "Loading…" : "Unavailable")}</div>
                  <div className="settings-actions">
                    <button type="button" disabled={cacheBusy || settingsBusy} onClick={() => {
                      setCacheBusy(true);
                      void platform.chooseImageCacheFolder!().then(folder => { if (folder) setCacheFolder(folder); }).catch(onError).finally(() => setCacheBusy(false));
                    }}>Choose Folder…</button>
                    <button type="button" disabled={cacheBusy || settingsBusy || cacheFolder?.isDefault} onClick={() => {
                      setCacheBusy(true);
                      void platform.resetImageCacheFolder!().then(setCacheFolder).catch(onError).finally(() => setCacheBusy(false));
                    }}>Use Default</button>
                  </div>
                </>}
                {cacheMessage && <p role="status">{cacheMessage}</p>}
              </div>
              {platform.setExportFontEmbedding && <div className="settings-section">
                <h3>Export fonts</h3>
                <p>Applies to HTML and ShowMe Package (.smp) exports.</p>
                <label>Font embedding{" "}
                  <select aria-label="Export font embedding" value={fontEmbedding} disabled={settingsBusy || fontBusy} onChange={event => {
                    const mode = event.target.value as FontEmbedding;
                    setFontBusy(true);
                    void platform.setExportFontEmbedding!(mode).then(() => setFontEmbedding(mode)).catch(onError).finally(() => setFontBusy(false));
                  }}>
                    <option value="none">None</option>
                    <option value="svg">SVG</option>
                    <option value="file">Font file</option>
                  </select>
                </label>
                <p>{fontEmbedding === "svg" ? "Static text becomes SVG outlines. Text with Effects stays live and is reported after export." : fontEmbedding === "file" ? "Includes complete font files and keeps text editable and animated. You must have a license to embed and share the fonts." : "No fonts are included. Text uses fonts installed on the receiving computer."}</p>
              </div>}
              {platform.setHtmlExportJpegQuality && (
                <div className="settings-section">
                  <h3>HTML export</h3>
                  <label>
                    JPEG quality{" "}
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      aria-label="HTML export JPEG quality"
                      value={htmlQualityDraft}
                      disabled={settingsBusy || htmlQualityBusy}
                      onChange={(event) =>
                        setHtmlQualityDraft(event.target.value)
                      }
                      onBlur={() => {
                        const quality = Number(htmlQualityDraft);
                        if (
                          !Number.isInteger(quality) ||
                          quality < 1 ||
                          quality > 100
                        ) {
                          setHtmlQualityDraft(String(htmlQuality));
                          return;
                        }
                        if (quality === htmlQuality) return;
                        setHtmlQualityBusy(true);
                        void platform.setHtmlExportJpegQuality!(quality)
                          .then(() => setHtmlQuality(quality))
                          .catch((error) => {
                            setHtmlQualityDraft(String(htmlQuality));
                            onError(error);
                          })
                          .finally(() => setHtmlQualityBusy(false));
                      }}
                    />
                  </label>
                  <p>
                    1–100, default 90. Applies only to prepared images in HTML
                    exports. Transparent and high bit depth images stay PNG;
                    animated images and SVGs keep their original format.
                  </p>
                </div>
              )}
              <LibraryStorageSettings />
              {!platform.getLibraryLifecycle && (<div className="settings-section">
                <div className="settings-section-heading">
                  <div>
                    <h3>Media Library</h3>
                    <p>
                      Imported media is stored here and referenced by
                      presentations.
                    </p>
                  </div>
                  {mediaLibrary?.isDefault && (
                    <span className="settings-default-badge">Default</span>
                  )}
                </div>
                <div
                  className="settings-path"
                  aria-label="Media library path"
                  title={mediaLibrary?.path ?? ""}
                >
                  {mediaLibrary?.path ??
                    (settingsBusy ? "Loading…" : "Unavailable")}
                </div>
              </div>)}
              {applicationSettings}
            </div>
            <footer className="settings-dialog-footer">
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Done
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`tool-button presentation-menu-trigger ${open ? "active" : ""}`}
        aria-label="Presentation menu"
        title="Presentation menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={openMenu}
      >
        <MaterialIcon name="file-presentation-box" />
      </button>
      {menu}
      {newOpen && onNewPresentation && (
        <NewPresentationDialog
          onClose={() => setNewOpen(false)}
          onCreate={async (name) => {
            if (!(await prepareReplacement())) return;
            await onNewPresentation(name);
          }}
        />
      )}
      <input
        ref={powerpointInput}
        type="file"
        aria-label="Import PowerPoint file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file || importingPowerPoint.current) return;
          importingPowerPoint.current = true;
          setImportBusy(true);
          setImportError("");
          void (async () => {
            if (!(await prepareReplacement())) return;
            const { importPowerPointPresentation } =
              await import("./importPowerPointPresentation");
            const result = await importPowerPointPresentation(file);
            if (result)
              onPresentationOpened?.(
                result.document,
                result.warnings.length
                  ? `PowerPoint imported. ${result.warnings.join(" ")}`
                  : "",
              );
          })()
            .catch((error) => {
              setImportError(String(error));
              onError(error);
            })
            .finally(() => {
              importingPowerPoint.current = false;
              setImportBusy(false);
            });
        }}
      />
      {importError && (
        <div className="presentation-file-error" role="alert">
          <p>{importError}</p>
          <button onClick={() => setImportError("")}>Dismiss</button>
        </div>
      )}
      <dialog
        ref={importProgress}
        className="new-presentation-dialog"
        aria-label="Importing PowerPoint"
        onCancel={(event) => event.preventDefault()}
      >
        <p role="status">Importing PowerPoint…</p>
      </dialog>
      <dialog ref={htmlProgressDialog} className="new-presentation-dialog html-export-progress" aria-labelledby="html-export-progress-title" onCancel={event => event.preventDefault()}>
        <h2 id="html-export-progress-title">Exporting HTML</h2>
        {htmlProgress && <>
          <p role="status">{{ fonts: "Preparing text…", videos: "Trimming videos…", images: "Preparing images…", embedding: "Embedding media…", writing: "Saving HTML…", complete: "Export complete" }[htmlProgress.stage]}</p>
          <progress aria-label="HTML export progress" max={100} value={htmlProgressValue(htmlProgress)} />
          <div className="html-export-progress-detail"><span>{htmlProgress.total > 0 ? `${htmlProgress.completed} / ${htmlProgress.total}` : "Preparing…"}</span><span>{Math.floor(htmlProgressValue(htmlProgress))}%</span></div>
        </>}
      </dialog>
      {settings}
    </>
  );
}

function htmlProgressValue(progress: HtmlExportProgress) {
  const [start, end] = { fonts: [0, 15], videos: [15, 55], images: [55, 80], embedding: [80, 95], writing: [95, 99], complete: [100, 100] }[progress.stage];
  return start + (end - start) * (progress.total > 0 ? Math.min(1, progress.completed / progress.total) : 0);
}
