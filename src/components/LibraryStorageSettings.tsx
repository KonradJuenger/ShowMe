import { useEffect, useState } from "react";
import { platform } from "../platform";
import {
  LIBRARY_RETENTION_MS,
  type LibraryLifecycleInfo,
  type LibraryLifecycleMode,
  type LibraryScanResult,
} from "../core/libraryLifecycle";

const descriptions: Record<LibraryLifecycleMode, string> = {
  managed:
    "Store assets once and share them between presentations. ShowMe scans .sme files recursively in your presentations folder. Unused assets move to Library Trash and are permanently deleted after 10 days.",
  "keep-all":
    "Store and share assets in the central Library. Automatic cleanup is disabled, including existing Library Trash. You can review those files yourself.",
  portable:
    "Each presentation contains its own assets. New imports belong to the presentation and saves use portable .smp packages. Existing Library files remain untouched.",
};
const size = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function LibraryStorageSettings() {
  const [info, setInfo] = useState<LibraryLifecycleInfo | null>(null);
  const [choice, setChoice] = useState<LibraryLifecycleMode>("managed");
  const [scan, setScan] = useState<LibraryScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void platform
      .getLibraryLifecycle?.()
      .then((info) => {
        if (live) {
          setInfo(info);
          setChoice(info.mode ?? "managed");
        }
      })
      .catch((error) => live && setError(String(error)));
    return () => {
      live = false;
    };
  }, []);
  if (!platform.getLibraryLifecycle || !info) return null;
  const execute = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const content = (
    <section className="settings-section" aria-label="Library and Storage">
      <h3>Library / Storage</h3>
      <details>
        <summary>Learn more about storage and portability</summary>
        <p>
          .sme documents depend on Library assets and are not self-contained.
          .smp packages are portable. Managed Library scans the presentations
          folder and its subfolders when you run cleanup. Unused assets move to
          Library Trash and are permanently deleted after 10 days.
        </p>
      </details>
      <label>
        Library mode{" "}
        <select
          aria-label="Library mode"
          value={choice}
          disabled={busy}
          onChange={(event) =>
            setChoice(event.target.value as LibraryLifecycleMode)
          }
        >
          <option value="managed">Managed Library (Recommended)</option>
          <option value="keep-all">Keep Everything</option>
          <option value="portable">Portable Presentations</option>
        </select>
      </label>
      <p>{descriptions[choice]}</p>
      {(!info.mode || choice !== info.mode) && (
        <button
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const next = await platform.setLibraryLifecycleMode!(choice);
              setInfo(next);
              setChoice(next.mode ?? "managed");
              setScan(null);
            })
          }
        >
          {info.mode ? "Apply storage mode" : "Use this storage mode"}
        </button>
      )}
      <p>Presentations folder</p>
      <div
        className="settings-path"
        aria-label="Presentations folder"
        title={info.presentations}
      >
        {info.presentations}
      </div>
      <p>
        Default save location. Cleanup scans every .sme file in this folder and
        its subfolders. Put all .sme files that use this media library here
        before running cleanup. Choosing a folder does not move files.
      </p>
      <div className="settings-actions">
        <button
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const next = await platform.choosePresentationsFolder!();
              if (next) {
                setInfo(next);
                setScan(null);
              }
            })
          }
        >
          Choose Presentations Folder…
        </button>
        <button
          disabled={busy || info.presentations === info.defaultPresentations}
          onClick={() =>
            void execute(async () => {
              setInfo(await platform.resetPresentationsFolder!());
              setScan(null);
            })
          }
        >
          Use Default Presentations Folder
        </button>
      </div>
      {info.mode !== "portable" && (
        <>
          <p>Media library folder</p>
          <div
            className="settings-path"
            aria-label="Media library folder"
            title={info.root}
          >
            {info.root}
          </div>
          <div className="settings-actions">
            <button
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  if (await platform.chooseMediaLibrary()) {
                    setInfo(await platform.getLibraryLifecycle!());
                    setScan(null);
                  }
                })
              }
            >
              Choose Media Library Folder…
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  await platform.resetMediaLibrary();
                  setInfo(await platform.getLibraryLifecycle!());
                  setScan(null);
                })
              }
            >
              Use Default Media Library Folder
            </button>
          </div>

          {info.mode === "managed" && (
            <p>
              Move unused assets to Library Trash after a complete scan.
              Permanently delete them after 10 days.
            </p>
          )}
          {
            <div className="settings-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void execute(async () =>
                    setScan(await platform.scanLibrary!()),
                  )
                }
              >
                {info.mode === "managed"
                  ? "Scan Presentations & Clean Library"
                  : "Scan Presentations"}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void execute(async () => {
                    await platform.reviewLibraryTrash!();
                  })
                }
              >
                Review Trash
              </button>
              {info.mode === "managed" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void execute(async () =>
                      setScan(await platform.emptyOldLibraryTrash!()),
                    )
                  }
                >
                  Empty old trash now
                </button>
              )}
            </div>
          }
          {scan && (
            <div aria-live="polite">
              <p>
                {scan.complete
                  ? `${scan.presentations} presentations scanned`
                  : "Scan incomplete — cleanup stopped"}
              </p>
              <p>
                Referenced assets: {size(scan.referencedBytes)} · Unused /
                pending: {size(scan.unusedBytes)} · Library Trash:{" "}
                {size(scan.trashBytes)} · Other: {size(scan.otherBytes)}
              </p>
              {scan.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
              {scan.trash.length > 0 && (
                <details>
                  <summary>Trash items ({scan.trash.length})</summary>
                  <ul>
                    {scan.trash.map((item) => (
                      <li
                        key={`${item.hash}-${item.originalRelativePath}-${item.trashedAt}`}
                      >
                        {item.originalRelativePath} · {size(item.bytes)} ·
                        eligible for permanent deletion{" "}
                        {new Date(
                          Date.parse(item.trashedAt) + LIBRARY_RETENTION_MS,
                        ).toLocaleDateString()}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
  return content;
}
