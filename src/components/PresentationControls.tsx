import type { usePresenterController } from "./usePresenterController";

export function PresentationControls({
  controller,
}: {
  controller: ReturnType<typeof usePresenterController>;
}) {
  const { state, command, end, fullscreen } = controller;
  if (!state) return null;
  const index = state.index;
  return (
    <div className="presentation-controls">
      <label>
        Jump to slide
        <select
          aria-label="Jump to slide"
          value={index ?? ""}
          disabled={index === null}
          onChange={(event) =>
            void command({ type: "jump", index: Number(event.target.value) })
          }
        >
          {index === null && <option value="">No visible slides</option>}
          {state.slideIds.map((id, position) => (
            <option key={id} value={position}>
              {position + 1}
            </option>
          ))}
        </select>
      </label>
      <div className="presenter-actions">
        <button
          disabled={index === null || index === 0}
          onClick={() => void command({ type: "previous" })}
        >
          Previous
        </button>
        <button
          disabled={index === null || index === state.slideIds.length - 1}
          onClick={() => void command({ type: "next" })}
        >
          Next
        </button>
        <button
          aria-pressed={state.pausedAt !== undefined}
          onClick={() => void command({ type: "toggle-pause" })}
        >
          {state.pausedAt !== undefined ? "Resume" : "Pause"}
        </button>
        <button
          aria-pressed={!!state.black}
          onClick={() => void command({ type: "toggle-black" })}
        >
          {state.black ? "Show slide" : "Black screen"}
        </button>
        <button
          disabled={index === null}
          onClick={() => void command({ type: "restart-media" })}
        >
          Restart media
        </button>
        <button onClick={() => void fullscreen()}>Fullscreen</button>
        <button onClick={() => void end()}>End</button>
      </div>
    </div>
  );
}
