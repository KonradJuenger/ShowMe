import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  findElement,
  isEditableScope,
  flattenElements,
  locateElement,
  containsElement,
} from "../core/scene";
import {
  replaceElements,
  setElementFrames,
  setSlideBackground,
  setDeckProperties,
  updateSlideMeta,
  type EditorSnapshot,
  type ReorderMode,
} from "../core/editorCommands";
import { setEditorOperations } from "../core/editorChange";
import { alignSelection, distributeSelection } from "../core/arrangeCommands";
import type { CanvasSelection } from "./editorCanvasCoordinator";
import { ElementPanel, PropertySection } from "./ElementPanel";
import { useSidebarEditing, type SidebarController } from "./sidebarEditing";
import { MaterialIcon, type MaterialIconName } from "./MaterialIcon";
import "./RightSidebar.css";
import { dimensionsForAspectRatio } from "../core/presentationDimensions";
import { PresentationFormatSettings } from "./PresentationFormatSettings";

const modes = [
  "Element",
  "Arrange",
  "Media",
  "Motion",
  "Effects",
  "CSS",
  "Slide",
  "Layers",
  "Settings",
] as const;
type Mode = (typeof modes)[number];
const icons: Record<Mode, MaterialIconName> = {
  Element: "tune-variant",
  Arrange: "cursor-move",
  Media: "image-outline",
  Motion: "play",
  Effects: "star-four-points",
  CSS: "code-braces",
  Slide: "presentation",
  Layers: "layers-outline",
  Settings: "toggle-switch-outline",
};
const transitionLabels = {
  none: "None",
  fade: "Fade",
  push: "Push / Slide",
  wipe: "Wipe",
};
const preferenceKey = "showme.right-sidebar.v1";
function preferences(): {
  mode: Mode;
  width: number;
} {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
    return {
      mode: modes.includes(value.mode) ? value.mode : "Element",
      width:
        typeof value.width === "number"
          ? Math.max(280, Math.min(560, value.width))
          : 336,
    };
  } catch {
    return { mode: "Element", width: 336 };
  }
}
export interface RightSidebarProps {
  documentId: string;
  snapshot: EditorSnapshot;
  selection: CanvasSelection;
  controller: SidebarController;
  structuralActions: {
    frameSelection(): Promise<void>;
    unframeSelection(): Promise<void>;
    reorderSelection(mode: ReorderMode): Promise<void>;
    canFrame(): boolean;
    canUnframe(): boolean;
  };
  layers: (active: boolean) => ReactNode;
  onAddLayer(): void;
  media: ReactNode;
  settings: ReactNode;
  motion?: ReactNode;
  effectsEditor?: ReactNode;
  templateControls?: ReactNode;
  showMedia: boolean;
  onMediaShown(): void;
  onReplaceMedia(): void;
  onCropFrame(id: string): void;
  onEditFrame(id: string): void;
  onMediaCenter(id: string): void;
  onMediaReset(id: string): void;
  onReparent(ids: string[], from: string, to: string): void;
  onMediaRule(id: string, rule: "fit" | "fill" | "free"): void;
  onTrimVideo?(id: string): void;
  onPreviewVideo?(id: string, command: "previous" | "play" | "next"): void;
  onGuides(): void;
  onError(error: unknown): void;
}
export function RightSidebar(props: RightSidebarProps) {
  const { snapshot, selection, controller, onError, showMedia, onMediaShown } =
    props;
  const [layout, setLayout] = useState(preferences);
  const root = useRef<HTMLElement>(null);
  const ids = selection.elementIds.filter(
    (id) => !!findElement(snapshot.slide, id),
  );
  const elements = ids.flatMap((id) => {
    const e = findElement(snapshot.slide, id);
    return e ? [e] : [];
  });
  const editable =
    elements.length > 0 &&
    elements.every((e) => isEditableScope(snapshot.slide, snapshot.deck, e.id));
  const editing = useSidebarEditing(controller, ids, onError);
  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(layout));
    } catch {
      /* Preferences are optional. */
    }
    const editor = root.current?.closest<HTMLElement>(".editor");
    editor?.style.setProperty("--inspector-width", `${layout.width}px`);
    return () => {
      editor?.style.removeProperty("--inspector-width");
    };
  }, [layout]);
  useEffect(() => {
    if (showMedia) {
      setLayout((current) => ({ ...current, mode: "Media" }));
      onMediaShown();
    }
  }, [showMedia, onMediaShown]);
  useEffect(() => {
    const switchMode = (event: Event) => {
      const mode = (event as CustomEvent).detail;
      if (modes.includes(mode)) setLayout((current) => ({ ...current, mode }));
    };
    document.addEventListener("showme-sidebar-mode", switchMode);
    return () =>
      document.removeEventListener("showme-sidebar-mode", switchMode);
  }, []);
  const selected = elements.length === 1 ? elements[0] : null;
  const selectionTitle = selected
    ? selected.content?.type === "text"
      ? "Text"
      : selected.content?.type === "video"
        ? "Video"
        : selected.content
          ? "Image"
          : selected.container
            ? "Frame"
            : selected.geometry.type === "ellipse"
              ? "Ellipse"
              : "Rectangle"
    : elements.length
      ? `${elements.length} selected`
      : "Element";
  const meta = snapshot.deck.slideMeta[snapshot.slide.id];
  const setMode = (mode: Mode) => {
    editing.cancel();
    setLayout((current) => ({ ...current, mode }));
  };
  const arrange = (
    kind: "align" | "distribute",
    axis:
      | "left"
      | "center"
      | "right"
      | "top"
      | "middle"
      | "bottom"
      | "horizontal"
      | "vertical",
  ) => {
    if (!selection.scopeId) return;
    const scope = selection.scopeId;
    editing.enqueue((current) =>
      kind === "align"
        ? alignSelection(
            current,
            ids,
            scope,
            axis as "left" | "center" | "right" | "top" | "middle" | "bottom",
          )
        : distributeSelection(
            current,
            ids,
            scope,
            axis as "horizontal" | "vertical",
          ),
    );
  };
  const stylesheet = snapshot.deck.stylesheet ?? "";
  const cssDraft = useRef<string | null>(null);
  const cssDocument = useRef(props.documentId);
  if (cssDocument.current !== props.documentId) {
    cssDocument.current = props.documentId;
    cssDraft.current = null;
  }
  const commitCss = () => {
    const next = cssDraft.current;
    cssDraft.current = null;
    if (next === null || next === stylesheet) return;
    editing.enqueue((current) =>
      setEditorOperations(
        { ...current, deck: { ...current.deck, stylesheet: next } },
        [{ type: "deck.properties.set", changes: { stylesheet: next } }],
      ),
    );
  };
  return (
    <aside
      className="right-panel right-sidebar"
      ref={root}
      aria-label="Right sidebar"
      onKeyDown={(event) => {
        // Let focused inspector buttons and disclosure controls activate natively.
        // The canvas Space shortcut otherwise prevents their default action.
        if (
          (event.key === " " || event.key === "Enter") &&
          (event.target as HTMLElement).closest("button, summary")
        )
          event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")
          (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <div
        className="sidebar-width-handle"
        role="separator"
        aria-label="Sidebar width"
        aria-orientation="vertical"
        tabIndex={0}
        aria-valuemin={280}
        aria-valuemax={560}
        aria-valuenow={layout.width}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight")
            setLayout((current) => ({
              ...current,
              width: Math.max(
                280,
                Math.min(
                  560,
                  current.width + (event.key === "ArrowLeft" ? 16 : -16),
                ),
              ),
            }));
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setLayout((current) => ({
              ...current,
              width: Math.max(
                280,
                Math.min(
                  560,
                  window.innerWidth * 0.45,
                  window.innerWidth - event.clientX,
                ),
              ),
            }));
        }}
      />
      <nav className="sidebar-mode-rail" aria-label="Sidebar modes">
        {modes.map((mode) => (
          <button
            type="button"
            key={mode}
            aria-label={mode === "Settings" ? "Controls" : mode}
            title={mode === "Settings" ? "Controls" : mode}
            aria-pressed={layout.mode === mode}
            onClick={() => setMode(mode)}
          >
            <MaterialIcon name={icons[mode]} />
          </button>
        ))}
      </nav>
      <div className="sidebar-tools">
        <header className="sidebar-panel-header">
          <h2>
            {layout.mode === "Element"
              ? selectionTitle
              : layout.mode === "Settings"
                ? "Controls"
                : layout.mode}
          </h2>
          {layout.mode === "Layers" && (
            <button
              type="button"
              aria-label="Add layer"
              title="Create new layer"
              onClick={props.onAddLayer}
            >
              +
            </button>
          )}
        </header>
        <div className="sidebar-primary" style={{ flex: 1 }}>
          {layout.mode === "Settings" && props.settings}
          {layout.mode === "Element" && (
            <fieldset
              disabled={elements.length > 0 && !editable}
              className="sidebar-fieldset"
            >
              <ElementPanel
                snapshot={snapshot}
                documentId={props.documentId}
                elements={elements}
                editing={editing}
                onIdentity={(name, value) =>
                  editing.enqueue((current) =>
                    replaceElements(
                      current,
                      ids.flatMap((id) => {
                        const e = findElement(current.slide, id);
                        if (
                          !e ||
                          !isEditableScope(current.slide, current.deck, id)
                        )
                          return [];
                        return [
                          {
                            ...e,
                            ...(name === "name"
                              ? { name: value }
                              : {
                                  cssClasses: [
                                    ...new Set(
                                      value.trim().split(/\s+/).filter(Boolean),
                                    ),
                                  ],
                                }),
                          },
                        ];
                      }),
                    ),
                  )
                }
                onReplace={props.onReplaceMedia}
                onRule={props.onMediaRule}
                onCenter={props.onMediaCenter}
                onReset={props.onMediaReset}
                onEditFrame={props.onEditFrame}
                onCrop={props.onCropFrame}
                onTrim={(id) => props.onTrimVideo?.(id)}
                onPreview={(id, command) => props.onPreviewVideo?.(id, command)}
                onError={onError}
              />
            </fieldset>
          )}
          {layout.mode === "Arrange" && (
            <fieldset disabled={!editable} className="sidebar-fieldset">
              <PropertySection title="Transform frame & content">
                <div className="element-wide sidebar-command-grid">
                  {(
                    [
                      ["Rotate left 90°", "rotate-left", "left"],
                      ["Rotate right 90°", "rotate-right", "right"],
                      ["Rotate 180°", "rotate-3d-variant", "half"],
                      ["Flip horizontal", "flip-horizontal", "flipX"],
                      ["Flip vertical", "flip-vertical", "flipY"],
                    ] as const
                  ).map(([label, icon, action]) => (
                    <button
                      type="button"
                      key={action}
                      aria-label={label}
                      title={label}
                      onClick={() =>
                        editing.enqueue((current) =>
                          setElementFrames(
                            current,
                            ids.flatMap((id) => {
                              const element = findElement(current.slide, id);
                              if (
                                !element ||
                                !isEditableScope(
                                  current.slide,
                                  current.deck,
                                  id,
                                )
                              )
                                return [];
                              const frame = element.frame;
                              return [
                                {
                                  elementId: id,
                                  value: {
                                    ...frame,
                                    ...(action === "flipX" || action === "flipY"
                                      ? { [action]: !frame[action] }
                                      : {
                                          rotation:
                                            frame.rotation +
                                            (action === "left"
                                              ? -90
                                              : action === "right"
                                                ? 90
                                                : 180),
                                        }),
                                  },
                                },
                              ];
                            }),
                          ),
                        )
                      }
                    >
                      <MaterialIcon name={icon} />
                    </button>
                  ))}
                </div>
              </PropertySection>
              <PropertySection title="Align">
                <div className="element-wide sidebar-command-grid">
                  {(
                    [
                      "left",
                      "center",
                      "right",
                      "top",
                      "middle",
                      "bottom",
                    ] as const
                  ).map((axis) => (
                    <button
                      type="button"
                      key={axis}
                      aria-label={`Align ${axis}`}
                      title={`Align ${axis}`}
                      onClick={() => arrange("align", axis)}
                    >
                      <MaterialIcon
                        name={
                          (
                            {
                              left: "align-horizontal-left",
                              center: "align-horizontal-center",
                              right: "align-horizontal-right",
                              top: "align-vertical-top",
                              middle: "align-vertical-center",
                              bottom: "align-vertical-bottom",
                            } as const
                          )[axis]
                        }
                      />
                    </button>
                  ))}
                </div>
              </PropertySection>
              <PropertySection title="Distribute">
                <div className="element-wide">
                  {(["horizontal", "vertical"] as const).map((axis) => (
                    <button
                      type="button"
                      key={axis}
                      disabled={ids.length < 3}
                      aria-label={axis}
                      title={`Distribute ${axis}`}
                      onClick={() => arrange("distribute", axis)}
                    >
                      <MaterialIcon
                        name={
                          axis === "horizontal"
                            ? "distribute-horizontal-center"
                            : "distribute-vertical-center"
                        }
                      />
                    </button>
                  ))}
                </div>
              </PropertySection>
              <PropertySection title="Order">
                <div className="element-wide arrange-order-groups">
                  {(
                    [
                      [
                        "Move to edge",
                        [
                          ["back", "Back", "Move to back"],
                          ["front", "Front", "Move to front"],
                        ],
                      ],
                      [
                        "Move one step",
                        [
                          ["backward", "Backward", "Move backward"],
                          ["forward", "Forward", "Move forward"],
                        ],
                      ],
                    ] as const
                  ).map(([group, actions]) => (
                    <div
                      className="arrange-order-group"
                      key={group}
                      role="group"
                      aria-label={group}
                    >
                      <span>{group}</span>
                      <div>
                        {actions.map(([mode, label, title]) => (
                          <button
                            type="button"
                            key={mode}
                            aria-label={title}
                            title={title}
                            onClick={() =>
                              void props.structuralActions
                                .reorderSelection(mode)
                                .catch(onError)
                            }
                          >
                            <MaterialIcon
                              name={
                                (
                                  {
                                    back: "arrange-send-to-back",
                                    front: "arrange-bring-to-front",
                                    backward: "arrange-send-backward",
                                    forward: "arrange-bring-forward",
                                  } as const
                                )[mode]
                              }
                            />
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </PropertySection>
              <PropertySection title="Structure">
                <div className="element-wide arrange-structure-actions">
                  <select
                    aria-label="Move Into"
                    value=""
                    onChange={(event) => {
                      if (selection.scopeId && event.currentTarget.value)
                        props.onReparent(
                          ids,
                          selection.scopeId,
                          event.currentTarget.value,
                        );
                    }}
                  >
                    <option value="">Move Into…</option>
                    {flattenElements(snapshot.slide)
                      .filter(
                        (e) =>
                          e.container &&
                          e.id !== selection.scopeId &&
                          isEditableScope(
                            snapshot.slide,
                            snapshot.deck,
                            e.id,
                          ) &&
                          !ids.some((id) =>
                            containsElement(snapshot.slide, id, e.id),
                          ),
                      )
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name || "Frame"}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      !selection.scopeId ||
                      !locateElement(snapshot.slide, selection.scopeId)
                    }
                    onClick={() => {
                      const parent =
                        selection.scopeId &&
                        locateElement(snapshot.slide, selection.scopeId)
                          ?.parentId;
                      if (parent && selection.scopeId)
                        props.onReparent(ids, selection.scopeId, parent);
                    }}
                  >
                    Move Out
                  </button>
                  <button
                    type="button"
                    disabled={!props.structuralActions.canFrame()}
                    onClick={() =>
                      void props.structuralActions
                        .frameSelection()
                        .catch(onError)
                    }
                  >
                    Frame Selection
                  </button>
                  <button
                    type="button"
                    disabled={!props.structuralActions.canUnframe()}
                    onClick={() =>
                      void props.structuralActions
                        .unframeSelection()
                        .catch(onError)
                    }
                  >
                    Unframe
                  </button>
                </div>
              </PropertySection>
            </fieldset>
          )}
          {layout.mode === "Media" && props.media}
          {layout.mode === "Motion" &&
            !snapshot.deck.templateIds.includes(snapshot.slide.id) &&
            props.motion}
          {layout.mode === "Effects" && props.effectsEditor}
          {layout.mode === "CSS" && (
            <div className="global-css-panel">
              <p>
                Global presentation stylesheet. Target Elements with{" "}
                <code>[data-showme-id="showme-ID"]</code> or their classes. Use{" "}
                <code>!important</code> to override structured styles.
              </p>
              <textarea
                key={`${props.documentId}-${stylesheet}`}
                aria-label="Global stylesheet"
                spellCheck={false}
                defaultValue={stylesheet}
                onChange={(event) => {
                  cssDraft.current = event.currentTarget.value;
                }}
                onBlur={commitCss}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    commitCss();
                  }
                }}
              />
            </div>
          )}
          {layout.mode === "Slide" && (
            <div className="slide-settings">
              <PropertySection
                title={
                  snapshot.deck.templateIds.includes(snapshot.slide.id)
                    ? "Template appearance"
                    : "Appearance"
                }
              >
                <label className="element-property element-wide">
                  <span>Name</span>
                  <input
                    key={`name-${snapshot.slide.id}-${meta?.name}`}
                    aria-label="Slide name"
                    disabled={snapshot.deck.templateIds.includes(
                      snapshot.slide.id,
                    )}
                    defaultValue={meta?.name ?? ""}
                    onBlur={(event) => {
                      const value = event.currentTarget.value;
                      editing.enqueue((current) =>
                        updateSlideMeta(current, snapshot.slide.id, {
                          name: value,
                        }),
                      );
                    }}
                  />
                </label>
                {props.templateControls}
                <label className="element-property element-property-color element-wide">
                  <span>Background</span>
                  <input
                    type="color"
                    aria-label="Slide background"
                    disabled={Boolean(meta?.templateId)}
                    title={
                      meta?.templateId
                        ? `Background from Template ${snapshot.deck.templateMeta[meta.templateId].label}`
                        : undefined
                    }
                    value={
                      meta?.templateId
                        ? (snapshot.templates?.[meta.templateId]?.background ??
                          snapshot.slide.background)
                        : snapshot.slide.background
                    }
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      editing.enqueue((current) =>
                        setSlideBackground(current, value),
                      );
                    }}
                  />
                </label>
                {meta?.templateId && (
                  <p className="element-wide inspector-field-hint">
                    From Template{" "}
                    {snapshot.deck.templateMeta[meta.templateId].label}
                  </p>
                )}
              </PropertySection>
              {!snapshot.deck.templateIds.includes(snapshot.slide.id) && (
                <PropertySection title="Transition">
                  <label className="element-property element-wide">
                    <span>Transition</span>
                    <select
                      aria-label="Slide transition"
                      value={meta?.transition?.kind ?? "default"}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        const kind =
                          value === "default"
                            ? undefined
                            : (value as import("../core/slideTransitions").SlideTransition["kind"]);
                        editing.enqueue((current) =>
                          updateSlideMeta(current, snapshot.slide.id, {
                            transition: {
                              ...current.deck.slideMeta[snapshot.slide.id]
                                .transition,
                              kind,
                            },
                          }),
                        );
                      }}
                    >
                      <option value="default">
                        Presentation default ·{" "}
                        {
                          transitionLabels[
                            snapshot.deck.transitionDefaults.kind
                          ]
                        }
                      </option>
                      <option value="none">None</option>
                      <option value="fade">Fade</option>
                      <option value="push">Push / Slide</option>
                      <option value="wipe">Wipe</option>
                    </select>
                  </label>
                  <label className="element-property element-wide">
                    <span>Timing</span>
                    <select
                      aria-label="Slide transition timing"
                      value={
                        meta?.transition?.durationMs === undefined &&
                        meta?.transition?.easing === undefined
                          ? "default"
                          : "custom"
                      }
                      onChange={(event) => {
                        const inherit = event.currentTarget.value === "default";
                        editing.enqueue((current) =>
                          updateSlideMeta(current, snapshot.slide.id, {
                            transition: {
                              ...current.deck.slideMeta[snapshot.slide.id]
                                .transition,
                              durationMs: inherit
                                ? undefined
                                : current.deck.transitionDefaults.durationMs,
                              easing: inherit
                                ? undefined
                                : current.deck.transitionDefaults.easing,
                            },
                          }),
                        );
                      }}
                    >
                      <option value="default">Presentation default</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {(meta?.transition?.durationMs !== undefined ||
                    meta?.transition?.easing !== undefined) && (
                    <>
                      <label className="element-property element-wide">
                        <span>Duration (s)</span>
                        <input
                          aria-label="Slide transition duration"
                          type="number"
                          min="0"
                          max="60"
                          step="0.1"
                          value={
                            (meta.transition.durationMs ??
                              snapshot.deck.transitionDefaults.durationMs) /
                            1000
                          }
                          onChange={(event) => {
                            const durationMs =
                              event.currentTarget.valueAsNumber * 1000;
                            if (
                              !Number.isFinite(durationMs) ||
                              durationMs < 0 ||
                              durationMs > 60000
                            )
                              return;
                            editing.enqueue((current) =>
                              updateSlideMeta(current, snapshot.slide.id, {
                                transition: {
                                  ...current.deck.slideMeta[snapshot.slide.id]
                                    .transition!,
                                  durationMs,
                                },
                              }),
                            );
                          }}
                        />
                      </label>
                      <label className="element-property element-wide">
                        <span>Easing</span>
                        <select
                          aria-label="Slide transition easing"
                          value={
                            meta.transition.easing ??
                            snapshot.deck.transitionDefaults.easing
                          }
                          onChange={(event) => {
                            const easing = event.currentTarget
                              .value as import("../core/slideTransitions").TransitionTiming["easing"];
                            editing.enqueue((current) =>
                              updateSlideMeta(current, snapshot.slide.id, {
                                transition: {
                                  ...current.deck.slideMeta[snapshot.slide.id]
                                    .transition!,
                                  easing,
                                },
                              }),
                            );
                          }}
                        >
                          {[
                            "linear",
                            "ease",
                            "ease-in",
                            "ease-out",
                            "ease-in-out",
                          ].map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </PropertySection>
              )}
              <div className="presentation-settings">
                <PropertySection title="Presentation">
                  <PresentationFormatSettings
                    size={snapshot.deck}
                    onRatioChange={(ratio) =>
                      editing.enqueue((current) =>
                        setDeckProperties(
                          current,
                          dimensionsForAspectRatio(current.deck, ratio),
                        ),
                      )
                    }
                    onCanvasChange={(changes) =>
                      editing.enqueue((current) =>
                        setDeckProperties(current, changes),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="element-wide"
                    onClick={props.onGuides}
                  >
                    Layout Guides
                  </button>
                </PropertySection>
                <PropertySection title="Default transition">
                  <label className="element-property element-wide">
                    <span>Transition</span>
                    <select
                      aria-label="Presentation default transition"
                      value={snapshot.deck.transitionDefaults.kind}
                      onChange={(event) => {
                        const kind = event.currentTarget
                          .value as import("../core/slideTransitions").TransitionDefaults["kind"];
                        editing.enqueue((current) =>
                          setDeckProperties(current, {
                            transitionDefaults: {
                              ...current.deck.transitionDefaults,
                              kind,
                            },
                          }),
                        );
                      }}
                    >
                      <option value="none">None</option>
                      <option value="fade">Fade</option>
                      <option value="push">Push / Slide</option>
                      <option value="wipe">Wipe</option>
                    </select>
                  </label>
                  <p className="element-wide">
                    Applies to all slides using defaults.
                  </p>

                  <label className="element-property element-wide">
                    <span>Duration (s)</span>
                    <input
                      aria-label="Presentation transition duration"
                      type="number"
                      min="0"
                      max="60"
                      step="0.1"
                      value={snapshot.deck.transitionDefaults.durationMs / 1000}
                      onChange={(event) => {
                        const durationMs =
                          event.currentTarget.valueAsNumber * 1000;
                        if (
                          !Number.isFinite(durationMs) ||
                          durationMs < 0 ||
                          durationMs > 60000
                        )
                          return;
                        editing.enqueue((current) =>
                          setDeckProperties(current, {
                            transitionDefaults: {
                              ...current.deck.transitionDefaults,
                              durationMs,
                            },
                          }),
                        );
                      }}
                    />
                  </label>
                  <label className="element-property element-wide">
                    <span>Easing</span>
                    <select
                      aria-label="Presentation transition easing"
                      value={snapshot.deck.transitionDefaults.easing}
                      onChange={(event) => {
                        const easing = event.currentTarget
                          .value as import("../core/slideTransitions").TransitionTiming["easing"];
                        editing.enqueue((current) =>
                          setDeckProperties(current, {
                            transitionDefaults: {
                              ...current.deck.transitionDefaults,
                              easing,
                            },
                          }),
                        );
                      }}
                    >
                      {[
                        "linear",
                        "ease",
                        "ease-in",
                        "ease-out",
                        "ease-in-out",
                      ].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                </PropertySection>
              </div>
            </div>
          )}
          <div hidden={layout.mode !== "Layers"}>
            {props.layers(layout.mode === "Layers")}
          </div>
        </div>
      </div>
    </aside>
  );
}
