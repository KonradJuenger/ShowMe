import {
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  expandSlideSubtrees,
  slideDropTarget,
  slideHierarchyRows,
  type SlideDropMode,
  type SlideDropTarget,
} from "../core/slideHierarchy";
import { SLIDE_TRANSFER_MIME } from "../core/slideTransfer";
import { platform } from "../platform";
import { getSlideNavigatorRuntime } from "./slideNavigatorRuntime";
import "./SlideHierarchy.css";

type RowHeight = number | ((index: number) => number);

interface VirtualListProps {
  count: number;
  rowHeight: RowHeight;
  render: (index: number) => ReactNode;
  label: string;
  footer?: ReactNode;
  slideAspectRatio?: number;
}

type SlideButtonElement = ReactElement<{
  [key: string]: unknown;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
}>;

function acceptsSlideDrop(dataTransfer: DataTransfer) {
  return (
    dataTransfer.types.includes("application/show-me-local-slides") ||
    dataTransfer.types.includes(SLIDE_TRANSFER_MIME) ||
    dataTransfer.types.includes("Files")
  );
}

function HierarchicalSlideList({
  count,
  render,
  label,
  footer,
  slideAspectRatio = 16 / 9,
}: Pick<VirtualListProps, "count" | "render" | "label" | "footer" | "slideAspectRatio">) {
  const ref = useRef<HTMLDivElement>(null),
    [top, setTop] = useState(0),
    [height, setHeight] = useState(600),
    [width, setWidth] = useState(177),
    [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()),
    [dragSlides, setDragSlides] = useState<string[]>([]),
    [drop, setDrop] = useState<{ id: string; mode: SlideDropMode } | null>(null),
    [appendDrop, setAppendDrop] = useState(false);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      setHeight(ref.current?.clientHeight ?? 600);
      setWidth(ref.current?.clientWidth ?? 177);
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const runtime = getSlideNavigatorRuntime(),
    snapshot = runtime?.getSnapshot() ?? null;
  if (!runtime || !snapshot) return null;
  const { deck, slide } = snapshot,
    selectedSlides = runtime.getSelectedSlides(),
    hierarchyRows = slideHierarchyRows(deck, collapsed),
    rows = hierarchyRows.map((row) => ({ kind: "slide" as const, ...row })),
    baseButtons = new Map<string, SlideButtonElement>();

  for (let index = 0; index < count; index++) {
    const node = render(index);
    if (!isValidElement(node)) continue;
    const candidate = node as SlideButtonElement,
      id = candidate.props["data-slide-id"];
    if (typeof id === "string") baseButtons.set(id, candidate);
  }

  const rowHeights = rows.map((row) => {
      if (deck.slideMeta[row.id]?.hidden) return 18;
      const available = Math.max(72, width - 38 - row.depth * 14);
      return available / slideAspectRatio + 20;
    }),
    offsets = [0];
  for (const value of rowHeights) offsets.push(offsets.at(-1)! + value);
  const first = offsets.findIndex((value) => value >= top),
    last = offsets.findIndex((value) => value >= top + height),
    start = Math.max(0, (first < 0 ? rows.length : first) - 3),
    end = Math.min(rows.length, (last < 0 ? rows.length : last) + 2);

  const resetDrop = () => {
    setDrop(null);
    setAppendDrop(false);
  };

  const autoScrollForPointer = (clientY: number) => {
    const node = ref.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect(),
      edge = Math.min(72, Math.max(36, bounds.height * 0.18));
    let delta = 0;
    if (clientY < bounds.top + edge) {
      const strength = Math.min(1, Math.max(0, (bounds.top + edge - clientY) / edge));
      delta = -Math.max(4, Math.round(28 * strength));
    } else if (clientY > bounds.bottom - edge) {
      const strength = Math.min(1, Math.max(0, (clientY - (bounds.bottom - edge)) / edge));
      delta = Math.max(4, Math.round(28 * strength));
    }
    if (!delta) return;
    const next = Math.max(
      0,
      Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + delta),
    );
    if (next === node.scrollTop) return;
    node.scrollTop = next;
    setTop(next);
  };

  const targetFor = (id: string, mode: SlideDropMode): SlideDropTarget =>
    slideDropTarget(deck, id, mode);

  const finishDrop = (event: DragEvent, target: SlideDropTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData(SLIDE_TRANSFER_MIME),
      files = Array.from(event.dataTransfer.files);
    void (async () => {
      if (dragSlides.length) {
        await runtime.moveSlides(dragSlides, target);
        return;
      }
      const input = raw ? JSON.parse(raw) : await platform.readSlideTransfer(files);
      if (input) await runtime.dropSlideTransfer(input, target);
    })().catch((error) => console.error(error));
    if (target.parentId)
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(target.parentId!);
        return next;
      });
    setDragSlides([]);
    resetDrop();
  };

  const focusAndSelect = (id: string) => {
    void runtime.selectSlide(id).then(() => {
      requestAnimationFrame(() =>
        ref.current
          ?.querySelector<HTMLElement>(`[data-slide-id="${id}"]`)
          ?.focus(),
      );
    });
  };

  const handleSlideKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    if (
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const index = rows.findIndex((row) => row.id === id),
      row = rows[index];
    if (!row) return;
    const previousSlide = rows
        .slice(0, index)
        .reverse()
        .at(0),
      nextSlide = rows
        .slice(index + 1)
        .at(0),
      firstSlide = rows[0],
      lastSlide = rows.at(-1);
    if (["ArrowUp", "ArrowLeft"].includes(event.key) && previousSlide)
      focusAndSelect(previousSlide.id);
    else if (["ArrowDown", "ArrowRight"].includes(event.key) && nextSlide)
      focusAndSelect(nextSlide.id);
    else if (event.key === "Home" && firstSlide)
      focusAndSelect(firstSlide.id);
    else if (event.key === "End" && lastSlide)
      focusAndSelect(lastSlide.id);
  };

  return (
    <div
      ref={ref}
      className={`virtual-list ${appendDrop ? "slide-append-drop" : ""}`.trim()}
      aria-label={label}
      role="tree"
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
      onDragOver={(event) => {
        if (!acceptsSlideDrop(event.dataTransfer)) return;
        autoScrollForPointer(event.clientY);
        if ((event.target as HTMLElement).closest("[data-slide-id]")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dragSlides.length ? "move" : "copy";
        setDrop(null);
        setAppendDrop(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setAppendDrop(false);
      }}
      onDrop={(event) => {
        if ((event.target as HTMLElement).closest("[data-slide-id]")) return;
        if (!acceptsSlideDrop(event.dataTransfer)) return;
        finishDrop(event, { parentId: null, beforeId: null });
      }}
    >
      <div style={{ height: offsets[rows.length], position: "relative" }}>
        {Array.from({ length: Math.max(0, end - start) }, (_, itemIndex) => {
          const rowIndex = start + itemIndex,
            row = rows[rowIndex],
            id = row.id,
            deckIndex = deck.slideIds.indexOf(id),
            meta = deck.slideMeta[id],
            base = baseButtons.get(id),
            mode = drop?.id === id ? drop.mode : null;
          if (!base) return null;
          const button = cloneElement(base, {
            className: `slide-thumb ${id === slide.id ? "active" : ""} ${selectedSlides.includes(id) ? "multi-selected" : ""} ${meta?.hidden ? "hidden-slide skipped-slide-thumb" : ""} ${dragSlides.includes(id) ? "dragging" : ""} ${mode === "before" ? "drop-before" : mode === "after" ? "drop-after" : mode === "inside" ? "drop-section" : ""}`,
            draggable: true,
            onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
              if (event.button === 0)
                void runtime.prepareSlideDrag(id).catch((error) =>
                  console.error(error),
                );
            },
            onDragStart: (event: DragEvent<HTMLButtonElement>) => {
              const bundle = runtime.getPreparedSlideTransfer(id),
                ids = expandSlideSubtrees(
                  deck,
                  selectedSlides.includes(id) ? selectedSlides : [id],
                );
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
                  setDragSlides([]);
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
              if (!acceptsSlideDrop(event.dataTransfer)) return;
              autoScrollForPointer(event.clientY);
              if (dragSlides.includes(id)) {
                resetDrop();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect(),
                fraction = (event.clientY - bounds.top) / bounds.height,
                nextMode: SlideDropMode =
                  fraction < 0.28
                    ? "before"
                    : fraction > 0.72
                      ? "after"
                      : "inside";
              setAppendDrop(false);
              setDrop({ id, mode: nextMode });
              event.dataTransfer.dropEffect = dragSlides.length
                ? "move"
                : "copy";
            },
            onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDrop((current) => (current?.id === id ? null : current));
            },
            onDrop: (event: DragEvent<HTMLButtonElement>) => {
              if (dragSlides.includes(id)) {
                event.preventDefault();
                resetDrop();
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect(),
                fraction = (event.clientY - bounds.top) / bounds.height,
                mode: SlideDropMode =
                  fraction < 0.28
                    ? "before"
                    : fraction > 0.72
                      ? "after"
                      : "inside";
              finishDrop(event, targetFor(id, mode));
            },
            onDragEnd: () => {
              setDragSlides([]);
              resetDrop();
            },
            onClick: (event: MouseEvent<HTMLButtonElement>) =>
              void runtime.selectSlide(id, {
                shift: event.shiftKey,
                toggle: event.ctrlKey || event.metaKey,
              }),
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
              handleSlideKey(event, id),
            "aria-label": meta?.hidden
              ? `Skipped slide ${deckIndex + 1}`
              : `Slide ${deck.slideIds.slice(0, deckIndex + 1).filter((slideId) => !deck.slideMeta[slideId]?.hidden).length}`,
            title: meta?.hidden ? "Skipped slide" : undefined,
          });
          return (
            <div
              key={id}
              style={{
                position: "absolute",
                top: offsets[rowIndex],
                height: rowHeights[rowIndex],
                width: "100%",
              }}
            >
              <div
                className="slide-nav-row"
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={
                  row.hasChildren ? !collapsed.has(id) : undefined
                }
                style={{ "--slide-depth": row.depth } as CSSProperties}
              >
                <button
                  type="button"
                  className={`slide-disclosure ${row.hasChildren ? "" : "placeholder"}`}
                  tabIndex={row.hasChildren ? 0 : -1}
                  aria-label={`${collapsed.has(id) ? "Expand" : "Collapse"} slide ${deckIndex + 1} section`}
                  aria-expanded={
                    row.hasChildren ? !collapsed.has(id) : undefined
                  }
                  disabled={!row.hasChildren}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                >
                  {row.hasChildren ? (collapsed.has(id) ? "▸" : "▾") : ""}
                </button>
                {button}
              </div>
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

function GenericVirtualList({
  count,
  rowHeight,
  render,
  label,
  footer,
}: VirtualListProps) {
  const ref = useRef<HTMLDivElement>(null),
    [top, setTop] = useState(0),
    [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() =>
      setHeight(ref.current?.clientHeight ?? 600),
    );
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const offsets = [0];
  for (let i = 0; i < count; i++)
    offsets.push(
      offsets[i] + (typeof rowHeight === "number" ? rowHeight : rowHeight(i)),
    );
  const first = offsets.findIndex((value) => value >= top);
  const last = offsets.findIndex((value) => value >= top + height);
  const start = Math.max(0, (first < 0 ? count : first) - 3);
  const end = Math.min(count, (last < 0 ? count : last) + 2);
  return (
    <div
      ref={ref}
      className="virtual-list"
      aria-label={label}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: offsets[count], position: "relative" }}>
        {Array.from({ length: Math.max(0, end - start) }, (_, i) => {
          const index = start + i;
          return (
            <div
              key={index}
              style={{
                position: "absolute",
                top: offsets[index],
                height: offsets[index + 1] - offsets[index],
                width: "100%",
              }}
            >
              {render(index)}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

export function VirtualList(props: VirtualListProps) {
  if (props.label === "Slides" && getSlideNavigatorRuntime()?.getSnapshot())
    return <HierarchicalSlideList {...props} />;
  return <GenericVirtualList {...props} />;
}
