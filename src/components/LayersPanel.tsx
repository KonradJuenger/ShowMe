import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import {
  containsElement,
  getOwningLayer,
  getParentId,
  isEditableScope,
} from "../core/scene";
import { IconEye, IconEyeOff, IconLock, IconUnlock } from "./AppIcons";

type Layer = Deck["layers"][number];
type LayerSettings = Omit<Layer, "id">;

interface DragState {
  ids: string[];
  from: string | null;
  layers: boolean;
}

interface DropTarget {
  id: string;
  edge: "before" | "after" | "inside";
  to: string | null;
  index: number;
}

interface RenameState {
  id: string;
  value: string;
}

function elementLabel(element: Element) {
  if (element.name) return element.name;
  if (element.container) return "Frame";
  if (element.content?.type === "text") return "Text";
  if (element.content?.type === "image") return "Image";
  if (element.content?.type === "svg") return "Image";
  if (element.content?.type === "video") return "Video";
  return element.geometry.type === "ellipse" ? "Ellipse" : "Rectangle";
}

export function LayersPanel({
  slide,
  deck,
  selectionScope,
  insertionScope = selectionScope,
  selected,
  onSelect,
  onEnter,
  onReparent,
  active,
  onDeleteLayer,
  onLayerChange,
}: {
  slide: Slide;
  deck: Deck;
  selectionScope: string | null;
  insertionScope?: string | null;
  selected: string[];
  onSelect: (parentId: string, id: string, additive: boolean) => void;
  onEnter: (scopeId: string) => void;
  onReparent: (
    ids: string[],
    from: string | null,
    to: string | null,
    index: number,
  ) => void;
  active: boolean;
  onDeleteLayer: (id: string) => void;
  onLayerChange: (id: string, patch: Partial<LayerSettings>) => void;
}) {
  const [expandedBySlide, setExpandedBySlide] = useState<
    Record<string, Set<string>>
  >({});
  const expanded = expandedBySlide[slide.id] ?? new Set<string>();
  const tree = useRef<HTMLDivElement>(null);
  const setExpanded = (update: (current: Set<string>) => Set<string>) => {
    setExpandedBySlide((current) => ({
      ...current,
      [slide.id]: update(current[slide.id] ?? new Set()),
    }));
  };
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const layers = deck.layers;

  useEffect(() => {
    if (!active) return;
    const path = new Set<string>();
    // Entering an empty Frame still reveals its scope; a current Layer alone
    // does not force that Layer open.
    if (
      !selected.length &&
      selectionScope &&
      getParentId(slide, selectionScope)
    ) {
      let scope: string | null = selectionScope;
      while (scope) {
        path.add(scope);
        scope = getParentId(slide, scope);
      }
    }
    for (const id of selected) {
      let parent = getParentId(slide, id);
      while (parent) {
        path.add(parent);
        parent = getParentId(slide, parent);
      }
    }
    setExpandedBySlide((current) => {
      const existing = current[slide.id] ?? new Set<string>();
      if ([...path].every((id) => existing.has(id))) return current;
      return { ...current, [slide.id]: new Set([...existing, ...path]) };
    });
  }, [active, selected, selectionScope, slide]);

  useEffect(() => {
    if (!active) return;
    const row = tree.current?.querySelector<HTMLElement>(
      '[data-layer-element-id][aria-selected="true"]',
    );
    const revealRow =
      row ?? tree.current?.querySelector<HTMLElement>('[aria-current="true"]');
    const viewport = tree.current?.closest<HTMLElement>(".sidebar-primary");
    if (!revealRow || !viewport) return;
    const bounds = revealRow.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    if (bounds.top < visible.top || bounds.bottom > visible.bottom)
      revealRow.scrollIntoView({ block: "nearest" });
  }, [active, selected, selectionScope, expandedBySlide]);

  // Keep disclosure state mounted, but do not build an inactive hierarchy.
  if (!active) return null;

  const clearDrag = () => {
    setDragging(null);
    setTarget(null);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commitRename = (id: string) => {
    if (!renaming || renaming.id !== id) return;
    const layer = layers.find((entry) => entry.id === id);
    const name = renaming.value.trim();
    setRenaming(null);
    if (layer && name && name !== layer.name) onLayerChange(id, { name });
  };

  function targetForLayer(
    event: DragEvent<HTMLElement>,
    layerId: string,
  ): DropTarget | null {
    if (!dragging || dragging.ids.includes(layerId)) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;

    if (!dragging.layers) {
      if (fraction <= 0.25 || fraction >= 0.75) return null;
      if (!isEditableScope(slide, deck, layerId)) return null;
      const root = slide.nodes.find((entry) => entry.id === layerId);
      if (!root) return null;
      return {
        id: layerId,
        edge: "inside",
        to: layerId,
        index: root.children.length,
      };
    }

    const remaining = slide.nodes.filter(
      (root) => !dragging.ids.includes(root.id),
    );
    const targetIndex = remaining.findIndex((root) => root.id === layerId);
    if (targetIndex < 0) return null;
    const edge = fraction < 0.5 ? "before" : "after";
    return {
      id: layerId,
      edge,
      to: null,
      index: targetIndex + (edge === "before" ? 1 : 0),
    };
  }

  function targetForElement(
    event: DragEvent<HTMLElement>,
    element: Element,
    siblings: readonly Element[],
    parentId: string,
  ): DropTarget | null {
    if (
      !dragging ||
      dragging.layers ||
      dragging.from === null ||
      dragging.ids.includes(element.id)
    )
      return null;

    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    const inside = element.container && fraction > 0.25 && fraction < 0.75;
    const to = inside ? element.id : parentId;
    if (!isEditableScope(slide, deck, to)) return null;
    if (dragging.ids.some((id) => id === to || containsElement(slide, id, to)))
      return null;

    if (inside) {
      return {
        id: element.id,
        edge: "inside",
        to,
        index: element.children.length,
      };
    }

    const remaining = siblings.filter(
      (entry) => !dragging.ids.includes(entry.id),
    );
    const targetIndex = remaining.findIndex((entry) => entry.id === element.id);
    if (targetIndex < 0) return null;
    const edge = fraction < 0.5 ? "before" : "after";
    return {
      id: element.id,
      edge,
      to,
      index: targetIndex + (edge === "before" ? 1 : 0),
    };
  }

  const renderElements = (
    children: readonly Element[],
    parentId: string,
    depth: number,
  ): ReactNode =>
    [...children].reverse().map((element) => {
      const container = element.container;
      const open = container && expanded.has(element.id);
      const active =
        selectionScope === parentId && selected.includes(element.id);
      const currentScope = !!container && selectionScope === element.id;
      const disabled = !isEditableScope(slide, deck, element.id);
      const drop = target?.id === element.id ? "layer-drop-" + target.edge : "";

      return (
        <div className="layer-node" key={element.id}>
          <div
            className={
              "layer-row " +
              (active ? "selected " : "") +
              (currentScope ? "current-scope " : "") +
              (disabled ? "layer-disabled " : "") +
              (dragging?.ids.includes(element.id) ? "dragging " : "") +
              drop
            }
            style={{ paddingLeft: 8 + depth * 16 }}
            role="treeitem"
            data-context-target="object"
            data-id={element.id}
            data-layer-element-id={element.id}
            data-layer-parent-id={parentId}
            tabIndex={0}
            aria-selected={active}
            aria-current={currentScope ? true : undefined}
            aria-expanded={container ? open : undefined}
            draggable={!disabled}
            onDragStart={(event) => {
              event.stopPropagation();
              if (disabled) {
                event.preventDefault();
                return;
              }
              const ids =
                selectionScope === parentId && selected.includes(element.id)
                  ? [...selected]
                  : [element.id];
              setDragging({ ids, from: parentId, layers: false });
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "application/show-me-element",
                element.id,
              );
            }}
            onDragEnd={clearDrag}
            onDragOver={(event) => {
              event.stopPropagation();
              const next = targetForElement(event, element, children, parentId);
              setTarget(next);
              if (next) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const next = targetForElement(event, element, children, parentId);
              if (dragging && next) {
                onReparent(dragging.ids, dragging.from, next.to, next.index);
                if (next.edge === "inside")
                  setExpanded((current) => new Set([...current, element.id]));
              }
              clearDrag();
            }}
            onClick={(event) => {
              if (!disabled) onSelect(parentId, element.id, event.shiftKey);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || disabled) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (container) onEnter(element.id);
                else onSelect(parentId, element.id, event.shiftKey);
              }
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (container && !disabled) onEnter(element.id);
            }}
          >
            {container ? (
              <button
                type="button"
                className="layer-disclosure"
                aria-label={
                  (open ? "Collapse " : "Expand ") + elementLabel(element)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpanded(element.id);
                }}
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="layer-disclosure-placeholder" />
            )}
            <span className="layer-name">{elementLabel(element)}</span>
          </div>
          {container && open && (
            <div role="group" className="layer-children">
              {renderElements(element.children, element.id, depth + 1)}
            </div>
          )}
        </div>
      );
    });

  const renderLayer = (root: Slide["nodes"][number], depth: number) => {
    const layer = layers.find((entry) => entry.id === root.id);
    if (!layer) return null;
    const open = expanded.has(root.id);
    const owningLayer = insertionScope
      ? getOwningLayer(slide, insertionScope)
      : null;
    const active = owningLayer?.id === root.id;
    const disabled = layer.hidden || layer.locked;
    const drop = target?.id === root.id ? "layer-drop-" + target.edge : "";

    return (
      <div className="layer-node" key={root.id}>
        <div
          className={
            "layer-row explicit-layer " +
            (active ? "selected " : "") +
            (disabled ? "layer-disabled " : "") +
            (dragging?.ids.includes(root.id) ? "dragging " : "") +
            drop
          }
          style={{ paddingLeft: 8 + depth * 16 }}
          role="treeitem"
          data-id={root.id}
          data-layer-row-id={root.id}
          tabIndex={0}
          aria-selected={active}
          aria-expanded={open}
          draggable={renaming?.id !== root.id}
          onDragStart={(event) => {
            event.stopPropagation();
            setDragging({ ids: [root.id], from: null, layers: true });
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/show-me-layer", root.id);
          }}
          onDragEnd={clearDrag}
          onDragOver={(event) => {
            event.stopPropagation();
            const next = targetForLayer(event, root.id);
            setTarget(next);
            if (next) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const next = targetForLayer(event, root.id);
            if (dragging && next) {
              onReparent(dragging.ids, dragging.from, next.to, next.index);
              if (next.edge === "inside")
                setExpanded((current) => new Set([...current, root.id]));
            }
            clearDrag();
          }}
          onClick={() => {
            if (!disabled) onEnter(root.id);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!disabled) onEnter(root.id);
            }
          }}
        >
          <button
            type="button"
            className="layer-current-toggle"
            disabled={disabled}
            aria-label={"Make " + layer.name + " current layer"}
            aria-pressed={active}
            title={active ? "Current layer" : "Make current layer"}
            onClick={(event) => {
              event.stopPropagation();
              onEnter(root.id);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span aria-hidden="true" />
          </button>
          <button
            type="button"
            className="layer-disclosure"
            aria-label={(open ? "Collapse " : "Expand ") + layer.name}
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded(root.id);
            }}
          >
            {open ? "▾" : "▸"}
          </button>
          {renaming?.id === root.id ? (
            <input
              className="layer-name"
              aria-label={"Rename " + layer.name}
              value={renaming.value}
              autoFocus
              onChange={(event) =>
                setRenaming({ id: root.id, value: event.target.value })
              }
              onBlur={() => commitRename(root.id)}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onDragStart={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename(root.id);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <span
              className="layer-name"
              title="Double-click to rename"
              onDoubleClick={(event) => {
                event.stopPropagation();
                setRenaming({ id: root.id, value: layer.name });
              }}
            >
              {layer.name}
            </span>
          )}
          <div
            className="layer-controls"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
          >
            <button
              type="button"
              title={layer.hidden ? "Show layer" : "Hide layer"}
              aria-label={(layer.hidden ? "Show " : "Hide ") + layer.name}
              aria-pressed={layer.hidden}
              onClick={() => onLayerChange(root.id, { hidden: !layer.hidden })}
            >
              {layer.hidden ? <IconEyeOff /> : <IconEye />}
            </button>
            <button
              type="button"
              title={layer.locked ? "Unlock layer" : "Lock layer"}
              aria-label={(layer.locked ? "Unlock " : "Lock ") + layer.name}
              aria-pressed={layer.locked}
              onClick={() => onLayerChange(root.id, { locked: !layer.locked })}
            >
              {layer.locked ? <IconLock /> : <IconUnlock />}
            </button>
            <label
              className="layer-color-control"
              title="Guide and selection color"
            >
              <span className="layer-color-swatch" aria-hidden="true">
                <span
                  className="layer-color-fill"
                  style={{ backgroundColor: layer.color }}
                />
              </span>
              <input
                type="color"
                aria-label={layer.name + " layer color"}
                value={layer.color}
                onChange={(event) =>
                  onLayerChange(root.id, { color: event.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="layer-delete-action"
              aria-label={"Delete " + layer.name}
              title={
                layers.length <= 1
                  ? "Keep at least one layer"
                  : "Delete layer from document"
              }
              disabled={layers.length <= 1}
              onClick={() => onDeleteLayer(root.id)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9M6.5 7v4M9.5 7v4" />
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <div role="group" className="layer-children">
            {renderElements(root.children, root.id, depth + 1)}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="layers-panel" aria-label="Layers">
      <div
        ref={tree}
        className="layers-tree"
        role="tree"
        aria-label="Slide layers"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setTarget(null);
        }}
      >
        {[...slide.nodes].reverse().map((root) => renderLayer(root, 0))}
      </div>
    </section>
  );
}
