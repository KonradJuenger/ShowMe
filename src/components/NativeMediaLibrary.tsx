import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { platform } from "../platform";
import type {
  LibraryBrowserEntry,
  LibraryBrowserResult,
  LibraryCategory,
} from "../core/libraryBrowser";
import type { Asset } from "../core/assets";
import { IconClose, IconFolder, IconLock, IconMore } from "./AppIcons";
import { VirtualList } from "./VirtualList";
import "./NativeMediaLibrary.css";

const PAGE_SIZE = 120;
const COLUMNS = 3;
const GAP = 8;
const ROW_PADDING = 4;
const FILTERS: Array<{
  id: "all" | LibraryCategory | "Trash";
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "fonts", label: "Fonts" },
  { id: "Effects", label: "Effects" },
  { id: "other", label: "Other" },
  { id: "Trash", label: "Trash" },
];

type Filter = (typeof FILTERS)[number]["id"];
type EditMode = "rename" | "move" | null;

const previewCache = new Map<string, Promise<string | undefined>>();

function humanPath(path: string) {
  return path.split("/").slice(1, -1).join(" / ");
}
function basename(path: string) {
  return path.split("/").at(-1) ?? path;
}
function categoryFolder(path: string) {
  return path.split("/").slice(1).join("/");
}
function isInsertable(entry: LibraryBrowserEntry) {
  return (
    entry.kind === "file" &&
    (entry.category === "images" || entry.category === "video")
  );
}

function EntryPreview({ entry }: { entry: LibraryBrowserEntry }) {
  const [preview, setPreview] = useState<string>();
  const font = useRef<FontFace | null>(null);
  useEffect(() => {
    setPreview(undefined);
    if (
      entry.kind === "folder" ||
      entry.error ||
      !platform.libraryBrowser ||
      !["images", "video", "fonts", "Effects"].includes(entry.category ?? "")
    )
      return;
    const key = `${entry.path}:${entry.signature ?? ""}`;
    let job = previewCache.get(key);
    if (!job) {
      job = platform
        .libraryBrowser({ type: "preview", path: entry.path })
        .then((result) => result.preview)
        .catch(() => undefined);
      previewCache.set(key, job);
      if (previewCache.size > 240)
        previewCache.delete(previewCache.keys().next().value!);
    }
    let active = true;
    void job.then(async (value) => {
      if (!active || !value) return;
      if (entry.category === "fonts") {
        try {
          const face = new FontFace(
            `showme-library-${entry.signature ?? entry.path}`,
            `url(${value})`,
          );
          await face.load();
          if (!active) return;
          document.fonts.add(face);
          font.current = face;
          setPreview(face.family);
        } catch {}
      } else setPreview(value);
    });
    return () => {
      active = false;
      if (font.current) document.fonts.delete(font.current);
      font.current = null;
    };
  }, [entry]);

  if (entry.kind === "folder")
    return (
      <span className="native-library-folder-preview" aria-hidden="true">
        <IconFolder />
      </span>
    );
  if (entry.category === "fonts")
    return (
      <span
        className="native-library-font-preview"
        style={preview ? { fontFamily: preview } : undefined}
      >
        Aa
      </span>
    );
  if (
    preview &&
    ["images", "video", "Effects"].includes(entry.category ?? "")
  )
    return (
      <img
        className={entry.category === "Effects" ? "effect-preview-image" : ""}
        src={preview}
        draggable={false}
        decoding="async"
        alt=""
      />
    );
  return (
    <span className="native-library-kind">
      {entry.category === "Effects"
        ? "FX"
        : (entry.category ?? "FILE").toUpperCase()}
    </span>
  );
}

function startLibraryDrag(
  event: DragEvent<HTMLElement>,
  entry: LibraryBrowserEntry,
) {
  if (!isInsertable(entry)) return;
  event.dataTransfer.effectAllowed = "copy";
  if (entry.asset)
    event.dataTransfer.setData(
      "application/show-me-asset",
      JSON.stringify(entry.asset),
    );
  else
    event.dataTransfer.setData(
      "application/show-me-library-entry",
      JSON.stringify({ path: entry.path }),
    );
}

