import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./PresentationMenu.css";
import { MaterialIcon } from "./MaterialIcon";
import { platform } from "../platform";
import { formatExportWarnings } from "../export/shared";
import { LibraryStorageSettings } from "./LibraryStorageSettings";
import { NewPresentationDialog } from "./NewPresentationDialog";
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
    ])
      .then(([info, enabled, deleteOnClose, folder]) => {
        if (live) {
          setMediaLibrary(info);
          setImageCaching(enabled);
          setDeleteCacheOnClose(deleteOnClose);
          setCacheFolder(folder);
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

  async function chooseMediaLibrary() {
    setSettingsBusy(true);
    try {
      const next = await platform.chooseMediaLibrary();
      if (next) setMediaLibrary(next);
    } catch (error) {
      onError(error);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function resetMediaLibrary() {
    setSettingsBusy(true);
    try {
      setMediaLibrary(await platform.resetMediaLibrary());
    } catch (error) {
      onError(error);
    } finally {
      setSettingsBusy(false);
    }
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
                      await flushTransactions();
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
                <p>Library storage, collaboration, and image caching.</p>
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
              {applicationSettings}
              <div className="settings-section">
                <h3>Image cache</h3>
                <label><input type="checkbox" checked={imageCaching} disabled={cacheBusy || settingsBusy} onChange={event => {
                  const enabled = event.target.checked;
                  setCacheBusy(true);
                  void platform.setImageCachingEnabled?.(enabled).then(() => setImageCaching(enabled)).catch(onError).finally(() => setCacheBusy(false));
                }} /> Enable image caching</label>
                <p>Prepare whole images at the resolution needed by the editor, thumbnails and presentation. Originals retain all their detail.</p>
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
                {mediaLibrary && !mediaLibrary.isDefault && (
                  <p className="settings-default-path">
                    Default: {mediaLibrary.defaultPath}
                  </p>
                )}
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={settingsBusy}
                    onClick={() => void chooseMediaLibrary()}
                  >
                    Choose Folder…
                  </button>
                  <button
                    type="button"
                    disabled={settingsBusy || mediaLibrary?.isDefault}
                    onClick={() => void resetMediaLibrary()}
                  >
                    Use Default
                  </button>
                </div>
              </div>)}
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
            await flushTransactions();
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
            await flushTransactions();
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
      {settings}
    </>
  );
}
