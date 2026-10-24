import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  const measure = () =>
    Math.min(
      window.innerWidth / Math.max(1, width),
      window.innerHeight / Math.max(1, height),
    );
  const [scale, setScale] = useState(measure);
  useLayoutEffect(() => {
    const resize = () => setScale(measure());
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [width, height]);
  return scale;
}

function HtmlSlide({
  slide,
  deck,
  active,
  state,
  scale,
}: {
  slide: HtmlExportPayload["document"]["slides"][number];
  deck: HtmlExportPayload["document"]["deck"];
  active: boolean;
  state: PresenterState;
  scale: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const lastActiveState = useRef<PresenterState | null>(null);
  if (active) lastActiveState.current = state;
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
        zIndex: active ? 2 : transition.outgoing ? 1 : 0,
        opacity: transition.visible ? 1 : 0,
      }}
    >
      <SlideRenderer
        slide={slide}
        deck={deck}
        presentation
        preparedImages={false}
        staticVideo={!active && !transition.outgoing}
        renderScale={scale}
        motionState={playbackState?.motion}
        effectClock={
          playbackState
            ? presenterEffectClockOrigins(playbackState)
            : undefined
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

  useEffect(() => () => resources.dispose(), [resources]);

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
          false,
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
          ? applyPresentationCommand(current, command, Date.now())
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
        event.target.closest("input, textarea, select, button, [contenteditable=true]")
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
        [state.transition?.fromSlideId, activeId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
  }, [activeId, state]);

  return (
    <RenderResourcesProvider resources={resources}>
      <main
        className="showme-html-presentation"
        data-showme-html-runtime={payload.runtimeVersion}
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
              <button type="button" onClick={() => void start()} disabled={starting}>
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
