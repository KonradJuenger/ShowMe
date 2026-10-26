import type { EffectClockOrigins } from "../core/effectClocks";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { IconChevronDown } from "./AppIcons";
import { usePreparedSlideImages } from "./usePreparedSlideImages";
import type { Deck, Slide } from "../core/document";
import { SlideRenderer } from "./SlideRenderer";
import { usePresenterController } from "./usePresenterController";
import { PresentationControls } from "./PresentationControls";
import {
  derivePresenterView,
  formatPresenterElapsedMinutes,
} from "./presenterViewModel";

function Preview({
  slide,
  deck,
  label,
  motionState,
  effectClock,
  imageProfile,
  onAdvance,
  advanceDisabled,
}: {
  slide: Slide | null;
  deck: Deck | null;
  label: string;
  effectClock?: EffectClockOrigins;
  imageProfile?: import("../core/presentationImages").ImageOutputProfile;
  motionState?: import("../core/motionPlayback").MotionPlaybackState;
  onAdvance?: () => void;
  advanceDisabled?: boolean;
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
            transform: "scale(" + scale + ") translate(-50%, -50%)",
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
      {onAdvance && (
        <button
          type="button"
          className="console-preview-advance"
          aria-label={"Advance, " + label.toLowerCase()}
          title="Advance one step"
          disabled={advanceDisabled}
          onClick={onAdvance}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ")
              event.stopPropagation();
          }}
        />
      )}
    </div>
  );
}

