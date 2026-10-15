import { EffectLibraryPanel } from "./EffectLibraryPanel";
import type { EditorSnapshot } from "../core/editorCommands";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Asset, AssetCategory } from "../core/assets";
import type { AssetPage, MediaLibraryInfo } from "../platform/api";
import { platform } from "../platform";
import { VirtualList } from "./VirtualList";
import { useAssetUrl } from "./useAssetUrl";
import { IconClose, IconFolder, IconPlus } from "./AppIcons";

const ASSET_COLUMNS = 3;
const PAGE_SIZE = 100;
const ASSET_GRID_GAP = 8;
const ASSET_LIST_PADDING = 2;
const ASSET_ROW_HORIZONTAL_PADDING = 2;
const ASSET_ROW_VERTICAL_PADDING = 4;
const ASSET_THUMB_WIDTH = 1;
const ASSET_THUMB_HEIGHT = 1;
const SECTION_HEADING_HEIGHT = 30;
const DEFAULT_LIST_WIDTH = 300;

const ASSET_LAYOUT_STYLE = {
  "--asset-columns": ASSET_COLUMNS,
  "--asset-grid-gap": `${ASSET_GRID_GAP}px`,
  "--asset-list-padding": `${ASSET_LIST_PADDING}px`,
  "--asset-row-x-padding": `${ASSET_ROW_HORIZONTAL_PADDING}px`,
  "--asset-row-y-padding": `${ASSET_ROW_VERTICAL_PADDING}px`,
  "--asset-thumb-aspect": `${ASSET_THUMB_WIDTH} / ${ASSET_THUMB_HEIGHT}`,
} as CSSProperties;

type AssetBrowserRow =
  | {
      kind: "heading";
      category: AssetCategory;
      label: string;
      count: number;
    }
  | {
      kind: "assets";
      category: AssetCategory;
      startIndex: number;
      count: number;
    };

function assetBrowserRows(counts: AssetPage["counts"]): AssetBrowserRow[] {
  const rows: AssetBrowserRow[] = [];
  let categoryStart = 0;
  for (const [category, label] of [
    ["images", "Images"],
    ["videos", "Videos"],
  ] as const) {
    const count = counts[category];
    if (count > 0) {
      rows.push({ kind: "heading", category, label, count });
      for (let offset = 0; offset < count; offset += ASSET_COLUMNS)
        rows.push({
          kind: "assets",
          category,
          startIndex: categoryStart + offset,
          count: Math.min(ASSET_COLUMNS, count - offset),
        });
    }
    categoryStart += count;
  }
  return rows;
}

function assetGridRowHeight(width: number) {
  const gridWidth = Math.max(
    ASSET_COLUMNS,
    width -
      ASSET_LIST_PADDING * 2 -
      ASSET_ROW_HORIZONTAL_PADDING * 2 -
      ASSET_GRID_GAP * (ASSET_COLUMNS - 1),
  );
  const columnWidth = gridWidth / ASSET_COLUMNS;
  return (
    (columnWidth * ASSET_THUMB_HEIGHT) / ASSET_THUMB_WIDTH +
    ASSET_ROW_VERTICAL_PADDING * 2
  );
}

