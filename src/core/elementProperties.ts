import { patchTextContent } from "./text";
import {
  resolveTextTypography,
  type TextTypography,
  type TextStyleSource,
} from "./textTypography";
import { contentSchema, geometrySchema, type Element } from "./element";
import {
  setElementAppearances,
  setElementContainerStates,
  setElementContents,
  setElementFrames,
  setElementGeometries,
  type EditorSnapshot,
} from "./editorCommands";
import { clampVideoTrim } from "./video";
import { convertMediaRule } from "./media";
import { findElement, isEditableScope } from "./scene";
import { updateTextWithLayout } from "../components/editor/textLayout";

import {
  unavailable,
  property,
  appearance,
  elementTransformProperties,
  type ElementProperty,
  type SelectionPropertyValue,
} from "./elementPropertyDescriptors";
export {
  unavailable,
  type ElementProperty,
  type SelectionPropertyValue,
} from "./elementPropertyDescriptors";
type TextContent = Extract<NonNullable<Element["content"]>, { type: "text" }>;
function text<
  K extends keyof Omit<TextContent, "type" | "format"> | keyof TextTypography,
>(
  key: K,
  label: string,
  interpolation: "number" | "color" | "discrete" = "number",
) {
  return property<(TextContent & TextTypography)[K]>(
    label,
    "content",
    (e, source) =>
      e.content?.type === "text"
        ? ((key in e.content
            ? e.content[key as keyof TextContent]
            : resolveTextTypography(source, e.content)[
                key as keyof TextTypography
              ]) as (TextContent & TextTypography)[K])
        : unavailable,
    (e, value: (TextContent & TextTypography)[K], source) =>
      e.content?.type === "text"
        ? {
            ...e,
            content: patchTextContent(
              e.content,
              {
                [key]: value,
                ...(key === "bold"
                  ? { fontWeight: value ? 700 : 400 }
                  : key === "fontWeight"
                    ? { bold: Number(value) >= 600 }
                    : {}),
              },
              source,
            ),
          }
        : e,
    interpolation,
  );
}
type Video = Extract<NonNullable<Element["content"]>, { type: "video" }>;
function video<
  K extends "volume" | "mute" | "loop" | "autoplay" | "startTime" | "endTime",
