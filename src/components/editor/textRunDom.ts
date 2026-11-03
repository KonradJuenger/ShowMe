import { normalizeTextRuns, type TextRun } from "../../core/textRuns";

/** Shared native inline layout for display, editing and measurement. */
export function writeTextRunDom(
  host: HTMLElement,
  runs: readonly TextRun[],
  editing = false,
) {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    if (run.fontWeight === undefined)
      fragment.append(document.createTextNode(run.text));
    else {
      const span = document.createElement("span");
      span.dataset.textWeight = String(run.fontWeight);
      span.style.fontWeight = String(run.fontWeight);
      span.textContent = run.text;
      fragment.append(span);
    }
  }
  if (editing && (!runs.length || runs.at(-1)?.text.endsWith("\n"))) {
    const terminal = document.createElement("br");
    terminal.dataset.textTerminal = "true";
    fragment.append(terminal);
  }
  host.replaceChildren(fragment);
}

function inspect(host: HTMLElement) {
  const runs: TextRun[] = [];
  const points = new Map<Node, number[]>();
  let offset = 0;
  const append = (text: string, fontWeight?: number) => {
    if (!text) return;
    runs.push(fontWeight === undefined ? { text } : { text, fontWeight });
    offset += text.length;
  };
  const visit = (node: Node, inherited?: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      points.set(
        node,
        Array.from({ length: text.length + 1 }, (_, index) => offset + index),
      );
      append(text, inherited);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    // The editing host's weight is the box default, not an authored run override.
    const numeric = Number(
      node === host
        ? undefined
        : (node.dataset.textWeight ?? node.style.fontWeight),
    );
    const weight = numeric >= 100 && numeric <= 900 ? numeric : inherited;
    const positions: number[] = [offset];
    points.set(node, positions);
    if (node.tagName === "BR") {
      if (
        !node.dataset.textTerminal &&
        !(node.parentNode === host && host.childNodes.length === 1)
      )
        append("\n", weight);
      return;
    }
    for (const child of node.childNodes) {
      if (
        child instanceof HTMLElement &&
        /^(DIV|P)$/.test(child.tagName) &&
        offset &&
        !runs.at(-1)?.text.endsWith("\n")
      )
        append("\n", weight);
      visit(child, weight);
      positions.push(offset);
    }
  };
  visit(host);
  return { runs: normalizeTextRuns(runs), points };
}

export function readTextRunDom(host: HTMLElement): TextRun[] {
  return inspect(host).runs;
}

export interface TextDomSelection {
  start: number;
  end: number;
  backward?: boolean;
}
export function readTextDomSelection(
  host: HTMLElement,
): TextDomSelection | null {
  const selection = window.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !host.contains(selection.anchorNode) ||
    !host.contains(selection.focusNode)
  )
    return null;
  const { points } = inspect(host);
  const anchor = points.get(selection.anchorNode)?.[selection.anchorOffset];
  const focus = points.get(selection.focusNode)?.[selection.focusOffset];
  if (anchor === undefined || focus === undefined) return null;
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    backward: anchor > focus,
  };
}

export function writeTextDomSelection(
  host: HTMLElement,
  selection: TextDomSelection,
) {
  const { points } = inspect(host);
  const find = (offset: number): [Node, number] => {
    for (const [node, positions] of points) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const index = positions.indexOf(offset);
      if (index >= 0) return [node, index];
    }
    return [host, offset === 0 ? 0 : host.childNodes.length];
  };
  const start = find(selection.start),
    end = find(selection.end);
  window
    .getSelection()
    ?.setBaseAndExtent(
      ...(selection.backward ? end : start),
      ...(selection.backward ? start : end),
    );
}
