import type { TextElement } from "../../core/text";
import { resolveTextTypography } from "../../core/textTypography";
import { runFontWeight } from "../../core/textRuns";
import { textMeasurementStyle } from "../../components/editor/textLayout";

export interface OutlineLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
  fontId: string;
}
export interface OutlineLayout {
  lines: OutlineLine[];
}
export interface OutlineFont {
  fontId: string;
  fontData: string;
  weight: number;
  italic: boolean;
}
export interface OutlineLayoutRequest {
  element: TextElement;
  fonts: OutlineFont[];
}
const installed = new Set<string>();

/** Chromium owns wrapping and fragment positions; outline shaping is verified against it. */
export async function layoutHtmlExportText({
  element,
  fonts,
}: OutlineLayoutRequest): Promise<OutlineLayout> {
  const typography = resolveTextTypography(undefined, element.content);
  for (const font of fonts) {
    const family = "showme-outline-" + font.fontId;
    if (installed.has(family)) continue;
    const bytes = Uint8Array.from(atob(font.fontData), (character) =>
      character.charCodeAt(0),
    );
    const face = new FontFace(family, bytes.buffer, {
      weight: String(font.weight),
      style: font.italic ? "italic" : "normal",
    });
    await face.load();
    document.fonts.add(face);
    installed.add(family);
  }
  const probe = document.createElement("div");
  Object.assign(probe.style, textMeasurementStyle(element), {
    left: "0px",
    top: "0px",
    fontSize: typography.fontSize + "px",
    lineHeight: String(typography.lineHeight),
    letterSpacing: typography.letterSpacing + "px",
    width: element.frame.width + "px",
    maxWidth: "none",
    maxHeight: "none",
    textAlign: typography.align,
  });
  const nodes = element.content.runs.map((run) => {
    const font = fonts.find(
      (font) => font.weight === runFontWeight(run, typography),
    )!;
    const span = document.createElement("span");
    span.style.fontFamily = "showme-outline-" + font.fontId;
    span.style.fontWeight = String(font.weight);
    const node = document.createTextNode(run.text);
    span.append(node);
    probe.append(span);
    return { node, font };
  });
  document.body.append(probe);
  try {
    const left = probe.getBoundingClientRect().left,
      range = document.createRange();
    const rows: Array<Array<{ text: string; x: number; font: OutlineFont }>> = [
      [],
    ];
    let top: number | undefined;
    for (const { node, font } of nodes) {
      for (const { segment, index } of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(node.data)) {
        if (segment === "\n") {
          rows.push([]);
          top = undefined;
          continue;
        }
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rect = range.getBoundingClientRect();
        if (top !== undefined && Math.abs(top - rect.top) > 0.5) rows.push([]);
        const row = rows.at(-1)!,
          previous = row.at(-1);
        if (previous?.font.fontId === font.fontId) previous.text += segment;
        else row.push({ text: segment, x: rect.left - left, font });
        top = rect.top;
      }
    }
    probe.replaceChildren();
    const fragments: Array<{
      text: string;
      x: number;
      span: HTMLSpanElement;
      baseline: HTMLSpanElement;
      fontId: string;
    }> = [];
    for (const row of rows) {
      const line = document.createElement("div"),
        baseline = document.createElement("span");
      line.style.whiteSpace = "pre";
      line.style.height = typography.fontSize * typography.lineHeight + "px";
      for (const fragment of row) {
        const span = document.createElement("span");
        span.style.fontFamily = "showme-outline-" + fragment.font.fontId;
        span.style.fontWeight = String(fragment.font.weight);
        span.textContent = fragment.text;
        line.append(span);
        fragments.push({
          text: fragment.text,
          x: fragment.x,
          span,
          baseline,
          fontId: fragment.font.fontId,
        });
      }
      Object.assign(baseline.style, {
        display: "inline-block",
        width: "0px",
        height: "0px",
      });
      line.append(baseline);
      probe.append(line);
    }
    const origin = probe.getBoundingClientRect();
    const vertical =
      (element.frame.height - origin.height) *
      (typography.verticalAlign === "middle"
        ? 0.5
        : typography.verticalAlign === "bottom"
          ? 1
          : 0);
    return {
      lines: fragments.map((fragment) => ({
        text: fragment.text,
        x: fragment.x,
        fontId: fragment.fontId,
        width: fragment.span.getBoundingClientRect().width,
        baseline:
          fragment.baseline.getBoundingClientRect().top - origin.top + vertical,
      })),
    };
  } finally {
    probe.remove();
  }
}
