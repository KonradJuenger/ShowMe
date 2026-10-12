import { z } from "zod";

export const transitionTimingSchema = z
  .object({
    durationMs: z.number().finite().min(0).max(60000),
    easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
  })
  .strict();
export const transitionKindSchema = z.enum(["none", "fade", "push", "wipe"]);
export const transitionDefaultsSchema = transitionTimingSchema.extend({
  kind: transitionKindSchema,
});
export const slideTransitionSchema = z
  .object({
    kind: transitionKindSchema.optional(),
    durationMs: transitionTimingSchema.shape.durationMs.optional(),
    easing: transitionTimingSchema.shape.easing.optional(),
  })
  .strict();
export type SlideTransition = z.infer<typeof slideTransitionSchema>;
export type TransitionDefaults = z.infer<typeof transitionDefaultsSchema>;
export type TransitionTiming = z.infer<typeof transitionTimingSchema>;
export const DEFAULT_TRANSITION_TIMING: TransitionTiming = {
  durationMs: 100,
  easing: "linear",
};
export const DEFAULT_TRANSITION: TransitionDefaults = {
  ...DEFAULT_TRANSITION_TIMING,
  kind: "none",
};
export type ResolvedSlideTransition = Required<SlideTransition>;
export interface SlideTransitionPlayback extends ResolvedSlideTransition {
  fromSlideId: string;
  toSlideId: string;
  /** Undefined while the incoming composition is preparing. */
  startedAt?: number;
}
export function resolveSlideTransition(
  transition: SlideTransition | undefined,
  defaults: TransitionDefaults = DEFAULT_TRANSITION,
): ResolvedSlideTransition {
  return {
    kind: transition?.kind ?? defaults.kind,
    durationMs: transition?.durationMs ?? defaults.durationMs,
    easing: transition?.easing ?? defaults.easing,
  };
}
