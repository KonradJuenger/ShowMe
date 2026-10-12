import {
  DEFAULT_TEXT_TYPOGRAPHY,
  patchTextFormat,
  resolveTextTypography,
  textTypographySchema,
  type TextTypography,
  type TextStyleSource,
} from "./textTypography";
import type { Point } from "./geometry";
import { stripEditorOperations } from "./editorChange";
import {
  insertElements,
  setElementContents,
  setElementFrames,
  type EditorSnapshot,
} from "./editorCommands";
import { contentSchema, MAX_ELEMENT_DIMENSION, type Element } from "./element";
import { findElement, resolveEditableScope, worldPointToScope } from "./scene";

export type TextContent = Extract<
  NonNullable<Element["content"]>,
  { type: "text" }
>;
export type TextElement = Element & { content: TextContent };
export type TextPatch = Partial<Omit<TextContent, "type">> &
  Partial<TextTypography>;
export type TextMeasurement = { width: number; height: number };
// Auto-size may grow beyond the canvas, up to the canonical frame resource limit.
export const TEXT_AUTO_SIZE_PADDING = 4;
export const TEXT_MEASUREMENT_LIMIT =
  MAX_ELEMENT_DIMENSION - TEXT_AUTO_SIZE_PADDING;
export type TextMeasure = (
  element: Element & { content: TextContent },
) => TextMeasurement | null;

export const TEXT_PLACEHOLDER = "Lorem ipsum dolor sit amet ";
export const TEXT_SIZE = { width: 800, height: 180 } as const;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function isTextContent(
  content: Element["content"],
): content is TextContent {
  return content?.type === "text";
}

export function isTextElement(
  element: Element | null | undefined,
): element is TextElement {
  return !!element && isTextContent(element.content);
}

export function createTextElement(
  id: string,
  origin: Point = { x: 160, y: 160 },
): Element {
  return {
    id,
    frame: {
      scaleX: 1,
      scaleY: 1,
      originX: 0.5,
      originY: 0.5,
      x: origin.x,
      y: origin.y,
      width: TEXT_SIZE.width,
      height: TEXT_SIZE.height,
      rotation: 0,
      flipX: false,
      flipY: false,
    },
    geometry: { type: "rect" },
    appearance: {
      opacity: 1,
      fill: null,
      strokeColor: "#000000",
      strokeWidth: 0,
      radius: 0,
    },
    content: {
      type: "text",
      text: TEXT_PLACEHOLDER,
      placeholder: true,
      format: { kind: "local", typography: { ...DEFAULT_TEXT_TYPOGRAPHY } },
      autoSize: "both",
    },
    container: false,
    clipChildren: false,
    children: [],
  };
}

export function patchTextContent(
  content: TextContent,
  patch: TextPatch,
  source?: TextStyleSource,
): TextContent {
  const typography = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in textTypographySchema.shape),
  );
  const local = Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => !(key in textTypographySchema.shape),
    ),
  );
  const next = {
    ...content,
    ...local,
    format:
      patch.format ??
      (Object.keys(typography).length
        ? patchTextFormat(source, content.format, typography)
        : content.format),
    type: "text" as const,
  };
  if (
    Object.prototype.hasOwnProperty.call(patch, "text") &&
    !Object.prototype.hasOwnProperty.call(patch, "placeholder")
  )
    next.placeholder = false;
  return contentSchema.parse(next) as TextContent;
}

export function resolveTextAutoSizeFrame(
  element: Element & { content: TextContent },
  measured: TextMeasurement,
): Element["frame"] {
  const mode = element.content.autoSize;
  if (mode === "none") return { ...element.frame };
  return {
    ...element.frame,
    width:
      mode === "both"
        ? clamp(
            Math.ceil(measured.width) + TEXT_AUTO_SIZE_PADDING,
            20,
            MAX_ELEMENT_DIMENSION,
          )
        : element.frame.width,
    height: clamp(
      Math.ceil(measured.height) + TEXT_AUTO_SIZE_PADDING,
      20,
      MAX_ELEMENT_DIMENSION,
    ),
  };
}

function sameTextContent(left: TextContent, right: TextContent) {
  return (
    left.text === right.text &&
    left.placeholder === right.placeholder &&
    JSON.stringify(left.format) === JSON.stringify(right.format) &&
    left.autoSize === right.autoSize
  );
}

function sameFrame(left: Element["frame"], right: Element["frame"]) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.flipX === right.flipX &&
    left.flipY === right.flipY
  );
}

export function updateText(
  snapshot: EditorSnapshot,
  elementId: string,
  patch: TextPatch,
  measure?: TextMeasure,
): EditorSnapshot {
  const element = findElement(snapshot.slide, elementId);
  if (!isTextElement(element))
    throw new Error("Selected Element has no text content");

  const content = patchTextContent(element.content, patch, snapshot.deck);
  const candidate: TextElement = { ...element, content };
  const next = sameTextContent(element.content, content)
    ? snapshot
    : setElementContents(snapshot, [{ elementId, value: content }]);
  if (content.autoSize === "none" || !measure) return next;

  const measured = measure({
    ...candidate,
    content: {
      ...content,
      format: {
        kind: "local",
        typography: resolveTextTypography(snapshot.deck, content),
      },
    },
  });
  if (!measured) return next;
  const frame = resolveTextAutoSizeFrame(candidate, measured);
  if (sameFrame(element.frame, frame)) return next;
  return setElementFrames(next, [{ elementId, value: frame }]);
}

export function updateTextDraft(
  snapshot: EditorSnapshot,
  elementId: string,
  patch: TextPatch,
  measure?: TextMeasure,
) {
  return updateText(stripEditorOperations(snapshot), elementId, patch, measure);
}

export function insertText(
  snapshot: EditorSnapshot,
  requestedScopeId: string | null,
  worldCenter: Point,
  id: string,
) {
  const scopeId = resolveEditableScope(
    snapshot.slide,
    snapshot.deck,
    requestedScopeId,
  );
  const center = worldPointToScope(snapshot.slide, scopeId, worldCenter);
  const element = createTextElement(id, {
    x: center.x - TEXT_SIZE.width / 2,
    y: center.y - TEXT_SIZE.height / 2,
  });
  return {
    snapshot: insertElements(snapshot, [element], scopeId),
    scopeId,
    elementId: id,
  };
}
