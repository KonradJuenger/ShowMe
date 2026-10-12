import type { MotionWorkspace } from "./MotionWorkspace";
import {
  deleteMotionBlock,
  motionDefaults,
  motionEaseNames,
  motionEaseFromName,
  namedMotionEase,
  type NamedMotionEase,
} from "../core/motion";
import {
  defaultPresenceTransition,
  editPresenceSchedule,
} from "../core/presence";
import type { PresenceSchedule, PresenceTransition } from "../core/motionModel";

export function PresenceInspector({
  workspace: w,
  blockId,
  schedule: s,
}: {
  workspace: MotionWorkspace;
  blockId: string;
  schedule: PresenceSchedule;
}) {
  function edit(fn: (s: PresenceSchedule) => void) {
    w.change((m) => editPresenceSchedule(m!, w.active, blockId, fn));
  }
  function transition(side: "enterTransition" | "exitTransition") {
    const t = s[side],
      label = side === "enterTransition" ? "Enter" : "Exit";
    const update = (fn: (t: PresenceTransition) => void) =>
      edit((s) => fn(s[side]));
    return (
      <>
        <label>
          Transition
          <select
            aria-label={`${label} transition`}
            value={t.kind}
            onChange={(e) => {
              const kind = e.target.value as PresenceTransition["kind"];
              edit((s) => {
                s[side] = defaultPresenceTransition(kind);
              });
            }}
          >
            {["none", "fade", "move", "scale", "rotate"].map((k) => (
              <option key={k} value={k}>
                {k[0].toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {t.kind !== "none" && (
          <>
            <label>
              Duration (s)
              <input
                aria-label={`${label} duration`}
                type="number"
                min="0.001"
                step="0.01"
                value={t.durationMs / 1000}
                onChange={(e) => {
                  const value = Math.round(Number(e.target.value) * 1000);
                  update((t) => {
                    t.durationMs = value;
                  });
                }}
              />
            </label>
            <label>
              Easing
              <select
                aria-label={`${label} easing`}
                value={namedMotionEase(t.easing)}
                onChange={(e) => {
                  const value = motionEaseFromName(
                    e.target.value as Exclude<NamedMotionEase, "Custom">,
                  );
                  update((t) => {
                    t.easing = value;
                  });
                }}
              >
                <option value="Custom" disabled>
                  Custom
                </option>
                {motionEaseNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            {(t.kind === "move" || t.kind === "rotate") && (
              <label>
                Direction
                <select
                  aria-label={`${label} direction`}
                  value={
                    t.direction ?? (t.kind === "move" ? "Left" : "Clockwise")
                  }
                  onChange={(e) => {
                    const value = e.target
                      .value as PresenceTransition["direction"];
                    update((t) => {
                      t.direction = value;
                    });
                  }}
                >
                  {(t.kind === "move"
                    ? ["Left", "Right", "Up", "Down"]
                    : ["Clockwise", "Counter-clockwise"]
                  ).map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
            )}
            {t.kind === "move" && (
              <label>
                Distance (px)
                <input
                  aria-label={`${label} distance`}
                  type="number"
                  min="0"
                  value={t.distance ?? motionDefaults.distance}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    update((t) => {
                      t.distance = value;
                    });
                  }}
                />
              </label>
            )}
            {t.kind === "scale" && (
              <label>
                Scale (%)
                <input
                  aria-label={`${label} scale`}
                  type="number"
                  min="0"
                  value={(t.scale ?? motionDefaults.scale) * 100}
                  onChange={(e) => {
                    const value = Number(e.target.value) / 100;
                    update((t) => {
                      t.scale = value;
                    });
                  }}
                />
              </label>
            )}
            {t.kind === "rotate" && (
              <label>
                Angle (°)
                <input
                  aria-label={`${label} angle`}
                  type="number"
                  min="0"
                  value={t.angle ?? motionDefaults.rotation}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    update((t) => {
                      t.angle = value;
                    });
                  }}
                />
              </label>
            )}
          </>
        )}
      </>
    );
  }
  return (
    <>
      <button
        onClick={() => {
          w.setSelected(null);
          w.setPreview(null);
        }}
      >
        ← Motion
      </button>
      <h3>Presence</h3>
      <h4>Enter</h4>
      <label>
        Trigger
        <select
          aria-label="Presence Enter trigger"
          value={w.active}
          onChange={(e) =>
            w.moveBlockToClick(w.active, blockId, Number(e.target.value), false)
          }
        >
          {w.motion!.stages.map((stage, i) => (
            <option key={stage.id} value={i}>
              {i === 0 ? "Slide start" : `Click ${i}`}
            </option>
          ))}
          <option value={w.motion!.stages.length}>+ New click</option>
        </select>
      </label>
      <label>
        Delay (s)
        <input
          aria-label="Presence delay"
          type="number"
          min="0"
          step="0.01"
          value={s.startOffsetMs / 1000}
          onChange={(e) => {
            const value = Math.round(Number(e.target.value) * 1000);
            edit((s) => {
              s.startOffsetMs = value;
            });
          }}
        />
      </label>
      {transition("enterTransition")}
      <h4>End</h4>
      <label>
        Trigger
        <select
          aria-label="Presence End trigger"
          value={s.end.mode === "click" ? s.end.stageId : s.end.mode}
          onChange={(e) => {
            const value = e.target.value;
            edit((s) => {
              if (value === "slide-end")
                s.exitTransition = defaultPresenceTransition();
              s.end =
                value === "after"
                  ? { mode: "after", durationMs: 2000 }
                  : value === "none" ||
                      value === "next-click" ||
                      value === "slide-end"
                    ? { mode: value }
                    : { mode: "click", stageId: value };
            });
          }}
        >
          <option value="none">None</option>
          <option value="next-click">Next click</option>
          {w.motion!.stages.slice(w.active + 1).map((stage, i) => (
            <option key={stage.id} value={stage.id}>
              Click {w.active + i + 1}
            </option>
          ))}
          <option value="after">After duration</option>
          <option value="slide-end">Slide end</option>
        </select>
      </label>
      {s.end.mode === "after" && (
        <label>
          After (s)
          <input
            aria-label="Presence End duration"
            type="number"
            min="0.001"
            step="0.01"
            value={s.end.durationMs / 1000}
            onChange={(e) => {
              const durationMs = Math.round(Number(e.target.value) * 1000);
              edit((s) => {
                s.end = { mode: "after", durationMs };
              });
            }}
          />
        </label>
      )}
      {s.end.mode !== "none" &&
        s.end.mode !== "slide-end" &&
        transition("exitTransition")}
      <button onClick={() => w.previewBlock(w.motion!, w.active, blockId)}>
        Preview
      </button>
      <button
        onClick={() =>
          w.change((m) => deleteMotionBlock(m!, w.active, blockId))
        }
      >
        Remove Presence
      </button>
    </>
  );
}
