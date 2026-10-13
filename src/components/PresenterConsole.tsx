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
  const [noteSize, setNoteSize] = useState(28);

  return (
    <main className="presenter-console" aria-label="Presenter Console">
      <header className="console-header">
        <div className="console-position">
          <span>Slide</span>
          <strong aria-label="Visible slide position">
            {state?.index == null ? 0 : state.index + 1}
            <small> / {state?.slideIds.length ?? 0}</small>
          </strong>
        </div>
        <div className="console-timing">
          <div>
            <span>Elapsed</span>
            <strong
              className="presenter-timer"
              aria-label="Elapsed presentation time"
            >
              {formatPresenterTime(elapsed)}
            </strong>
          </div>
          <div>
            <span>Time</span>
            <time>
              {new Date(clock).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        </div>
      </header>

      {!state ? (
        <div className="console-ended" role="status">
          Presentation ended
        </div>
      ) : (
        <>
          <div className="console-workspace">
            <section className="console-current">
              <div className="console-section-header">
                <h2>Current</h2>
                {state.black && (
                  <strong className="console-black-status">Audience black</strong>
                )}
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

            <aside className="console-side">
              <section className="console-next">
                <div className="console-section-header">
                  <h2>Next slide</h2>
                </div>
                <Preview
                  slide={nextSlide}
                  deck={deck}
                  label="Next slide preview"
                  imageProfile={controller.audienceProfile}
                />
              </section>

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
            </aside>
          </div>

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
