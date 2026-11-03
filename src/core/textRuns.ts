import { z } from "zod";
import type { TextTypography } from "./textTypography";

export const textRunSchema = z
  .object({
    text: z.string().max(100000),
    fontWeight: z.number().int().min(100).max(900).optional(),
  })
  .strict();
export type TextRun = z.infer<typeof textRunSchema>;

export function normalizeTextRuns(runs: readonly TextRun[]): TextRun[] {
  const result: TextRun[] = [];
  for (const run of runs) {
    const text = run.text.replace(/\r\n?/g, "\n");
    if (!text) continue;
    const previous = result.at(-1);
    if (previous && previous.fontWeight === run.fontWeight)
      previous.text += text;
    else
      result.push(
        run.fontWeight === undefined
          ? { text }
          : { text, fontWeight: run.fontWeight },
      );
  }
  return result;
}

export const textRunsSchema = z
  .array(textRunSchema)
  .max(100000)
  .superRefine((runs, context) => {
    if (runs.reduce((length, run) => length + run.text.length, 0) > 100000)
      context.addIssue({ code: "custom", message: "Text exceeds size limit" });
    const normalized = normalizeTextRuns(runs);
    if (
      runs.length !== normalized.length ||
      runs.some(
        (run, index) =>
          run.text !== normalized[index]?.text ||
          run.fontWeight !== normalized[index]?.fontWeight,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Text runs must be normalized",
      });
  });

export const plainText = (content: { runs: readonly TextRun[] }) =>
  content.runs.map((run) => run.text).join("");
export const textRuns = (text: string): TextRun[] =>
  normalizeTextRuns([{ text }]);
export const boxFontWeight = (
  type: Pick<TextTypography, "bold" | "fontWeight">,
) => (type.bold ? Math.max(700, type.fontWeight) : type.fontWeight);
export const runFontWeight = (
  run: TextRun,
  type: Pick<TextTypography, "bold" | "fontWeight">,
) => run.fontWeight ?? boxFontWeight(type);

/** DOM offsets are UTF-16; semantic edits never bisect a visible grapheme. */
export function textSelection(
  runs: readonly TextRun[],
  start: number,
  end: number,
) {
  const text = plainText({ runs });
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > text.length
  )
    throw new Error("Invalid text selection");
  const boundaries = [
    0,
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (item) => item.index + item.segment.length,
    ),
  ];
  const from = [...boundaries].reverse().find((offset) => offset <= start) ?? 0;
  return {
    start: from,
    end:
      start === end
        ? from
        : (boundaries.find((offset) => offset >= end) ?? text.length),
  };
}

export function sliceTextRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
): TextRun[] {
  let offset = 0;
  return normalizeTextRuns(
    runs.flatMap((run) => {
      const from = Math.max(0, start - offset),
        to = Math.min(run.text.length, end - offset);
      offset += run.text.length;
      return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
    }),
  );
}

export function replaceTextRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
  insertion: readonly TextRun[],
): TextRun[] {
  ({ start, end } = textSelection(runs, start, end));
  const length = plainText({ runs }).length;
  return normalizeTextRuns([
    ...sliceTextRuns(runs, 0, start),
    ...insertion,
    ...sliceTextRuns(runs, end, length),
  ]);
}

export function formatTextRuns(
  runs: readonly TextRun[],
  start: number,
  end: number,
  fontWeight: number,
): TextRun[] {
  ({ start, end } = textSelection(runs, start, end));
  return replaceTextRuns(
    runs,
    start,
    end,
    sliceTextRuns(runs, start, end).map((run) => ({ ...run, fontWeight })),
  );
}

/** Weight for insertion follows the preceding character, or the first run at the start. */
export function typingFontWeight(
  runs: readonly TextRun[],
  offset: number,
): number | undefined {
  let position = 0;
  for (const run of runs) {
    position += run.text.length;
    if (offset <= position) return run.fontWeight;
  }
  return undefined;
}

/** String Effects retain formatting for unchanged text and prefix/suffix reveals.
 * Arbitrary generated replacement text inherits the box format.
 */
export function effectTextRuns(
  runs: readonly TextRun[],
  text: string,
): TextRun[] {
  const source = plainText({ runs });
  if (source.startsWith(text)) return sliceTextRuns(runs, 0, text.length);
  if (source.endsWith(text))
    return sliceTextRuns(runs, source.length - text.length, source.length);
  return textRuns(text);
}
