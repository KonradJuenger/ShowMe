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
    "Store assets once in Library/ and share them between .sme presentations anywhere below the ShowMe root. Cleanup scans that complete root recursively. Unused assets move to Library Trash and are permanently deleted after 10 days.",
  "keep-all":
    "Store and share assets in Library/ below the ShowMe root. Automatic cleanup is disabled, including permanent deletion of existing Library Trash.",
  portable:
    "Use self-contained .smp packages instead of Managed Library dependencies. The selected ShowMe root and its Library remain untouched.",
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
      .then((next) => {
        if (live && next) {
          setInfo(next);
          setChoice(next.mode ?? "managed");
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

  return (
    <section className="settings-section" aria-label="Library and Storage">
      <h3>Library / Storage</h3>
      <details>
        <summary>Learn more about storage and portability</summary>
        <p>
          The ShowMe root is the shared storage boundary. Its visible Library/
          directory stores central assets, while .sme presentations that use
          those assets can live anywhere recursively below the same root.
          Cleanup scans the complete root before classifying assets as unused.
          A portable .smp is the alternative when a presentation should be
          self-contained or live elsewhere.
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

      <p>ShowMe root</p>
      <div className="settings-path" aria-label="ShowMe root" title={info.root}>
        {info.root}
      </div>
      <p>
        Library/ lives directly inside this folder. Every .sme presentation that
        depends on this Library must also live somewhere below this root.
        Choosing another root does not move or merge any existing files.
      </p>
      <div className="settings-actions">
        <button
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              const next = await platform.chooseShowMeRoot!();
              if (next) {
                setInfo(next);
                setChoice(next.mode ?? "managed");
                setScan(null);
              }
            })
          }
        >
          Choose ShowMe Root…
        </button>
      </div>

      <p>Library folder</p>
      <div
        className="settings-path"
        aria-label="Library folder"
        title={info.library}
      >
        {info.library}
      </div>
      <p>
        Library files remain directly accessible in Finder or Explorer. ShowMe
        does not hide them in application data.
      </p>
      {platform.openMediaLibrary && (
        <button
          disabled={busy}
          onClick={() =>
            void execute(async () => {
              await platform.openMediaLibrary!();
            })
          }
        >
          Open Library Folder
        </button>
      )}

      {info.mode !== "portable" && (
        <>
          {info.mode === "managed" && (
            <p>
              Cleanup moves unused assets to Library Trash only after a complete
              recursive scan of the ShowMe root. Trash becomes eligible for
              permanent deletion after 10 days.
            </p>
          )}
          <div className="settings-actions">
            <button
              disabled={busy}
              onClick={() =>
                void execute(async () => setScan(await platform.scanLibrary!()))
              }
            >
              {info.mode === "managed"
                ? "Scan Root & Clean Library"
                : "Scan Root"}
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
              {scan.errors.map((scanError) => (
                <p key={scanError}>{scanError}</p>
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
}
