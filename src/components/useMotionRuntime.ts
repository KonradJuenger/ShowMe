import {
  sampleEffectClocks,
  endEffectClocks,
  type EffectClockOrigins,
} from "../core/effectClocks";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { stageDuration } from "../core/motionModel";
import type { Slide } from "../core/document";
import type { MotionPreviewState } from "../core/motionPlayback";
import { effectSurface } from "./effectRuntime";
import {
  effectTiming,
  effectDependencies,
  compileEffectTiming,
  type EffectClocks,
} from "../core/effects";
import { walkElements } from "../core/element";
import { createMotionRuntime, type MotionRenderSink } from "./motionRuntime";

const stageOffsets = new WeakMap<NonNullable<Slide["motion"]>, number[]>();
function offsetsFor(slide: Slide) {
  if (!slide.motion) return [];
  let offsets = stageOffsets.get(slide.motion);
  if (!offsets) {
    offsets = [];
    let elapsed = 0;
    for (const stage of slide.motion.stages) {
      offsets.push(elapsed);
      elapsed += stageDuration(stage) / 1000;
    }
    stageOffsets.set(slide.motion, offsets);
  }
  return offsets;
}

/** DOM execution stays outside React render and the document authority. */
export function useMotionRuntime(
  root: RefObject<HTMLDivElement | null>,
  slide: Slide,
  state?: MotionPreviewState | null,
  continuous = false,
  origins?: EffectClockOrigins,
  bindingTopology?: object | null,
  renderer?: MotionRenderSink,
) {
  const hasOrigins = Boolean(origins);
  const origin = useRef({
    slideId: slide.id,
    slideStartedAt: Date.now(),
    presentationStartedAt: Date.now(),
  });
  if (origin.current.slideId !== slide.id)
    origin.current = {
      ...origin.current,
      slideId: slide.id,
      slideStartedAt: Date.now(),
    };
  const latest = useRef({
    state,
    origins,
    slide,
    fallbackOrigins: { ...origin.current },
  });
  // Retain the outgoing activation's transport until its disposal sample.
  if (
    latest.current.slide.id !== slide.id ||
    Boolean(latest.current.origins) !== Boolean(origins)
  )
    latest.current = {
      state,
      origins,
      slide,
      fallbackOrigins: { ...origin.current },
    };
  else Object.assign(latest.current, { state, origins, slide });
  const clocks = (
    transport = latest.current,
    now = Date.now(),
  ): EffectClocks => {
    const preview = transport.state;
    if (!transport.origins && preview) {
      const stepTime =
        Math.max(
          0,
          preview.time +
            (preview.running ? Math.max(0, now - preview.startedAt) : 0),
        ) / 1000;
      const offsets = offsetsFor(transport.slide);
      const prior = preview.effectClock
        ? preview.effectClock.stageStart / 1000
        : (offsets[Math.max(0, preview.stageIndex)] ?? 0);
      const stageStarts = preview.effectClock
        ? preview.effectClock.stageStarts.map((t) => t / 1000)
        : offsets;
      return {
        presentationTime: prior + stepTime,
        slideTime: prior + stepTime,
        stepTime,
        stepIndex: Math.max(0, preview.stageIndex),
        stageStarts,
      };
    }
    const value = transport.origins ?? transport.fallbackOrigins;
    const sampled = sampleEffectClocks(
      {
        ...value,
        stepIndex:
          transport.state?.stageIndex ??
          ("stepIndex" in value ? value.stepIndex : 0),
        stepStartedAt:
          ("stepStartedAt" in value ? value.stepStartedAt : undefined) ??
          transport.state?.startedAt ??
          value.slideStartedAt,
      },
      now,
    );
    const offsets =
      "stageStartedOffsets" in value ? value.stageStartedOffsets : undefined;
    return offsets
      ? { ...sampled, stageStarts: offsets.map((offset) => offset / 1000) }
      : sampled;
  };
  useLayoutEffect(() => {
    if (!root.current || !continuous) return;
    const transport = latest.current;
    const nodes = Array.from(
      root.current.querySelectorAll<HTMLElement>("[data-effect-id]"),
    );
    const elements = new Map(
      walkElements(transport.slide.nodes.flatMap((r) => r.children)).map(
        (e) => [e.id, e],
      ),
    );
    const bindings = nodes.flatMap((node) => {
      const element = elements.get(
        node.closest<HTMLElement>("[data-element-id]")?.dataset.elementId ?? "",
      );
      const instance = element?.effects?.find(
        (i) => i.id === node.dataset.effectId,
      );
      const surface = effectSurface(node);
      return element && instance && surface
        ? [{ element, instance, surface }]
        : [];
    });
    return () => {
      const endedAt =
        latest.current.slide.id !== transport.slide.id
          ? (latest.current.origins?.slideStartedAt ?? Date.now())
          : Date.now();
      const finalClocks = endEffectClocks(clocks(transport, endedAt));
      for (const { element, instance, surface } of bindings) {
        const definition =
          transport.slide.effectResources?.[instance.resourceId];
        surface.setTiming(
          effectTiming(
            transport.slide.motion,
            transport.state?.stageIndex ?? 0,
            transport.state?.time ?? 0,
            element.id,
            instance.id,
            finalClocks,
            definition?.timeControl,
          ),
        );
      }
    };
    // Only activation disposal is an end event; accepted edits and clock ticks are not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, slide.id, continuous, Boolean(origins)]);
  const sampleEffects = useRef<(() => void) | null>(null);
  const clockReader = useRef(clocks);
  clockReader.current = clocks;
  useLayoutEffect(() => {
    if (!root.current) return;
    const elements = new Map(
      walkElements(slide.nodes.flatMap((r) => r.children)).map((e) => [
        e.id,
        e,
      ]),
    );
    const bindings = Array.from(
      root.current.querySelectorAll<HTMLElement>("[data-effect-id]"),
    ).flatMap((node) => {
      const element = elements.get(
        node.closest<HTMLElement>("[data-element-id]")?.dataset.elementId ?? "",
      );
      const instance = element?.effects?.find(
        (i) => i.id === node.dataset.effectId,
      );
      const definition =
        instance && slide.effectResources?.[instance.resourceId];
      const surface = effectSurface(node);
      return element && instance && definition && surface
        ? [
            {
              element,
              instance,
              surface,
              node: node.closest<HTMLElement>("[data-element-id]"),
              deps: effectDependencies(definition),
              definition,
              timing: compileEffectTiming(
                slide.motion,
                element.id,
                instance.id,
                definition.timeControl,
              ),
            },
          ]
        : [];
    });
    const hasPresence = Boolean(
      slide.motion?.stages.some((stage) =>
        stage.blocks?.some((block) => block.presenceSchedule),
      ),
    );
    if (
      !bindings.length &&
      (!hasOrigins ||
        !slide.motion?.stages.some((s) =>
          s.blocks?.some((b) => b.presenceSchedule),
        ))
    )
      return;
    let frame = 0;
    const update = () => {
      let needsFrame = false;
      const playback = latest.current.state;
      if (latest.current.origins)
        runtime.current?.samplePresence(
          (clockReader.current().stepTime ?? 0) * 1000,
        );
      for (const {
        node,
        surface,
        deps,
        definition,
        timing: compiled,
      } of bindings) {
        if (node?.closest('[data-presentation-absent="true"]')) continue;
        const timing = compiled.sample(
          playback?.stageIndex ?? 0,
          runtime.current?.time ?? playback?.time ?? 0,
          clockReader.current(),
        );
        surface.setTiming(timing);
        const range = compiled.range;
        const start = range?.schedule.start ?? definition.timeControl.start;
        const delayedStart =
          !timing.started &&
          (start !== "click" ||
            (range !== undefined &&
              (playback?.stageIndex ?? 0) >= range.stageIndex));
        needsFrame ||=
          deps.continuous || (deps.progress && timing.running) || delayedStart;
      }
      if (
        continuous &&
        (needsFrame || hasPresence) &&
        latest.current.origins?.pausedAt === undefined
      )
        frame = requestAnimationFrame(update);
    };
    sampleEffects.current = () => {
      cancelAnimationFrame(frame);
      update();
    };
    update();
    return () => {
      sampleEffects.current = null;
      cancelAnimationFrame(frame);
    };
  }, [root, slide, continuous, hasOrigins, origins?.pausedAt]);
  useLayoutEffect(() => {
    sampleEffects.current?.();
  }, [state]);
  const runtime = useRef<ReturnType<typeof createMotionRuntime> | null>(null);
  const stageIndex = state?.stageIndex;
  useLayoutEffect(() => {
    if (!root.current || stageIndex === undefined || !slide.motion) return;
    const instance = createMotionRuntime(
      root.current,
      slide,
      stageIndex,
      () => clockReader.current(),
      renderer,
    );
    runtime.current = instance;
    return () => {
      instance.cancel();
      runtime.current = null;
    };
  }, [root, slide, stageIndex, continuous, bindingTopology, renderer]);
  useLayoutEffect(() => {
    if (state) runtime.current?.sync(state);
  }, [state, slide, bindingTopology]);
}
