import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePreparedSlideImages } from "../../components/usePreparedSlideImages";
import { useAudienceReady } from "../../components/useAudienceReady";
import { releasePreparedVideos } from "../../components/preparedVideoPool";
import type { PresentationCommand } from "../../core/presentationSession";
import type { PresenterState } from "../../platform/api";
import { SlideRenderer } from "../../components/SlideRenderer";
import { RenderResourcesProvider } from "../../components/renderResources";
import { useSlideTransition } from "../../components/useSlideTransition";
import {
  applyPresentationCommand,
  presentationShortcut,
  startSession,
} from "../../core/presentationSession";
import { presenterEffectClockOrigins } from "../../core/effectClocks";
import { stageDuration } from "../../core/motionModel";
import { EmbeddedRenderResources } from "./embeddedResources";
import type { HtmlExportPayload } from "./types";

function useViewportScale(width: number, height: number) {
  const measure = useCallback(
    () =>
      Math.min(
        window.innerWidth / Math.max(1, width),
        window.innerHeight / Math.max(1, height),
      ),
    [width, height],
  );
  const [scale, setScale] = useState(measure);
  useLayoutEffect(() => {
    const resize = () => setScale(measure());
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [measure]);
  return scale;
}

function HtmlSlide({
  slide,
  deck,
  active,
  state,
  scale,
  held,
  onPrepared,
  apply,
  onError,
}: {
  slide: HtmlExportPayload["document"]["slides"][number];
  deck: HtmlExportPayload["document"]["deck"];
  active: boolean;
  state: PresenterState;
  scale: number;
  held: boolean;
  onPrepared: (id: string) => void;
  apply: (command: PresentationCommand) => void;
  onError: (cause: unknown) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const lastActiveState = useRef<PresenterState | null>(null);
  useEffect(() => {
    if (active) lastActiveState.current = state;
  }, [active, state]);
  const ready = usePreparedSlideImages(root, slide, scale, deck.id);
  const waiting = active && !!state.awaitingAudience;
  useAudienceReady(
    root,
    slide.id,
    state,
    waiting && ready,
    onPrepared,
    apply,
    onError,
  );
  const transition = useSlideTransition(
    root,
    slide.id,
    active,
    scale,
    state.transition,
    state.pausedAt,
  );
  const playbackState = active
    ? state
    : transition.outgoing
      ? lastActiveState.current
      : null;
  return (
    <div
      ref={root}
      data-html-slide={slide.id}
      data-active-slide={active ? "" : undefined}
      data-images-prepared={ready ? "true" : "false"}
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: deck.width,
        height: deck.height,
        marginLeft: -deck.width / 2,
        marginTop: -deck.height / 2,
        transform: `scale(${scale})`,
        transformOrigin: "center",
        pointerEvents: active ? "auto" : "none",
        zIndex: active && ready ? 2 : held || transition.outgoing ? 1 : 0,
        opacity:
          held || (transition.visible && ready && !transition.preparing)
            ? 1
            : 0,
      }}
    >
      <SlideRenderer
        slide={slide}
        deck={deck}
        presentation
        preparedImages={false}
        staticVideo={waiting || (!active && !transition.outgoing)}
        prepareVideo={!active || waiting}
        renderScale={scale}
        motionState={playbackState?.motion}
        effectClock={
          playbackState ? presenterEffectClockOrigins(playbackState) : undefined
        }
      />
    </div>
  );
}

