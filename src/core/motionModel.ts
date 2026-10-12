import {
  motionPropertyDescriptor,
  unavailable,
} from "./elementPropertyDescriptors";
import { z } from "zod";
import { idSchema } from "./ids";
import type { Element } from "./element";
import type { ElementPropertyId } from "./elementProperties";
import {
  parseEffectProperty,
  isReservedEffectParameter,
  type EffectResources,
  type EffectProperty,
} from "./effects";

export const EFFECT_SCHEDULE_VERSION = 1 as const;
export const PRESENCE_SCHEDULE_VERSION = 1 as const;

export const motionProperties = [
  "transform.x",
  "transform.y",
  "transform.rotation",
  "transform.scaleX",
  "transform.scaleY",
  "appearance.opacity",
] as const satisfies readonly ElementPropertyId[];
export type MotionProperty = (typeof motionProperties)[number] | EffectProperty;
export const motionValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("base") }).strict(),
  ...(["absolute", "offset", "factor"] as const).map((type) =>
    z.object({ type: z.literal(type), value: z.number().finite() }).strict(),
  ),
]);
export const motionEaseSchema = z.union([
  z.literal("linear"),
  z.literal("hold"),
  z.tuple([
    z.number().min(0).max(1),
    z.number().finite(),
    z.number().min(0).max(1),
    z.number().finite(),
  ]),
]);
export const motionKeyframeSchema = z
  .object({
    id: idSchema,
    at: z.number().int().nonnegative().max(86400000),
    value: motionValueSchema,
    easeToNext: motionEaseSchema.optional(),
  })
  .strict();
export const motionTrackSchema = z
  .object({
    id: idSchema,
    elementId: idSchema,
    property: z.union([
      z.enum(motionProperties),
      z
        .string()
        .refine(
          (address) =>
            !!parseEffectProperty(address) &&
            !isReservedEffectParameter(parseEffectProperty(address)!.key),
          "Invalid effect property",
        )
        .transform((address) => address as EffectProperty),
    ]),
    initial: motionValueSchema.optional(),
    keyframes: z.array(motionKeyframeSchema).min(1).max(10000),
  })
  .strict();
export const effectScheduleSchema = z
  .object({
    version: z.literal(EFFECT_SCHEDULE_VERSION),
    start: z.enum(["presentation", "slide", "click"]),
    startOffsetMs: z.number().int().nonnegative().max(86400000),
    stop: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }).strict(),
      z.object({ mode: z.literal("next-click") }).strict(),
      z.object({ mode: z.literal("slide-end") }).strict(),
      z.object({ mode: z.literal("click"), stageId: idSchema }).strict(),
      z
        .object({
          mode: z.literal("after"),
          durationMs: z.number().int().positive().max(86400000),
        })
        .strict(),
    ]),
    progressEasing: motionEaseSchema.optional(),
  })
  .strict();
