import { EFFECT_SCHEDULE_VERSION } from "./motionModel";
import { uid } from "./ids";
import { blockRange, editMotionBlock } from "./motion";
import { type ElementEffect, type EffectDefinition } from "./effects";
import {
  slideMotionSchema,
  type EffectSchedule,
  type SlideMotion,
} from "./motionModel";
/** Explicit Effect execution; category never infers choreography. */
export function addEffectTrigger(
  input: SlideMotion | undefined,
  stageIndex: number,
  elementId: string,
  instance: ElementEffect,
  definition: EffectDefinition,
) {
  if (
    input?.stages.some((s) =>
      s.blocks?.some(
        (b) =>
          b.binding?.kind === "effect" &&
          b.binding.elementId === elementId &&
          b.binding.effectInstanceId === instance.id,
      ),
    )
  )
    throw new Error("An Effect instance has one Click Timeline trigger");
  const next: SlideMotion = structuredClone(input ?? { stages: [] });
  const start = definition.timeControl.start;
  if (start !== "click") stageIndex = 0;
  const stop = structuredClone(definition.timeControl.stop);
  while (next.stages.length <= stageIndex)
    next.stages.push({ id: uid(), tracks: [], blocks: [] });
  (next.stages[stageIndex].blocks ??= []).push({
    id: uid(),
    label: definition.name,
    members: [],
    binding: { kind: "effect", elementId, effectInstanceId: instance.id },
    effectSchedule: {
      version: EFFECT_SCHEDULE_VERSION,
      start,
      startOffsetMs: 0,
      stop,
    },
  });
  return next;
}

/** Instance IDs are local to their Element, including duplicated Elements. */
export function findEffectTrigger(
  input: SlideMotion | undefined,
  elementId: string,
  instanceId: string,
) {
  for (const [index, stage] of (input?.stages ?? []).entries()) {
    const block = stage.blocks?.find(
      (block) =>
        block.binding?.kind === "effect" &&
        block.binding.elementId === elementId &&
        block.binding.effectInstanceId === instanceId,
    );
    if (block) return { index, id: block.id };
  }
  return undefined;
}

/** Schedule edits remain one semantic shared-timeline change. */
export function editEffectSchedule(
  input: SlideMotion,
  index: number,
  blockId: string,
  edit: (schedule: EffectSchedule) => void,
) {
  const next = structuredClone(input),
    stage = next.stages[index],
    target = stage.blocks!.find((b) => b.id === blockId)!;
  if (!target?.effectSchedule || target.binding?.kind !== "effect")
    throw new Error("Unknown Effect block");
  const value = target.effectSchedule;
  edit(value);
  if (value.start !== "click" && (index !== 0 || value.startOffsetMs !== 0)) {
    const range = blockRange(next, index, blockId);
    const schedule = { ...value, startOffsetMs: 0 };
    const moved = editMotionBlock(
      next,
      index,
      blockId,
      0,
      0,
      range.end - range.start,
    );
    moved.stages[0].blocks!.find(
      (block) => block.id === blockId,
    )!.effectSchedule = schedule;
    return slideMotionSchema.parse(moved);
  }
  return slideMotionSchema.parse(next);
}

/** The timed block interval drives both clock transport and finite progress. */
export function resizeEffectTime(
  input: SlideMotion,
  index: number,
  blockId: string,
  startMs: number,
  stop: EffectSchedule["stop"],
) {
  return editEffectSchedule(input, index, blockId, (s) => {
    s.startOffsetMs = Math.max(0, Math.round(startMs));
    s.start = "click";
    s.stop = stop;
  });
}