function Tile({
  asset,
  onInsert,
}: {
  asset: Asset;
  onInsert: (a: Asset) => void;
}) {
  const url = useAssetUrl(asset.id, true);
  const name = asset.names[0];
  return (
    <button
      className="asset-tile"
      data-context-target="asset"
      data-asset-id={asset.id}
      data-asset-type={asset.type}
      aria-label={`Insert ${name}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          "application/show-me-asset",
          JSON.stringify(asset),
        );
      }}
      onClick={() => onInsert(asset)}
    >
      <span className="asset-thumb">
        {url ? (
          <img src={url} draggable={false} decoding="async" alt="" />
        ) : (
          <span className="asset-kind">{asset.type.toUpperCase()}</span>
        )}
        <span className="asset-name-overlay" aria-hidden="true">
          {name}
        </span>
      </span>
    </button>
  );
}

export function AssetLibrary({
  refresh,
  onInsert,
  onClose,
  onImport,
  snapshot,
}: {
  refresh: number;
  snapshot?: EditorSnapshot;
  onInsert: (a: Asset) => void;
  onClose?: () => void;
  onImport?: () => void;
}) {
  const [tab, setTab] = useState("media");
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<AssetPage["counts"]>({
    images: 0,
    videos: 0,
  });
  const [pages, setPages] = useState<Record<number, Asset[]>>({});
  const [libInfo, setLibInfo] = useState<MediaLibraryInfo | null>(null);
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const listHost = useRef<HTMLDivElement>(null);
  const requested = useRef(new Set<number>());
  const generation = useRef(0);

  const reload = useCallback(() => {
    generation.current++;
    requested.current.clear();
    setPages({});
    setTotal(0);
    setCounts({ images: 0, videos: 0 });
    const g = generation.current;
    void platform.listAssets("", 0, PAGE_SIZE).then((result) => {
      if (g !== generation.current) return;
      requested.current.add(0);
      setPages({ 0: result.items });
      setTotal(result.total);
      setCounts(result.counts);
    });
  }, []);

  useEffect(() => {
    void platform
      .getMediaLibrary()
      .then(setLibInfo)
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    reload();
  }, [refresh, reload]);

  useLayoutEffect(() => {
    const node = listHost.current;
    if (!node) return;
    const measure = () => setListWidth(Math.max(1, node.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [tab, total]);

  const request = useCallback((page: number) => {
    if (requested.current.has(page)) return;
    requested.current.add(page);
    const g = generation.current;
    void platform.listAssets("", page * PAGE_SIZE, PAGE_SIZE).then((result) => {
      if (g === generation.current)
        setPages((current) => ({ ...current, [page]: result.items }));
    });
  }, []);

  const rows = assetBrowserRows(counts);
  const gridRowHeight = assetGridRowHeight(listWidth);

  return (
    <section
      className="asset-library"
      aria-label="Media browser"
      style={ASSET_LAYOUT_STYLE}
    >
      <header className="asset-browser-header">
        <div className="asset-browser-title">
          <strong>Media</strong>
          <span>{total}</span>
        </div>
        <div className="compact-actions asset-browser-actions">
          {window.desktop && libInfo && platform.openMediaLibrary && (
            <button
              aria-label="Open Library folder"
              title={`Media library: ${libInfo.path}\nOpen in Finder or Explorer`}
              onClick={() => {
                void platform.openMediaLibrary?.();
              }}
            >
              <IconFolder />
            </button>
          )}
          {onImport && (
            <button
              aria-label="Import media"
              title="Import media"
              onClick={onImport}
            >
              <IconPlus />
            </button>
          )}
          {onClose && (
            <button
              aria-label="Close media browser"
              title="Close"
              onClick={onClose}
            >
              <IconClose />
            </button>
          )}
        </div>
      </header>
      {snapshot && (
        <nav aria-label="Library categories">
          <button
            aria-pressed={tab === "media"}
            onClick={() => setTab("media")}
          >
            Media
          </button>
          <button
            aria-pressed={tab === "effects"}
            onClick={() => setTab("effects")}
          >
            Effects
          </button>
        </nav>
      )}
      {tab === "effects" && snapshot ? (
        <EffectLibraryPanel snapshot={snapshot} />
      ) : total === 0 ? (
        <div className="empty-library">
          <p>No media yet</p>
          <span>Import files or drop them directly onto the slide.</span>
        </div>
      ) : (
        <div className="asset-list-host" ref={listHost}>
          <VirtualList
            label="Asset library"
            count={rows.length}
            rowHeight={(index) =>
              rows[index]?.kind === "heading"
                ? SECTION_HEADING_HEIGHT
                : gridRowHeight
            }
            render={(rowIndex) => {
              const row = rows[rowIndex];
              if (!row) return null;
              if (row.kind === "heading")
                return (
                  <div
                    className="asset-section-heading"
                    role="heading"
                    aria-level={3}
                    data-asset-category={row.category}
                    data-asset-count={row.count}
                  >
                    <span>{row.label}</span>
                  </div>
                );
              return (
                <div
                  className="asset-grid-row"
                  data-asset-category={row.category}
                >
                  {Array.from({ length: row.count }, (_, column) => {
                    const index = row.startIndex + column;
                    const page = Math.floor(index / PAGE_SIZE);
                    const asset = pages[page]?.[index % PAGE_SIZE];
                    return (
                      <AssetCell
                        key={index}
                        index={index}
                        asset={asset}
                        request={request}
                        onInsert={onInsert}
                      />
                    );
                  })}
                </div>
              );
            }}
          />
        </div>
      )}
    </section>
  );
}

function AssetCell({
  index,
  asset,
  request,
  onInsert,
}: {
  index: number;
  asset?: Asset;
  request: (p: number) => void;
  onInsert: (a: Asset) => void;
}) {
  useEffect(() => {
    if (!asset) request(Math.floor(index / PAGE_SIZE));
  }, [index, asset, request]);
  return asset ? (
    <Tile asset={asset} onInsert={onInsert} />
  ) : (
    <span className="asset-loading" aria-hidden="true">
      Loading…
    </span>
  );
}
