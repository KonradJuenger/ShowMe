import { TextStyleControl } from "./TextStyleControl";
import {
  prepareTextStyleLayout,
  applyPreparedTextStyleLayout,
} from "./editor/textStyleLayout";
import { resolveTextTypography } from "../core/textTypography";
import { useEffect, useState, useRef, type ReactNode } from "react";
import type { Element } from "../core/element";
import {
  getProperty,
  selectionProperty,
  type ElementPropertyId,
  type PropertyValue,
} from "../core/elementProperties";
import type { useSidebarEditing } from "./sidebarEditing";
import { elementCapabilities } from "../core/elementCapabilities";
import type { EditorSnapshot } from "../core/editorCommands";
import { ImageFileControls } from "./MediaFileControls";
import { platform } from "../platform";
import { MaterialIcon, type MaterialIconName } from "./MaterialIcon";

type Editing = ReturnType<typeof useSidebarEditing>;
export function PropertyControl<K extends ElementPropertyId>({
  id,
  elements,
  editing,
  kind = "number",
  options,
  choices,
  min,
  max,
  step = 1,
  label,
  preserveScaleRatio = false,
  precision = 2,
}: {
  id: K;
  elements: readonly Element[];
  editing: Editing;
  kind?:
    | "number"
    | "text"
    | "textarea"
    | "color"
    | "checkbox"
    | "select"
    | "segments";
  options?: readonly PropertyValue<K>[];
  choices?: readonly {
    value: PropertyValue<K>;
    icon: MaterialIconName;
    label: string;
  }[];
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  preserveScaleRatio?: boolean;
  precision?: number;
}) {
  const property = getProperty(id);
  const resolved = selectionProperty(elements, id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || id !== "content.text.fontFamily") return;
    if (document.activeElement !== input) input.value = String(value);
    const commitFont = () => {
      if (input.value !== String(value))
        editing.set(id, input.value as PropertyValue<K>);
    };
    input.addEventListener("showme-font-selected", commitFont);
    return () => input.removeEventListener("showme-font-selected", commitFont);
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input || kind !== "number") return;
    const wheel = (event: WheelEvent) => {
      if (document.activeElement === input) event.preventDefault();
    };
    input.addEventListener("wheel", wheel, { passive: false });
    return () => input.removeEventListener("wheel", wheel);
  }, [kind]);
  const scrub = useRef<{ x: number; value: number } | null>(null);
  if (resolved.state === "unavailable") return null;
  const value = resolved.state === "value" ? resolved.value : "";
  const title = label ?? property.label;
  const flip = id.endsWith(".flipX") || id.endsWith(".flipY");
  const clamp = (n: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const toggleIcon =
    id === "content.text.bold"
      ? "format-bold"
      : id === "content.text.italic"
        ? "format-italic"
        : undefined;
  if (toggleIcon)
    return (
      <button
        type="button"
        className="element-format-toggle"
        data-property-id={id}
        data-property-state={resolved.state}
        aria-label={title}
        title={title}
        aria-pressed={resolved.state === "mixed" ? "mixed" : value === true}
        onClick={() => editing.set(id, (value !== true) as PropertyValue<K>)}
      >
        <MaterialIcon name={toggleIcon} />
      </button>
    );
  if (kind === "segments")
    return (
      <div
        className="element-property element-property-segments"
        data-property-id={id}
        data-property-state={resolved.state}
      >
        <span>
          {id === "content.text.align"
            ? "Horizontal"
            : id === "content.text.verticalAlign"
              ? "Vertical"
              : title}
        </span>
        <div className="element-segment" role="group" aria-label={title}>
          {choices?.map((choice) => (
            <button
              type="button"
              key={String(choice.value)}
              aria-label={choice.label}
              title={choice.label}
              aria-pressed={
                resolved.state === "value" && value === choice.value
              }
              onClick={() => editing.set(id, choice.value)}
            >
              <MaterialIcon name={choice.icon} />
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <label
      className={`element-property element-property-${kind}${flip ? " element-flip" : ""}${id === "content.text.fontFamily" ? " element-wide element-font-family" : ""}`}
      title={flip ? title : undefined}
      data-property-id={id}
      data-property-state={resolved.state}
    >
      <span
        className={flip ? "element-flip-label" : undefined}
        onPointerDown={
          kind === "number"
            ? (event) => {
                event.preventDefault();
                editing.commit();
                setDraft(null);
                event.currentTarget.setPointerCapture(event.pointerId);
                scrub.current = {
                  x: event.clientX,
                  value: typeof value === "number" ? value : 0,
                };
                void editing.begin(id);
              }
            : undefined
        }
        onPointerMove={(event) => {
          if (!scrub.current) return;
          editing.preview(
            id,
            clamp(
              scrub.current.value + (event.clientX - scrub.current.x) * step,
            ) as PropertyValue<K>,
            preserveScaleRatio,
          );
        }}
        onPointerUp={() => {
          if (scrub.current) {
            scrub.current = null;
            editing.commit();
          }
        }}
        onPointerCancel={() => {
          scrub.current = null;
          editing.cancel();
        }}
        title={kind === "number" ? "Drag to scrub" : undefined}
      >
        {(
          {
            "transform.x": "X",
            "transform.y": "Y",
            "transform.width": "W",
            "transform.height": "H",
            "transform.scaleX": "X",
            "transform.scaleY": "Y",
            "transform.rotation": "Rotation",
            "content.media.rotation": "Rotation",
            "content.media.zoom": "Zoom",
            "content.media.anchorX": "X",
            "content.media.anchorY": "Y",
            "appearance.opacity": "Opacity",
            "content.text.color": "Color",
            "content.text.letterSpacing": "Tracking",
            "appearance.fill": "Fill",
            "appearance.strokeColor": "Stroke",
            "appearance.strokeWidth": "Width",
            "geometry.radius": "Radius",
            "geometry.type": "Geometry",
            "content.video.volume": "Volume",
            "content.video.mute": "Mute",
            "content.video.loop": "Loop",
            "content.video.autoplay": "Autoplay",
            "content.video.startTime": "Start",
            "content.video.endTime": "End",
          } as Partial<Record<ElementPropertyId, string>>
        )[id] ?? title}
      </span>
      {flip && (
        <MaterialIcon
          className="element-flip-icon"
          name={id.endsWith(".flipY") ? "flip-vertical" : "flip-horizontal"}
        />
      )}
      {kind === "checkbox" ? (
        <input
          type="checkbox"
          aria-label={title}
          checked={value === true}
          ref={(input) => {
            if (input) input.indeterminate = resolved.state === "mixed";
          }}
          onChange={(event) =>
            editing.set(id, event.currentTarget.checked as PropertyValue<K>)
          }
        />
      ) : kind === "select" ? (
        <select
          aria-label={title}
          value={String(value)}
          onChange={(event) => {
            const choice = options?.find(
              (option) => String(option) === event.currentTarget.value,
            );
            if (choice !== undefined) editing.set(id, choice);
          }}
        >
          {resolved.state === "mixed" && <option value="">Mixed</option>}
          {options?.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : kind === "textarea" ? (
        <textarea
          key={`${elements.map((e) => e.id).join()}-${id}-${String(value)}`}
          aria-label={title}
          defaultValue={String(value)}
          onBlur={(event) => {
            if (event.currentTarget.value !== String(value))
              editing.set(id, event.currentTarget.value as PropertyValue<K>);
          }}
        />
      ) : kind === "text" ? (
        <input
          key={`${elements.map((e) => e.id).join()}-${id}-${id === "content.text.fontFamily" ? "font" : String(value)}`}
          type="text"
          ref={inputRef}
          aria-label={title}
          defaultValue={String(value)}
          placeholder={resolved.state === "mixed" ? "Mixed" : undefined}
          onBlur={(event) => {
            if (event.currentTarget.value !== String(value))
              editing.set(id, event.currentTarget.value as PropertyValue<K>);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ) : (
        <input
          ref={inputRef}
          type={kind}
          aria-label={title}
          value={
            draft !== null
              ? draft
              : kind === "color"
                ? String(value || "#ffffff")
                : typeof value === "number"
                  ? Number(value.toFixed(precision))
                  : ""
          }
          placeholder={resolved.state === "mixed" ? "Mixed" : undefined}
          min={min}
          max={max}
          step={step}
          onFocus={(event) => {
            setDraft(event.currentTarget.value);
            void editing.begin(id);
          }}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            const next =
              kind === "number"
                ? clamp(Number(event.currentTarget.value))
                : event.currentTarget.value;
            if (event.currentTarget.value !== "")
              editing.preview(id, next as PropertyValue<K>, preserveScaleRatio);
          }}
          onBlur={() => {
            setDraft(null);
            editing.commit();
          }}
          onWheel={(event) => {
            if (
              kind !== "number" ||
              document.activeElement !== event.currentTarget
            )
              return;
            const next = clamp(
              Number(draft ?? value ?? 0) + (event.deltaY < 0 ? step : -step),
            );
            setDraft(String(next));
            editing.preview(id, next as PropertyValue<K>, preserveScaleRatio);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              editing.cancel();
              event.currentTarget.blur();
            } else if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}
export function PropertySection({
  title,
  children,
  collapsible = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  className?: string;
}) {
  if (collapsible)
    return (
      <section className={`km-section element-section ${className}`}>
        <details open>
          <summary>
            <h3>{title}</h3>
            <MaterialIcon name="chevron-down" />
          </summary>
          <div className="element-property-grid">{children}</div>
        </details>
      </section>
    );
  return (
    <section className="km-section element-section">
      <h3>{title}</h3>
      <div className="element-property-grid">{children}</div>
    </section>
  );
}
export function ElementPanel({
  elements,
  snapshot,
  editing,
  documentId,
  onIdentity,
  onReplace,
  onRule,
  onCenter,
  onReset,
  onEditFrame,
  onCrop,
  onTrim,
  onPreview,
  onError,
}: {
  elements: readonly Element[];
  snapshot: EditorSnapshot;
  editing: Editing;
  documentId: string;
  onIdentity(name: "name" | "cssClasses", value: string): void;
  onReplace(): void;
  onRule(id: string, rule: "fit" | "fill" | "free"): void;
  onCenter(id: string): void;
  onReset(id: string): void;
  onEditFrame(id: string): void;
  onCrop(id: string): void;
  onTrim(id: string): void;
  onPreview(id: string, command: "previous" | "play" | "next"): void;
  onError(error: unknown): void;
}) {
  const [mediaLocked, setMediaLocked] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const [scaleLinked, setScaleLinked] = useState(false);
  useEffect(() => {
    let live = true;
    setMediaLocked(false);
    void platform
      .packageMediaState?.(documentId)
      .then((state) => {
        if (live) setMediaLocked(state.locked);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [documentId, onError]);
  if (!elements.length)
    return (
      <p className="sidebar-empty">Select an Element to edit its properties.</p>
    );
  const one = elements.length === 1 ? elements[0] : null;
  const capabilities = elementCapabilities(elements, snapshot);
  const allText = capabilities.text,
    allMedia = capabilities.media,
    allVideo = capabilities.video;
  const title = one
    ? one.content?.type === "text"
      ? "Text"
      : one.content?.type === "video"
        ? "Video"
        : one.content
          ? "Image"
          : one.container
            ? "Frame"
            : one.geometry.type === "ellipse"
              ? "Ellipse"
              : "Rectangle"
    : `${elements.length} selected`;
  const resolvedElements = elements.map((e) =>
    e.content?.type === "text"
      ? {
          ...e,
          content: {
            ...e.content,
            format: {
              kind: "local" as const,
              typography: resolveTextTypography(snapshot.deck, e.content),
            },
          },
        }
      : e,
  );
  const control = <K extends ElementPropertyId>(
    id: K,
    props: Omit<
      Parameters<typeof PropertyControl<K>>[0],
      "id" | "elements" | "editing"
    > = {},
  ) => (
    <PropertyControl
      key={`${id}-${elements.map((e) => e.id).join("|")}`}
      id={id}
      elements={resolvedElements}
      editing={editing}
      {...props}
    />
  );
  const saveMedia = () => {
    if (one?.content && one.content.type !== "text")
      void platform
        .saveMediaAs?.(documentId, one.content.assetId)
        .catch(onError);
  };
  return (
    <div className="element-panel" aria-label="Element properties">
      {allText && (
        <>
          <PropertySection title="Style">
            <TextStyleControl
              key={elements
                .map(
                  (e) =>
                    e.id +
                    ":" +
                    (e.content?.type === "text" &&
                    e.content.format.kind === "style"
                      ? e.content.format.styleId
                      : "local"),
                )
                .join("|")}
              snapshot={snapshot}
              elements={elements}
              busy={styleBusy}
              onChange={(change) => {
                if (styleBusy) return;
                try {
                  const next = change(snapshot);
                  setStyleBusy(true);
                  void prepareTextStyleLayout(snapshot, next)
                    .then((operations) => {
                      editing.enqueue((current) =>
                        applyPreparedTextStyleLayout(current, operations),
                      );
                    })
                    .catch(onError)
                    .finally(() => setStyleBusy(false));
                } catch (error) {
                  onError(error);
                }
              }}
            />
          </PropertySection>
          <PropertySection title="Text">
            {control("content.text.fontFamily", {
              kind: "text",
              label: "Font family",
            })}
            {control("content.text.fontWeight", {
              kind: "select",
              label: "Font weight",
              options: [100, 200, 300, 400, 500, 600, 700, 800, 900],
            })}
            {control("content.text.fontSize", { min: 1 })}
            <div className="element-wide element-text-style-row">
              {control("content.text.color", { kind: "color" })}
              <div className="element-toggle-cluster element-text-format">
                {control("content.text.bold", { kind: "checkbox" })}
                {control("content.text.italic", { kind: "checkbox" })}
              </div>
            </div>
            {control("content.text.align", {
              kind: "segments",
              label: "Horizontal alignment",
              choices: [
                {
                  value: "left",
                  icon: "format-align-left",
                  label: "Align text left",
                },
                {
                  value: "center",
                  icon: "format-align-center",
                  label: "Align text center",
                },
                {
                  value: "right",
                  icon: "format-align-right",
                  label: "Align text right",
                },
              ],
            })}
            {control("content.text.verticalAlign", {
              kind: "segments",
              label: "Vertical alignment",
              choices: [
                {
                  value: "top",
                  icon: "format-vertical-align-top",
                  label: "Align text top",
                },
                {
                  value: "middle",
                  icon: "format-vertical-align-center",
                  label: "Align text middle",
                },
                {
                  value: "bottom",
                  icon: "format-vertical-align-bottom",
                  label: "Align text bottom",
                },
              ],
            })}
            {control("content.text.lineHeight", {
              min: 0.5,
              max: 5,
              step: 0.1,
            })}
            {control("content.text.letterSpacing", {
              min: -100,
              max: 500,
              step: 0.1,
            })}
            {control("content.text.autoSize", {
              kind: "segments",
              label: "Auto size",
              choices: [
                { value: "none", icon: "resize", label: "Fixed text size" },
                {
                  value: "height",
                  icon: "arrow-expand-vertical",
                  label: "Auto size height",
                },
                {
                  value: "both",
                  icon: "arrow-expand-all",
                  label: "Auto size width and height",
                },
              ],
            })}
            <div className="element-wide">
              {control("content.text.text", {
                kind: "textarea",
                label: "Text content",
              })}
            </div>
          </PropertySection>
        </>
      )}
      <PropertySection
        collapsible
        title="Transform"
        className="element-transform-section"
      >
        {control("transform.x", { label: "x" })}
        {control("transform.y", { label: "y" })}
        {control("transform.width", { min: 1, max: 100000, label: "width" })}
        {control("transform.height", { min: 1, max: 100000, label: "height" })}
        <div className="element-wide element-scale-heading">
          <span>Scale</span>
          <button
            type="button"
            className="element-format-toggle"
            aria-label="Link scale X and Y"
            title="Link scale X and Y (preserve proportions)"
            aria-pressed={scaleLinked}
            onClick={() => setScaleLinked((linked) => !linked)}
          >
            <MaterialIcon name="link" />
          </button>
        </div>
        <div className="element-wide element-scale-row">
          {control("transform.scaleX", {
            min: 0.000001,
            max: 10000,
            step: 0.01,
            precision: 6,
            preserveScaleRatio: scaleLinked,
          })}
          {control("transform.scaleY", {
            min: 0.000001,
            max: 10000,
            step: 0.01,
            precision: 6,
            preserveScaleRatio: scaleLinked,
          })}
        </div>
        {control("transform.rotation", { label: "rotation" })}
        <div className="element-wide element-flip-row">
          <span>Flip</span>
          <div className="element-icon-cluster">
            {control("transform.flipX", {
              kind: "checkbox",
              label: "Flip frame horizontal",
            })}
            {control("transform.flipY", {
              kind: "checkbox",
              label: "Flip frame vertical",
            })}
          </div>
        </div>
      </PropertySection>
      {allMedia && (
        <>
          <PropertySection collapsible title={allVideo ? "Video" : "Image"}>
            {one?.content && one.content.type !== "text" && (
              <div className="element-wide media-rule-actions">
                <span className="media-rule-label">Media fit</span>
                <div className="media-fit-segment">
                  {(["fit", "fill", "free"] as const).map((rule) => (
                    <button
                      type="button"
                      key={rule}
                      aria-label={rule[0].toUpperCase() + rule.slice(1)}
                      title={rule[0].toUpperCase() + rule.slice(1)}
                      aria-pressed={
                        !!one.content &&
                        one.content.type !== "text" &&
                        one.content.transform.rule === rule
                      }
                      onClick={() => onRule(one.id, rule)}
                    >
                      {rule[0].toUpperCase() + rule.slice(1)}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="Crop"
                    title="Crop"
                    onClick={() => onCrop(one.id)}
                  >
                    Crop
                  </button>
                </div>
                <div className="media-secondary-actions">
                  <button
                    type="button"
                    aria-label="Edit Content"
                    title="Edit Content"
                    onClick={() => onEditFrame(one.id)}
                  >
                    Edit Content
                  </button>
                  <button
                    type="button"
                    aria-label="Center"
                    title="Center"
                    onClick={() => onCenter(one.id)}
                  >
                    Center
                  </button>
                  <button
                    type="button"
                    aria-label="Reset"
                    title="Reset"
                    onClick={() => onReset(one.id)}
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}
            {control("content.media.rotation", {
              step: 1,
              label: "Media rotation degrees",
            })}
            <div className="element-wide element-flip-row">
              <span>Flip</span>
              <div className="element-icon-cluster">
                {control("content.media.flipX", { kind: "checkbox" })}
                {control("content.media.flipY", { kind: "checkbox" })}
              </div>
            </div>
            {control("content.media.zoom", {
              min: 0.001,
              max: 100,
              step: 0.05,
            })}
            <div className="element-wide media-anchor-row">
              <span>Anchor</span>
              <div className="media-anchor-fields">
                {control("content.media.anchorX", {
                  min: 0,
                  max: 1,
                  step: 0.01,
                })}
                {control("content.media.anchorY", {
                  min: 0,
                  max: 1,
                  step: 0.01,
                })}
              </div>
            </div>
            {allVideo && (
              <>
                {control("content.video.volume", {
                  min: 0,
                  max: 1,
                  step: 0.05,
                  label: "Video volume",
                })}
                <div className="element-wide element-toggle-cluster">
                  {control("content.video.mute", { kind: "checkbox" })}
                  {control("content.video.loop", { kind: "checkbox" })}
                  {control("content.video.autoplay", { kind: "checkbox" })}
                </div>
                {control("content.video.startTime", {
                  min: 0,
                  step: 0.1,
                  label: "Video start time",
                })}
                {control("content.video.endTime", {
                  min: 0.05,
                  step: 0.1,
                  label: "Video end time",
                })}
                {one && (
                  <div className="element-wide element-video-actions">
                    <button type="button" onClick={() => onTrim(one.id)}>
                      Trim Video
                    </button>
                    {(["previous", "play", "next"] as const).map((command) => (
                      <button
                        type="button"
                        key={command}
                        aria-label={
                          command === "play"
                            ? "Play or pause video"
                            : `${command} video`
                        }
                        title={
                          command === "play"
                            ? "Play / pause"
                            : `${command} video`
                        }
                        onClick={() => onPreview(one.id, command)}
                      >
                        <MaterialIcon
                          name={
                            command === "play"
                              ? "play-pause"
                              : command === "previous"
                                ? "skip-previous"
                                : "skip-next"
                          }
                        />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </PropertySection>
        </>
      )}
      <PropertySection collapsible title="Appearance">
        <div className="element-wide">
          {control("appearance.opacity", {
            min: 0,
            max: 1,
            step: 0.01,
            label: "opacity",
          })}
        </div>
        <div className="element-wide element-fill-row">
          {control("appearance.fill", { kind: "color" })}
          <button
            type="button"
            onClick={() => editing.set("appearance.fill", null)}
            className="element-no-fill"
            aria-label="No fill"
            title="No fill"
            aria-pressed={elements.every(
              (element) => element.appearance.fill === null,
            )}
          >
            <MaterialIcon name="format-color-fill" />
            <span>No fill</span>
          </button>
        </div>
        <div className="element-wide element-stroke-row">
          {control("appearance.strokeColor", { kind: "color" })}
          {control("appearance.strokeWidth", { min: 0 })}
        </div>
        {control("geometry.radius", { min: 0 })}
        {control("geometry.type", {
          kind: "segments",
          label: "Geometry",
          choices: [
            {
              value: "rect",
              icon: "rectangle-outline",
              label: "Rectangle geometry",
            },
            {
              value: "ellipse",
              icon: "ellipse-outline",
              label: "Ellipse geometry",
            },
          ],
        })}
      </PropertySection>
      <PropertySection
        collapsible
        title={
          one?.content && one.content.type !== "text" ? "File" : "Container"
        }
      >
        {one?.content && one.content.type !== "text" && (
          <ImageFileControls
            assetId={one.content.assetId}
            onReplace={onReplace}
            onSaveAs={saveMedia}
            canSaveMedia={!!platform.saveMediaAs && !mediaLocked}
          />
        )}
        {control("frame.container", { kind: "checkbox" })}
        {control("frame.clipChildren", { kind: "checkbox" })}
      </PropertySection>
      <PropertySection collapsible title="Name & CSS">
        <label className="element-wide element-identity-field">
          <span>Name</span>
          <input
            aria-label="Element name"
            key={`${elements.map((e) => e.id).join()}-${one?.name}`}
            defaultValue={one?.name ?? ""}
            placeholder={one ? title : "Mixed"}
            onBlur={(event) => {
              if (event.currentTarget.value !== (one?.name ?? ""))
                onIdentity("name", event.currentTarget.value);
            }}
          />
        </label>
        {one && (
          <div className="element-wide css-identity">
            <span className="css-identity-label">CSS ID</span>
            <code title={`showme-${one.id}`}>{`showme-${one.id}`}</code>
            <button
              type="button"
              aria-label="Copy CSS ID"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`[data-showme-id="showme-${one.id}"]`)
                  .catch(onError)
              }
            >
              <MaterialIcon name="content-copy" />
            </button>
          </div>
        )}
        <label className="element-wide element-identity-field">
          <span>CSS classes</span>
          <input
            aria-label="CSS classes"
            key={`classes-${elements.map((e) => e.id).join()}-${one?.cssClasses?.join()}`}
            defaultValue={one?.cssClasses?.join(" ") ?? ""}
            placeholder={one ? "class names" : "Mixed"}
            onBlur={(event) => {
              if (
                event.currentTarget.value !== (one?.cssClasses?.join(" ") ?? "")
              )
                onIdentity("cssClasses", event.currentTarget.value);
            }}
          />
        </label>
      </PropertySection>
    </div>
  );
}
