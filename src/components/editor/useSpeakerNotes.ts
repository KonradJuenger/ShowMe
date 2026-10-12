import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import {
  setSlideNotes,
  type EditorSnapshot,
} from "../../core/editorCommands";
import type { EditorChange } from "../../core/editorChange";
import type { EditScope } from "../../core/documentAuthority";

interface NotesController {
  snapshot: EditorSnapshot | EditorChange | null;
  snapshotRef: { current: EditorSnapshot | EditorChange | null };
  apply(
    value: EditorSnapshot | EditorChange,
    commit?: boolean,
  ): void;
  commitPreview(): void;
  flush(): Promise<void>;
  acquireEditScopes(scopes: EditScope[]): Promise<boolean>;
  releaseLeases(): Promise<void>;
  beginHistoryGroup(id?: string): string;
  endHistoryGroup(): Promise<void>;
  draftConflict: unknown;
}

export function useSpeakerNotes({
  controller,
  onStatus,
}: {
  controller: NotesController;
  onStatus(message: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const {
    snapshotRef,
    apply,
    commitPreview,
    flush,
    acquireEditScopes,
    releaseLeases,
    beginHistoryGroup,
    endHistoryGroup,
  } = controller;
  const draftRef = useRef("");
  const editingSlideRef = useRef<string | null>(null);
  const leaseGrantedRef = useRef(false);
  const historyOpenRef = useRef(false);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const finishingRef = useRef<Promise<void> | null>(null);

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const applyDraft = useCallback(() => {
    const slideId = editingSlideRef.current;
    const snapshot = snapshotRef.current;
    if (!slideId || !snapshot || snapshot.slide.id !== slideId) return;
    if (snapshot.slide.notes === draftRef.current) return;
    apply(setSlideNotes(snapshot, draftRef.current), false);
  }, [apply, snapshotRef]);

  const scheduleCommit = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (leaseGrantedRef.current && !composingRef.current) commitPreview();
    }, 350);
  }, [clearTimer, commitPreview]);

  const finish = useCallback(async () => {
    if (finishingRef.current) return finishingRef.current;
    const hadLease = leaseGrantedRef.current;
    const hadHistory = historyOpenRef.current;
    if (!editingSlideRef.current && !hadLease && !hadHistory) return;
    generationRef.current += 1;
    clearTimer();
    composingRef.current = false;

    const run = (async () => {
      try {
        if (hadLease) {
          applyDraft();
          commitPreview();
        }
        editingSlideRef.current = null;
        leaseGrantedRef.current = false;
        historyOpenRef.current = false;
        setReady(false);
        if (hadHistory) await endHistoryGroup();
        else await releaseLeases();
      } finally {
        finishingRef.current = null;
      }
    })();
    finishingRef.current = run;
    return run;
  }, [
    applyDraft,
    clearTimer,
    commitPreview,
    endHistoryGroup,
    releaseLeases,
  ]);

  const onFocus = useCallback(
    async (event: FocusEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      if (leaseGrantedRef.current) return;
      await finish();
      await flush();
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      const slideId = snapshot.slide.id;
      const generation = ++generationRef.current;
      editingSlideRef.current = slideId;
      draftRef.current = snapshot.slide.notes;
      setDraft(snapshot.slide.notes);

      const granted = await acquireEditScopes([
        { kind: "notes", slideId },
      ]);
      if (
        generation !== generationRef.current ||
        editingSlideRef.current !== slideId ||
        snapshotRef.current?.slide.id !== slideId ||
        document.activeElement !== target
      ) {
        if (granted) await releaseLeases().catch(() => undefined);
        return;
      }
      if (!granted) {
        editingSlideRef.current = null;
        setReady(false);
        onStatus("Speaker notes are being edited by a collaborator.");
        return;
      }

      leaseGrantedRef.current = true;
      beginHistoryGroup();
      historyOpenRef.current = true;
      setReady(true);
    },
    [
      acquireEditScopes,
      beginHistoryGroup,
      finish,
      flush,
      onStatus,
      releaseLeases,
      snapshotRef,
    ],
  );

  const onChange = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraft(value);
      if (!leaseGrantedRef.current) return;
      applyDraft();
      if (!composingRef.current) scheduleCommit();
    },
    [applyDraft, scheduleCommit],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    clearTimer();
  }, [clearTimer]);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    if (!leaseGrantedRef.current) return;
    applyDraft();
    commitPreview();
  }, [applyDraft, commitPreview]);

  const slide = controller.snapshot?.slide;
  const slideId = slide?.id;
  const slideNotes = slide?.notes;

  useEffect(() => {
    if (!slideId) return;
    if (
      !leaseGrantedRef.current ||
      editingSlideRef.current !== slideId
    ) {
      const nextNotes = slideNotes ?? "";
      draftRef.current = nextNotes;
      setDraft(nextNotes);
    }
  }, [slideId, slideNotes]);

  useEffect(() => {
    if (controller.draftConflict && editingSlideRef.current)
      void finish().catch(() => undefined);
  }, [controller.draftConflict, finish]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      clearTimer();
      composingRef.current = false;
      if (leaseGrantedRef.current) {
        applyDraft();
        commitPreview();
      }
      if (historyOpenRef.current)
        void endHistoryGroup().catch(() => undefined);
      else void releaseLeases().catch(() => undefined);
    },
    [
      applyDraft,
      clearTimer,
      commitPreview,
      endHistoryGroup,
      releaseLeases,
    ],
  );

  return {
    draft,
    ready,
    onFocus,
    onChange,
    onCompositionStart,
    onCompositionEnd,
    flush: finish,
  };
}
