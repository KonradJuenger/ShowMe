import {
  presentationShortcut,
  type PresentationCommand,
} from "../core/presentationSession";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageOutputProfile } from "../core/presentationImages";
import type { Deck, Slide } from "../core/document";
import { platform } from "../platform";
import type {
  PresentationDisplay,
  PresentationDisplayAssignment,
} from "../core/presentationDisplays";
import type { PresenterState } from "../platform/api";
import { usePresentationState } from "./usePresentationState";
import { slideCacheFor, type CachedSlide } from "./slideCache";

export function formatPresenterTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

export function usePresenterController(keyboard = false) {
  const [notesBySlide, setNotesBySlide] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const onError = useCallback((error: unknown) => setError(String(error)), []);
  const state = usePresentationState(onError);
  const [displays, setDisplays] = useState<PresentationDisplay[]>([]);
  const [audienceProfile, setAudienceProfile] = useState<ImageOutputProfile>();
  useEffect(() => {
    if (!state?.deckId) return;
    let live = true;
    const update = () => { void platform.audienceImageProfile!(state.deckId).then(profile => {
      if (live) setAudienceProfile(old => old?.width === profile.width && old.height === profile.height ? old : profile);
    }).catch(onError); };
    update();
    const stop = platform.onImageReadiness?.(status => { if (!status || status.documentId === state.deckId) update(); });
    return () => { live = false; stop?.(); };
  }, [state?.deckId, displays, onError]);
  const [loaded, setLoaded] = useState<{
    deckId: string;
    record: CachedSlide;
  } | null>(null);
  const [nextRecord, setNextRecord] = useState<CachedSlide | null>(null);
  const [clock, setClock] = useState(Date.now);
  const contentRevision = useRef<number | undefined>(undefined);
  const deckId = state?.deckId;
  const slideId =
    state && state.index !== null ? state.slideIds[state.index] : undefined;

  useEffect(() => {
    setNotesBySlide({});
    return platform.onDocumentAccepted?.((event) => {
      if (event.documentId !== deckId) return;
      const changes = event.accepted.operations.filter(
        (op) => op.type === "slide.notes.set",
      );
      if (changes.length)
        setNotesBySlide((previous) => {
          const next = { ...previous };
          for (const operation of changes)
            if (operation.type === "slide.notes.set")
              next[operation.slideId] = operation.notes;
          return next;
        });
    });
  }, [deckId]);

  useEffect(() => {
    let live = true;
    const unsubscribe = platform.onDisplaysChanged?.((value) => {
      if (live) setDisplays(value);
    });
    void platform
      .displays()
      .then((value) => {
        if (live) setDisplays(value);
      })
      .catch((cause) => {
        if (live) onError(cause);
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [
    onError,
    state?.audienceDisplayId,
    state?.presenterDisplayId,
    state?.displayWarning,
  ]);

  useEffect(() => {
    if (!deckId || !slideId) {
      setLoaded(null);
      return;
    }
    let live = true;
    const cache = slideCacheFor(deckId);
    if (contentRevision.current !== state?.contentRevision) {
      if (contentRevision.current !== undefined) cache.clear();
      contentRevision.current = state?.contentRevision;
    }
    const ready = cache.get(slideId);
    if (ready) setLoaded({ deckId, record: ready });
    else setLoaded(null);
    void cache
      .load(slideId)
      .then((record) => {
        if (!live) return;
        setLoaded({ deckId, record });
        cache.prefetch(record.deck, slideId, true);
        setError("");
      })
      .catch((cause) => {
        if (live) onError(cause);
      });
    return () => {
      live = false;
    };
  }, [deckId, slideId, state?.contentRevision, onError]);

  const nextId =
    state && state.index !== null ? state.slideIds[state.index + 1] : undefined;
  useEffect(() => {
    let live = true;
    setNextRecord(null);
    if (deckId && nextId)
      void slideCacheFor(deckId)
        .load(nextId)
        .then((record) => {
          if (!live) return;
          setNextRecord(record);
          void slideCacheFor(deckId).warmPreviews(record.value, true);
        })
        .catch(onError);
    return () => {
      live = false;
    };
  }, [deckId, nextId, state?.contentRevision, onError]);

  useEffect(() => {
    if (!state?.startedAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.startedAt]);

  const command = useCallback(
    (value: PresentationCommand) =>
      platform.presentationCommand(value).catch(onError),
    [onError],
  );
  const end = useCallback(
    () => platform.closePresentation().catch(onError),
    [onError],
  );
  const fullscreen = useCallback(
    () => platform.fullscreen().catch(onError),
    [onError],
  );
  useEffect(() => {
    if (!keyboard) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      const action = presentationShortcut(event.key);
      if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (action === "end") void end();
      else if (action === "fullscreen") void fullscreen();
      else void command(action);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [keyboard, command, end, fullscreen]);

  const assignDisplays = useCallback(
    (assignment: PresentationDisplayAssignment | null) =>
      platform.setPresentationDisplays(assignment).catch(onError),
    [onError],
  );
  const start = useCallback(
    (input: PresenterState) => platform.present(input),
    [],
  );

  const currentRecord =
    loaded && loaded.deckId === deckId && loaded.record.value.id === slideId
      ? loaded.record
      : null;
  const next = nextRecord && nextRecord.value.id === nextId ? nextRecord : null;
  const deck: Deck | null = currentRecord?.deck ?? next?.deck ?? null;
  const slide: Slide | null = currentRecord?.value ?? null;

  return {
    state,
    notes: slideId ? (notesBySlide[slideId] ?? slide?.notes ?? "") : "",
    deck,
    nextSlide: next?.value ?? null,
    clock,
    command,
    end,
    fullscreen,
    assignDisplays,
    displays,
    audienceProfile,
    start,
    error,
    slide,
    elapsed: state?.startedAt ? Math.max(0, clock - state.startedAt) : 0,
  };
}
