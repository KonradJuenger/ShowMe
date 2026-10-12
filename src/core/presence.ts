import { PRESENCE_SCHEDULE_VERSION } from "./motionModel";
import type { Element } from "./element";
import type { EffectClocks } from "./effects";
import { uid } from "./ids";
import {
  easeProgress,
  motionDefaults,
  motionPresetRecipes,
  presetSpecs,
  resolveMotionValue,
  type MotionPresetSettings,
} from "./motion";
import {
  slideMotionSchema,
  transitionDuration,
  type SlideMotion,
  type PresenceSchedule,
  type PresenceTransition,
} from "./motionModel";

export function defaultPresenceTransition(
  kind: PresenceTransition["kind"] = "none",
): PresenceTransition {
  return {
    kind,
    durationMs: motionDefaults.duration,
    easing: motionDefaults.ease,
  };
}
export function addPresence(
  input: SlideMotion | undefined,
  index: number,
  elementIds: readonly string[],
) {
  const motion = structuredClone(
    input ?? { stages: [{ id: uid(), tracks: [] }] },
  );
  for (const elementId of elementIds)
    (motion.stages[index].blocks ??= []).push({
      id: uid(),
      label: "Presence",
      binding: { kind: "presence", elementId },
      members: [],
      presenceSchedule: {
        version: PRESENCE_SCHEDULE_VERSION,
        startOffsetMs: 0,
        end: { mode: "none" },
        enterTransition: defaultPresenceTransition(),
        exitTransition: defaultPresenceTransition(),
      },
    });
  return slideMotionSchema.parse(motion);
}
export function editPresenceSchedule(
  input: SlideMotion,
  index: number,
  id: string,
  edit: (s: PresenceSchedule) => void,
) {
  const next = structuredClone(input);
  const schedule = next.stages[index].blocks?.find(
    (b) => b.id === id,
  )?.presenceSchedule;
  if (!schedule) throw new Error("Unknown Presence block");
  edit(schedule);
  return slideMotionSchema.parse(next);
}
export type PresenceSample = {
  present: boolean;
  phase: "absent" | "entering" | "present" | "exiting";
  transitionProgress: number;
  transition?: PresenceTransition;
  entrance?: boolean;
  exitFrom?: { transition: PresenceTransition; progress: number };
};
const absent: PresenceSample = {
  present: false,
  phase: "absent",
  transitionProgress: 0,
};
const present: PresenceSample = {
  present: true,
  phase: "present",
  transitionProgress: 1,
};
/** End is the exit trigger; disappearance follows it by the exit duration.
 * Only recorded past gate origins are used. No future click is assigned a time. */
export function sampleElementPresence(
  motion: SlideMotion | undefined,
  elementId: string,
  stageIndex: number,
  timeMs: number,
  clocks?: EffectClocks,
): PresenceSample {
  const intervals = (motion?.stages ?? []).flatMap((stage, index) =>
    (stage.blocks ?? []).flatMap((b) =>
      b.binding?.kind === "presence" &&
      b.binding.elementId === elementId &&
      b.presenceSchedule
        ? [{ index, s: b.presenceSchedule }]
        : [],
    ),
  );
  if (!intervals.length) return present;
  const elapsed = (index: number) =>
    index === stageIndex
      ? timeMs
      : clocks?.stageStarts?.[index] !== undefined
        ? (clocks.slideTime - clocks.stageStarts[index]) * 1000
        : Infinity;
  // The latest reached Enter owns the lifecycle, even after it has ended.
  intervals.sort(
    (a, b) => b.index - a.index || b.s.startOffsetMs - a.s.startOffsetMs,
  );
  for (const { index, s } of intervals) {
    if (stageIndex < index || elapsed(index) < s.startOffsetMs) continue;
    const age = elapsed(index) - s.startOffsetMs;
    const end = s.end;
    const gate =
      end.mode === "click"
        ? motion!.stages.findIndex((stage) => stage.id === end.stageId)
        : index + 1;
    const exitAge =
      end.mode === "after"
        ? age - end.durationMs
        : (end.mode === "click" || end.mode === "next-click") &&
            stageIndex >= gate
          ? elapsed(gate)
          : end.mode === "slide-end" && clocks?.slideEnd !== undefined
            ? (clocks.slideTime - clocks.slideEnd.slideTime) * 1000
            : -1;
    if (exitAge >= 0) {
      const duration = transitionDuration(s.exitTransition);
      if (exitAge < duration)
        return {
          present: true,
          phase: "exiting",
          transitionProgress: exitAge / duration,
          transition: s.exitTransition,
          entrance: false,
          exitFrom: {
            transition: s.enterTransition,
            progress: Number.isFinite(age - exitAge)
              ? Math.min(
                  1,
                  (age - exitAge) /
                    (transitionDuration(s.enterTransition) || 1),
                )
              : 1,
          },
        };
      return absent;
    }
    const duration = transitionDuration(s.enterTransition);
    if (age < duration)
      return {
        present: true,
        phase: "entering",
        transitionProgress: age / duration,
        transition: s.enterTransition,
        entrance: true,
      };
    return present;
  }
  return absent;
}
/** Sample the same canonical recipes against the already animated Element.
 * Offsets/factors remain relative; opacity is a multiplier, never lifecycle state. */
