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
import { flushEffectSurfaces } from "../../components/effectRuntime";
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

function nextPaint() {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function mediaSettled(root: HTMLElement) {
  if (root.querySelector('[data-media-loading="true"]')) return false;
  for (const owner of root.querySelectorAll<HTMLElement>(
    '[data-media-type="video"]',
  )) {
    const video = owner.querySelector("video");
    if (!video) return false;
    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
      !video.error
    )
      return false;
  }
  return true;
}

async function waitForMedia(root: HTMLElement) {
  const deadline = performance.now() + 12000;
  while (!mediaSettled(root) && performance.now() < deadline)
    await nextPaint();
  return mediaSettled(root);
}

async function prepareHtmlSlide(root: HTMLElement) {
  const mediaReady = await waitForMedia(root);
  await Promise.all(
    Array.from(root.querySelectorAll("img")).map((image) =>
      image.decode().catch(() => undefined),
    ),
  );
  await nextPaint();
  const effectsReady = await flushEffectSurfaces(root).catch(() => false);
  return { mediaReady, effectsReady };
}

function HtmlSlide({
  slide,
  deck,
  active,
  state,
  scale,
  onAudienceReady,
  onWarning,
}: {
  slide: HtmlExportPayload["document"]["slides"][number];
  deck: HtmlExportPayload["document"]["deck"];
  active: boolean;
  state: PresenterState;
  scale: number;
  onAudienceReady(command: Parameters<typeof applyPresentationCommand>[1]): void;
  onWarning(message: string): void;
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
  const sessionStartedAt = state.startedAt;
  const motionStartedAt = state.motion?.startedAt ?? state.slideStartedAt;
  useEffect(() => {
    if (
      !active ||
      !state.awaitingAudience ||
      sessionStartedAt === undefined ||
      motionStartedAt === undefined ||
      !root.current
    )
      return;
    let live = true;
    const node = root.current;
    void prepareHtmlSlide(node)
      .then(({ mediaReady, effectsReady }) => {
        if (!live) return;
        if (!mediaReady)
          onWarning(
            `Slide "${slide.id}" media did not become ready before playback started.`,
          );
        if (!effectsReady)
          onWarning(
            `Slide "${slide.id}" contains Effect output that could not become ready in this browser.`,
          );
      })
      .catch((cause) => {
        if (live)
          onWarning(
            `Slide "${slide.id}" preparation failed: ${String(cause)}`,
          );
      })
      .finally(() => {
        if (!live) return;
        onAudienceReady({
          type: "audience-ready",
          slideId: slide.id,
          sessionStartedAt,
          motionStartedAt,
        });
      });
    return () => {
      live = false;
    };
  }, [
    active,
    state.awaitingAudience,
    sessionStartedAt,
    motionStartedAt,
    slide.id,
    onAudienceReady,
    onWarning,
  ]);
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
        opacity: transition.visible && !transition.preparing ? 1 : 0,
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
      const fontWarnings = await resources.installFonts();
      if (fontWarnings.length) setError(fontWarnings.join("\n"));
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
          ? applyPresentationCommand(current, command, Date.now())
          : current,
      ),
    [],
  );

  const onAudienceReady = useCallback(
    (command: Parameters<typeof applyPresentationCommand>[1]) => apply(command),
    [apply],
  );
  const reportWarning = useCallback((message: string) => {
    setError((current) =>
      current.includes(message)
        ? current
        : current
          ? `${current}\n${message}`
          : message,
    );
  }, []);

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
                  onAudienceReady={onAudienceReady}
                  onWarning={reportWarning}
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
