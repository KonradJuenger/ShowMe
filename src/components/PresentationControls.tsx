import { derivePresenterView } from "./presenterViewModel";
import type { usePresenterController } from "./usePresenterController";

export function PresentationControls({
  controller,
}: {
  controller: ReturnType<typeof usePresenterController>;
}) {
  const { state, command, end, fullscreen } = controller;
  if (!state) return null;

  const view = derivePresenterView(state, controller.clock);
  const index = state.index;
  const slideCount = state.slideIds.length;

  return (
    <nav className="presentation-controls" aria-label="Presentation controls">
      <button
        className="presenter-previous"
        disabled={!view.canPrevious}
        onClick={() => void command({ type: "previous" })}
      >
        <span aria-hidden="true">←</span>
        <span>Previous</span>
      </button>

      <button
        className="presenter-advance"
        disabled={!view.canAdvance}
        aria-label={"Advance, " + view.advanceDetail}
        onClick={() => void command({ type: "next" })}
      >
        <span className="presenter-advance-label">Advance</span>
        <span className="presenter-advance-detail">{view.advanceDetail}</span>
        <span className="presenter-advance-arrow" aria-hidden="true">
          →
        </span>
      </button>

      <button
        className="presenter-secondary"
        aria-pressed={!!state.black}
        onClick={() => void command({ type: "toggle-black" })}
      >
        {state.black ? "Show slide" : "Black screen"}
      </button>

      <button
        className="presenter-secondary"
        aria-pressed={state.pausedAt !== undefined}
        onClick={() => void command({ type: "toggle-pause" })}
      >
        {state.pausedAt !== undefined ? "Resume" : "Pause"}
      </button>

      <label className="presenter-slide-jump">
        <span>Slide</span>
        <select
          aria-label="Jump to slide"
          value={index ?? ""}
          disabled={index === null}
          onChange={(event) =>
            void command({ type: "jump", index: Number(event.target.value) })
          }
        >
          {index === null && <option value="">None</option>}
          {state.slideIds.map((id, position) => (
            <option key={id} value={position}>
              {position + 1} / {slideCount}
            </option>
          ))}
        </select>
      </label>

      <details className="presenter-more">
        <summary>More</summary>
        <div className="presenter-more-menu">
          <button
            disabled={index === null}
            onClick={() => void command({ type: "restart-media" })}
          >
            Restart media
          </button>
          <button onClick={() => void fullscreen()}>Fullscreen</button>
          <button className="presenter-end" onClick={() => void end()}>
            End presentation
          </button>
        </div>
      </details>
    </nav>
  );
}
