import { warmVideoPlayer, videoPlayerKey, cancelVideoWarmup } from "./preparedVideoPool";
import { presenterEffectClockOrigins } from "../core/effectClocks";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePreparedSlideImages } from "./usePreparedSlideImages";
import { flushEffectSurfaces } from "./effectRuntime";
import { presentationSpan } from "./presentationDiagnostics";
import type { PresenterState } from "../platform/api";
import { platform } from "../platform";
import { usePresentationState } from "./usePresentationState";
import { presentationShortcut } from "../core/presentationSession";
import { SlideRenderer } from "./SlideRenderer";
import { slideCacheFor, type CachedSlide } from "./slideCache";
import { flattenElements } from "../core/scene";
import { useSlideTransition } from "./useSlideTransition";

// Retain the actual players, rather than warming disposable video elements.
// Bound the number of prepared slides even for very long presentations.
const VIDEO_SLIDE_LOOKAHEAD = 4;
const hasVideo = (record: CachedSlide) =>
  flattenElements(record.value).some(
    (element) => element.content?.type === "video",
  );

export function AudienceOutput() {
  const [slides, setSlides] = useState<Record<string, CachedSlide>>({});
  const [error, setError] = useState("");
  const revisionRef = useRef<number | undefined>(undefined);
  const onError = useCallback((cause: unknown) => setError(String(cause)), []);
  const state = usePresentationState(onError);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      const action = presentationShortcut(event.key);
      if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (action === "end") void platform.closePresentation().catch(onError);
      else if (action === "fullscreen")
        void platform.fullscreen().catch(onError);
      else void platform.presentationCommand(action).catch(onError);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onError]);

  const deckId = state?.deckId;
  const index = state?.index;
  const slideIds = state?.slideIds;

  useEffect(() => {
    if (!deckId || index === undefined || index === null || !slideIds?.length) {
      setSlides({});
      return;
    }
    let live = true;
    const cache = slideCacheFor(deckId);
    if (revisionRef.current !== state?.contentRevision) {
      if (revisionRef.current !== undefined) cache.clear();
      revisionRef.current = state?.contentRevision;
      setSlides({});
    }
    const ids = slideIds.slice(Math.max(0, index - 1), index + 1);
    const retain = (records: Record<string, CachedSlide>) => Object.fromEntries(Object.entries(records).filter(([id]) => ids.includes(id)));
    const usefulPlayers = new Set<string>();
    for (const record of Object.values(Object.fromEntries(ids.flatMap(id => { const record = cache.get(id); return record ? [[id, record]] : []; })))) if (ids.includes(record.value.id)) for (const element of flattenElements(record.value)) if (element.content?.type === "video") usefulPlayers.add(videoPlayerKey(deckId, record.value.id, element.id));
    cancelVideoWarmup(usefulPlayers, ids.map(id => deckId + ":" + id + ":"));
    const loaded = presentationSpan("slide-projections", slideIds[index]);
    cache.protect(ids);
    setSlides(retain);
    void Promise.all(ids.map(async (id) => [id, await cache.load(id)] as const))
      .then((rows) => {
        loaded();
        if (!live) return;
        setSlides((old) => retain({ ...old, ...Object.fromEntries(rows) }));
        const nextId = slideIds[index + 1];
        const next = nextId ? rows.find(([id]) => id === nextId)?.[1] : null;
        if (next) void cache.warmPreviews(next.value, true);
        setError("");
        // Start at presentation entry, scanning beyond ordinary adjacent-slide
        // prefetch. Navigation cancels this work and reprioritizes the pool.
        void (async () => {
          const prepared: string[] = [];
          for (const id of slideIds.slice(index + 1)) {
            if (!live || prepared.length >= VIDEO_SLIDE_LOOKAHEAD) return;
            try {
              const record = await cache.load(id);
              if (!live) return;
              if (!hasVideo(record)) continue;
              prepared.push(id);
              for (const element of flattenElements(record.value)) {
                if (element.content?.type !== "video") continue;
                const key = videoPlayerKey(deckId, record.value.id, element.id);
                usefulPlayers.add(key);
                await warmVideoPlayer(key, element.content, () => live);
                if (!live) return;
              }
            } catch {
              // Report unavailable projections only when navigating to them.
            }
          }
        })();
      })
      .catch((cause) => {
        loaded();
        if (live) setError(String(cause));
      });
    return () => {
      loaded();
      live = false;
    };
  }, [deckId, index, slideIds, state?.contentRevision]);

  const activeId =
    state && state.index !== null ? state.slideIds[state.index] : undefined;
  const visibleCount = state?.slideIds.length ?? 0;
  return (
    <main
      className={`presenter audience-output ${
        state?.black || !visibleCount ? "black" : ""
      }`}
      data-testid="presenter"
      data-index={state?.index ?? -1}
      data-black={state?.black ? "true" : "false"}
      data-error={error || undefined}
      aria-label="Audience Output"
    >
      {!state?.black &&
        Object.values(slides).map((record) => {
          const slide = record.value;
          const active = slide.id === activeId;
          return (
            <AudienceSlide
              key={`${slide.id}:${state?.restartToken ?? 0}`}
              record={record}
              active={active}
              prepareVideo={
                !!state &&
                state.index !== null &&
                state.slideIds.indexOf(slide.id) > state.index
              }
              state={state}
              onError={onError}
            />
          );
        })}
    </main>
  );
}

