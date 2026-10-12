import {
  cloneElement,
  isValidElement,
  useState,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type DragEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Deck as Deck } from "../../core/document";
import { slideDropTarget, type SlideDropMode } from "../../core/slideHierarchy";
import { SLIDE_TRANSFER_MIME } from "../../core/slideTransfer";
import { platform } from "../../platform";
import { MaterialIcon } from "../MaterialIcon";
import { getSlideNavigatorRuntime } from "../slideNavigatorRuntime";
import { VirtualList } from "../VirtualList";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export type SlideRailRow =
  | { kind: "section"; section: string; key: string; count: number }
  | { kind: "slide"; id: string };

type OverviewSlideElement = ReactElement<{
  [key: string]: unknown;
  className?: string;
  children?: ReactNode;
}>;

export function EditorSlideRail({
  templates,
  rows,
  slideMeta,
  contentWidth,
  renderSlide,
  collapsedSections,
  setCollapsedSections,
  navWidth,
  setNavWidth,
  busy,
  onAddSlide,
  onOpenOverview,
}: {
  templates?: ReactNode;
  rows: SlideRailRow[];
  slideMeta: Deck["slideMeta"];
  contentWidth: number;
  renderSlide: (id: string) => ReactNode;
  collapsedSections: Set<string>;
  setCollapsedSections: Dispatch<SetStateAction<Set<string>>>;
  navWidth: number;
  setNavWidth: Dispatch<SetStateAction<number>>;
  busy: boolean;
  onAddSlide: () => void;
  onOpenOverview: () => void;
}) {
  return (
    <aside className="slide-rail" data-context-target="slide-rail-empty">
      {templates}
      <header className="panel-heading slide-panel-heading">
        <span>Slides</span>
        <div className="compact-actions">
          <button
            aria-label="Slide overview"
            title="Grid overview"
            onClick={onOpenOverview}
          >
            <MaterialIcon name="view-grid-outline" />
          </button>
        </div>
      </header>
      <VirtualList
        label="Slides"
        footer={
          <div className="slide-rail-add-row">
            <button
              type="button"
              className="slide-rail-add-button"
              aria-label="Add slide"
              title="Add slide"
              disabled={busy}
              onClick={onAddSlide}
            >
              <MaterialIcon name="plus" />
            </button>
          </div>
        }
        count={rows.length}
        rowHeight={(index) => {
          const row = rows[index];
          return row.kind === "section"
            ? 32
            : slideMeta[row.id]?.hidden
              ? 18
              : ((contentWidth - 34) * 9) / 16 + 20;
        }}
        render={(index) => {
          const row = rows[index];
          return row.kind === "slide" ? (
            renderSlide(row.id)
          ) : (
            <button
              className="slide-section-toggle"
              aria-expanded={!collapsedSections.has(row.section)}
              aria-label={row.section}
              onClick={() =>
                setCollapsedSections((current) => {
                  const next = new Set(current);
                  if (next.has(row.section)) next.delete(row.section);
                  else next.add(row.section);
                  return next;
                })
              }
            >
              <span>{collapsedSections.has(row.section) ? "▸" : "▾"}</span>
              <strong>{row.section}</strong>
              <small>{row.count}</small>
            </button>
          );
        }}
      />
      <div
        className="slide-rail-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize slide sidebar"
        aria-orientation="vertical"
        aria-valuemin={140}
        aria-valuemax={420}
        aria-valuenow={navWidth}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const left =
            event.currentTarget.parentElement!.getBoundingClientRect().left;
          setNavWidth(clamp(event.clientX - left, 140, 420));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onDoubleClick={() => setNavWidth(194)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          setNavWidth((width) =>
            event.key === "Home"
              ? 140
              : event.key === "End"
                ? 420
                : clamp(
                    width + (event.key === "ArrowRight" ? 10 : -10),
                    140,
                    420,
                  ),
          );
        }}
      />
    </aside>
  );
}