>(key: K, label: string) {
  return property(
    label,
    "content",
    (e) => (e.content?.type === "video" ? e.content[key] : unavailable),
    (e, value: Video[K]) =>
      e.content?.type === "video"
        ? {
            ...e,
            content: contentSchema.parse({
              ...e.content,
              [key]: value,
              ...(key === "startTime" || key === "endTime"
                ? clampVideoTrim(
                    key === "startTime" ? Number(value) : e.content.startTime,
                    key === "endTime"
                      ? (value as number | null)
                      : e.content.endTime,
                    Infinity,
                  )
                : {}),
            }),
          }
        : e,
    key === "volume" || key.endsWith("Time") ? "number" : "discrete",
  );
}
function media(
  key: "rotation" | "zoom" | "anchorX" | "anchorY",
  label: string,
) {
  return property<number>(
    label,
    "content",
    (e) => {
      if (!e.content || e.content.type === "text") return unavailable;
      const t = e.content.transform;
      if (t.rule === "free")
        return key === "rotation"
          ? t.local.rotation
          : key === "zoom"
            ? Math.sqrt(t.local.scaleX * t.local.scaleY)
            : unavailable;
      return key === "zoom"
        ? t.rule === "fill"
          ? t.zoom
          : unavailable
        : t[key];
    },
    (e, value) => {
      if (!e.content || e.content.type === "text") return e;
      const t = e.content.transform;
      const transform =
        t.rule === "free"
          ? {
              ...t,
              local:
                key === "zoom"
                  ? {
                      ...t.local,
                      scaleX:
                        (t.local.scaleX * value) /
                        Math.sqrt(t.local.scaleX * t.local.scaleY),
                      scaleY:
                        (t.local.scaleY * value) /
                        Math.sqrt(t.local.scaleX * t.local.scaleY),
                    }
                  : { ...t.local, rotation: value },
            }
          : { ...t, [key]: value };
      return {
        ...e,
        content: contentSchema.parse({ ...e.content, transform }),
      };
    },
  );
}
function mediaFlip(key: "flipX" | "flipY", label: string) {
  return property<boolean>(
    label,
    "content",
    (e) => {
      if (!e.content || e.content.type === "text") return unavailable;
      return e.content.transform.rule === "free"
        ? e.content.transform.local[key]
        : e.content.transform[key];
    },
    (e, value) => {
      if (!e.content || e.content.type === "text") return e;
      const t = e.content.transform;
      return {
        ...e,
        content: contentSchema.parse({
          ...e.content,
          transform:
            t.rule === "free"
              ? { ...t, local: { ...t.local, [key]: value } }
              : { ...t, [key]: value },
        }),
      };
    },
    "discrete",
  );
}
export const elementProperties = {
  ...elementTransformProperties,
  "appearance.fill": appearance("fill", "Fill", "color"),
  "appearance.strokeColor": appearance("strokeColor", "Stroke", "color"),
  "appearance.strokeWidth": appearance("strokeWidth", "Stroke width"),
  "geometry.radius": appearance("radius", "Radius"),
  "geometry.type": property<Element["geometry"]["type"]>(
    "Geometry",
    "geometry",
    (e) => e.geometry.type,
    (e, value) => ({ ...e, geometry: geometrySchema.parse({ type: value }) }),
    "discrete",
  ),
  "frame.clipChildren": property(
    "Clip content and children",
    "container",
    (e) => e.clipChildren,
    (e, value: boolean) => ({ ...e, clipChildren: value }),
    "discrete",
  ),
  "frame.container": property(
    "Container",
    "container",
    (e) => e.container,
    (e, value: boolean) => {
      if (!value && e.children.length)
        throw new Error("A container with children cannot be disabled");
      return { ...e, container: value };
    },
    "discrete",
  ),
  "content.text.text": text("text", "Text", "discrete"),
  "content.text.fontFamily": text("fontFamily", "Font", "discrete"),
  "content.text.fontWeight": text("fontWeight", "Weight", "discrete"),
  "content.text.fontSize": text("fontSize", "Font size"),
  "content.text.bold": text("bold", "Bold", "discrete"),
  "content.text.italic": text("italic", "Italic", "discrete"),
  "content.text.color": text("color", "Text color", "color"),
  "content.text.align": text("align", "Alignment", "discrete"),
  "content.text.verticalAlign": text(
    "verticalAlign",
    "Vertical alignment",
    "discrete",
  ),
  "content.text.lineHeight": text("lineHeight", "Line height"),
  "content.text.letterSpacing": text("letterSpacing", "Letter spacing"),
  "content.text.autoSize": text("autoSize", "Auto size", "discrete"),
  "content.media.rule": property<"fit" | "fill" | "free">(
    "Framing",
    "content",
    (e) =>
      e.content && e.content.type !== "text"
        ? e.content.transform.rule
        : unavailable,
    (e, value) => ({ ...e, content: convertMediaRule(e, value) }),
    "discrete",
  ),
  "content.media.rotation": media("rotation", "Content rotation"),
  "content.media.flipX": mediaFlip("flipX", "Flip content horizontal"),
  "content.media.flipY": mediaFlip("flipY", "Flip content vertical"),
  "content.media.zoom": media("zoom", "Zoom"),
  "content.media.anchorX": media("anchorX", "Anchor X"),
  "content.media.anchorY": media("anchorY", "Anchor Y"),
  "content.video.volume": video("volume", "Volume"),
  "content.video.mute": video("mute", "Mute"),
  "content.video.loop": video("loop", "Loop"),
  "content.video.autoplay": video("autoplay", "Autoplay"),
  "content.video.startTime": video("startTime", "Start time"),
  "content.video.endTime": video("endTime", "End time"),
};
export type ElementPropertyId = keyof typeof elementProperties;
export type PropertyValue<K extends ElementPropertyId> = Exclude<
  ReturnType<(typeof elementProperties)[K]["read"]>,
  typeof unavailable