export function NativeMediaLibrary({
  refresh,
  onInsert,
  onImport,
}: {
  refresh: number;
  onInsert: (asset: Asset) => void;
  onImport?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<Record<number, LibraryBrowserEntry[]>>({});
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<LibraryBrowserEntry | null>(null);
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [editValue, setEditValue] = useState("");
  const [newFolder, setNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [width, setWidth] = useState(300);
  const host = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<number>());
  const generation = useRef(0);

  const requestPage = useCallback(
    (page: number, reset = false) => {
      if (!platform.libraryBrowser || requested.current.has(page)) return;
      requested.current.add(page);
      const current = generation.current;
      const offset = page * PAGE_SIZE;
      const request =
        filter === "Trash"
          ? ({ type: "trash", offset, limit: PAGE_SIZE } as const)
          : ({
              type: "list",
              category: filter,
              folder: filter === "all" ? "" : folder,
              query,
              all: filter === "all",
              offset,
              limit: PAGE_SIZE,
            } as const);
      void platform
        .libraryBrowser(request)
        .then((result) => {
          if (current !== generation.current) return;
          setPages((before) =>
            reset ? { [page]: result.entries } : { ...before, [page]: result.entries },
          );
          setTotal(result.total);
          setFolders(result.folders);
          setError("");
        })
        .catch((failure) => {
          requested.current.delete(page);
          setError(String(failure));
        });
    },
    [filter, folder, query],
  );

  const reload = useCallback(() => {
    generation.current++;
    requested.current.clear();
    setPages({});
    setTotal(0);
    setSelected(null);
    setEditMode(null);
    requestPage(0, true);
  }, [requestPage]);

  useEffect(() => {
    const timer = setTimeout(reload, query ? 120 : 0);
    return () => clearTimeout(timer);
  }, [filter, folder, query, refresh, reload]);

  useEffect(() => {
    const off = platform.onMediaInventoryChanged?.(reload);
    return off;
  }, [reload]);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(1, node.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  const mutate = useCallback(
    async (request: Parameters<NonNullable<typeof platform.libraryBrowser>>[0]) => {
      if (!platform.libraryBrowser) return;
      try {
        await platform.libraryBrowser(request);
        reload();
      } catch (failure) {
        setError(String(failure));
      }
    },
    [reload],
  );

  const insert = useCallback(
    async (entry: LibraryBrowserEntry) => {
      if (!isInsertable(entry) || !platform.libraryBrowser) return;
      try {
        const asset =
          entry.asset ??
          (await platform.libraryBrowser({ type: "import", path: entry.path }))
            .asset;
        if (asset) onInsert(asset);
      } catch (failure) {
        setError(String(failure));
      }
    },
    [onInsert],
  );

  const openFolder = (entry: LibraryBrowserEntry) => {
    if (entry.kind !== "folder" || !entry.category) return;
    setFilter(entry.category);
    setFolder(categoryFolder(entry.path));
    setQuery("");
  };

  const chooseFilter = (next: Filter) => {
    setFilter(next);
    setFolder("");
    setQuery("");
  };

  const importHere = () => {
    if (
      filter !== "all" &&
      filter !== "Trash" &&
      filter !== "Effects" &&
      platform.libraryBrowser
    ) {
      void mutate({ type: "import-files", category: filter, folder });
      return;
    }
    onImport?.();
  };

  const beginEdit = (mode: Exclude<EditMode, null>) => {
    if (!selected) return;
    setEditMode(mode);
    if (mode === "rename") setEditValue(selected.name);
    else {
      const parent = selected.path.split("/").slice(0, -1).join("/");
      setEditValue(parent);
    }
  };

  const commitEdit = () => {
    if (!selected || !editMode || !editValue.trim()) return;
    if (editMode === "rename")
      void mutate({
        type: "rename",
        path: selected.path,
        name: editValue.trim(),
      });
    else {
      const destination = `${editValue.replace(/\/$/, "")}/${basename(selected.path)}`;
      void mutate({
        type: "move",
        path: selected.path,
        destination,
      });
    }
    setEditMode(null);
  };

  const currentCategory =
    filter !== "all" && filter !== "Trash" ? filter : undefined;
  const currentRootLabel =
    FILTERS.find((item) => item.id === filter)?.label ?? "Media";
  const rowWidth = Math.max(1, width - GAP * (COLUMNS - 1));
  const tile = rowWidth / COLUMNS;
  const rowHeight = tile + ROW_PADDING * 2;
  const rowCount = Math.ceil(total / COLUMNS);

  const selectableFolders = selected?.category
    ? folders.filter(
        (candidate) =>
          candidate.startsWith(selected.category + "/") &&
          candidate !== selected.path &&
          !candidate.startsWith(selected.path + "/"),
      )
    : [];

  return (
    <div className="native-library" ref={host}>
      <div className="native-library-topbar">
        <input
          type="search"
          aria-label="Search Library"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="native-library-filter"
          aria-label="Media type filter"
          value={filter}
          onChange={(event) => chooseFilter(event.target.value as Filter)}
        >
          {FILTERS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <details className="native-library-actions">
          <summary aria-label="Library actions" title="Library actions">
            <IconMore />
          </summary>
          <div className="native-library-menu" role="menu">
            {(onImport || (currentCategory && currentCategory !== "Effects")) && (
              <button type="button" role="menuitem" onClick={importHere}>
                Import…
              </button>
            )}
            {currentCategory && (
              <button
                type="button"
                role="menuitem"
                onClick={() => setNewFolder(true)}
              >
                New Folder…
              </button>
            )}
            {platform.openMediaLibrary && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void platform.openMediaLibrary?.()}
              >
                Show Library Folder
              </button>
            )}
          </div>
        </details>
      </div>


      {folder && currentCategory && (
        <nav className="native-library-breadcrumbs" aria-label="Current folder">
          <button type="button" onClick={() => setFolder("")}>
            {currentRootLabel}
          </button>
          {folder.split("/").map((part, index, parts) => (
            <button
              type="button"
              key={parts.slice(0, index + 1).join("/")}
              aria-current={index === parts.length - 1 ? "location" : undefined}
              onClick={() =>
                setFolder(parts.slice(0, index + 1).join("/"))
              }
            >
              {part}
            </button>
          ))}
        </nav>
      )}

      {newFolder && currentCategory && (
        <form
          className="native-library-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newFolderName.trim();
            if (!name) return;
            void mutate({
              type: "mkdir",
              path: `${currentCategory}${folder ? "/" + folder : ""}/${name}`,
            });
            setNewFolder(false);
            setNewFolderName("");
          }}
        >
          <input
            autoFocus
            aria-label="Folder name"
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="Folder name"
          />
          <button type="submit">Create</button>
          <button type="button" onClick={() => setNewFolder(false)}>
            Cancel
          </button>
        </form>
      )}

      {selected && (
        <div className="native-library-selection" role="region" aria-label="Selected Library item">
          <div className="native-library-selection-title">
            <span title={selected.path}>{selected.name}</span>
            <button
              type="button"
              aria-label="Close item actions"
              onClick={() => {
                setSelected(null);
                setEditMode(null);
              }}
            >
              <IconClose />
            </button>
          </div>
          {editMode ? (
            <form
              className="native-library-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                commitEdit();
              }}
            >
              {editMode === "rename" ? (
                <input
                  autoFocus
                  aria-label="New name"
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                />
              ) : (
                <select
                  aria-label="Destination folder"
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                >
                  <option value={selected.category ?? ""}>
                    {selected.category}
                  </option>
                  {selectableFolders.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate.split("/").slice(1).join(" / ")}
                    </option>
                  ))}
                </select>
              )}
              <button type="submit">{editMode === "rename" ? "Rename" : "Move"}</button>
              <button type="button" onClick={() => setEditMode(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <div className="native-library-selection-actions">
              {selected.kind === "trash" ? (
                <>
                  <button
                    type="button"
                    onClick={() => void mutate({ type: "restore", path: selected.path })}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => void mutate({ type: "reveal", path: selected.path })}
                  >
                    Show in Folder
                  </button>
                </>
              ) : (
                <>
                  {selected.category !== "Effects" &&
                    (selected.protection === "parent" ? (
                      <span className="native-library-protected-by-parent">
                        <IconLock /> Protected by folder
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          void mutate({
                            type: "protect",
                            path: selected.path,
                            protected: selected.protection !== "self",
                          })
                        }
                      >
                        {selected.protection === "self"
                          ? "Allow Cleanup"
                          : "Protect from Cleanup"}
                      </button>
                    ))}
                  <button type="button" onClick={() => void mutate({ type: "reveal", path: selected.path })}>
                    Show in Folder
                  </button>
                  {selected.category !== "Effects" && (
                    <>
                      <button type="button" onClick={() => beginEdit("rename")}>
                        Rename…
                      </button>
                      <button type="button" onClick={() => beginEdit("move")}>
                        Move…
                      </button>
                    </>
                  )}
                  {selected.kind === "folder" && (
                    <button
                      type="button"
                      onClick={() => void mutate({ type: "remove-folder", path: selected.path })}
                    >
                      Delete Empty Folder
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="native-library-error" role="alert">{error}</div>}

      {total === 0 && !error ? (
        <div className="empty-library native-library-empty">
          <p>{query ? "No matches" : filter === "Trash" ? "Trash is empty" : "Nothing here yet"}</p>
          <span>
            {filter === "all"
              ? "Import media or create folders from the Library menu."
              : "Change the filter or add content from the Library menu."}
          </span>
        </div>
      ) : (
        <div className="native-library-list">
          <VirtualList
            label="Media Library"
            count={rowCount}
            rowHeight={() => rowHeight}
            render={(row) => (
              <div
                className="native-library-grid-row"
                style={{ "--native-library-columns": COLUMNS } as CSSProperties}
              >
                {Array.from({ length: COLUMNS }, (_, column) => {
                  const index = row * COLUMNS + column;
                  if (index >= total) return <span key={index} />;
                  const page = Math.floor(index / PAGE_SIZE);
                  const entry = pages[page]?.[index % PAGE_SIZE];
                  return (
                    <LibraryCell
                      key={entry?.path ?? index}
                      index={index}
                      entry={entry}
                      requestPage={requestPage}
                      selected={selected?.path === entry?.path}
                      onSelect={setSelected}
                      onOpenFolder={openFolder}
                      onInsert={insert}
                    />
                  );
                })}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}

function LibraryCell({
  index,
  entry,
  requestPage,
  selected,
  onSelect,
  onOpenFolder,
  onInsert,
}: {
  index: number;
  entry?: LibraryBrowserEntry;
  requestPage: (page: number) => void;
  selected: boolean;
  onSelect: (entry: LibraryBrowserEntry) => void;
  onOpenFolder: (entry: LibraryBrowserEntry) => void;
  onInsert: (entry: LibraryBrowserEntry) => void;
}) {
  useEffect(() => {
    if (!entry) requestPage(Math.floor(index / PAGE_SIZE));
  }, [entry, index, requestPage]);

  if (!entry)
    return <span className="asset-loading native-library-loading" aria-hidden="true">Loading…</span>;

  const insertable = isInsertable(entry);
  const pathLabel = humanPath(entry.path);
  return (
    <div
      className={`native-library-item${selected ? " is-selected" : ""}`}
      data-library-path={entry.path}
      data-library-kind={entry.kind}
      title={pathLabel ? `${entry.name}\n${pathLabel}` : entry.name}
    >
      <button
        type="button"
        className="native-library-tile"
        aria-label={
          entry.kind === "folder"
            ? `Open ${entry.name}`
            : insertable
              ? `Insert ${entry.name}`
              : `Select ${entry.name}`
        }
        draggable={insertable}
        onDragStart={(event) => startLibraryDrag(event, entry)}
        onClick={() => {
          if (entry.kind === "folder") onOpenFolder(entry);
          else if (insertable) void onInsert(entry);
          else onSelect(entry);
        }}
      >
        <span
          className={`native-library-preview${entry.category === "Effects" ? " is-effect" : ""}`}
        >
          <EntryPreview entry={entry} />
          <span className="asset-name-overlay" aria-hidden="true">
            {entry.name}
          </span>
        </span>
      </button>
      {entry.protection && (
        <span
          className="native-library-lock"
          title={
            entry.protection === "parent"
              ? "Protected by parent folder"
              : "Protected from cleanup"
          }
        >
          <IconLock />
        </span>
      )}
      <button
        type="button"
        className="native-library-more"
        aria-label={`Actions for ${entry.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(entry);
        }}
      >
        <IconMore />
      </button>
    </div>
  );
}
