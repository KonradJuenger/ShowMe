import { mix } from "motion";
import type { Slide } from "./document";
import type { Element } from "./element";
import {
  motionPropertyDescriptor,
  unavailable,
} from "./elementPropertyDescriptors";
import { walkElements } from "./element";
import { uid } from "./ids";
import {
  slideMotionSchema,
  stageDuration,
  type MotionValue,
  type MotionEase,
  type MotionTrack,
  type MotionBlock,
  type MotionStage,
  type SlideMotion,
} from "./motionModel";
export { stageDuration } from "./motionModel";

export function resolveMotionValue(value: MotionValue, base: number): number {
  switch (value.type) {
    case "base":
      return base;
    case "absolute":
      return value.value;
    case "offset":
      return base + value.value;
    case "factor":
      return base * value.value;
  }
}
export { motionEasing, easeProgress } from "./motionEasing";
import { easeProgress } from "./motionEasing";
export const motionEaseNames = [
  "Linear",
  "Ease In",
  "Ease Out",
  "Ease In Out",
  "Hold",
] as const;
export type NamedMotionEase = (typeof motionEaseNames)[number] | "Custom";
export function motionEaseFromName(
  name: Exclude<NamedMotionEase, "Custom">,
): MotionEase {
  switch (name) {
    case "Linear":
      return "linear";
    case "Hold":
      return "hold";
    case "Ease In":
      return [0.42, 0, 1, 1];
    case "Ease Out":
      return [0, 0, 0.58, 1];
    case "Ease In Out":
      return [0.42, 0, 0.58, 1];
  }
}
export function namedMotionEase(ease: MotionEase = "linear"): NamedMotionEase {
  for (const name of motionEaseNames) {
    const standard = motionEaseFromName(name);
    if (
      ease === standard ||
      (Array.isArray(ease) &&
        Array.isArray(standard) &&
        ease.every((v, i) => v === standard[i]))
    )
      return name;
  }
  return "Custom";
}
/** Only outgoing segments inside each member range contribute to the inspector. */
export function blockMotionEase(
  stage: MotionStage,
  block: MotionBlock,
): NamedMotionEase {
  if (block.effectSchedule)
    return namedMotionEase(block.effectSchedule.progressEasing ?? "linear");
  const names = block.members.flatMap((member) => {
    const track = stage.tracks.find((t) => t.id === member.trackId)!;
    const from = track.keyframes.findIndex(
      (k) => k.id === member.fromKeyframeId,
    );
    const to = track.keyframes.findIndex((k) => k.id === member.toKeyframeId);
    return track.keyframes
      .slice(from, to)
      .map((k) => namedMotionEase(k.easeToNext));
  });
  return names.length && names.every((name) => name === names[0])
    ? names[0]
    : "Custom";
}
function sample(
  track: MotionTrack,
  base: number,
  entering: number,
  time: number,
) {
  const keys = track.keyframes;
  if (time < keys[0].at) return entering;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i],
      b = keys[i + 1];
    if (time === a.at) return resolveMotionValue(a.value, base);
    if (time < b.at) {
      const from = resolveMotionValue(a.value, base),
        to = resolveMotionValue(b.value, base);
      return mix(
        from,
        to,
        easeProgress((time - a.at) / (b.at - a.at), a.easeToNext),
      );
    }
  }
  return resolveMotionValue(keys[keys.length - 1].value, base);
}
export type MotionOverlay = Record<
  string,
  Partial<Record<MotionTrack["property"], number>>