export function presenceElement(
  element: Element,
  sample: PresenceSample,
): Element {
  if (sample.exitFrom && sample.transition) {
    const from = presenceElement(element, {
      present: true,
      phase: "entering",
      entrance: true,
      transition: sample.exitFrom.transition,
      transitionProgress: sample.exitFrom.progress,
    });
    const to = presenceElement(element, {
      ...sample,
      exitFrom: undefined,
      transitionProgress: 1,
    });
    const p = easeProgress(sample.transitionProgress, sample.transition.easing);
    return {
      ...element,
      frame: {
        ...element.frame,
        ...Object.fromEntries(
          (["x", "y", "rotation", "scaleX", "scaleY"] as const).map((key) => [
            key,
            from.frame[key] * (1 - p) + to.frame[key] * p,
          ]),
        ),
      },
      appearance: {
        ...element.appearance,
        opacity: from.appearance.opacity * (1 - p) + to.appearance.opacity * p,
      },
    };
  }
  const t = sample.transition;
  if (!t || t.kind === "none") return element;
  const recipe = motionPresetRecipes.find(
    (r) => r.family === t.kind && r.entrance === sample.entrance,
  )!;
  const settings = (
    t.kind === "fade"
      ? { family: "fade", presetId: recipe.id }
      : t.kind === "move"
        ? {
            family: "move",
            presetId: recipe.id,
            direction: t.direction ?? "Left",
            distance: t.distance ?? motionDefaults.distance,
          }
        : t.kind === "scale"
          ? {
              family: "scale",
              presetId: recipe.id,
              scale: t.scale ?? motionDefaults.scale,
            }
          : {
              family: "rotate",
              presetId: recipe.id,
              direction: t.direction ?? "Clockwise",
              angle: t.angle ?? motionDefaults.rotation,
            }
  ) as MotionPresetSettings;
  const p = easeProgress(sample.transitionProgress, t.easing);
  const result = {
    ...element,
    frame: { ...element.frame },
    appearance: { ...element.appearance },
  };
  for (const spec of presetSpecs(recipe, settings)) {
    const key = spec.property;
    const base =
      key === "appearance.opacity"
        ? element.appearance.opacity
        : element.frame[
            key.slice(10) as "x" | "y" | "rotation" | "scaleX" | "scaleY"
          ];
    const value =
      resolveMotionValue(spec.from, base) * (1 - p) +
      resolveMotionValue(spec.to, base) * p;
    if (key === "appearance.opacity") result.appearance.opacity = value;
    else
      result.frame[
        key.slice(10) as "x" | "y" | "rotation" | "scaleX" | "scaleY"
      ] = value;
  }
  return result;
}
