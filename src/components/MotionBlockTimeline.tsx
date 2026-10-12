import { blockRange, resolveMotion } from "../core/motion";
import {
  blockStateTimes,
  editBlockState,
  setBlockState,
} from "../core/motionStates";
import {
  motionPropertyDescriptor,
  unavailable,
} from "../core/elementPropertyDescriptors";
import { findElement } from "../core/scene";
import type { EditorSnapshot } from "../core/editorCommands";
import type { SlideMotion, MotionEase } from "../core/motionModel";

export function MotionBlockTimeline({
  snapshot,
  motion,
  stageIndex,
  blockId,
  time,
  seek,
  change,
}: {
  snapshot: EditorSnapshot;
  motion: SlideMotion;
  stageIndex: number;
  blockId: string;
  time: number;
  seek(time: number): void;
  change(fn: (motion: SlideMotion | undefined) => SlideMotion): void;
}) {
  const { block, start, end } = blockRange(motion, stageIndex, blockId);
  const states = blockStateTimes(motion, stageIndex, blockId);
  const at = Math.round(Math.max(start, Math.min(end, time)));
  const outside = time < start || time > end;
  const exists = states.includes(at);
  const tracks = motion.stages[stageIndex].tracks.filter((t) =>
    block.members.some((m) => m.trackId === t.id),
  );
  const overlay = resolveMotion({ ...snapshot.slide, motion }, stageIndex, at);
  const intermediate = !outside && at > start && at < end && exists;
  function stateEdit(action: Parameters<typeof editBlockState>[4]) {
    change((m) => editBlockState(m!, stageIndex, blockId, at, action));
  }
  return (
    <section className="motion-local" aria-label="Block-local timeline">
      <p>
        {states.length} states · {((at - start) / 1000).toFixed(2)} s
      </p>
      <input
        aria-label="Block-local playhead"
        type="range"
        min={0}
        max={end - start}
        step={1}
        value={at - start}
        onChange={(e) => seek(start + Number(e.target.value))}
      />
      <div className="motion-local-states">
        {states.map((state, i) => (
          <button
            key={state}
            aria-label={
              i === 0
                ? "Start state"
                : i === states.length - 1
                  ? "End state"
                  : `State ${i + 1}`
            }
            aria-pressed={at === state}
            style={{ left: `${((state - start) / (end - start)) * 100}%` }}
            onClick={() => seek(state)}
          >
            ◆
          </button>
        ))}
      </div>
      <div className="motion-local-labels">
        <span>0.0 s</span>
        <span>{((end - start) / 1000).toFixed(2)} s</span>
      </div>
      {outside && <p role="status">Scrub inside this block to edit a state</p>}
      {!outside && !exists && (
        <p role="status">Editing here will create a state</p>
      )}
      <button
        disabled={outside || exists}
        onClick={() =>
          change((m) =>
            setBlockState(
              { ...snapshot, slide: { ...snapshot.slide, motion: m } },
              stageIndex,
              blockId,
              at,
            ),
          )
        }
      >
        Add state
      </button>
      <button
        disabled={!intermediate}
        onClick={() => stateEdit({ type: "delete" })}
      >
        Delete state
      </button>
      {intermediate && (
        <label>
          State time (ms)
          <input
            aria-label="State time"
            type="number"
            min={1}
            max={end - start - 1}
            key={`${blockId}:${at}`}
            defaultValue={at - start}
            onBlur={(e) => {
              const to = start + Number(e.target.value);
              if (to !== at) {
                change((m) => {
                  const next = editBlockState(m!, stageIndex, blockId, at, {
                    type: "retime",
                    to,
                  });
                  seek(to);
                  return next;
                });
              }
            }}
          />
        </label>
      )}
      {exists && at < end && (
        <label>
          Interpolation after this state
          <select
            aria-label="State interpolation"
            disabled={outside}
            value={JSON.stringify(
              tracks[0].keyframes.find((k) => k.at === at)?.easeToNext ??
                "linear",
            )}
            onChange={(e) =>
              stateEdit({
                type: "ease",
                ease: JSON.parse(e.target.value) as MotionEase,
              })
            }
          >
            {(
              [
                ["Linear", "linear"],
                ["Ease In", [0.42, 0, 1, 1]],
                ["Ease Out", [0, 0, 0.58, 1]],
                ["Ease In Out", [0.42, 0, 0.58, 1]],
                ["Hold", "hold"],
              ] as const
            ).map(([label, ease]) => (
              <option key={label} value={JSON.stringify(ease)}>
                {label}
              </option>
            ))}
            <option
              disabled
              value={JSON.stringify(
                tracks[0].keyframes.find((k) => k.at === at)?.easeToNext ??
                  "linear",
              )}
            >
              Current interpolation
            </option>
          </select>
        </label>
      )}
      <details>
        <summary>{block.binding ? "State parameters" : "State values"}</summary>
        {tracks.map((track) => {
          const element = findElement(snapshot.slide, track.elementId);
          if (!element) return null;
          const descriptor = motionPropertyDescriptor(
            element,
            track.property,
            snapshot.slide.effectResources,
          );
          const base = descriptor?.read(element);
          if (base === unavailable || base === undefined) return null;
          const value = overlay[element.id]?.[track.property] ?? base;
          return (
            <label key={track.id}>
              {track.property.split(".").at(-1)}
              <input
                aria-label={`State ${track.property.split(".").at(-1)}`}
                type="number"
                disabled={outside}
                step="any"
                key={`${track.id}:${at}:${value}`}
                defaultValue={value}
                onBlur={(e) => {
                  const edited = Number(e.target.value);
                  if (edited !== value)
                    change((m) =>
                      setBlockState(
                        {
                          ...snapshot,
                          slide: { ...snapshot.slide, motion: m },
                        },
                        stageIndex,
                        blockId,
                        at,
                        { [element.id]: { [track.property]: edited } },
                      ),
                    );
                }}
              />
            </label>
          );
        })}
      </details>
    </section>
  );
}
