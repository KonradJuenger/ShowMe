import { presenterEffectClockOrigins } from "../core/effectClocks";
import type { EffectClockOrigins } from "../core/effectClocks";
import { useLayoutEffect, useRef, useState } from "react";
import { usePreparedSlideImages } from "./usePreparedSlideImages";
import type { Deck, Slide } from "../core/document";
import { SlideRenderer } from "./SlideRenderer";
import {
  usePresenterController,
  formatPresenterTime,
} from "./usePresenterController";
import { PresentationControls } from "./PresentationControls";

function Preview({
  slide,
  deck,
  label,
  motionState,
  effectClock,
  imageProfile,
}: {
  slide: Slide | null;
  deck: Deck | null;
  label: string;
  effectClock?: EffectClockOrigins;
  imageProfile?: import("../core/presentationImages").ImageOutputProfile;
  motionState?: import("../core/motionPlayback").MotionPlaybackState;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const prepared = usePreparedSlideImages(
    container,
    slide,
    scale,
    deck?.id ?? "",
  );

  const width = deck?.width;
  const height = deck?.height;
  useLayoutEffect(() => {
    const node = container.current;
    if (!node || !width || !height) return;
    const resize = () =>
      setScale(Math.min(node.clientWidth / width, node.clientHeight / height));
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [width, height]);

  return (
    <div
      ref={container}
      className="console-slide"
      aria-label={label}
      style={{
        aspectRatio: deck ? `${deck.width} / ${deck.height}` : undefined,
      }}
    >
      {slide && deck ? (
        <div
          className="console-slide-content"
          style={{
            width: deck.width,
            height: deck.height,
            transform: `scale(${scale})`,
            visibility: prepared ? "visible" : "hidden",
          }}
        >
          <SlideRenderer
            slide={slide}
            deck={deck}
            preparedImages
            imageProfile={imageProfile}
            renderScale={scale}
            staticVideo
            motionState={motionState}
            effectClock={effectClock}
          />
        </div>
      ) : (
        <span>
          {label === "Next slide preview" ? "End" : "No visible slides"}
        </span>
      )}
    </div>
  );
}

export function PresenterConsole() {
  const controller = usePresenterController(true);
  const { notes, state, deck, slide, nextSlide, elapsed, clock, error } =
    controller;

  return (
    <main className="presenter-console" aria-label="Presenter Console">
      <header className="console-header">
        <div>
          <p className="eyebrow">PRESENTER CONSOLE</p>
          <h1>Your presentation</h1>
        </div>
        <div className="console-timing">
          <strong aria-label="Visible slide position">
            {state?.index == null ? 0 : state.index + 1} /{" "}
            {state?.slideIds.length ?? 0}
          </strong>
          <span
            className="presenter-timer"
            aria-label="Elapsed presentation time"
          >
            {formatPresenterTime(elapsed)}
          </span>
          <time>
            {new Date(clock).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
      </header>
      {!state ? (
        <p role="status">Presentation ended</p>
      ) : (
        <>
          <section className="console-previews">
            <div className="console-current">
              <h2>Current slide</h2>
              <Preview
                slide={slide}
                deck={deck}
                motionState={state?.motion}
                effectClock={presenterEffectClockOrigins(state)}
                label="Current slide preview"
                imageProfile={controller.audienceProfile}
              />
              {state.black && (
                <p className="console-output-status" role="status">
                  Audience output is black
                </p>
              )}
            </div>
            <div className="console-next">
              <h2>Next slide</h2>
              <Preview
                slide={nextSlide}
                deck={deck}
                label="Next slide preview"
                imageProfile={controller.audienceProfile}
              />
            </div>
          </section>
          <section className="console-notes" aria-label="Presenter notes">
            <h2>Notes</h2>
            <p className="presenter-notes">
              {notes || "No notes for this slide."}
            </p>
          </section>
          <PresentationControls controller={controller} />
          {state.displayWarning && <p role="status">{state.displayWarning}</p>}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
