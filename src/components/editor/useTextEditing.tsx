import {
  plainText,
  normalizeTextRuns,
  replaceTextRuns,
  formatTextRuns,
  sliceTextRuns,
  typingFontWeight,
  runFontWeight,
  textSelection,
  type TextRun,
} from "../../core/textRuns";
import { resolveTextTypography } from "../../core/textTypography";
import {
  readTextDomSelection,
  writeTextDomSelection,
  writeTextRunDom,
} from "./textRunDom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { EditorChange } from "../../core/editorChange";
import type { EditorSnapshot } from "../../core/editorCommands";
import { findElement, isEditableScope, locateElement } from "../../core/scene";
import { isTextContent } from "../../core/text";
import { isContextMenuOpen } from "../../platform/contextMenu";
import { platform } from "../../platform";
import type { CanvasSelection } from "../editorCanvasCoordinator";
import { updateTextDraftWithLayout } from "./textLayout";

export type TextSelectionMode = "end" | "all";

let memoryTextClipboard = "";

async function writeTextClipboard(value: string) {
  memoryTextClipboard = value;
  try {
    if (platform.writeTextClipboard) {
      await platform.writeTextClipboard(value);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard)
      await navigator.clipboard.writeText(value);
  } catch {
    // Keep the local fallback so Cut never discards unrecoverable text.
  }
}

async function readTextClipboard() {
  try {
    if (platform.readTextClipboard)
      return (await platform.readTextClipboard()) || memoryTextClipboard;
    if (typeof navigator !== "undefined" && navigator.clipboard)
      return (await navigator.clipboard.readText()) || memoryTextClipboard;
  } catch {
    // Fall through to the local fallback.
  }
  return memoryTextClipboard;
}

export interface TextCommandContext {
  documentId: string;
  slideId: string;
  elementId: string;
  scopeId: string;
  text: string;
  selection: { start: number; end: number };
}

interface TextSessionController {
  undo(redo?: boolean): void;
  flush(): Promise<void>;
  snapshot?: EditorSnapshot | EditorChange | null;
  snapshotRef: RefObject<EditorSnapshot | EditorChange | null>;
  apply(value: EditorSnapshot | EditorChange, commit?: boolean): void;
  commitPreview(): void;
  acquireElementScopes(
    slideId: string,
    elementIds: readonly string[],
    structuralParentIds?: readonly string[],
  ): Promise<boolean>;
  releaseLeases(): Promise<void>;
  beginHistoryGroup(id?: string): string;
  endHistoryGroup(): Promise<void>;
  draftConflict: unknown;
}

export interface TextEditingController {
  editingId: string | null;
  draftText: string;
  draftRuns: TextRun[];
  boldState: boolean | "mixed";
  toggleBold(): void;
  insertText(value: string): void;
  refreshSelection(): void;
  history(redo: boolean): Promise<void>;
  inputRef: RefObject<HTMLDivElement | null>;
  selectionMode: RefObject<TextSelectionMode>;
  enter(elementId: string, selection?: TextSelectionMode): Promise<void>;
  exit(): Promise<void>;
  onFocus(event: FocusEvent<HTMLDivElement>): void;
  onChange(value: TextRun[]): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  onBlur(): void;
  captureCommandContext(): TextCommandContext | null;
  executeCommand(
    command: "text.cut" | "text.copy" | "text.paste" | "text.select-all",
    context: TextCommandContext,
  ): Promise<void>;
}

