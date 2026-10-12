import { PresenceInspector } from "./PresenceInspector";
import { useState } from "react";
import { MotionBlockTimeline } from "./MotionBlockTimeline";
import {
  blockMotionEase,
  motionEaseNames,
  motionEaseFromName,
  type NamedMotionEase,
  blockRange,
  editMotionBlock,
  deleteMotionBlock,
  stageDuration,
  nativeAnimationNames,
} from "../core/motion";
import { findElement } from "../core/scene";
import { isEffectTriggerBlock } from "../core/motionModel";
import type { EditorController } from "./EditorCanvas";
import type { MotionWorkspace } from "./MotionWorkspace";
type Workspace = MotionWorkspace;
export function MotionSidebar({
  workspace: w,
  controller,
}: {
  workspace: Workspace;
  controller: EditorController;
}) {
  const [picking, setPicking] = useState(false);
  const motion = w.motion,
    stage = motion?.stages[w.active];
  const range =
    w.selected &&
    motion &&
    stage?.blocks?.some(
      (b) => b.id === w.selected && !isEffectTriggerBlock(stage, b),
    )
      ? blockRange(motion, w.active, w.selected)
      : null;
  function retime(start: number, duration: number, destination = w.active) {
    if (range)
      w.change((m) =>
        editMotionBlock(
          m!,
          w.active,
          range.block.id,
          destination,
          start,
          duration,
        ),
      );
  }
  return (
    <section className="motion-sidebar" aria-label="Motion panel">
      {range?.block.presenceSchedule ? (
        <PresenceInspector
          workspace={w}
          blockId={range.block.id}
          schedule={range.block.presenceSchedule}
        />
      ) : range ? (
        <>
          <button
            onClick={() => {
              w.setSelected(null);
              w.setEditingStates(false);
              w.setPreview(null);
            }}
          >
            ← Motion
          </button>
          <h3>{range.block.label}</h3>
          <button
            onClick={() => {
              w.setEditingStates(!w.editingStates);
              if (!w.editingStates) w.localSeek(range.start);
              else w.setPreview(null);
            }}
          >
            {w.editingStates ? "Done" : "Edit states"}
          </button>

          {w.editingStates && (
            <p role="status">
              Motion &gt; {range.block.label} &gt;{" "}
              {w.cursor.time === range.start
                ? "Start"
                : w.cursor.time === range.end
                  ? "End"
                  : "State"}
            </p>
          )}
          {w.editingStates && controller.snapshot && (
            <MotionBlockTimeline
              snapshot={controller.snapshot}
              motion={motion!}
              stageIndex={w.active}
              blockId={range.block.id}
              time={
                w.cursor.stageIndex === w.active ? w.cursor.time : range.start
              }
              seek={w.localSeek}
              change={w.change}
            />
          )}
          <label>
            Delay (s)
            <input
              aria-label="Motion delay"
              type="number"
              min="0"
              step="0.01"
              value={range.start / 1000}
              onChange={(e) =>
                retime(
                  Math.round(Number(e.target.value) * 1000),
                  range.end - range.start,
                )
              }
            />
          </label>
          <label>
            Duration (s)
            <input
              aria-label="Motion duration"
              type="number"
              min="0.001"
              step="0.01"
              value={(range.end - range.start) / 1000}
              onChange={(e) =>
                retime(range.start, Math.round(Number(e.target.value) * 1000))
              }
            />
          </label>
          <label>
            Trigger
            <select
              aria-label="Motion trigger"
              value={w.active}
              onChange={(e) =>
                w.moveBlockToClick(
                  w.active,
                  range.block.id,
                  Number(e.target.value),
                  false,
                )
              }
            >
              {motion!.stages.map((s, i) => (
                <option key={s.id} value={i}>
                  {i === 0 ? "Slide start" : `Click ${i}`}
                </option>
              ))}
              <option value={motion!.stages.length}>+ New click</option>
            </select>
          </label>
          <label>
            Easing
            <select
              aria-label="Animation easing"
              value={blockMotionEase(stage!, range.block)}
              onChange={(e) => {
                const ease = motionEaseFromName(
                  e.target.value as Exclude<NamedMotionEase, "Custom">,
                );
                w.change((m) => {
                  const next = structuredClone(m!);
                  for (const member of range.block.members) {
                    const t = next.stages[w.active].tracks.find(
                      (t) => t.id === member.trackId,
                    )!;
                    const a = t.keyframes.findIndex(
                        (k) => k.id === member.fromKeyframeId,
                      ),
                      b = t.keyframes.findIndex(
                        (k) => k.id === member.toKeyframeId,
                      );
                    for (let i = a; i < b; i++)
                      t.keyframes[i].easeToNext = ease;
                  }
                  return next;
                });
              }}
            >
              <option value="Custom" disabled>
                Custom
              </option>
              {motionEaseNames.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              w.change((m) =>
                editMotionBlock(
                  m!,
                  w.active,
                  range.block.id,
                  w.active,
                  stageDuration(m!.stages[w.active]) + 1,
                  range.end - range.start,
                  true,
                ),
              )
            }
          >
            Duplicate animation
          </button>

          <button
            onClick={() =>
              w.change((m) => deleteMotionBlock(m!, w.active, range.block.id))
            }
          >
            Delete animation
          </button>
          <button
            onClick={() => w.previewBlock(motion!, w.active, range.block.id)}
          >
            Preview
          </button>
        </>
      ) : picking ? (
        <>
          <button onClick={() => setPicking(false)}>← Motion</button>
          <h3>Add Motion</h3>
          {(["Presence", "Animate"] as const).map((intent) => (
            <div role="group" aria-label={intent} key={intent}>
              <h4>{intent}</h4>
              {(intent === "Animate"
                ? [...nativeAnimationNames]
                : ["Presence" as const]
              ).map((preset) => (
                <button
                  key={preset}
                  aria-label={preset}
                  disabled={!w.selection.elementIds.length}
                  onClick={() => {
                    setPicking(false);
                    w.add(preset);
                  }}
                >
                  {preset.split(" ")[0]}
                </button>
              ))}
            </div>
          ))}
        </>
      ) : (
        <>
          <p>
            {w.selection.elementIds.length === 1 && controller.snapshot
              ? (findElement(
                  controller.snapshot.slide,
                  w.selection.elementIds[0],
                )?.name ?? "Element")
              : "Select an Element"}
          </p>
          <h4>Applied</h4>
          {motion?.stages.flatMap((s, index) =>
            (s.blocks ?? [])
              .filter((b) => !isEffectTriggerBlock(s, b))
              .filter(
                (b) =>
                  (b.binding?.kind === "presence" &&
                    w.selection.elementIds.includes(b.binding.elementId)) ||
                  b.members.some((member) =>
                    w.selection.elementIds.includes(
                      s.tracks.find((t) => t.id === member.trackId)!.elementId,
                    ),
                  ),
              )
              .map((b) => {
                const r = blockRange(motion, index, b.id);
                return (
                  <button key={b.id} onClick={() => w.selectBlock(index, b.id)}>
                    {b.label}
                    <small>
                      {" "}
                      · {index === 0 ? "Slide start" : `Click ${index}`}
                      {!b.presenceSchedule &&
                        ` · ${((r.end - r.start) / 1000).toFixed(2)} s`}
                    </small>
                  </button>
                );
              }),
          )}
          <button
            disabled={!w.selection.elementIds.length}
            onClick={() => setPicking(true)}
          >
            + Add Motion
          </button>
        </>
      )}
      <button onClick={() => w.setOpen(true)}>Click Timeline</button>
    </section>
  );
}