function AudienceSlide({
  record,
  active,
  prepareVideo,
  state,
  onError,
}: {
  record: CachedSlide;
  active: boolean;
  prepareVideo: boolean;
  state: PresenterState | null;
  onError: (cause: unknown) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const resize = () =>
      setScale(
        Math.min(
          innerWidth / record.deck.width,
          innerHeight / record.deck.height,
        ),
      );
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [record.deck.width, record.deck.height]);
  const ready = usePreparedSlideImages(
    root,
    record.value,
    scale,
    record.deck.id,
  );
  const waiting = active && state?.awaitingAudience;
  const lastActiveState = useRef<PresenterState | null>(null);
  useEffect(() => {
    if (active) lastActiveState.current = state;
  }, [active, state]);
  const transition = useSlideTransition(
    root,
    record.value.id,
    active,
    scale,
    state?.transition,
    state?.pausedAt,
  );
  const playbackState = active
    ? state
    : transition.outgoing
      ? lastActiveState.current
      : null;
  const sessionStartedAt = state?.startedAt;
  const motionStartedAt = state?.motion?.startedAt ?? state?.slideStartedAt;
  useEffect(() => {
    if (
      !waiting ||
      !ready ||
      sessionStartedAt === undefined ||
      motionStartedAt === undefined
    )
      return;
    let live = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void (async () => {
          if (root.current && !(await flushEffectSurfaces(root.current))) {
            onError(new Error("Effect output is not ready for presentation"));
            return;
          }
          if (live)
            void platform
              .presentationCommand({
                type: "audience-ready",
                slideId: record.value.id,
                sessionStartedAt,
                motionStartedAt,
              })
              .catch(onError);
        })().catch(onError);
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [waiting, ready, sessionStartedAt, motionStartedAt, record, onError]);
  return (
    <div
      ref={root}
      data-active-slide={active ? "" : undefined}
      data-images-prepared={ready ? "true" : "false"}
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: record.deck.width,
        height: record.deck.height,
        marginLeft: -record.deck.width / 2,
        marginTop: -record.deck.height / 2,
        transform: `scale(${scale})`,
        visibility: transition.visible ? "visible" : "hidden",
        zIndex: active ? 2 : transition.outgoing ? 1 : 0,
        // Shader/text output can set visibility: visible on descendants. Keep
        // prepared slides mounted, but suppress the entire inactive composition.
        opacity: transition.visible && !transition.preparing ? 1 : 0,
      }}
    >
      <SlideRenderer
        slide={record.value}
        deck={record.deck}
        staticVideo={!active && !transition.outgoing}
        prepareVideo={prepareVideo}
        presentation
        renderScale={scale}
        motionState={playbackState?.motion}
        effectClock={
          playbackState ? presenterEffectClockOrigins(playbackState) : undefined
        }
      />
    </div>
  );
}
