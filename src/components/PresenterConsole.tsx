import { presenterEffectClockOrigins } from "../core/effectClocks";
import type { EffectClockOrigins } from "../core/effectClocks";
import { useLayoutEffect, useRef, useState } from "react";
import { usePreparedSlideImages } from "./usePreparedSlideImages";
import type { Deck, Slide } from "../core/document";
import { SlideRenderer } from "./SlideRenderer";
import { usePresenterController } from "./usePresenterController";
import { PresentationControls } from "./PresentationControls";
import { derivePresenterView } from "./presenterViewModel";

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
    <div ref={container} className="console-slide" aria-label={label}>
      {slide && deck ? (
        <div
          className="console-slide-content"
          style={{
            width: deck.width,
            height: deck.height,
            transform:
              "scale(" + scale + ") translate(-50%, -50%)",
            visibility: prepared ? "visible" : "hidden",
          }}
        >
          <SlideRenderer
            visualPlayback="static"
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
        <span className="console-slide-empty">
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
  const [noteSize, setNoteSize] = useState(28);
  const presenter = state ? derivePresenterView(state, clock) : null;
  const elapsedMinutes = Math.floor(elapsed / 60_000);

  return (
    <main className="presenter-console" aria-label="Presenter Console">
      <header className="console-status-strip">
        <div
          className="console-slide-position"
          aria-label={
            "Slide " +
            (presenter?.slidePosition ?? 0) +
            " of " +
            (presenter?.slideCount ?? 0)
          }
        >
          <strong>{presenter?.slidePosition ?? 0}</strong>
          <span>/</span>
          <span>{presenter?.slideCount ?? 0}</span>
        </div>
        <div className="console-clocks">
          <span aria-label={elapsedMinutes + " minutes since presentation start"}>
            <strong>{elapsedMinutes}</strong> min
          </span>
          <time
            aria-label="Current time"
            dateTime={new Date(clock).toISOString()}
          >
            {new Date(clock).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
      </header>

      {!state || !presenter ? (
        <div className="console-ended" role="status">
          Presentation ended
        </div>
      ) : (
        <>
          <div
            className="console-readiness"
            data-readiness={presenter.readiness}
            role="status"
            aria-live="polite"
          >
            <span className="console-readiness-mark" aria-hidden="true" />
            <span>{presenter.readinessLabel}</span>
          </div>

          <div className="console-preview-row">
            <section className="console-current">
              <div className="console-section-header">
                <h2>Current</h2>
              </div>
              <div className="console-current-frame">
                <Preview
                  slide={slide}
                  deck={deck}
                  motionState={state.motion}
                  effectClock={presenterEffectClockOrigins(state)}
                  label="Current slide preview"
                  imageProfile={controller.audienceProfile}
                />
                {state.black && (
                  <div className="console-black-overlay" role="status">
                    <strong>Audience screen is black</strong>
                    <span>Press B or use Show slide to restore it.</span>
                  </div>
                )}
              </div>
            </section>

            <section className="console-next">
              <div className="console-section-header">
                <h2>Next</h2>
              </div>
              <Preview
                slide={nextSlide}
                deck={deck}
                label="Next slide preview"
                imageProfile={controller.audienceProfile}
              />
            </section>
          </div>

          <section className="console-notes" aria-label="Presenter notes">
            <div className="console-notes-header">
              <h2>Notes</h2>
              <div className="console-note-size" aria-label="Note text size">
                <button
                  type="button"
                  aria-label="Make notes smaller"
                  disabled={noteSize <= 18}
                  onClick={() => setNoteSize((size) => Math.max(18, size - 2))}
                >
                  A−
                </button>
                <button
                  type="button"
                  aria-label="Make notes larger"
                  disabled={noteSize >= 40}
                  onClick={() => setNoteSize((size) => Math.min(40, size + 2))}
                >
                  A+
                </button>
              </div>
            </div>
            <p className="presenter-notes" style={{ fontSize: noteSize }}>
              {notes || "No notes for this slide."}
            </p>
          </section>

          <PresentationControls controller={controller} />

          {(state.displayWarning || error) && (
            <div className="console-alerts">
              {state.displayWarning && <p role="status">{state.displayWarning}</p>}
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </>
      )}

      {!state && error && <p role="alert">{error}</p>}
    </main>
  );
}
