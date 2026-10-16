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
        .then((result) => {
          if (!result.preview) previewCache.delete(key);
          return result.preview;
        })
        .catch(() => {
          previewCache.delete(key);
          return undefined;
        });
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
  const [pages, setPages] = useState<Record<number, LibraryBrowserEntry[]>>({});
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [editValue, setEditValue] = useState("");
  const [newFolderMode, setNewFolderMode] = useState<
    "empty" | "selection" | null
  >(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [width, setWidth] = useState(300);
  const host = useRef<HTMLDivElement>(null);
  const listHost = useRef<HTMLDivElement>(null);
  const marqueeOrigin = useRef<{
    x: number;
    y: number;
    base: Set<string>;
  } | null>(null);
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
              query: "",
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
    [filter, folder],
  );

  const reload = useCallback(() => {
    generation.current++;
    requested.current.clear();
    setPages({});
    setTotal(0);
    setSelectedPaths(new Set());
    setSelectionAnchor(null);
    setEditMode(null);
    requestPage(0, true);
  }, [requestPage]);

  useEffect(() => {
    reload();
  }, [filter, folder, refresh, reload]);

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

  const mutateMany = useCallback(
    async (
      requests: Array<
        Parameters<NonNullable<typeof platform.libraryBrowser>>[0]
      >,
    ) => {
      if (!platform.libraryBrowser) return;
      try {
        for (const request of requests)
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
  };

  const chooseFilter = (next: Filter) => {
    setFilter(next);
    setFolder("");
  };

  const importHere = () => {
    if (filter === "Effects" || filter === "Trash") return;
    if (filter !== "all" && platform.libraryBrowser) {
      void mutate({ type: "import-files", category: filter, folder });
      return;
    }
    onImport?.();
  };

  const loadedEntries = new Map<
    string,
    { entry: LibraryBrowserEntry; index: number }
  >();
  for (const [pageText, entries] of Object.entries(pages)) {
    const page = Number(pageText);
    entries.forEach((entry, offset) =>
      loadedEntries.set(entry.path, {
        entry,
        index: page * PAGE_SIZE + offset,
      }),
    );
  }
  const selectedEntries = [...selectedPaths]
    .map((path) => loadedEntries.get(path)?.entry)
    .filter((entry): entry is LibraryBrowserEntry => Boolean(entry));
  const selected =
    selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectionCategory =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) => entry.category === selectedEntries[0].category,
    )
      ? selectedEntries[0].category
      : undefined;

  const selectEntry = (
    entry: LibraryBrowserEntry,
    index: number,
    options: { shift: boolean; additive: boolean },
  ) => {
    setEditMode(null);
    setSelectedPaths((before) => {
      if (options.shift && selectionAnchor !== null) {
        const next = options.additive ? new Set(before) : new Set<string>();
        const first = Math.min(selectionAnchor, index);
        const last = Math.max(selectionAnchor, index);
        for (let current = first; current <= last; current++) {
          const page = Math.floor(current / PAGE_SIZE);
          const candidate = pages[page]?.[current % PAGE_SIZE];
          if (candidate) next.add(candidate.path);
        }
        return next;
      }
      if (options.additive) {
        const next = new Set(before);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      }
      return new Set([entry.path]);
    });
    if (!options.shift) setSelectionAnchor(index);
  };

  const beginEdit = (mode: Exclude<EditMode, null>) => {
    if (selectedEntries.length === 0) return;
    if (mode === "rename" && !selected) return;
    setEditMode(mode);
    if (mode === "rename") setEditValue(selected!.name);
    else setEditValue(selectionCategory ?? "");
  };

  const commitEdit = () => {
    if (!editMode || !editValue.trim()) return;
    if (editMode === "rename") {
      if (!selected) return;
      void mutate({
        type: "rename",
        path: selected.path,
        name: editValue.trim(),
      });
    } else {
      if (!selectionCategory || selectedEntries.length === 0) return;
      const destination = editValue.replace(/\/$/, "");
      void mutateMany(
        selectedEntries.map((entry) => ({
          type: "move" as const,
          path: entry.path,
          destination: `${destination}/${basename(entry.path)}`,
        })),
      );
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

  const selectableFolders = selectionCategory
    ? folders.filter(
        (candidate) =>
          candidate.startsWith(selectionCategory + "/") &&
          selectedEntries.every(
            (entry) =>
              candidate !== entry.path &&
              !candidate.startsWith(entry.path + "/"),
          ),
      )
    : [];
  const canMoveSelection =
    Boolean(selectionCategory) &&
    selectedEntries.length > 0 &&
    selectedEntries.every((entry) => entry.kind !== "trash");
  const folderCreationCategory = currentCategory ?? selectionCategory;

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const origin = marqueeOrigin.current;
      const node = listHost.current;
      if (!origin || !node) return;
      const bounds = node.getBoundingClientRect();
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
      const left = Math.min(origin.x, x);
      const top = Math.min(origin.y, y);
      const right = Math.max(origin.x, x);
      const bottom = Math.max(origin.y, y);
      setMarquee({
        left,
        top,
        width: right - left,
        height: bottom - top,
      });
      const next = new Set(origin.base);
      for (const item of node.querySelectorAll<HTMLElement>(
        ".native-library-item[data-library-path]",
      )) {
        const rect = item.getBoundingClientRect();
        const itemLeft = rect.left - bounds.left;
        const itemTop = rect.top - bounds.top;
        const itemRight = rect.right - bounds.left;
        const itemBottom = rect.bottom - bounds.top;
        if (
          itemRight >= left &&
          itemLeft <= right &&
          itemBottom >= top &&
          itemTop <= bottom
        ) {
          const path = item.dataset.libraryPath;
          if (path) next.add(path);
        }
      }
      setSelectedPaths(next);
    };
    const finish = () => {
      if (!marqueeOrigin.current) return;
      marqueeOrigin.current = null;
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, []);

  return (
    <div className="native-library" ref={host}>
      <div className="native-library-topbar">
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
            {filter !== "Effects" &&
              filter !== "Trash" &&
              (onImport || currentCategory) && (
                <button type="button" role="menuitem" onClick={importHere}>
                  Import…
                </button>
              )}
            {currentCategory && (
              <button
                type="button"
                role="menuitem"
                onClick={() => setNewFolderMode("empty")}
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

      {newFolderMode && folderCreationCategory && (
        <form
          className="native-library-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newFolderName.trim();
            if (!name) return;
            const destination = `${folderCreationCategory}${
              currentCategory && folder ? "/" + folder : ""
            }/${name}`;
            if (
              newFolderMode === "selection" &&
              selectionCategory === folderCreationCategory &&
              selectedEntries.length > 0
            )
              void mutateMany([
                { type: "mkdir", path: destination },
                ...selectedEntries.map((entry) => ({
                  type: "move" as const,
                  path: entry.path,
                  destination: `${destination}/${basename(entry.path)}`,
                })),
              ]);
            else void mutate({ type: "mkdir", path: destination });
            setNewFolderMode(null);
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
          <button type="button" onClick={() => setNewFolderMode(null)}>
            Cancel
          </button>
        </form>
      )}

      {selectedEntries.length > 0 && (
        <div
          className="native-library-selection"
          role="region"
          aria-label="Selected Library items"
        >
          <div className="native-library-selection-title">
            <span title={selected?.path}>
              {selected
                ? selected.name
                : `${selectedEntries.length} items selected`}
            </span>
            <button
              type="button"
              aria-label="Close item actions"
              onClick={() => {
                setSelectedPaths(new Set());
                setSelectionAnchor(null);
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
                  <option value={selectionCategory ?? ""}>
                    {selectionCategory}
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
              {selectedEntries.length > 1 ? (
                <>
                  {canMoveSelection && (
                    <button type="button" onClick={() => beginEdit("move")}>
                      Move to Folder…
                    </button>
                  )}
                  {folderCreationCategory && (
                    <button
                      type="button"
                      onClick={() => setNewFolderMode("selection")}
                    >
                      New Folder with Selection…
                    </button>
                  )}
                </>
              ) : selected?.kind === "trash" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void mutate({ type: "restore", path: selected.path })
                    }
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void mutate({ type: "reveal", path: selected.path })
                    }
                  >
                    Show in Folder
                  </button>
                </>
              ) : selected ? (
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
                  <button
                    type="button"
                    onClick={() =>
                      void mutate({ type: "reveal", path: selected.path })
                    }
                  >
                    Show in Folder
                  </button>
                  {selected.category !== "Effects" && (
                    <button type="button" onClick={() => beginEdit("rename")}>
                      Rename…
                    </button>
                  )}
                  {canMoveSelection && (
                    <button type="button" onClick={() => beginEdit("move")}>
                      Move to Folder…
                    </button>
                  )}
                  {folderCreationCategory && (
                    <button
                      type="button"
                      onClick={() => setNewFolderMode("selection")}
                    >
                      New Folder with Selection…
                    </button>
                  )}
                  {selected.kind === "folder" && (
                    <button
                      type="button"
                      onClick={() =>
                        void mutate({
                          type: "remove-folder",
                          path: selected.path,
                        })
                      }
                    >
                      Delete Empty Folder
                    </button>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      {error && <div className="native-library-error" role="alert">{error}</div>}

      {total === 0 && !error ? (
        <div className="empty-library native-library-empty">
          <p>{filter === "Trash" ? "Trash is empty" : "Nothing here yet"}</p>
          <span>
            {filter === "all"
              ? "Import media or create folders from the Library menu."
              : "Change the filter or add content from the Library menu."}
          </span>
        </div>
      ) : (
        <div
          className="native-library-list"
          ref={listHost}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              (event.target as HTMLElement).closest(".native-library-item")
            )
              return;
            const node = listHost.current;
            if (!node) return;
            const bounds = node.getBoundingClientRect();
            const additive =
              event.shiftKey || event.metaKey || event.ctrlKey;
            marqueeOrigin.current = {
              x: event.clientX - bounds.left,
              y: event.clientY - bounds.top,
              base: additive ? new Set(selectedPaths) : new Set(),
            };
            if (!additive) setSelectedPaths(new Set());
            setSelectionAnchor(null);
            setMarquee({
              left: event.clientX - bounds.left,
              top: event.clientY - bounds.top,
              width: 0,
              height: 0,
            });
            event.preventDefault();
          }}
        >
          {marquee && (
            <span
              className="native-library-marquee"
              style={marquee}
              aria-hidden="true"
            />
          )}
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
                      selected={Boolean(
                        entry && selectedPaths.has(entry.path),
                      )}
                      onSelect={selectEntry}
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
  onSelect: (
    entry: LibraryBrowserEntry,
    index: number,
    options: { shift: boolean; additive: boolean },
  ) => void;
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
            ? `Select folder ${entry.name}`
            : `Select ${entry.name}`
        }
        draggable={insertable}
        onDragStart={(event) => startLibraryDrag(event, entry)}
        aria-pressed={selected}
        onClick={(event) =>
          onSelect(entry, index, {
            shift: event.shiftKey,
            additive: event.metaKey || event.ctrlKey,
          })
        }
        onDoubleClick={() => {
          if (entry.kind === "folder") onOpenFolder(entry);
          else if (insertable) void onInsert(entry);
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
          if (!selected)
            onSelect(entry, index, { shift: false, additive: false });
        }}
      >
        <IconMore />
      </button>
    </div>
  );
}
