import type { TextElement } from "../../core/text";
import { resolveTextTypography } from "../../core/textTypography";
import { textMeasurementStyle } from "../../components/editor/textLayout";

export interface OutlineLine {
  text: string;
  x: number;
  baseline: number;
  width: number;
}
export interface OutlineLayout {
  lines: OutlineLine[];
}
export interface OutlineLayoutRequest {
  element: TextElement;
  fontId: string;
  fontData: string;
}

const installed = new Set<string>();

/** Export preparation on the existing native preview surface, using editor text styles. */
export async function layoutHtmlExportText({
  element,
  fontId,
  fontData,
}: OutlineLayoutRequest): Promise<OutlineLayout> {
  const family = "showme-outline-" + fontId;
  const content = element.content;
  const typography = resolveTextTypography(undefined, content);
  if (!installed.has(family)) {
    const bytes = Uint8Array.from(atob(fontData), (character) =>
      character.charCodeAt(0),
    );
    const face = new FontFace(family, bytes.buffer, {
      weight: String(
        typography.bold
          ? Math.max(700, typography.fontWeight)
          : typography.fontWeight,
      ),
      style: typography.italic ? "italic" : "normal",
    });
    await face.load();
    document.fonts.add(face);
    installed.add(family);
  }
  const probe = document.createElement("div");
  const style = textMeasurementStyle(element);
  Object.assign(probe.style, style, {
    left: "0px",
    top: "0px",
    fontFamily: family,
    fontSize: `${typography.fontSize}px`,
    lineHeight: String(typography.lineHeight),
    letterSpacing: `${typography.letterSpacing}px`,
    width: `${element.frame.width}px`,
    maxWidth: "none",
    maxHeight: "none",
    textAlign: typography.align,
  });
  const text = content.text.replace(/\r\n?/g, "\n");
  probe.textContent = text;
  document.body.append(probe);
  try {
    const node = probe.firstChild!;
    const range = document.createRange();
    const rows: Array<{ text: string; x: number }> = [];
    const left = probe.getBoundingClientRect().left;
    let offset = 0;
    for (const paragraph of text.split("\n")) {
      let row = "",
        x = 0,
        top: number | undefined;
      for (const { segment, index } of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      }).segment(paragraph)) {
        range.setStart(node, offset + index);
        range.setEnd(node, offset + index + segment.length);
        const rect = range.getBoundingClientRect(),
          y = rect.top;
        if (top !== undefined && Math.abs(top - y) > 0.5) {
          rows.push({ text: row, x });
          row = "";
        }
        if (!row) x = rect.left - left;
        top = y;
        row += segment;
      }
      rows.push({ text: row, x });
      offset += paragraph.length + 1;
    }
    probe.replaceChildren();
    const items = rows.map(({ text, x }) => {
      const line = document.createElement("div"),
        span = document.createElement("span"),
        baseline = document.createElement("span");
      line.style.whiteSpace = "pre";
      line.style.height = `${typography.fontSize * typography.lineHeight}px`;
      span.textContent = text;
      Object.assign(baseline.style, {
        display: "inline-block",
        width: "0px",
        height: "0px",
      });
      line.append(span, baseline);
      probe.append(line);
      return { text, x, span, baseline };
    });
    const origin = probe.getBoundingClientRect();
    const vertical =
      (element.frame.height - origin.height) *
      (typography.verticalAlign === "middle"
        ? 0.5
        : typography.verticalAlign === "bottom"
          ? 1
          : 0);
    return {
      lines: items.map(({ text, x, span, baseline }) => ({
        text,
        x,
        width: span.getBoundingClientRect().width,
        baseline: baseline.getBoundingClientRect().top - origin.top + vertical,
      })),
    };
  } finally {
    probe.remove();
  }
}