export function PresenterConsole() {
  const controller = usePresenterController(true);
  const { notes, state, deck, slide, nextSlide, elapsed, clock, error } =
    controller;
  const [noteSize, setNoteSize] = useState(24);
  const [notesLayout, setNotesLayout] = useState<{
    documentId: string | undefined;
    share: number;
  } | null>(null);
  const notesShare =
    notesLayout && notesLayout.documentId === state?.deckId
      ? notesLayout.share
      : controller.hasSpeakerNotes
        ? 0.34
        : 0;
  const setNotesShare = (share: number) =>
    setNotesLayout({ documentId: state?.deckId, share });
  const lastNotesShare = useRef(0.34);
  const workspace = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const notesCollapsed = notesShare === 0;
  const resizeNotes = (share: number) => {
    const next = share < 0.08 ? 0 : Math.max(0.15, Math.min(0.75, share));
    if (next) lastNotesShare.current = next;
    setNotesShare(next);
  };
  const toggleNotes = () =>
    setNotesShare(notesCollapsed ? lastNotesShare.current : 0);
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key))
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") toggleNotes();
    else if (event.key === "Home") resizeNotes(0);
    else if (event.key === "End") resizeNotes(0.75);
    else resizeNotes(notesShare + (event.key === "ArrowUp" ? 0.05 : -0.05));
  };
  const stopNotesNavigation = (event: KeyboardEvent<HTMLElement>) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
        "Enter",
      ].includes(event.key)
    )
      event.stopPropagation();
  };
  const presenter = state ? derivePresenterView(state, clock) : null;
  const elapsedMinutes = formatPresenterElapsedMinutes(elapsed);
  const [wholeMinutes, fractionMinutes] = elapsedMinutes.split(" ");

  return (
    <main className="presenter-console" aria-label="Presenter Console">
      <header className="console-status-strip">
        <div className="console-session-status">
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
          {presenter && (
            <div
              className="console-readiness"
              data-readiness={presenter.readiness}
              role="status"
              aria-live="polite"
            >
              <span>{presenter.readinessLabel}</span>
            </div>
          )}
        </div>
        <div className="console-clocks">
          <span
            className="console-elapsed"
            aria-label={elapsedMinutes + " minutes since first advance"}
          >
            <strong className="console-elapsed-value">
              <span className="console-elapsed-whole">{wholeMinutes}</span>
              <span className="console-elapsed-fraction">
                {fractionMinutes}
              </span>
            </strong>
            <span className="console-elapsed-unit">min</span>
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
            ref={workspace}
            className="console-workspace"
            style={
              {
                gridTemplateRows: notesCollapsed
                  ? "minmax(140px, 1fr) var(--console-divider-height)"
                  : `minmax(140px, ${1 - notesShare}fr) var(--console-divider-height) minmax(80px, ${notesShare}fr)`,
                "--console-slide-aspect": deck
                  ? `${deck.width} / ${deck.height}`
                  : "16 / 9",
              } as CSSProperties
            }
          >
            <div className="console-preview-row">
              <section className="console-current" aria-label="Current slide">
                <div className="console-current-frame">
                  <Preview
                    slide={slide}
                    deck={deck}
                    motionState={controller.preview.motionState}
                    effectClock={controller.preview.effectClock}
                    label="Current slide preview"
                    imageProfile={controller.audienceProfile}
                    onAdvance={() => void controller.command({ type: "next" })}
                    advanceDisabled={!presenter.canAdvance}
                  />
                  {state.black && (
                    <div className="console-black-overlay" role="status">
                      <strong>Audience screen is black</strong>
                      <span>Press B or use Show slide to restore it.</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="console-next" aria-label="Next slide">
                <Preview
                  slide={nextSlide}
                  deck={deck}
                  label="Next slide preview"
                  imageProfile={controller.audienceProfile}
                  onAdvance={() => void controller.command({ type: "next" })}
                  advanceDisabled={!nextSlide || !presenter.canAdvance}
                />
              </section>
            </div>

            <div className="console-notes-divider">
              <div
                className="console-notes-resize"
                role="separator"
                aria-label="Resize speaker notes"
                aria-orientation="horizontal"
                aria-controls="console-speaker-notes"
                aria-valuemin={0}
                aria-valuemax={75}
                aria-valuenow={Math.round(notesShare * 100)}
                aria-valuetext={
                  notesCollapsed
                    ? "Notes collapsed"
                    : `${Math.round(notesShare * 100)}% for notes`
                }
                tabIndex={0}
                title="Drag to resize notes. Use arrow keys to resize, Enter to collapse."
                onKeyDown={resizeKey}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  dragging.current = event.pointerId;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (
                    dragging.current !== event.pointerId ||
                    !workspace.current
                  )
                    return;
                  const bounds = workspace.current.getBoundingClientRect();
                  const dividerHeight =
                    event.currentTarget.parentElement!.getBoundingClientRect()
                      .height;
                  resizeNotes(
                    (bounds.bottom - event.clientY - dividerHeight / 2) /
                      Math.max(1, bounds.height - dividerHeight),
                  );
                }}
                onPointerUp={(event) => {
                  if (dragging.current !== event.pointerId) return;
                  dragging.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onLostPointerCapture={() => {
                  dragging.current = null;
                }}
              />
              <button
                className="console-notes-toggle"
                type="button"
                onClick={toggleNotes}
                aria-expanded={!notesCollapsed}
                aria-controls="console-speaker-notes"
                onKeyDown={stopNotesNavigation}
              >
                <IconChevronDown aria-hidden="true" />
                {notesCollapsed ? "Show notes" : "Hide notes"}
              </button>
            </div>
            <section
              id="console-speaker-notes"
              className="console-notes"
              aria-label="Presenter notes"
              hidden={notesCollapsed}
              onKeyDown={stopNotesNavigation}
            >
              <div className="console-notes-header">
                <div className="console-note-size" aria-label="Note text size">
                  <button
                    type="button"
                    aria-label="Make notes smaller"
                    disabled={noteSize <= 18}
                    onClick={() =>
                      setNoteSize((size) => Math.max(18, size - 2))
                    }
                  >
                    A−
                  </button>
                  <button
                    type="button"
                    aria-label="Make notes larger"
                    disabled={noteSize >= 40}
                    onClick={() =>
                      setNoteSize((size) => Math.min(40, size + 2))
                    }
                  >
                    A+
                  </button>
                </div>
              </div>
              <p
                className="presenter-notes"
                data-empty={!notes}
                style={{ fontSize: noteSize }}
                tabIndex={0}
              >
                {notes || "No notes for this slide."}
              </p>
            </section>
          </div>

          <PresentationControls controller={controller} />

          {(state.displayWarning || error) && (
            <div className="console-alerts">
              {state.displayWarning && (
                <p role="status">{state.displayWarning}</p>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </>
      )}

      {!state && error && <p role="alert">{error}</p>}
    </main>
  );
}
