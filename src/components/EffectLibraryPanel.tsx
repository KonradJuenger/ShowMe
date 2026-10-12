import { useState } from "react";
import {
  libraryEffectSchema,
  libraryEffectFilename,
  type EffectLibraryRequest,
  type LibraryEffectAsset,
} from "../core/libraryEffects";
import type { EffectDefinition } from "../core/effects";
import type { EditorSnapshot } from "../core/editorCommands";
import { EffectEditor } from "./EffectEditor";
import { requestEffectLibrary, useEffectLibrary } from "./useEffectLibrary";
import "./EffectLibraryPanel.css";

export function EffectLibraryPanel({
  snapshot,
  onApply,
  canApply,
}: {
  snapshot: EditorSnapshot;
  onApply?(definition: EffectDefinition): void;
  canApply?(definition: EffectDefinition): boolean;
}) {
  const { library, error: loadError } = useEffectLibrary();
  const [folder, setFolder] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [draft, setDraft] = useState<{
    definition: EffectDefinition | null;
    asset?: LibraryEffectAsset;
    creating?: boolean;
    folder?: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function change(request: EffectLibraryRequest) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await requestEffectLibrary(request);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  const entries = library.entries
    .filter(
      (entry) =>
        (folder === null || entry.folder === folder) &&
        `${entry.asset.definition.name} ${entry.folder}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      a.asset.definition.name.localeCompare(b.asset.definition.name),
    );
  return (
    <section className="effect-library-panel" aria-label="Library Effects">
      <h3>My Effects</h3>
      <p>
        Reusable effects. Deleting here keeps effects already applied in
        presentations.
      </p>
      <button
        onClick={() =>
          setDraft({ definition: null, creating: true, folder: folder ?? "" })
        }
      >
        + New Effect
      </button>
      <label>
        Search
        <input
          type="search"
          aria-label="Search My Effects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label>
        Folder
        <select
          aria-label="Library Effects folder"
          value={folder ?? "*"}
          onChange={(e) =>
            setFolder(e.target.value === "*" ? null : e.target.value)
          }
        >
          <option value="*">All folders</option>
          <option value="">Effects</option>
          {library.folders.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
      <details>
        <summary>Folders and import</summary>
        <label>
          New folder
          <input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
          />
        </label>
        <div className="effect-library-actions">
          <button
            disabled={busy || !newFolder.trim()}
            onClick={() => void change({ type: "folder", folder: newFolder })}
          >
            Create folder
          </button>
        </div>
        <label>
          Import Effect
          <input
            type="file"
            accept=".txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setError("");
              if (file.size > 256000) {
                setError("Effect file exceeds 256 KB");
                return;
              }
              void file
                .text()
                .then((text) => {
                  setDraft({
                    folder: folder ?? "",
                    definition: libraryEffectSchema.parse(JSON.parse(text))
                      .definition,
                  });
                })
                .catch((failure) => setError(String(failure)));
            }}
          />
        </label>
      </details>
      <small>
        {entries.length} of {library.entries.length} effects
      </small>
      {entries.map(({ asset, folder: entryFolder }) => (
        <article
          className="effect-library-entry"
          key={asset.id}
          aria-label={asset.definition.name}
        >
          <strong>{asset.definition.name}</strong>
          <small>
            {entryFolder || "Effects"} ·{" "}
            {asset.definition.kind === "fragment-glsl" ? "Shader" : "CSS + JS"}
          </small>
          <div className="effect-library-actions">
            {onApply && (
              <button
                disabled={!canApply?.(asset.definition)}
                onClick={() => onApply(structuredClone(asset.definition))}
              >
                Apply
              </button>
            )}
            <button
              onClick={() =>
                setDraft({
                  definition: structuredClone(asset.definition),
                  asset,
                })
              }
            >
              Edit definition…
            </button>
            <button
              onClick={() =>
                setDraft({
                  folder: entryFolder,
                  definition: {
                    ...structuredClone(asset.definition),
                    name: asset.definition.name + " copy",
                  },
                })
              }
            >
              Duplicate
            </button>
            <button
              className="effect-library-delete"
              disabled={busy}
              onClick={() =>
                void change({
                  type: "delete",
                  id: asset.id,
                  revision: asset.revision,
                })
              }
            >
              Delete
            </button>
          </div>
          <details>
            <summary>Rename, move and export</summary>
            <label>
              Rename
              <input
                aria-label={`Rename ${asset.definition.name}`}
                key={`${asset.id}-${asset.revision}`}
                defaultValue={asset.definition.name}
                disabled={busy}
                onBlur={(e) => {
                  if (e.target.value !== asset.definition.name)
                    void change({
                      type: "save",
                      id: asset.id,
                      revision: asset.revision,
                      definition: { ...asset.definition, name: e.target.value },
                    });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <label>
              Move
              <select
                aria-label={`Move ${asset.definition.name}`}
                value={entryFolder}
                disabled={busy}
                onChange={(e) =>
                  void change({
                    type: "move",
                    id: asset.id,
                    revision: asset.revision,
                    folder: e.target.value,
                  })
                }
              >
                <option value="">Effects</option>
                {library.folders.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <div className="effect-library-actions">
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(asset, null, 2) + "\n"], {
                      type: "text/plain;charset=utf-8",
                    }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = libraryEffectFilename(asset);
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Export
              </button>
              {window.desktop && (
                <button
                  disabled={busy}
                  onClick={() => void change({ type: "reveal", id: asset.id })}
                >
                  Reveal in Explorer/Finder
                </button>
              )}
            </div>
          </details>
        </article>
      ))}
      {!entries.length && (
        <p>
          {library.entries.length
            ? "No matching effects."
            : "Create or import your first reusable effect."}
        </p>
      )}
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      {draft && (
        <EffectEditor
          definition={draft.definition}
          asset={draft.asset}
          folder={draft.folder}
          creating={draft.creating}
          snapshot={snapshot}
          element={null}
          onChange={(definition) => setDraft({ ...draft, definition })}
          onClose={() => setDraft(null)}
          onSaved={() => setDraft(null)}
        />
      )}
    </section>
  );
}