>;
/** Pure, sparse overlay. Canonical Elements are never modified. stageIndex=-1 is slide entry. */
export function resolveMotion(
  slide: Slide,
  stageIndex: number,
  stageTime: number,
): MotionOverlay {
  const result: MotionOverlay = {};
  if (!slide.motion) return result;
  const elements = new Map(
    walkElements(slide.nodes.flatMap((r) => r.children)).map((e) => [e.id, e]),
  );
  const seen = new Set<string>();
  for (const stage of slide.motion.stages)
    for (const track of stage.tracks) {
      const key = `${track.elementId}:${track.property}`,
        element = elements.get(track.elementId);
      if (!element || seen.has(key)) continue;
      seen.add(key);
      const base =
        motionPropertyDescriptor(
          element,
          track.property,
          slide.effectResources,
        )?.read(element) ?? unavailable;
      if (base !== unavailable && track.initial)
        (result[element.id] ??= {})[track.property] = resolveMotionValue(
          track.initial,
          base,
        );
    }
  for (let i = 0; i <= stageIndex && i < slide.motion.stages.length; i++) {
    for (const track of slide.motion.stages[i].tracks) {
      const element = elements.get(track.elementId);
      if (!element) continue;
      const base =
        motionPropertyDescriptor(
          element,
          track.property,
          slide.effectResources,
        )?.read(element) ?? unavailable;
      if (base === unavailable) continue;
      const values = (result[element.id] ??= {});
      const time = i < stageIndex ? Infinity : Math.max(0, stageTime);
      values[track.property] = sample(
        track,
        base,
        values[track.property] ?? base,
        time,
      );
    }
  }
  return result;
}
export function motionElement(
  element: Element,
  overlay: MotionOverlay,
): Element {
  const values = overlay[element.id];
  if (!values) return element;
  const frame = { ...element.frame },
    appearance = { ...element.appearance };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (key === "appearance.opacity")
      appearance.opacity = Math.max(0, Math.min(1, value));
    else if (key.startsWith("transform.")) {
      const field = key.slice(10) as
        "x" | "y" | "rotation" | "scaleX" | "scaleY";
      frame[field] = value;
    }
  }
  return { ...element, frame, appearance };
}

export const motionDefaults = {
  duration: 400,
  distance: 120,
  scale: 0.85,
  rotation: 25,
  ease: [0.25, 0.1, 0.25, 1] as MotionEase,
};

/** Parameter blocks are ordinary keyframe ranges, including effects-only stages. */
export function addParameterAnimation(
  input: SlideMotion | undefined,
  stageIndex: number,
  elementId: string,
  property: MotionTrack["property"],
  label: string,
  from: number,
  to: number,
  duration: number,
  initial = false,
) {
  if (
    ![from, to, duration].every(Number.isFinite) ||
    duration < 1 ||
    duration > 86400000
  )
    throw new Error("Enter finite values and a duration from 1 to 86400000 ms");
  const motion = structuredClone(input ?? { stages: [] });
  while (motion.stages.length <= stageIndex)
    motion.stages.push({ id: uid(), tracks: [] });
  const stage = motion.stages[stageIndex];
  let track = stage.tracks.find(
    (t) => t.elementId === elementId && t.property === property,
  );
  if (!track) {
    track = { id: uid(), elementId, property, keyframes: [] };
    stage.tracks.push(track);
  }
  const start = track.keyframes.length ? track.keyframes.at(-1)!.at + 1 : 0;
  if (start + duration > 86400000)
    throw new Error("Animation exceeds maximum stage time");
  if (track.keyframes.length) track.keyframes.at(-1)!.easeToNext = "hold";
  else if (
    initial &&
    !motion.stages
      .slice(0, stageIndex)
      .some((s) =>
        s.tracks.some(
          (t) => t.elementId === elementId && t.property === property,
        ),
      )
  )
    track.initial = { type: "absolute", value: from };
  const a = {
      id: uid(),
      at: start,
      value: { type: "absolute" as const, value: from },
    },
    b = {
      id: uid(),
      at: start + Math.round(duration),
      value: { type: "absolute" as const, value: to },
    };
  track.keyframes.push(a, b);
  (stage.blocks ??= []).push({
    id: uid(),
    label,
    members: [{ trackId: track.id, fromKeyframeId: a.id, toKeyframeId: b.id }],
  });
  return slideMotionSchema.parse(motion);
}
export const motionPresetRecipes = [
  { id: "fade-in", label: "Fade In", family: "fade", entrance: true },
  { id: "move-in", label: "Move In", family: "move", entrance: true },
  { id: "scale-in", label: "Scale In", family: "scale", entrance: true },
  { id: "rotate-in", label: "Rotate In", family: "rotate", entrance: true },
  { id: "fade-out", label: "Fade Out", family: "fade", entrance: false },
  { id: "move-out", label: "Move Out", family: "move", entrance: false },
  { id: "scale-out", label: "Scale Out", family: "scale", entrance: false },
  { id: "rotate-out", label: "Rotate Out", family: "rotate", entrance: false },
] as const;
export type MotionPresetId = (typeof motionPresetRecipes)[number]["id"];
export const nativeAnimationNames = [
  "Move",
  "Scale",
  "Rotate",
  "Fade",
  "Pulse",
] as const;
export type MotionPreset = (typeof nativeAnimationNames)[number];
export type MoveDirection = "Left" | "Right" | "Up" | "Down";
export type RotateDirection = "Clockwise" | "Counter-clockwise";
export type MotionPresetSettings =
  | { family: "fade"; presetId: MotionPresetId }
  | {
      family: "move";
      presetId: MotionPresetId;
      direction: MoveDirection;
      distance: number;
    }
  | { family: "scale"; presetId: MotionPresetId; scale: number }
  | {
      family: "rotate";
      presetId: MotionPresetId;
      direction: RotateDirection;
      angle: number;
    };
