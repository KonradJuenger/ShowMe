import {
  motionEaseNames,
  namedMotionEase,
  motionEaseFromName,
} from "../core/motion";
import {
  EFFECT_SCHEDULE_VERSION,
  type EffectSchedule,
} from "../core/motionModel";
/** Start/Stop settings; click position and delay are authored on the timeline. */
export function EffectTimeControls({
  value: schedule,
  onChange,
  clicks = [],
  easing,
  onEasingChange,
}: {
  value: Pick<EffectSchedule, "version" | "start" | "stop">;
  onChange(value: Pick<EffectSchedule, "version" | "start" | "stop">): void;
  clicks?: { id: string; label: string }[];
  easing?: EffectSchedule["progressEasing"];
  onEasingChange?(value: NonNullable<EffectSchedule["progressEasing"]>): void;
}) {
  function update(
    input: string,
    fn: (
      s: Pick<EffectSchedule, "version" | "start" | "stop">,
      input: string,
    ) => void,
  ) {
    const next = structuredClone(schedule);
    next.version = EFFECT_SCHEDULE_VERSION;
    fn(next, input);
    onChange(next);
  }
  const milliseconds = (value: string) =>
    Math.max(1, Math.min(86400000, Math.round(Number(value) * 1000)));
  return (
    <div className="effect-time-controls" aria-label="Effect time">
      <label>
        Start
        <select
          aria-label="Effect time start"
          value={schedule.start}
          onChange={(e) =>
            update(e.target.value, (s, input) => {
              s.start = input as "slide" | "presentation" | "click";
            })
          }
        >
          <option value="slide">Slide start</option>
          <option value="presentation">Presentation start</option>
          <option value="click">Click (timeline)</option>
        </select>
      </label>
      <label>
        Stop
        <select
          aria-label="Effect stop"
          value={
            schedule.stop.mode === "click"
              ? schedule.stop.stageId
              : schedule.stop.mode
          }
          onChange={(e) =>
            update(e.target.value, (s, input) => {
              const value = input;
              s.stop =
                value === "none"
                  ? { mode: "none" }
                  : value === "next-click"
                    ? { mode: "next-click" }
                    : value === "slide-end"
                      ? { mode: value }
                      : value === "after"
                        ? {
                            mode: "after",
                            durationMs: 2000,
                          }
                        : { mode: "click", stageId: value };
            })
          }
        >
          <option value="none">None</option>
          <option value="slide-end">Slide end</option>
          <option value="next-click">Next click</option>
          {clicks.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          <option value="after">After duration</option>
        </select>
      </label>
      {schedule.stop.mode === "after" && (
        <label>
          After (s)
          <input
            aria-label="Effect stop duration"
            type="number"
            min="0.001"
            max="86400"
            step="0.01"
            value={schedule.stop.durationMs / 1000}
            onChange={(e) =>
              update(e.target.value, (s, input) => {
                s.stop = {
                  mode: "after",
                  durationMs: milliseconds(input),
                };
              })
            }
          />
        </label>
      )}
      {schedule.stop.mode === "after" && onEasingChange && (
        <label>
          Easing
          <select
            aria-label="Effect interval easing"
            value={namedMotionEase(easing)}
            onChange={(event) =>
              onEasingChange(
                motionEaseFromName(
                  event.currentTarget.value as (typeof motionEaseNames)[number],
                ),
              )
            }
          >
            {namedMotionEase(easing) === "Custom" && (
              <option value="Custom">Custom</option>
            )}
            {motionEaseNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
