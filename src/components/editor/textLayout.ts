import { resolveTextTypography } from "../../core/textTypography";
import type { CSSProperties } from "react";
import type { EditorSnapshot } from "../../core/editorCommands";
import type { Element } from "../../core/element";
import {
  isTextContent,
  updateText,
  updateTextDraft,
  TEXT_MEASUREMENT_LIMIT,
  type TextContent,
  type TextPatch,
} from "../../core/text";

let textMeasurementProbe: HTMLDivElement | null = null;

export function textMeasurementStyle(
  element: Element & { content: TextContent },
  source?: import("../../core/textTypography").TextStyleSource,
): CSSProperties {
  const content = {
    ...element.content,
    ...resolveTextTypography(source, element.content),
  };
  return {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    left: -10000,
    top: -10000,
    fontSize: content.fontSize,
    fontFamily: content.fontFamily,
    fontWeight: content.bold
      ? Math.max(700, content.fontWeight)
      : content.fontWeight,
    fontStyle: content.italic ? "italic" : "normal",
    lineHeight: content.lineHeight,
    letterSpacing: content.letterSpacing,
    whiteSpace: content.autoSize === "both" ? "pre" : "pre-wrap",
    overflowWrap: content.autoSize === "both" ? "normal" : "anywhere",
    width: content.autoSize === "both" ? "max-content" : element.frame.width,
    maxWidth: content.autoSize === "both" ? TEXT_MEASUREMENT_LIMIT : "none",
    maxHeight: TEXT_MEASUREMENT_LIMIT,
  };
}

export function measureText(
  element: Element & { content: TextContent },
  source?: import("../../core/textTypography").TextStyleSource,
) {
  if (typeof document === "undefined") return null;
  const probe = textMeasurementProbe ?? document.createElement("div");
  if (!probe.isConnected) {
    document.body.appendChild(probe);
    textMeasurementProbe = probe;
  }
  const content = {
    ...element.content,
    ...resolveTextTypography(source, element.content),
  };
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.left = "-10000px";
  probe.style.top = "-10000px";
  probe.style.fontSize = `${content.fontSize}px`;
  probe.style.fontFamily = content.fontFamily;
  probe.style.fontWeight = String(
    content.bold ? Math.max(700, content.fontWeight) : content.fontWeight,
  );
  probe.style.fontStyle = content.italic ? "italic" : "normal";
  probe.style.lineHeight = String(content.lineHeight);
  probe.style.letterSpacing = `${content.letterSpacing}px`;
  probe.style.whiteSpace = content.autoSize === "both" ? "pre" : "pre-wrap";
  probe.style.overflowWrap =
    content.autoSize === "both" ? "normal" : "anywhere";
  probe.style.width =
    content.autoSize === "both" ? "max-content" : `${element.frame.width}px`;
  probe.style.maxWidth =
    content.autoSize === "both" ? `${TEXT_MEASUREMENT_LIMIT}px` : "none";
  probe.style.maxHeight = `${TEXT_MEASUREMENT_LIMIT}px`;
  probe.textContent = content.text || " ";
  const rect = probe.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

const measure = (element: Element & { content: TextContent }) =>
  isTextContent(element.content) ? measureText(element) : null;

export function updateTextWithLayout(
  snapshot: EditorSnapshot,
  elementId: string,
  patch: TextPatch,
) {
  return updateText(snapshot, elementId, patch, measure);
}

export function updateTextDraftWithLayout(
  snapshot: EditorSnapshot,
  elementId: string,
  patch: TextPatch,
) {
  return updateTextDraft(snapshot, elementId, patch, measure);
}