type PresetSpec = {
  property: MotionTrack["property"];
  from: MotionValue;
  to: MotionValue;
};
const base: MotionValue = { type: "base" };
export function presetSpecs(
  recipe: (typeof motionPresetRecipes)[number],
  settings?: MotionPresetSettings,
): PresetSpec[] {
  const hidden: { property: MotionTrack["property"]; value: MotionValue }[] =
    [];
  if (recipe.family === "move") {
    const direction = settings?.family === "move" ? settings.direction : "Left";
    const distance =
      settings?.family === "move" ? settings.distance : motionDefaults.distance;
    hidden.push({
      property:
        direction === "Left" || direction === "Right"
          ? "transform.x"
          : "transform.y",
      value: {
        type: "offset",
        value: (direction === "Left" || direction === "Up" ? -1 : 1) * distance,
      },
    });
  } else if (recipe.family === "scale") {
    for (const property of ["transform.scaleX", "transform.scaleY"] as const)
      hidden.push({
        property,
        value: {
          type: "factor",
          value:
            settings?.family === "scale"
              ? settings.scale
              : motionDefaults.scale,
        },
      });
  } else if (recipe.family === "rotate") {
    const clockwise =
      settings?.family !== "rotate" || settings.direction === "Clockwise";
    const angle =
      settings?.family === "rotate" ? settings.angle : motionDefaults.rotation;
    // Positive rotation travels clockwise; Entrance travels FROM the offset.
    hidden.push({
      property: "transform.rotation",
      value: {
        type: "offset",
        value: (clockwise ? 1 : -1) * (recipe.entrance ? -1 : 1) * angle,
      },
    });
  }
  hidden.push({
    property: "appearance.opacity",
    value: { type: "absolute", value: 0 },
  });
  return hidden.map(({ property, value }) => ({
    property,
    from: recipe.entrance ? value : base,
    to: recipe.entrance ? base : value,
  }));
}
export function addMotionPreset(
  input: SlideMotion | undefined,
  stageIndex: number,
  elementIds: readonly string[],
  preset: MotionPreset,
): SlideMotion {
  const motion = structuredClone(
    input ?? { stages: [{ id: uid(), tracks: [] }] },
  );
  const stage = motion.stages[stageIndex];
  if (!stage) throw new Error("Unknown stage");
  if (!nativeAnimationNames.includes(preset)) throw new Error("Unknown preset");
  const specs: PresetSpec[] =
    preset === "Move"
      ? [
          {
            property: "transform.x",
            from: base,
            to: { type: "offset", value: motionDefaults.distance },
          },
          { property: "transform.y", from: base, to: base },
        ]
      : preset === "Scale" || preset === "Pulse"
        ? ["transform.scaleX", "transform.scaleY"].map((property) => ({
            property: property as MotionTrack["property"],
            from: base,
            to:
              preset === "Pulse"
                ? base
                : { type: "factor" as const, value: 1.15 },
          }))
        : preset === "Rotate"
          ? [
              {
                property: "transform.rotation",
                from: base,
                to: { type: "offset", value: motionDefaults.rotation },
              },
            ]
          : [
              {
                property: "appearance.opacity",
                from: base,
                to: { type: "absolute", value: 0.5 },
              },
            ];
  // Align multi-selection and leave one millisecond between authored runs.
  const start = Math.max(
    0,
    ...stage.tracks
      .filter(
        (t) =>
          elementIds.includes(t.elementId) &&
          specs.some((s) => s.property === t.property),
      )
      .map((t) => (t.keyframes.at(-1)?.at ?? 0) + 1),
  );
  for (const elementId of elementIds) {
    const block: MotionBlock = {
      id: uid(),
      label: preset,
      members: [],
    };
    for (const spec of specs) {
      let track = stage.tracks.find(
        (t) => t.elementId === elementId && t.property === spec.property,
      );
      if (!track) {
        track = {
          id: uid(),
          elementId,
          property: spec.property,
          keyframes: [],
        };
        stage.tracks.push(track);
      }
      if (track.keyframes.length)
        track.keyframes[track.keyframes.length - 1].easeToNext = "hold";
      const from = {
          id: uid(),
          at: start,
          value: spec.from,
          easeToNext: motionDefaults.ease,
        },
        to = { id: uid(), at: start + motionDefaults.duration, value: spec.to };
      track.keyframes.push(
        from,
        ...(preset === "Pulse"
          ? [
              {
                id: uid(),
                at: start + motionDefaults.duration / 2,
                value: { type: "factor" as const, value: 1.15 },
                easeToNext: motionDefaults.ease,
              },
            ]
          : []),
        to,
      );
      block.members.push({
        trackId: track.id,
        fromKeyframeId: from.id,
        toKeyframeId: to.id,
      });
    }
    (stage.blocks ??= []).push(block);
  }
  cleanInitial(motion);
  return slideMotionSchema.parse(motion);
}
export function blockRange(
  motion: SlideMotion,
  stageIndex: number,
  blockId: string,
) {
  const stage = motion.stages[stageIndex],
    block = stage.blocks?.find((b) => b.id === blockId);
  if (!block) throw new Error("Unknown block");
  if (block.presenceSchedule) {
    const schedule = block.presenceSchedule;
    return {
      block,
      start: schedule.startOffsetMs,
      end:
        schedule.startOffsetMs +
        (schedule.end.mode === "after"
          ? schedule.end.durationMs
          : Math.max(
              1,
              schedule.enterTransition.kind === "none"
                ? 0
                : schedule.enterTransition.durationMs,
            )),
    };
  }
  if (block.effectSchedule) {
    const schedule = block.effectSchedule;
    const duration =
      schedule.stop.mode === "after" ? schedule.stop.durationMs : 0;
    return {
      block,
      start: schedule.startOffsetMs,
      end: schedule.startOffsetMs + duration,
    };
  }
  const keys = block.members.flatMap((m) => {
    const t = stage.tracks.find((t) => t.id === m.trackId)!;
    return t.keyframes.slice(
      t.keyframes.findIndex((k) => k.id === m.fromKeyframeId),
      t.keyframes.findIndex((k) => k.id === m.toKeyframeId) + 1,
    );
  });
  return {
    start: Math.min(...keys.map((k) => k.at)),
    end: Math.max(...keys.map((k) => k.at)),
    block,
  };
}
function cleanInitial(motion: SlideMotion) {
  const seen = new Set<string>();
  for (const stage of motion.stages)
    for (const t of stage.tracks) {
      const key = `${t.elementId}:${t.property}`;
      if (seen.has(key)) delete t.initial;
      seen.add(key);
    }
}
export function editMotionBlock(
  input: SlideMotion,
  source: number,
  blockId: string,
  destination: number,
  start: number,
  duration: number,
  duplicate = false,
): SlideMotion {
  if (
    duplicate &&
    input.stages[source]?.blocks?.find((b) => b.id === blockId)?.binding
      ?.kind === "presence"
  )
    throw new Error("Add another Presence instead of duplicating its interval");
  const motion = structuredClone(input),
    src = motion.stages[source],
    dst = motion.stages[destination];
  if (!dst) throw new Error("Unknown stage");
  const range = blockRange(motion, source, blockId),
    members: MotionBlock["members"] = [];
  start = Math.max(0, Math.round(start));
  duration = Math.max(1, Math.round(duration));
  if (range.block.presenceSchedule) {
    range.block.presenceSchedule.startOffsetMs = start;
    if (range.block.presenceSchedule.end.mode === "after")
      range.block.presenceSchedule.end.durationMs = duration;
  }
  if (range.block.effectSchedule) {
    range.block.effectSchedule.startOffsetMs = start;
    if (range.block.effectSchedule.start)
      range.block.effectSchedule.start = "click";
    if (range.block.effectSchedule.stop.mode === "after")
      range.block.effectSchedule.stop.durationMs = duration;
  }
  for (const m of range.block.members) {
    const track = src.tracks.find((t) => t.id === m.trackId)!;
    const a = track.keyframes.findIndex((k) => k.id === m.fromKeyframeId),
      b = track.keyframes.findIndex((k) => k.id === m.toKeyframeId);
    const original = track.keyframes.slice(a, b + 1);
    const keys = original.map((k) => ({
      ...k,
      id: duplicate ? uid() : k.id,
      at:
        start +
        Math.round(
          ((k.at - range.start) * duration) / (range.end - range.start),
        ),
    }));
    const initial = track.initial;
    if (!duplicate) {
      track.keyframes.splice(a, b - a + 1);
      if (a === 0 && source !== destination) delete track.initial;
    }
    let target = dst.tracks.find(
      (t) => t.elementId === track.elementId && t.property === track.property,
    );
    if (!target) {
      target = {
        ...track,
        id: uid(),
        keyframes: [],
        ...(initial ? { initial } : {}),
      };
      dst.tracks.push(target);
    }
    const lo = keys[0].at,
      hi = keys[keys.length - 1].at;
    const existing = target.keyframes;
    // Also reject crossing a block whose endpoints lie outside the proposed run.
    if (
      existing.some((k) => k.at >= lo && k.at <= hi) ||
      existing.some(
        (k, i) =>
          existing[i + 1] &&
          k.at < hi &&
          existing[i + 1].at > lo &&
          k.easeToNext !== "hold",
      ) ||
      (existing.length > 0 &&
        existing[0].at < lo &&
        existing[existing.length - 1].at > hi &&
        (dst.blocks ?? []).some(
          (block) =>
            block.id !== blockId &&
            block.members.some(
              (member) =>
                member.trackId === target.id &&
                (() => {
                  const r = blockRange(motion, destination, block.id);
                  return r.start < hi && r.end > lo;
                })(),
            ),
        ))
    )
      throw new Error(
        "Animation overlaps another block. Move it to free time or another click.",
      );
    target.keyframes.push(...keys);
    target.keyframes.sort((a, b) => a.at - b.at);
    for (let i = 0; i < target.keyframes.length - 1; i++)
      if (target.keyframes[i].id === keys.at(-1)?.id)
        target.keyframes[i].easeToNext = "hold";
    members.push({
      trackId: target.id,
      fromKeyframeId: keys[0].id,
      toKeyframeId: keys[keys.length - 1].id,
    });
  }
  if (!duplicate) src.blocks = src.blocks?.filter((b) => b.id !== blockId);
  (dst.blocks ??= []).push({
    ...range.block,
    id: duplicate ? uid() : blockId,
    ...(duplicate && range.block.binding?.kind !== "presence"
      ? { binding: undefined }
      : {}),
    members,
  });
  for (const stage of motion.stages)
    stage.tracks = stage.tracks.filter((t) => t.keyframes.length);
  cleanInitial(motion);
  return slideMotionSchema.parse(motion);
}
export function deleteMotionBlock(
  input: SlideMotion,
  stageIndex: number,
  blockId: string,
  ungroup = false,
) {
  const motion = structuredClone(input),
    stage = motion.stages[stageIndex];
  const block = stage.blocks?.find((b) => b.id === blockId);
  if (!block) throw new Error("Unknown block");
  if (!ungroup)
    for (const member of block.members) {
      const t = stage.tracks.find((t) => t.id === member.trackId)!;
      const a = t.keyframes.findIndex((k) => k.id === member.fromKeyframeId),
        b = t.keyframes.findIndex((k) => k.id === member.toKeyframeId);
      const earliest = a === 0;
      t.keyframes.splice(a, b - a + 1);
      if (earliest) delete t.initial;
    }
  stage.blocks = stage.blocks?.filter((b) => b.id !== blockId);
  stage.tracks = stage.tracks.filter((t) => t.keyframes.length);
  return slideMotionSchema.parse(motion);
}
export function mergeMotionStages(input: SlideMotion, rightIndex: number) {
  if (rightIndex <= 0 || rightIndex >= input.stages.length)
    throw new Error("Enter cannot be removed");
  const motion = structuredClone(input),
    left = motion.stages[rightIndex - 1],
    right = motion.stages[rightIndex],
    shift = stageDuration(left);
  const remap = new Map<string, string>();
  for (const track of right.tracks) {
    const target = left.tracks.find(
      (t) => t.elementId === track.elementId && t.property === track.property,
    );
    const keys = track.keyframes.map((k) => ({ ...k, at: k.at + shift }));
    if (target) {
      remap.set(track.id, target.id);
      const last = target.keyframes.at(-1)!;
      last.easeToNext = "hold";
      // A cut at a shared boundary uses one ordinary millisecond, never duplicate timestamps.
      const adjustment = keys[0].at <= last.at ? last.at + 1 - keys[0].at : 0;
      target.keyframes.push(
        ...keys.map((k) => ({ ...k, at: k.at + adjustment })),
      );
    } else {
      left.tracks.push({ ...track, keyframes: keys });
      remap.set(track.id, track.id);
    }
  }
  left.blocks = [
    ...(left.blocks ?? []),
    ...(right.blocks ?? []).map((b) => ({
      ...b,
      members: b.members.map((m) => ({ ...m, trackId: remap.get(m.trackId)! })),
    })),
  ];
  for (const block of left.blocks ?? [])
    if (right.blocks?.some((b) => b.id === block.id)) {
      if (block.effectSchedule) block.effectSchedule.startOffsetMs += shift;
      if (block.presenceSchedule) block.presenceSchedule.startOffsetMs += shift;
    }
  // Removing an event gate would make an explicit time interval End ambiguous.
  if (
    motion.stages.some((s) =>
      s.blocks?.some(
        (b) =>
          (b.presenceSchedule?.end.mode === "click" &&
            b.presenceSchedule.end.stageId === right.id) ||
          (b.presenceSchedule?.end.mode === "next-click" &&
            motion.stages[motion.stages.indexOf(s) + 1]?.id === right.id) ||
          (b.effectSchedule?.stop.mode === "click" &&
            b.effectSchedule.stop.stageId === right.id) ||
          (b.effectSchedule?.stop.mode === "next-click" &&
            motion.stages[motion.stages.indexOf(s) + 1]?.id === right.id),
      ),
    )
  )
    throw new Error("Change Effect Stop before merging its click gate.");
  motion.stages.splice(rightIndex, 1);
  cleanInitial(motion);
  return slideMotionSchema.parse(motion);
}