export function HtmlPresentationApp({
  payload,
}: {
  payload: HtmlExportPayload;
}) {
  const { document: exported } = payload;
  const { deck, slides } = exported;
  const resources = useMemo(
    () => new EmbeddedRenderResources(payload.assets, payload.fonts),
    [payload],
  );
  const byId = useMemo(
    () => new Map(slides.map((slide) => [slide.id, slide])),
    [slides],
  );
  const motionSlides = useMemo(
    () =>
      Object.fromEntries(
        slides.map((slide) => [
          slide.id,
          slide.motion?.stages.map((stage) => ({
            id: stage.id,
            duration: stageDuration(stage),
          })) ?? [],
        ]),
      ),
    [slides],
  );
  const scale = useViewportScale(deck.width, deck.height);
  const [state, setState] = useState<PresenterState | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [presentedId, setPresentedId] = useState<string>();
  const onError = useCallback((cause: unknown) => setError(String(cause)), []);
  const onPrepared = useCallback((id: string) => setPresentedId(id), []);

  useEffect(
    () => () => {
      releasePreparedVideos(resources);
      resources.dispose();
    },
    [resources],
  );
  useEffect(() => {
    if (!state) {
      setPresentedId(undefined);
      releasePreparedVideos(resources);
    }
  }, [state, resources]);

  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      await resources.installFonts();
      setState(
        startSession(
          { deckId: deck.id, slideIds: [], index: null },
          deck,
          Date.now(),
          motionSlides,
          true,
        ),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setStarting(false);
    }
  }, [deck, motionSlides, resources, starting]);

  const apply = useCallback(
    (command: Parameters<typeof applyPresentationCommand>[1]) =>
      setState((current) =>
        current
          ? current.awaitingAudience &&
            !["audience-ready", "black", "toggle-black"].includes(command.type)
            ? current
            : applyPresentationCommand(current, command, Date.now())
          : current,
      ),
    [],
  );

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  }, []);

  useEffect(() => {
    if (!state) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          "input, textarea, select, button, [contenteditable=true]",
        )
      )
        return;
      const action = presentationShortcut(event.key);
      if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      if (action === "fullscreen") {
        void toggleFullscreen().catch((cause) => setError(String(cause)));
        return;
      }
      if (action === "end") {
        setState(null);
        return;
      }
      apply(action);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [apply, state, toggleFullscreen]);

  const activeId =
    state && state.index !== null ? state.slideIds[state.index] : null;
  const visibleIds = useMemo(() => {
    if (!state || !activeId) return [];
    return [
      ...new Set(
        [
          state.transition?.fromSlideId,
          activeId,
          state.slideIds[(state.index ?? 0) + 1],
          presentedId,
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
  }, [activeId, state, presentedId]);

  return (
    <RenderResourcesProvider resources={resources}>
      <main
        className="showme-html-presentation"
        data-showme-html-runtime={payload.runtimeVersion}
        data-awaiting-audience={state?.awaitingAudience ? "true" : "false"}
        data-index={state?.index ?? -1}
        onClick={(event) => {
          if (!state || state.black) return;
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("button")
          )
            return;
          apply({ type: "next" });
        }}
      >
        {!state ? (
          <section className="showme-html-start">
            <div>
              <h1>{deck.name}</h1>
              <button
                type="button"
                onClick={() => void start()}
                disabled={starting}
              >
                {starting ? "Preparing…" : "Start presentation"}
              </button>
              <p>
                Arrow keys, Space or Enter advance. P pauses, B blacks the
                screen, F toggles fullscreen, Escape ends.
              </p>
              {error && <p className="showme-html-error">{error}</p>}
            </div>
          </section>
        ) : (
          <>
            {visibleIds.map((id) => {
              const slide = byId.get(id);
              if (!slide) return null;
              return (
                <HtmlSlide
                  key={`${id}:${state.restartToken ?? 0}`}
                  slide={slide}
                  deck={deck}
                  active={id === activeId}
                  state={state}
                  scale={scale}
                  held={id === presentedId && id !== activeId}
                  onPrepared={onPrepared}
                  apply={apply}
                  onError={onError}
                />
              );
            })}
            {state.black && (
              <div
                className="showme-html-black"
                aria-label="Black presentation output"
              />
            )}
            {error && <div className="showme-html-runtime-error">{error}</div>}
          </>
        )}
      </main>
    </RenderResourcesProvider>
  );
}
