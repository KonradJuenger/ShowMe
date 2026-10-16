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
import { videoPoster } from "../core/videoPoster";
import { ImageWorkQueue } from "../core/imageWorkQueue";
import { organizationalLibraryCategory } from "../core/libraryBrowser";
import type {
  LibraryBrowserEntry,
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
  id: LibraryCategory | "Trash";
  label: string;
}> = [
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "Effects", label: "Effects" },
  { id: "other", label: "Other" },
  { id: "Trash", label: "Trash" },
];

type Filter = (typeof FILTERS)[number]["id"];

const videoPreviewWork = new ImageWorkQueue(2);
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
  useEffect(() => {
    setPreview(undefined);
    if (
      entry.kind === "folder" ||
      entry.error ||
      !platform.libraryBrowser ||
      !["images", "video", "Effects"].includes(entry.category ?? "")
    )
      return;
    const key = `${entry.path}:${entry.signature ?? ""}`;
    let job = previewCache.get(key);
    if (!job) {
      const assetId = entry.asset?.id;
      const load =
        entry.category === "video" && assetId
          ? videoPreviewWork.run(0, () => videoPoster(assetId, 0))
          : platform
              .libraryBrowser({ type: "preview", path: entry.path })
              .then((result) => result.preview);
      job = load
        .then((result) => {
          if (!result) previewCache.delete(key);
          return result ?? undefined;
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
    void job.then((value) => {
      if (active && value) setPreview(value);
    });
    return () => {
      active = false;
    };
  }, [entry]);

  if (entry.kind === "folder")
    return (
      <span className="native-library-folder-preview" aria-hidden="true">
        <IconFolder />
      </span>
    );
  if (preview && ["images", "video", "Effects"].includes(entry.category ?? ""))
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
  const [filter, setFilter] = useState<Filter>("images");
  const [folder, setFolder] = useState("");
  const [pages, setPages] = useState<Record<number, LibraryBrowserEntry[]>>({});
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [moving, setMoving] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [newFolderMode, setNewFolderMode] = useState<
    "empty" | "selection" | null
  >(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [width, setWidth] = useState(300);
  const host = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<number>());
  const generation = useRef(0);

  const requestPage = useCallback(
    (page: number) => {
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
              folder,
              query: "",
              all: false,
              offset,
              limit: PAGE_SIZE,
            } as const);
      void platform
        .libraryBrowser(request)
        .then((result) => {
          if (current !== generation.current) return;
          setPages((before) => ({ ...before, [page]: result.entries }));
          setTotal(result.total);
          setFolders(result.folders);
          setError("");
        })
        .catch((failure) => {
          if (current !== generation.current) return;
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
    // Keep the scroll extent until the refreshed count arrives. Clearing it
    // unmounts VirtualList and loses the viewport during inventory updates.
    setSelectedPaths(new Set());
    setSelectionMode(false);
    setMoving(false);
    requestPage(0);
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
    async (
      request: Parameters<NonNullable<typeof platform.libraryBrowser>>[0],
    ) => {
      if (!platform.libraryBrowser) return;
      setMutationError("");
      try {
        const result = await platform.libraryBrowser(request);
        if (result.reconciliationError)
          setMutationError(result.reconciliationError);
      } catch (failure) {
        setMutationError(String(failure));
      } finally {
        reload();
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
      setMutationError("");
      try {
        for (const request of requests) {
          const result = await platform.libraryBrowser(request);
          if (result.reconciliationError)
            setMutationError(result.reconciliationError);
        }
      } catch (failure) {
        setMutationError(String(failure));
      } finally {
        reload();
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
    if (platform.libraryBrowser) {
      void mutate({ type: "import-files", category: filter, folder });
      return;
    }
    onImport?.();
  };

  const loadedEntries = new Map(
    Object.values(pages)
      .flat()
      .map((entry) => [entry.path, entry]),
  );
  const selectedEntries = [...selectedPaths]
    .map((path) => loadedEntries.get(path))
    .filter((entry): entry is LibraryBrowserEntry => Boolean(entry));
  const selected = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectionCategory = organizationalLibraryCategory(selectedEntries);
  const selectionParent =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) =>
        entry.path.split("/").slice(0, -1).join("/") ===
        selectedEntries[0].path.split("/").slice(0, -1).join("/"),
    )
      ? selectedEntries[0].path.split("/").slice(0, -1).join("/")
      : selectionCategory;

  const finishSelection = () => {
    setSelectionMode(false);
    setSelectedPaths(new Set());
    setMoving(false);
    setNewFolderMode(null);
  };

  const selectEntry = (entry: LibraryBrowserEntry) => {
    setMoving(false);
    setSelectedPaths((before) => {
      if (!selectionMode) return new Set([entry.path]);
      const next = new Set(before);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const beginMove = () => {
    if (selectedEntries.length === 0) return;
    setMoving(true);
    setEditValue(selectionParent ?? selectionCategory ?? "");
  };

  const commitMove = () => {
    if (
      !moving ||
      !editValue.trim() ||
      !selectionCategory ||
      selectedEntries.length === 0
    )
      return;
    const destination = editValue.replace(/\/$/, "");
    const requests = selectedEntries
      .map((entry) => ({
        type: "move" as const,
        path: entry.path,
        destination: `${destination}/${basename(entry.path)}`,
      }))
      .filter((request) => request.destination !== request.path);
    if (requests.length) void mutateMany(requests);
    setMoving(false);
  };

  const currentCategory = filter !== "Trash" ? filter : undefined;
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
  const canOrganizeSelection = Boolean(selectionCategory);
  const canMoveSelection = canOrganizeSelection;
  const folderCreationCategory =
    newFolderMode === "selection"
      ? canOrganizeSelection
        ? selectionCategory
        : undefined
      : currentCategory;

  return (
    <div
      className="native-library"
      ref={host}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectionMode) {
          event.stopPropagation();
          finishSelection();
        }
      }}
    >
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
        <button
          type="button"
          className="native-library-select"
          aria-pressed={selectionMode}
          onClick={() => {
            if (selectionMode) finishSelection();
            else {
              setSelectedPaths(new Set());
              setMoving(false);
              setNewFolderMode(null);
              setSelectionMode(true);
            }
          }}
        >
          {selectionMode ? "Done" : "Select"}
        </button>
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
              onClick={() => setFolder(parts.slice(0, index + 1).join("/"))}
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

      {(selectionMode || selectedEntries.length > 0) && (
        <div
          className="native-library-selection"
          role="region"
          aria-label="Selected Library items"
        >
          <div className="native-library-selection-title">
            <span title={selected?.path} role="status">
              {selectionMode
                ? `${selectedEntries.length} selected`
                : selected?.name}
            </span>
            <button
              type="button"
              aria-label="Close item actions"
              onClick={finishSelection}
            >
              <IconClose />
            </button>
          </div>
          {moving ? (
            <form
              className="native-library-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                commitMove();
              }}
            >
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
              <button type="submit">Move</button>
              <button type="button" onClick={() => setMoving(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <div className="native-library-selection-actions">
              {selectedEntries.length > 1 ? (
                <>
                  {canMoveSelection && (
                    <button type="button" onClick={beginMove}>
                      Move to Folder…
                    </button>
                  )}
                  {canOrganizeSelection && (
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
                </>
              ) : selected ? (
                <>
                  {selected.category !== "Effects" &&
                    (selected.kind === "folder" || selected.managed) && (
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
                          ? selected.kind === "folder"
                            ? "Allow Cleanup for Contents"
                            : "Allow Cleanup"
                          : selected.kind === "folder"
                            ? "Protect Contents from Cleanup"
                            : "Protect from Cleanup"}
                      </button>
                    )}
                  {canMoveSelection && (
                    <button type="button" onClick={beginMove}>
                      Move to Folder…
                    </button>
                  )}
                  {canOrganizeSelection && (
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

      {(mutationError || error) && (
        <div className="native-library-error" role="alert">
          {mutationError || error}
        </div>
      )}

      {total === 0 && !error ? (
        <div className="empty-library native-library-empty">
          <p>{filter === "Trash" ? "Trash is empty" : "Nothing here yet"}</p>
          <span>Change the filter or add content from the Library menu.</span>
        </div>
      ) : (
        <div className="native-library-list">
          <VirtualList
            key={`${filter}/${folder}`}
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
                      selected={Boolean(entry && selectedPaths.has(entry.path))}
                      selectionMode={selectionMode}
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
  selectionMode,
  onSelect,
  onOpenFolder,
  onInsert,
}: {
  index: number;
  entry?: LibraryBrowserEntry;
  requestPage: (page: number) => void;
  selected: boolean;
  selectionMode: boolean;
  onSelect: (entry: LibraryBrowserEntry) => void;
  onOpenFolder: (entry: LibraryBrowserEntry) => void;
  onInsert: (entry: LibraryBrowserEntry) => void;
}) {
  useEffect(() => {
    if (!entry) requestPage(Math.floor(index / PAGE_SIZE));
  }, [entry, index, requestPage]);

  if (!entry)
    return (
      <span className="asset-loading native-library-loading" aria-hidden="true">
        Loading…
      </span>
    );

  const insertable = isInsertable(entry);
  const pathLabel = humanPath(entry.path);
  return (
    <div
      className={`native-library-item${selected ? " is-selected" : ""}${selectionMode ? " is-selecting" : ""}`}
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
        draggable={insertable && !selectionMode}
        onDragStart={(event) => startLibraryDrag(event, entry)}
        aria-pressed={selected}
        onClick={() => onSelect(entry)}
        onDoubleClick={() => {
          if (selectionMode) return;
          if (entry.kind === "folder") onOpenFolder(entry);
          else if (insertable) void onInsert(entry);
        }}
      >
        <span
          className={`native-library-preview${entry.category === "Effects" ? " is-effect" : ""}`}
        >
          <EntryPreview entry={entry} />
          {selectionMode && (
            <span className="native-library-check" aria-hidden="true">
              {selected ? "✓" : ""}
            </span>
          )}
          <span className="asset-name-overlay" aria-hidden="true">
            {entry.name}
          </span>
        </span>
      </button>
      {entry.protection && (
        <span
          className="native-library-lock"
          title={
            entry.protection === "mixed"
              ? "Some contents are protected from cleanup"
              : entry.kind === "folder"
                ? "Contents protected from cleanup"
                : "Protected from cleanup"
          }
        >
          <IconLock />
        </span>
      )}
      {!selectionMode && (
        <button
          type="button"
          className="native-library-more"
          aria-label={`Actions for ${entry.name}`}
          onClick={(event) => {
            event.stopPropagation();
            if (!selected) onSelect(entry);
          }}
        >
          <IconMore />
        </button>
      )}
    </div>
  );
}