export function filterMotion(
  input: SlideMotion | undefined,
  ids: ReadonlySet<string>,
): SlideMotion | undefined {
  if (!input) return undefined;
  const motion = structuredClone(input);
  for (const stage of motion.stages) {
    stage.tracks = stage.tracks.filter((t) => ids.has(t.elementId));
    const tracks = new Set(stage.tracks.map((t) => t.id));
    stage.blocks = stage.blocks?.flatMap((b) => {
      const members = b.members.filter((m) => tracks.has(m.trackId));
      return members.length || (b.binding && ids.has(b.binding.elementId))
        ? [{ ...b, members }]
        : [];
    });
  }
  return motion;
}
export function cloneMotion(
  input: SlideMotion | undefined,
  elementIds: ReadonlyMap<string, string>,
  newId: () => string = uid,
): SlideMotion | undefined {
  const motion = filterMotion(input, new Set(elementIds.keys()));
  if (!motion) return undefined;
  const ids = new Map<string, string>();
  const remap = (id: string) => {
    let next = ids.get(id);
    if (!next) {
      next = newId();
      ids.set(id, next);
    }
    return next;
  };
  for (const stage of motion.stages) {
    stage.id = remap(stage.id);
    for (const t of stage.tracks) {
      t.elementId = elementIds.get(t.elementId)!;
      t.id = remap(t.id);
      for (const k of t.keyframes) k.id = remap(k.id);
    }
    for (const b of stage.blocks ?? []) {
      b.id = remap(b.id);
      if (b.binding) b.binding.elementId = elementIds.get(b.binding.elementId)!;
      if (b.effectSchedule?.stop.mode === "click")
        b.effectSchedule.stop.stageId = remap(b.effectSchedule.stop.stageId);
      if (b.presenceSchedule?.end.mode === "click")
        b.presenceSchedule.end.stageId = remap(b.presenceSchedule.end.stageId);
      for (const m of b.members) {
        m.trackId = remap(m.trackId);
        m.fromKeyframeId = remap(m.fromKeyframeId);
        m.toKeyframeId = remap(m.toKeyframeId);
      }
    }
  }
  return motion;
}

/** Same-scope duplication and translation-only paste retain absolute visual paths. */
export function translateAbsoluteMotion(
  input: SlideMotion,
  offsets: ReadonlyMap<string, { x: number; y: number }>,
): SlideMotion {
  const motion = structuredClone(input);
  for (const stage of motion.stages)
    for (const track of stage.tracks) {
      const offset = offsets.get(track.elementId);
      const delta =
        track.property === "transform.x"
          ? offset?.x
          : track.property === "transform.y"
            ? offset?.y
            : undefined;
      if (delta === undefined) continue;
      for (const value of [
        track.initial,
        ...track.keyframes.map((k) => k.value),
      ])
        if (value?.type === "absolute") value.value += delta;
    }
  return motion;
}