export function useTextEditing({
  controller,
  selection,
  setSelection,
  setFrameEditing,
  onError,
}: {
  controller: TextSessionController;
  selection: CanvasSelection;
  setSelection: Dispatch<SetStateAction<CanvasSelection>>;
  setFrameEditing(value: null): void;
  onError(error: unknown): void;
}): TextEditingController {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftRuns, setDraftRuns] = useState<TextRun[]>([]);
  const runsRef = useRef<TextRun[]>([]);
  const lastSelection = useRef("");
  const typingWeight = useRef<number | undefined>(undefined);
  const [boldState, setBoldState] = useState<boolean | "mixed">(false);
  const inputRef = useRef<HTMLDivElement | null>(null);
  const pendingCaretRef = useRef<{ start: number; end: number } | null>(null);
  const selectionMode = useRef<TextSelectionMode>("end");
  const editingIdRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const editingSlideRef = useRef<string | null>(null);
  const grantedRef = useRef(false);
  const historyOpenRef = useRef(false);
  const composingRef = useRef(false);
  const compositionDraft = useRef<{
    runs: TextRun[];
    start: number;
    end: number;
    weight?: number;
  } | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const exitingRef = useRef<Promise<void> | null>(null);
  const selectionRef = useRef(selection);
  const { snapshotRef, apply, commitPreview, endHistoryGroup, releaseLeases } =
    controller;
  selectionRef.current = selection;
  editingIdRef.current = editingId;
  draftRef.current = draftText;

  const clearCommitTimer = useCallback(() => {
    if (!commitTimer.current) return;
    clearTimeout(commitTimer.current);
    commitTimer.current = null;
  }, []);

  const applyDraft = useCallback(
    (_value: string) => {
      const id = editingIdRef.current;
      const snapshot = snapshotRef.current;
      if (!id || !snapshot || !grantedRef.current) return;
      const element = findElement(snapshot.slide, id);
      if (!element || !isTextContent(element.content)) return;
      // Entering a placeholder is an interaction preview, not a document edit.
      if (element.content.placeholder && !runsRef.current.length) return;
      if (
        !element.content.placeholder &&
        JSON.stringify(element.content.runs) === JSON.stringify(runsRef.current)
      )
        return;
      const next = updateTextDraftWithLayout(snapshot, id, {
        runs: runsRef.current,
      });
      if (next !== snapshot) apply(next, false);
    },
    [apply, snapshotRef],
  );

  const scheduleCommit = useCallback(() => {
    clearCommitTimer();
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      if (grantedRef.current && !composingRef.current) commitPreview();
    }, 350);
  }, [clearCommitTimer, commitPreview]);

  const exit = useCallback(async () => {
    if (exitingRef.current) return exitingRef.current;
    const hadEditing = !!editingIdRef.current;
    const wasGranted = grantedRef.current;
    const hadHistory = historyOpenRef.current;
    if (!hadEditing && !wasGranted && !hadHistory) return;

    generationRef.current += 1;
    clearCommitTimer();
    composingRef.current = false;

    const run = (async () => {
      try {
        if (wasGranted) {
          applyDraft(draftRef.current);
          commitPreview();
        }
        editingIdRef.current = null;
        editingSlideRef.current = null;
        grantedRef.current = false;
        historyOpenRef.current = false;
        setEditingId(null);
        setDraftText("");
        if (hadHistory) await endHistoryGroup();
        else await releaseLeases();
      } finally {
        exitingRef.current = null;
      }
    })().catch((error) => {
      onError(error);
    });
    exitingRef.current = run;
    return run;
  }, [
    applyDraft,
    clearCommitTimer,
    commitPreview,
    endHistoryGroup,
    onError,
    releaseLeases,
  ]);

  const enter = useCallback(
    async (elementId: string, mode: TextSelectionMode = "end") => {
      if (editingIdRef.current === elementId) {
        selectionMode.current = mode;
        requestAnimationFrame(() => {
          const area = inputRef.current;
          if (!area) return;
          area.focus();
          if (mode === "all")
            writeTextDomSelection(area, {
              start: 0,
              end: draftRef.current.length,
            });
        });
        return;
      }
      if (editingIdRef.current) await exit();

      const snapshot = controller.snapshotRef.current;
      if (
        !snapshot ||
        !isEditableScope(snapshot.slide, snapshot.deck, elementId)
      )
        return;
      const location = locateElement(snapshot.slide, elementId);
      if (!location || !isTextContent(location.element.content)) return;

      const generation = ++generationRef.current;
      const initial = location.element.content.placeholder
        ? ""
        : plainText(location.element.content);
      runsRef.current = location.element.content.placeholder
        ? []
        : location.element.content.runs;
      setDraftRuns(runsRef.current);
      typingWeight.current = typingFontWeight(runsRef.current, initial.length);
      lastSelection.current = "";
      selectionMode.current = mode;
      editingSlideRef.current = snapshot.slide.id;
      editingIdRef.current = elementId;
      draftRef.current = initial;
      setDraftText(initial);
      setEditingId(elementId);
      setSelection({ elementIds: [elementId], scopeId: location.parentId });
      setFrameEditing(null);

      const granted = await controller.acquireElementScopes(snapshot.slide.id, [
        elementId,
      ]);
      if (
        generation !== generationRef.current ||
        editingIdRef.current !== elementId ||
        editingSlideRef.current !== snapshot.slide.id
      ) {
        if (granted) await controller.releaseLeases().catch(() => undefined);
        return;
      }
      if (!granted) {
        editingIdRef.current = null;
        editingSlideRef.current = null;
        setEditingId(null);
        setDraftText("");
        onError(new Error("A collaborator owns this text Element"));
        return;
      }

      grantedRef.current = true;
      controller.beginHistoryGroup();
      historyOpenRef.current = true;
      applyDraft(draftRef.current);
      controller.commitPreview();
      requestAnimationFrame(() => {
        const area = inputRef.current;
        if (!area || editingIdRef.current !== elementId) return;
        area.focus();
        if (selectionMode.current === "all")
          writeTextDomSelection(area, {
            start: 0,
            end: draftRef.current.length,
          });
        else
          writeTextDomSelection(area, {
            start: initial.length,
            end: initial.length,
          });
      });
    },
    [applyDraft, controller, exit, onError, setFrameEditing, setSelection],
  );

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const input = event.currentTarget;
    requestAnimationFrame(() => {
      if (!input.isConnected || document.activeElement !== input) return;
      if (selectionMode.current === "all")
        writeTextDomSelection(input, {
          start: 0,
          end: draftRef.current.length,
        });
    });
  }, []);

  const onChange = useCallback(
    (runs: TextRun[]) => {
      runsRef.current = normalizeTextRuns(runs);
      setDraftRuns(runsRef.current);
      const value = plainText({ runs: runsRef.current });
      pendingCaretRef.current = null;
      draftRef.current = value;
      setDraftText(value);
      if (!grantedRef.current) return;
      applyDraft(value);
      if (!composingRef.current) scheduleCommit();
    },
    [applyDraft, scheduleCommit],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    const selected = inputRef.current
      ? readTextDomSelection(inputRef.current)
      : null;
    compositionDraft.current = selected
      ? { runs: runsRef.current, ...selected, weight: typingWeight.current }
      : null;
    clearCommitTimer();
  }, [clearCommitTimer]);

  const onCompositionEnd = useCallback(() => {
    const initial = compositionDraft.current;
    compositionDraft.current = null;
    if (initial) {
      const oldText = plainText({ runs: initial.runs }),
        nextText = draftRef.current;
      const prefix = oldText.slice(0, initial.start),
        suffix = oldText.slice(initial.end);
      if (
        nextText.startsWith(prefix) &&
        nextText.endsWith(suffix) &&
        nextText.length >= prefix.length + suffix.length
      ) {
        const insertion = nextText.slice(
          prefix.length,
          nextText.length - suffix.length,
        );
        onChange(
          replaceTextRuns(
            initial.runs,
            initial.start,
            initial.end,
            insertion
              ? [
                  {
                    text: insertion,
                    ...(initial.weight === undefined
                      ? {}
                      : { fontWeight: initial.weight }),
                  },
                ]
              : [],
          ),
        );
      }
    }
    composingRef.current = false;
    if (!grantedRef.current) return;
    applyDraft(draftRef.current);
    controller.commitPreview();
  }, [applyDraft, controller, onChange]);

  const onBlur = useCallback(() => {
    if (!isContextMenuOpen()) void exit();
  }, [exit]);

  const captureCommandContext = useCallback(() => {
    const id = editingIdRef.current;
    const area = inputRef.current;
    const snapshot = controller.snapshotRef.current;
    if (!id || !area || !snapshot) return null;
    const location = locateElement(snapshot.slide, id);
    if (!location || !isTextContent(location.element.content)) return null;
    const pending = pendingCaretRef.current;
    pendingCaretRef.current = null;
    return {
      documentId: snapshot.deck.id,
      slideId: snapshot.slide.id,
      elementId: id,
      scopeId: location.parentId,
      text: plainText({ runs: runsRef.current }),
      selection: pending ?? readTextDomSelection(area) ?? { start: 0, end: 0 },
    };
  }, [controller.snapshotRef]);

  const commandContextIsCurrent = useCallback(
    (context: TextCommandContext) => {
      const area = inputRef.current;
      const snapshot = controller.snapshotRef.current;
      return (
        !!area &&
        !!snapshot &&
        editingIdRef.current === context.elementId &&
        snapshot.deck.id === context.documentId &&
        snapshot.slide.id === context.slideId &&
        context.text === draftRef.current
      );
    },
    [controller.snapshotRef],
  );

  const focusCaret = useCallback((start: number, end = start) => {
    pendingCaretRef.current = { start, end };
    requestAnimationFrame(() => {
      const area = inputRef.current;
      if (!area || !editingIdRef.current) return;
      area.focus();
      writeTextDomSelection(area, { start, end });
    });
  }, []);

  const executeCommand = useCallback(
    async (
      command: "text.cut" | "text.copy" | "text.paste" | "text.select-all",
      context: TextCommandContext,
    ) => {
      const area = inputRef.current;
      if (!area || editingIdRef.current !== context.elementId) return;
      if (command === "text.select-all") {
        area.focus();
        writeTextDomSelection(area, { start: 0, end: draftRef.current.length });
        return;
      }

      const { start, end } = context.selection;
      const chosen = context.text.slice(start, end);
      if (command === "text.copy" || command === "text.cut") {
        await writeTextClipboard(chosen);
        if (command === "text.copy") return;
      }

      let insertion = "";
      if (command === "text.paste") insertion = await readTextClipboard();
      if (!commandContextIsCurrent(context)) return;

      const currentText = plainText({ runs: runsRef.current });
      const next =
        currentText.slice(0, start) + insertion + currentText.slice(end);
      const caret = start + insertion.length;
      runsRef.current = replaceTextRuns(
        runsRef.current,
        start,
        end,
        insertion
          ? [
              {
                text: insertion,
                ...(typingWeight.current === undefined
                  ? {}
                  : { fontWeight: typingWeight.current }),
              },
            ]
          : [],
      );
      setDraftRuns(runsRef.current);
      writeTextRunDom(area, runsRef.current, true);
      draftRef.current = next;
      setDraftText(next);
      if (grantedRef.current) {
        applyDraft(next);
        if (!composingRef.current) scheduleCommit();
      }
      focusCaret(caret);
    },
    [applyDraft, commandContextIsCurrent, focusCaret, scheduleCommit],
  );

  const refreshSelection = useCallback(() => {
    const area = inputRef.current,
      snapshot = snapshotRef.current,
      id = editingIdRef.current;
    if (!area || !snapshot || !id) return;
    const selected = readTextDomSelection(area);
    const element = findElement(snapshot.slide, id);
    if (!selected || element?.content?.type !== "text") return;
    const key = `${id}:${selected.start}:${selected.end}:${selected.backward}`;
    if (key === lastSelection.current) return;
    lastSelection.current = key;
    typingWeight.current = typingFontWeight(runsRef.current, selected.start);
    const type = resolveTextTypography(snapshot.deck, element.content);
    const weights =
      selected.start === selected.end
        ? [runFontWeight({ text: "", fontWeight: typingWeight.current }, type)]
        : sliceTextRuns(runsRef.current, selected.start, selected.end).map(
            (run) => runFontWeight(run, type),
          );
    setBoldState(
      weights.every((weight) => weight >= 600)
        ? true
        : weights.some((weight) => weight >= 600)
          ? "mixed"
          : false,
    );
  }, [snapshotRef]);

  const insertText = useCallback(
    (value: string) => {
      const area = inputRef.current;
      if (!area || !grantedRef.current) return;
      const native = readTextDomSelection(area);
      if (!native) return;
      const selected = textSelection(runsRef.current, native.start, native.end);
      const insertion = value
        ? [
            {
              text: value,
              ...(typingWeight.current === undefined
                ? {}
                : { fontWeight: typingWeight.current }),
            },
          ]
        : [];
      onChange(
        replaceTextRuns(
          runsRef.current,
          selected.start,
          selected.end,
          insertion,
        ),
      );
      writeTextRunDom(area, runsRef.current, true);
      writeTextDomSelection(area, {
        start: selected.start + value.length,
        end: selected.start + value.length,
      });
    },
    [onChange],
  );

  const toggleBold = useCallback(() => {
    const area = inputRef.current,
      snapshot = snapshotRef.current,
      id = editingIdRef.current;
    if (
      !area ||
      !snapshot ||
      !id ||
      !grantedRef.current ||
      composingRef.current
    )
      return;
    const selected = readTextDomSelection(area);
    const element = findElement(snapshot.slide, id);
    if (!selected || element?.content?.type !== "text") return;
    const type = resolveTextTypography(snapshot.deck, element.content);
    Object.assign(
      selected,
      textSelection(runsRef.current, selected.start, selected.end),
    );
    const chosen = sliceTextRuns(runsRef.current, selected.start, selected.end);
    const allBold = chosen.length
      ? chosen.every((run) => runFontWeight(run, type) >= 600)
      : runFontWeight({ text: "", fontWeight: typingWeight.current }, type) >=
        600;
    const weight = allBold ? 400 : 700;
    if (selected.start === selected.end) typingWeight.current = weight;
    else {
      onChange(
        allBold
          ? formatTextRuns(runsRef.current, selected.start, selected.end, 400)
          : replaceTextRuns(
              runsRef.current,
              selected.start,
              selected.end,
              chosen.map((run) => ({
                ...run,
                fontWeight: Math.max(700, runFontWeight(run, type)),
              })),
            ),
      );
      writeTextRunDom(area, runsRef.current, true);
      writeTextDomSelection(area, selected);
      controller.commitPreview();
    }
    setBoldState(!allBold);
  }, [controller, onChange, snapshotRef]);

  const history = useCallback(
    async (redo: boolean) => {
      const id = editingIdRef.current;
      await exit();
      const generation = generationRef.current;
      controller.undo(redo);
      await controller.flush();
      // Let the accepted projection reach React before constructing a new draft.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (
        id &&
        generation === generationRef.current &&
        selectionRef.current.elementIds.includes(id)
      )
        await enter(id);
    },
    [controller, enter, exit],
  );

  useEffect(() => {
    const id = editingIdRef.current;
    if (!id) return;
    const snapshot = controller.snapshot;
    const location = snapshot ? locateElement(snapshot.slide, id) : null;
    const selected = selectionRef.current;
    if (
      !snapshot ||
      snapshot.slide.id !== editingSlideRef.current ||
      !location ||
      !isTextContent(location.element.content) ||
      !isEditableScope(snapshot.slide, snapshot.deck, id) ||
      selected.scopeId !== location.parentId ||
      selected.elementIds.length !== 1 ||
      selected.elementIds[0] !== id
    )
      void exit();
  }, [controller.snapshot, exit, selection]);

  useEffect(() => {
    if (editingIdRef.current && controller.draftConflict) void exit();
  }, [controller.draftConflict, exit]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      clearCommitTimer();
      composingRef.current = false;
      if (grantedRef.current) {
        applyDraft(draftRef.current);
        commitPreview();
      }
      if (historyOpenRef.current) void endHistoryGroup().catch(() => undefined);
      else void releaseLeases().catch(() => undefined);
    },
    [
      applyDraft,
      clearCommitTimer,
      commitPreview,
      endHistoryGroup,
      releaseLeases,
    ],
  );

  return {
    editingId,
    draftText,
    draftRuns,
    boldState,
    toggleBold,
    insertText,
    refreshSelection,
    history,
    inputRef,
    selectionMode,
    enter,
    exit,
    onFocus,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    onBlur,
    captureCommandContext,
    executeCommand,
  };
}
