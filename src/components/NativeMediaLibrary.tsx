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
import type { EffectDefinition } from "../core/effects";
import { IconClose, IconFolder, IconLock, IconMore } from "./AppIcons";
import { VirtualList } from "./VirtualList";
import { MediaFolderNavigation } from "./MediaFolderNavigation";
import "./NativeMediaLibrary.css";

const PAGE_SIZE = 120;
const GAP = 8;
const ROW_PADDING = 4;
const FILTERS: Array<{
  id: LibraryCategory | "Trash";
  label: string;
}> = [
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "Effects", label: "Effects" },
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
  onApplyEffect,
}: {
  refresh: number;
  onInsert: (asset: Asset) => void;
  onImport?: () => void;
  onApplyEffect?: (definition: EffectDefinition) => void;
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
  const header = useRef<HTMLDivElement>(null);
  const libraryMenu = useRef<HTMLDetailsElement>(null);
  const itemMenu = useRef<HTMLDetailsElement>(null);
  const focusItemMenu = useRef(false);
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
    setNewFolderMode(null);
    if (libraryMenu.current) libraryMenu.current.open = false;
    if (itemMenu.current) itemMenu.current.open = false;
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

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (libraryMenu.current && !libraryMenu.current.contains(target))
        libraryMenu.current.open = false;
      if (itemMenu.current && !itemMenu.current.contains(target))
        itemMenu.current.open = false;
      if (!header.current?.contains(target)) {
        setMoving(false);
        setNewFolderMode(null);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
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
        const asset = entry.asset
          ? await platform.getAsset(entry.asset.id)
          : (await platform.libraryBrowser({ type: "import", path: entry.path })).asset;
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
    if (itemMenu.current) itemMenu.current.open = false;
  };

  const selectEntry = (entry: LibraryBrowserEntry) => {
    setMoving(false);
    setNewFolderMode(null);
    if (itemMenu.current) itemMenu.current.open = false;
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
    setNewFolderMode(null);
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
  // Keep previews and folder labels legible in the narrow inspector.
  const columns = width < 260 ? 2 : 3;
  const rowWidth = Math.max(1, width - GAP * (columns - 1));
  const tile = rowWidth / columns;
  const rowHeight = tile + ROW_PADDING * 2;
  const rowCount = Math.ceil(total / columns);

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
  const hasSelection = selectedEntries.length > 0;
  const hasItemActions = Boolean(
    canOrganizeSelection ||
    selected?.kind === "trash" ||
    (selected?.category !== "Effects" && selected?.managed),
  );
  useLayoutEffect(() => {
    if (!focusItemMenu.current) return;
    focusItemMenu.current = false;
    if (hasItemActions && itemMenu.current) {
      itemMenu.current.open = true;
      itemMenu.current.querySelector("summary")?.focus();
    }
  }, [selectedPaths, hasItemActions]);

  const folderCreationCategory =
    newFolderMode === "selection"
      ? canOrganizeSelection
        ? selectionCategory
        : undefined
      : currentCategory;

  const cancelCommand = () => {
    const trigger =
      moving || newFolderMode === "selection" ? itemMenu : libraryMenu;
    setMoving(false);
    setNewFolderMode(null);
    trigger.current?.querySelector("summary")?.focus();
  };

  return (
    <div
      className="native-library"
      ref={host}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        const openMenu = [libraryMenu.current, itemMenu.current].find(
          (menu) => menu?.open,
        );
        if (openMenu) {
          event.stopPropagation();
          openMenu.open = false;
          openMenu.querySelector("summary")?.focus();
        } else if (moving || newFolderMode) {
          event.stopPropagation();
          cancelCommand();
        } else if (selectionMode || hasSelection) {
          event.stopPropagation();
          finishSelection();
        }
      }}
    >
      <div className="native-library-header" ref={header}>
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
          <details className="native-library-actions" ref={libraryMenu}>
            <summary aria-label="Library actions" title="Library actions">
              <IconMore />
            </summary>
            <div
              className="native-library-menu"
              role="group"
              aria-label="Library commands"
              onClick={() => {
                if (libraryMenu.current) libraryMenu.current.open = false;
              }}
            >
              {filter !== "Effects" &&
                filter !== "Trash" &&
                (onImport || currentCategory) && (
                  <button type="button" onClick={importHere}>
                    Import…
                  </button>
                )}
              {currentCategory && (
                <button
                  type="button"
                  onClick={() => {
                    setMoving(false);
                    setNewFolderMode("empty");
                  }}
                >
                  New Folder…
                </button>
              )}
              {platform.openMediaLibrary && (
                <button
                  type="button"
                  onClick={() => void platform.openMediaLibrary?.()}
                >
                  Show Library Folder
                </button>
              )}
            </div>
          </details>
        </div>

        <div
          className="native-library-selection"
          role="region"
          aria-label="Selected Library items"
        >
          {!selectionMode && !hasSelection && folder && currentCategory ? (
            <MediaFolderNavigation
              rootLabel={currentRootLabel}
              folder={folder}
              onNavigate={(next) => {
                finishSelection();
                setFolder(next);
              }}
            />
          ) : (
            <span
              className="native-library-selection-name"
              title={selected?.path}
              role="status"
            >
              {selectionMode
                ? selectedEntries.length + " selected"
                : (selected?.name ??
                  total + " " + (total === 1 ? "item" : "items"))}
            </span>
          )}
          {canMoveSelection && (
            <button type="button" onClick={beginMove}>
              Move…
            </button>
          )}
          <details
            className="native-library-actions"
            ref={itemMenu}
            hidden={!hasItemActions}
          >
            <summary
              aria-label="Selected item actions"
              aria-disabled={!hasItemActions}
              tabIndex={hasItemActions ? 0 : -1}
              onClick={(event) => {
                if (!hasItemActions) event.preventDefault();
              }}
            >
              Actions
            </summary>
            {hasItemActions && (
              <div
                className="native-library-menu native-library-item-menu"
                role="group"
                aria-label="Item commands"
                onClick={() => {
                  if (itemMenu.current) itemMenu.current.open = false;
                }}
              >
                {canMoveSelection && (
                  <button type="button" onClick={beginMove}>
                    Move to Folder…
                  </button>
                )}
                {canOrganizeSelection && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoving(false);
                      setNewFolderMode("selection");
                    }}
                  >
                    New Folder with Selection…
                  </button>
                )}
                {selected?.kind === "trash" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void mutate({ type: "restore", path: selected.path })
                    }
                  >
                    Restore
                  </button>
                ) : (
                  selected &&
                  selected.category !== "Effects" &&
                  (selected.kind === "folder" || selected.managed) && (
                    <button
                      type="button"
                      title="Protected media is kept when unused Library files are cleaned up."
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
                  )
                )}
                {selected?.kind === "folder" && (
                  <button
                    type="button"
                    className="native-library-delete"
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
              </div>
            )}
          </details>
          <button
            type="button"
            className="native-library-clear"
            aria-label="Close item actions"
            disabled={!hasSelection && !selectionMode}
            hidden={!hasSelection && !selectionMode}
            onClick={finishSelection}
          >
            <IconClose />
          </button>
        </div>

        {newFolderMode && folderCreationCategory && (
          <form
            className="native-library-command-panel native-library-inline-form"
            aria-label="Create Library folder"
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
            <button type="button" onClick={cancelCommand}>
              Cancel
            </button>
          </form>
        )}

        {moving && (
          <form
            className="native-library-command-panel native-library-inline-form"
            aria-label="Move Library items"
            onSubmit={(event) => {
              event.preventDefault();
              commitMove();
            }}
          >
            <select
              autoFocus
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
            <button type="button" onClick={cancelCommand}>
              Cancel
            </button>
          </form>
        )}
      </div>

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
                style={{ "--native-library-columns": columns } as CSSProperties}
              >
                {Array.from({ length: columns }, (_, column) => {
                  const index = row * columns + column;
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
                      onActions={(entry) => {
                        focusItemMenu.current = true;
                        selectEntry(entry);
                      }}
                      onOpenFolder={openFolder}
                      onInsert={insert}
                      onApplyEffect={onApplyEffect}
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
  onActions,
  onInsert,
  onApplyEffect,
}: {
  index: number;
  entry?: LibraryBrowserEntry;
  requestPage: (page: number) => void;
  selected: boolean;
  selectionMode: boolean;
  onSelect: (entry: LibraryBrowserEntry) => void;
  onOpenFolder: (entry: LibraryBrowserEntry) => void;
  onActions: (entry: LibraryBrowserEntry) => void;
  onInsert: (entry: LibraryBrowserEntry) => void;
  onApplyEffect?: (definition: EffectDefinition) => void;
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
  const effect =
    !selectionMode && entry.kind === "file" && entry.category === "Effects"
      ? entry.effect?.definition
      : undefined;
  const appliesEffect = !!effect && !!onApplyEffect;
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
          appliesEffect
            ? `Apply effect ${entry.name}`
            : entry.kind === "folder"
              ? `Select folder ${entry.name}`
              : `Select ${entry.name}`
        }
        draggable={insertable && !selectionMode}
        onDragStart={(event) => startLibraryDrag(event, entry)}
        aria-pressed={appliesEffect ? undefined : selected}
        onClick={(event) => {
          if (effect && onApplyEffect) {
            if (event.detail < 2) onApplyEffect(structuredClone(effect));
          } else onSelect(entry);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || selectionMode || appliesEffect) return;
          if (entry.kind !== "folder" && !insertable) return;
          event.preventDefault();
          event.stopPropagation();
          if (entry.kind === "folder") onOpenFolder(entry);
          else onInsert(entry);
        }}
        onDoubleClick={() => {
          if (selectionMode) return;
          if (entry.kind === "folder") onOpenFolder(entry);
          else if (insertable) void onInsert(entry);
        }}
      >
        <span
          className={`native-library-preview${entry.kind === "folder" ? " is-folder" : entry.category === "Effects" ? " is-effect" : ""}`}
        >
          <EntryPreview entry={entry} />
          {selectionMode && (
            <span className="native-library-check" aria-hidden="true">
              {selected ? "✓" : ""}
            </span>
          )}
          <span
            className={
              entry.kind === "folder"
                ? "native-library-folder-name"
                : "asset-name-overlay"
            }
            aria-hidden="true"
          >
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
            onActions(entry);
          }}
        >
          <IconMore />
        </button>
      )}
    </div>
  );
}
