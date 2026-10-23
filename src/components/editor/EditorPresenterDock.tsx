import { presenterEffectClockOrigins } from "../../core/effectClocks";
import type { EffectClockOrigins } from "../../core/effectClocks";
import { useLayoutEffect, useRef, useState } from "react";
import type { Deck, Slide } from "../../core/document";
import { platform } from "../../platform";
import { PresentationControls } from "../PresentationControls";
import { SlideRenderer } from "../SlideRenderer";
import {
  formatPresenterTime,
  usePresenterController,
} from "../usePresenterController";

type PresenterController = ReturnType<typeof usePresenterController>;

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
  imageProfile?: import("../../core/presentationImages").ImageOutputProfile;
  motionState?: import("../../core/motionPlayback").MotionPlaybackState;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  const width = deck?.width;
  const height = deck?.height;
  useLayoutEffect(() => {
    const node = root.current;
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
      ref={root}
      className="empty-thumb"
      aria-label={label}
      style={{
        position: "relative",
        overflow: "hidden",
        aspectRatio: deck ? `${deck.width} / ${deck.height}` : undefined,
      }}
    >
      {slide && deck && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: deck.width,
            height: deck.height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        >
          <SlideRenderer
            visualPlayback="static"
            slide={slide}
            deck={deck}
            renderScale={scale}
            preparedImages
            imageProfile={imageProfile}
            staticVideo
            motionState={motionState}
            effectClock={effectClock}
          />
        </div>
      )}
    </div>
  );
}

export function EditorPresenterDock({
  controller,
  onError,
}: {
  controller: PresenterController;
  onError: (error: unknown) => void;
}) {
  const { notes, state, slide, nextSlide, deck } = controller;
  return (
    <>
      {controller.error && <p role="alert">Presenter: {controller.error}</p>}
      {state && (
        <section className="presenter-dock" aria-label="Presenter controls">
          <div className="presenter-preview current">
            <span>Current</span>
            <Preview
              slide={slide}
              deck={deck}
              motionState={state?.motion}
              effectClock={presenterEffectClockOrigins(state)}
              label="Current slide"
              imageProfile={controller.audienceProfile}
            />
          </div>
          <div className="presenter-preview next">
            <span>Next</span>
            <Preview
              slide={nextSlide}
              deck={deck}
              label="Next slide"
              imageProfile={controller.audienceProfile}
            />
          </div>
          <div className="presenter-info">
            <strong>
              {state.index === null ? 0 : state.index + 1} /{" "}
              {state.slideIds.length}
            </strong>
            <span className="presenter-timer">
              {formatPresenterTime(controller.elapsed)}
            </span>
            <PresentationControls controller={controller} />
            <button
              onClick={() =>
                void platform.showPresenterConsole().catch(onError)
              }
            >
              Presenter Console
            </button>
            {notes && <p className="presenter-notes">{notes}</p>}
          </div>
        </section>
      )}
    </>
  );
}