export type EffectSchedule = z.infer<typeof effectScheduleSchema>;
export const presenceTransitionSchema = z
  .object({
    kind: z.enum(["none", "fade", "move", "scale", "rotate"]),
    durationMs: z.number().int().nonnegative().max(86400000),
    easing: motionEaseSchema,
    direction: z
      .enum(["Left", "Right", "Up", "Down", "Clockwise", "Counter-clockwise"])
      .optional(),
    distance: z.number().finite().nonnegative().optional(),
    scale: z.number().finite().nonnegative().optional(),
    angle: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const presenceScheduleSchema = z
  .object({
    version: z.literal(PRESENCE_SCHEDULE_VERSION),
    startOffsetMs: z.number().int().nonnegative().max(86400000),
    end: effectScheduleSchema.shape.stop,
    enterTransition: presenceTransitionSchema,
    exitTransition: presenceTransitionSchema,
  })
  .strict()
  .refine(
    (s) => s.end.mode !== "slide-end" || s.exitTransition.kind === "none",
    "Slide end only supports Exit None",
  );
export type PresenceSchedule = z.infer<typeof presenceScheduleSchema>;
export type PresenceTransition = z.infer<typeof presenceTransitionSchema>;
export function transitionDuration(t: PresenceTransition) {
  return t.kind === "none" ? 0 : t.durationMs;
}
export const motionBlockSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(200),
    binding: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("effect"),
            elementId: idSchema,
            effectInstanceId: idSchema,
          })
          .strict(),
        z.object({ kind: z.literal("presence"), elementId: idSchema }).strict(),
      ])
      .optional(),
    presenceSchedule: presenceScheduleSchema.optional(),
    effectSchedule: effectScheduleSchema.optional(),
    members: z
      .array(
        z
          .object({
            trackId: idSchema,
            fromKeyframeId: idSchema,
            toKeyframeId: idSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const slideMotionSchema = z
  .object({
    stages: z
      .array(
        z
          .object({
            id: idSchema,
            tracks: z.array(motionTrackSchema).max(10000),
            blocks: z.array(motionBlockSchema).max(10000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((motion, ctx) => {
    const ids = new Set<string>(),
      seen = new Set<string>();
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const unique = (id: string) => {
      if (ids.has(id)) fail("Duplicate Motion ID");
      ids.add(id);
    };
    for (const stage of motion.stages) {
      unique(stage.id);
      const properties = new Set<string>();
      for (const track of stage.tracks) {
        unique(track.id);
        const key = `${track.elementId}:${track.property}`;
        if (properties.has(key)) fail("Competing property tracks");
        properties.add(key);
        if (seen.has(key) && track.initial)
          fail("Only the earliest track may define initial");
        seen.add(key);
        let last = -1;
        for (const k of track.keyframes) {
          unique(k.id);
          if (k.at <= last) fail("Keyframe times must be sorted and unique");
          last = k.at;
        }
      }
      const ranges = new Map<string, [number, number][]>();
      for (const block of stage.blocks ?? []) {
        unique(block.id);
        if (
          !block.members.length &&
          !block.effectSchedule &&
          !block.presenceSchedule
        )
          fail("Empty Motion block");
        if (block.binding?.kind === "effect" && !block.effectSchedule)
          fail("Effect binding requires a schedule");
        if (block.effectSchedule) {
          const schedule = block.effectSchedule;
          if (block.binding?.kind !== "effect")
            fail("Effect schedule requires an Effect binding");
          const end = schedule.stop;
          if (
            end.mode === "click" &&
            !motion.stages
              .slice(
                (schedule.start && schedule.start !== "click"
                  ? 0
                  : motion.stages.indexOf(stage)) + 1,
              )
              .some((s) => s.id === end.stageId)
          )
            fail("Effect Stop must reference a later click");
        }
        if (block.presenceSchedule) {
          if (
            block.binding?.kind !== "presence" ||
            block.members.length ||
            block.effectSchedule
          )
            fail("Presence requires its own binding and no property tracks");
          const end = block.presenceSchedule.end;
          if (
            end.mode === "click" &&
            !motion.stages
              .slice(motion.stages.indexOf(stage) + 1)
              .some((s) => s.id === end.stageId)
          )
            fail("Presence End must reference a later click");
        } else if (block.binding?.kind === "presence")
          fail("Presence binding requires a schedule");
        for (const member of block.members) {
          const track = stage.tracks.find((t) => t.id === member.trackId);
          const from =
            track?.keyframes.findIndex((k) => k.id === member.fromKeyframeId) ??
            -1;
          const to =
            track?.keyframes.findIndex((k) => k.id === member.toKeyframeId) ??
            -1;
          if (from < 0 || to <= from) {
            fail("Dangling or invalid block range");
            continue;
          }
          const previous = ranges.get(member.trackId) ?? [];
          if (previous.some(([a, b]) => from <= b && to >= a))
            fail("Overlapping block ranges");
          previous.push([from, to]);
          ranges.set(member.trackId, previous);
        }
      }
    }
    const intervals = motion.stages.flatMap((stage, index) =>
      (stage.blocks ?? []).flatMap((b) =>
        b.presenceSchedule && b.binding?.kind === "presence"
          ? [{ index, id: b.binding.elementId, s: b.presenceSchedule }]
          : [],
      ),
    );
    intervals.sort(
      (a, b) => a.index - b.index || a.s.startOffsetMs - b.s.startOffsetMs,
    );
    for (let i = 0; i < intervals.length; i++) {
      const a = intervals[i],
        end = a.s.end;
      const gate =
        end.mode === "click"
          ? motion.stages.findIndex((s) => s.id === end.stageId)
          : end.mode === "next-click"
            ? a.index + 1
            : end.mode === "after"
              ? a.index
              : Infinity;
      const time =
        (end.mode === "after" ? a.s.startOffsetMs + end.durationMs : 0) +
        transitionDuration(a.s.exitTransition);
      for (const b of intervals.slice(i + 1))
        if (
          a.id === b.id &&
          (b.index < gate || (b.index === gate && b.s.startOffsetMs < time))
        )
          fail(
            "Presence intervals overlap; move or end the existing interval first",
          );
    }
  });
export type SlideMotion = z.infer<typeof slideMotionSchema>;
export type MotionStage = SlideMotion["stages"][number];
export type MotionTrack = MotionStage["tracks"][number];
export type MotionBlock = z.infer<typeof motionBlockSchema>;
export type MotionValue = z.infer<typeof motionValueSchema>;
export type MotionEase = z.infer<typeof motionEaseSchema>;
export function validateMotionTargets(
  motion: SlideMotion,
  elements: readonly Element[],
  resources?: EffectResources,
) {
  const ids = new Set(elements.map((e) => e.id));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const bindings = new Set<string>();
  for (const stage of motion.stages) {
    for (const block of stage.blocks ?? []) {
      if (!block.binding) continue;
      const binding = block.binding;
      if (binding.kind === "presence") {
        if (!ids.has(binding.elementId))
          throw new Error("Dangling Presence Element target");
        continue;
      }
      const key = binding.elementId + ":" + binding.effectInstanceId;
      if (bindings.has(key))
        throw new Error("An effect instance has one timing block");
      bindings.add(key);
      if (
        !byId
          .get(binding.elementId)
          ?.effects?.some((e) => e.id === binding.effectInstanceId)
      )
        throw new Error("Dangling effect block binding");
      if (
        block.members.some((member) => {
          const track = stage.tracks.find((t) => t.id === member.trackId);
          return (
            track?.elementId !== binding.elementId ||
            parseEffectProperty(track.property)?.instanceId !==
              binding.effectInstanceId
          );
        })
      )
        throw new Error("Effect block members must target its bound instance");
    }
  }
  for (const stage of motion.stages)
    for (const track of stage.tracks) {
      const element = byId.get(track.elementId);
      const descriptor =
        element && motionPropertyDescriptor(element, track.property, resources);
      if (
        !descriptor?.animation.motion ||
        !element ||
        descriptor.read(element) === unavailable
      )
        throw new Error("Motion property is unavailable");
    }
  if (motion.stages.some((s) => s.tracks.some((t) => !ids.has(t.elementId))))
    throw new Error("Dangling Motion Element target");
}
export function stageDuration(stage: MotionStage) {
  return Math.max(
    0,
    ...stage.tracks.map((t) => t.keyframes.at(-1)?.at ?? 0),
    ...(stage.blocks ?? []).map((b) =>
      b.presenceSchedule
        ? b.presenceSchedule.startOffsetMs +
          Math.max(
            transitionDuration(b.presenceSchedule.enterTransition),
            b.presenceSchedule.end.mode === "after"
              ? b.presenceSchedule.end.durationMs +
                  transitionDuration(b.presenceSchedule.exitTransition)
              : 0,
          )
        : b.effectSchedule
          ? b.effectSchedule.startOffsetMs +
            (b.effectSchedule.stop.mode === "after"
              ? b.effectSchedule.stop.durationMs
              : 0)
          : 0,
    ),
  );
}

/** The persisted scheduler is shared; Effect execution and Motion are siblings. */
export function isEffectTriggerBlock(stage: MotionStage, block: MotionBlock) {
  return (
    block.binding?.kind === "effect" ||
    block.members.some(
      (member) =>
        !!parseEffectProperty(
          stage.tracks.find((t) => t.id === member.trackId)?.property ?? "",
        ),
    )
  );
}