>;
export function getProperty<K extends ElementPropertyId>(
  id: K,
): ElementProperty<PropertyValue<K>> {
  return elementProperties[id] as ElementProperty<PropertyValue<K>>;
}
export function selectionProperty<K extends ElementPropertyId>(
  elements: readonly Element[],
  id: K,
  source?: TextStyleSource,
): SelectionPropertyValue<PropertyValue<K>> {
  if (!elements.length) return { state: "unavailable" };
  const values = elements.map((e) => getProperty(id).read(e, source));
  if (values.some((v) => v === unavailable)) return { state: "unavailable" };
  return values.every((v) => Object.is(v, values[0]))
    ? { state: "value", value: values[0] as PropertyValue<K> }
    : { state: "mixed" };
}
export function setSelectionProperty<K extends ElementPropertyId>(
  snapshot: EditorSnapshot,
  ids: readonly string[],
  id: K,
  value: PropertyValue<K>,
  preserveScaleRatio = false,
): EditorSnapshot {
  const descriptor = getProperty(id);
  const elements = ids.map((elementId) =>
    findElement(snapshot.slide, elementId),
  );
  if (
    elements.some(
      (e) => !e || !isEditableScope(snapshot.slide, snapshot.deck, e.id),
    )
  )
    throw new Error("Selection is not editable");
  const selected = elements as Element[];
  if (selectionProperty(selected, id, snapshot.deck).state === "unavailable")
    throw new Error("Property is unavailable for this selection");
  if (id.startsWith("content.text.")) {
    const key = id.slice("content.text.".length);
    return selected.reduce((next, e) => {
      const patch = {
        [key]: value,
        ...(key === "bold"
          ? { fontWeight: value ? 700 : 400 }
          : key === "fontWeight"
            ? { bold: Number(value) >= 600 }
            : {}),
      };
      return updateTextWithLayout(next, e.id, patch);
    }, snapshot);
  }
  const edited = selected.map((e) => {
    if (
      preserveScaleRatio &&
      (id === "transform.scaleX" || id === "transform.scaleY")
    ) {
      const axis = id === "transform.scaleX" ? "scaleX" : "scaleY";
      const other = axis === "scaleX" ? "scaleY" : "scaleX";
      const ratio = e.frame[other] / e.frame[axis];
      const scale = Math.min(Number(value), 10000, 10000 / ratio);
      const next = descriptor.write(e, scale as PropertyValue<K>);
      return getProperty(
        other === "scaleX" ? "transform.scaleX" : "transform.scaleY",
      ).write(next, scale * ratio);
    }
    return descriptor.write(e, value);
  });
  switch (descriptor.block) {
    case "effects":
      throw new Error("Effect parameters require the effect instance command");
    case "frame": {
      const framed = setElementFrames(
        snapshot,
        edited.map((e) => ({ elementId: e.id, value: e.frame })),
      );
      if (id !== "transform.width" && id !== "transform.height") return framed;
      // Free content has an explicit local rectangle; resize it with the element.
      // Fit and Fill already resolve against the new frame dimensions.
      return setElementContents(
        framed,
        selected.flatMap<{ elementId: string; value: Element["content"] }>(
          (before, index) => {
            const content = before.content;
            if (content?.type === "text")
              return content.autoSize !== "none" &&
                (before.frame.width !== edited[index].frame.width ||
                  before.frame.height !== edited[index].frame.height)
                ? [
                    {
                      elementId: before.id,
                      value: { ...content, autoSize: "none" as const },
                    },
                  ]
                : [];
            if (!content || content.transform.rule !== "free") return [];
            const sx = edited[index].frame.width / before.frame.width;
            const sy = edited[index].frame.height / before.frame.height;
            const local = content.transform.local;
            return [
              {
                elementId: before.id,
                value: {
                  ...content,
                  transform: {
                    rule: "free" as const,
                    local: {
                      ...local,
                      x: local.x * sx,
                      y: local.y * sy,
                      width: local.width * sx,
                      height: local.height * sy,
                    },
                  },
                },
              },
            ];
          },
        ),
      );
    }
    case "appearance":
      return setElementAppearances(
        snapshot,
        edited.map((e) => ({ elementId: e.id, value: e.appearance })),
      );
    case "geometry":
      return setElementGeometries(
        snapshot,
        edited.map((e) => ({ elementId: e.id, value: e.geometry })),
      );
    case "content":
      return setElementContents(
        snapshot,
        edited.map((e) => ({ elementId: e.id, value: e.content })),
      );
    case "container":
      return setElementContainerStates(
        snapshot,
        edited.map((e) => ({
          elementId: e.id,
          value: { container: e.container, clipChildren: e.clipChildren },
        })),
      );
  }
}
