import { z } from "zod/v4";
import type { DocumentProjection } from "./documentProjection";
import {
  effectSlideSeed,
  sampleEffectClocks,
  type EffectClockOrigins,
} from "./effectClocks";
import { enterMotion, navigateMotion, previewInterval } from "./motionPlayback";
import { stageDuration } from "./motionModel";
import { resolveVisualSlide } from "./templates";

const time = z.number().finite().nonnegative().max(86400000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const agentSampleTraceSchema = z
  .object({
    presentationOriginMs: time,
    activationMs: time,
    clickTimesMs: z.array(time).max(99),
    captureTimeMs: time,
    previousSlideId: id.optional(),
  })
  .strict();
export const agentPreviewSampleSchema = z.discriminatedUnion("mode", [
  agentSampleTraceSchema.extend({ mode: z.literal("timeline") }),
  agentSampleTraceSchema.extend({ mode: z.literal("finite-complete") }),
  z
    .object({
      mode: z.literal("transition"),
      previousSlideId: id,
      elapsedMs: time,
      incoming: agentSampleTraceSchema,
      outgoing: agentSampleTraceSchema,
    })
    .strict(),
]);
export type AgentPreviewSample = z.infer<typeof agentPreviewSampleSchema>;
export type AgentSampleTrace = z.infer<typeof agentSampleTraceSchema>;

/** Resolve one coherent event trace with the same stage navigation and clocks as playback. */
export function resolveAgentTimelineSample(
  projection: DocumentProjection,
  trace: AgentSampleTrace,
  complete = false,
) {
  const slide = resolveVisualSlide(
    projection.deck,
    projection.slide,
    projection.templates ?? {},
  ).slide;
  const starts = [trace.activationMs, ...trace.clickTimesMs];
  if (
    trace.presentationOriginMs > trace.activationMs ||
    trace.captureTimeMs < starts.at(-1)! ||
    starts.some((value, index) => index > 0 && value <= starts[index - 1])
  )
    throw new Error(
      "Use strictly increasing reached click times, after activation and no later than capture; presentation origin must precede activation.",
    );
  if (
    trace.previousSlideId &&
    !projection.deck.slideIds.includes(trace.previousSlideId)
  )
    throw new Error("The previous slide is not in this deck.");
  const stages =
    slide.motion?.stages.map((stage) => ({
      id: stage.id,
      duration: stageDuration(stage),
    })) ?? [];
  let state = enterMotion(stages, trace.activationMs);
  for (const click of trace.clickTimesMs) {
    if (!state) throw new Error("This slide has no further click stage.");
    state = navigateMotion(state, stages, "next", click) ?? undefined;
    if (!state) throw new Error("The trace reaches a nonexistent click stage.");
  }
  const index = state?.stageIndex ?? 0,
    stepStartedAt = starts[index];
  const origins: EffectClockOrigins = {
    presentationStartedAt: trace.presentationOriginMs,
    slideStartedAt: trace.activationMs,
    stepStartedAt,
    stepIndex: index,
    pausedAt: trace.captureTimeMs,
    stageStartedOffsets: starts.map((value) => value - trace.activationMs),
    slideIndex: projection.deck.slideIds.indexOf(slide.id),
    slideCount: projection.deck.slideIds.length,
    slideSeed: effectSlideSeed(slide.id),
    previousSlideIndex: projection.deck.slideIds.indexOf(
      trace.previousSlideId ?? slide.id,
    ),
    previousSlideSeed: effectSlideSeed(trace.previousSlideId ?? slide.id),
  };
  const playback = state
    ? {
        ...state,
        time: trace.captureTimeMs - stepStartedAt,
        startedAt: trace.captureTimeMs,
        running: false,
      }
    : undefined;
  if (complete && slide.motion && playback) {
    const interval = previewInterval(
      slide.motion,
      {
        ...playback,
        effectClock: {
          stageStart: stepStartedAt - trace.activationMs,
          stageStarts: starts.map((value) => value - trace.activationMs),
        },
      },
      trace.captureTimeMs,
    );
    if (playback.time < interval.duration)
      throw new Error(
        `Finite completion requires captureTimeMs at least ${stepStartedAt + interval.duration}; future click and slide-end stops remain unresolved.`,
      );
  }
  return {
    origins,
    playback,
    metadata: {
      mode: complete ? ("finite-complete" as const) : ("timeline" as const),
      trace,
      stageId: state?.stageId ?? null,
      stageIndex: index,
      stageTimeMs: trace.captureTimeMs - stepStartedAt,
      clocks: {
        ...sampleEffectClocks(origins, trace.captureTimeMs),
        stageStarts: starts.map((value) => (value - trace.activationMs) / 1000),
      },
      video: "static-poster" as const,
    },
  };
}