export function EditorSlideOverview({
  open,
  slides,
  renderSlide,
  onClose,
}: {
  open: boolean;
  slides: string[];
  renderSlide: (id: string) => ReactNode;
  onClose: () => void;
}) {
  const [dragSlides, setDragSlides] = useState<string[]>([]);
  const [drop, setDrop] = useState<{
    id: string;
    mode: SlideDropMode;
  } | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(1000);
  useLayoutEffect(() => {
    if (!open) return;
    const grid = root.current?.querySelector<HTMLElement>(".virtual-list");
    if (!grid) return;
    const measure = () => setGridWidth(grid.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [open]);
  const columns =
    gridWidth >= 1000 ? 4 : gridWidth >= 700 ? 3 : gridWidth >= 420 ? 2 : 1;
  const thumbnailWidth = (gridWidth - 12 - (columns - 1) * 14) / columns - 12;
  const rowHeight = Math.ceil((thumbnailWidth * 9) / 16) + 56;

  if (!open) return null;

  const runtime = getSlideNavigatorRuntime();
  const snapshot = runtime?.getSnapshot() ?? null;
  const clearDrag = () => {
    setDragSlides([]);
    setDrop(null);
  };
  const renderOverviewSlide = (id: string) => {
    const node = renderSlide(id);
    if (!runtime || !snapshot || !isValidElement(node)) return node;
    const base = node as OverviewSlideElement;
    const mode = drop?.id === id ? drop.mode : null;
    return cloneElement(base, {
      className:
        `${base.props.className ?? ""} ${dragSlides.includes(id) ? "dragging" : ""} ${mode === "before" ? "drop-before" : mode === "after" ? "drop-after" : mode === "inside" ? "drop-section" : ""}`.trim(),
      draggable: true,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button === 0)
          void runtime
            .prepareSlideDrag(id)
            .catch((error) => console.error(error));
      },
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        const selected = runtime.getSelectedSlides();
        const ids = selected.includes(id)
          ? snapshot.deck.slideIds.filter((slideId) =>
              selected.includes(slideId),
            )
          : [id];
        const bundle = runtime.getPreparedSlideTransfer(id);
        runtime.activateSlideDragSelection(id);
        setDragSlides(ids);
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData(
          "application/show-me-local-slides",
          JSON.stringify(ids),
        );
        if (bundle) {
          event.dataTransfer.setData(
            SLIDE_TRANSFER_MIME,
            JSON.stringify(bundle),
          );
          if (event.altKey && platform.startSlideDrag(bundle)) {
            event.preventDefault();
            clearDrag();
            return;
          }
        }
        const preview = document.createElement("div");
        preview.className = "slide-drag-preview";
        preview.textContent =
          ids.length === 1 ? "1 slide" : `${ids.length} slides`;
        document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview, 14, 14);
        requestAnimationFrame(() => preview.remove());
      },
      onDragOver: (event: DragEvent<HTMLButtonElement>) => {
        if (
          !dragSlides.length &&
          !event.dataTransfer.types.includes(SLIDE_TRANSFER_MIME) &&
          !event.dataTransfer.types.includes("Files")
        )
          return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - bounds.left) / bounds.width;
        const inside =
          dragSlides.length > 0 &&
          !dragSlides.includes(id) &&
          fraction > 0.28 &&
          fraction < 0.72;
        setDrop({
          id,
          mode: inside ? "inside" : fraction < 0.5 ? "before" : "after",
        });
        event.dataTransfer.dropEffect = dragSlides.length ? "move" : "copy";
      },
      onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDrop((current) => (current?.id === id ? null : current));
      },
      onDrop: (event: DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - bounds.left) / bounds.width;
        const inside =
          dragSlides.length > 0 &&
          !dragSlides.includes(id) &&
          fraction > 0.28 &&
          fraction < 0.72;
        const target = slideDropTarget(
          snapshot.deck,
          id,
          inside ? "inside" : fraction < 0.5 ? "before" : "after",
        );
        if (dragSlides.length) {
          void Promise.resolve(runtime.moveSlides(dragSlides, target)).catch(
            (error) => console.error(error),
          );
        } else {
          const raw = event.dataTransfer.getData(SLIDE_TRANSFER_MIME);
          const files = Array.from(event.dataTransfer.files);
          void (async () => {
            const input = raw
              ? JSON.parse(raw)
              : await platform.readSlideTransfer(files);
            if (input) await runtime.dropSlideTransfer(input, target);
          })().catch((error) => console.error(error));
        }
        clearDrag();
      },
      onDragEnd: clearDrag,
    });
  };

  return (
    <div
      className="slide-overview"
      ref={root}
      role="dialog"
      aria-label="Slide overview dialog"
    >
      <header>
        <strong>Slide overview</strong>
        <button aria-label="Close slide overview" onClick={onClose}>
          ×
        </button>
      </header>
      <VirtualList
        label="Slide overview grid"
        count={Math.ceil(slides.length / columns)}
        rowHeight={rowHeight}
        render={(row) => (
          <div
            className="overview-row"
            style={{
              height: rowHeight - 8,
              gridTemplateColumns: "repeat(" + columns + ", minmax(0, 1fr))",
            }}
          >
            {slides
              .slice(row * columns, row * columns + columns)
              .map(renderOverviewSlide)}
          </div>
        )}
      />
    </div>
  );
}
