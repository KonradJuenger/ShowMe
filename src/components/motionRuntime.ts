import { sampleElementPresence, presenceElement } from "../core/presence";
import {
  animate,
  motionValue,
  styleEffect,
  type MotionValue,
  type StyleTransitions,
} from "motion";
import type { Slide } from "../core/document";
import { presentationSpan } from "./presentationDiagnostics";
import {
  IDENTITY,
  localMatrix,
  multiply,
  walkElements,
  type Matrix,
} from "../core/element";
import {
  motionPropertyDescriptor,
  unavailable,
} from "../core/elementPropertyDescriptors";
import {
  motionEasing,
  resolveMotion,
  resolveMotionValue,
  motionElement,
} from "../core/motion";
import { stageDuration } from "../core/motionModel";
import { effectSurface, flushEffectSurfaces } from "./effectRuntime";
import {
  numericEffectParameters,
  effectTiming,
  effectProperty,
  type EffectClocks,
} from "../core/effects";
import { motionTime, type MotionPlaybackState } from "../core/motionPlayback";

/** A completed semantic sample. The renderer consumes it without another clock
 * or a readback of Motion's DOM writes. Frames remain in document coordinates. */
export type MotionVisualSample = {
  elementId: string;
  frame: import("../core/element").Element["frame"];
  opacity: number;
  present: boolean;
};
export interface MotionRenderSink {
  ownsOpacity?(elementId: string): boolean;
  apply(samples: readonly MotionVisualSample[]): void;
  reset(): void;
}

/** Compile ordinary ShowMe tracks. Delayed first keys are hard cuts, not tweens
 * from the entering state. Pad each property to the stage's common clock. */
export function compileMotionStage(slide: Slide, stageIndex: number) {
  const stage = slide.motion?.stages[stageIndex];
  if (!stage) return [];
  const duration = stageDuration(stage);
  const entering = resolveMotion(slide, stageIndex - 1, Infinity);
  const elements = new Map(
    walkElements(slide.nodes.flatMap((r) => r.children)).map((e) => [e.id, e]),
  );
  const parents = new Map<string, string | null>();
  const indexParents = (
    children: readonly import("../core/element").Element[],
    parentId: string | null,
  ) =>
    children.forEach((child) => {
      parents.set(child.id, parentId);
      indexParents(child.children, child.id);
    });
  slide.nodes.forEach((root) => indexParents(root.children, null));
  const semanticWorldTransform = (
    id: string,
    overlay: ReturnType<typeof resolveMotion>,
  ) => {
    const chain: string[] = [];
    for (let current: string | null | undefined = id; current; )
      chain.push(current), (current = parents.get(current));
    let matrix: Matrix = IDENTITY;
    for (const elementId of chain.reverse()) {
      const element = elements.get(elementId);
      if (!element) continue;
      matrix = multiply(
        matrix,
        localMatrix(motionElement(element, overlay).frame),
      );
    }
    return new DOMMatrix([...matrix]);
  };
  return stage.tracks.flatMap((track) => {
    const element = elements.get(track.elementId);
    if (!element) return [];
    const base =
      motionPropertyDescriptor(
        element,
        track.property,
        slide.effectResources,
      )?.read(element) ?? unavailable;
    if (base === unavailable) return [];
    const keys = track.keyframes;
    const values = keys.map((k) => resolveMotionValue(k.value, base));
    const times = keys.map((k) => k.at);
    const ease = keys.slice(0, -1).map((k) => motionEasing(k.easeToNext));
    if (times[0] > 0) {
      values.unshift(entering[element.id]?.[track.property] ?? base);
      times.unshift(0);
      ease.unshift(motionEasing("hold"));
    }
    if (times[times.length - 1] < duration) {
      values.push(values[values.length - 1]);
      times.push(duration);
      ease.push(motionEasing());
    }
    return [
      {
        elementId: element.id,
        property: track.property,
        values,
        times: times.map((t) => (duration ? t / duration : 0)),
        ease,
        duration,
      },
    ];
  });
}

/** Motion owns independent curves and batches local transform composition. */
export function createMotionRuntime(
  root: HTMLElement,
  slide: Slide,
  stageIndex: number,
  clocks?: () => EffectClocks,
  renderer?: MotionRenderSink,
) {
  const finish = presentationSpan("motion-runtime-create", slide.id, {
    stageIndex,
  });
  const elements = new Map(
    walkElements(slide.nodes.flatMap((r) => r.children)).map((e) => [e.id, e]),
  );
  const nodes = new Map(
    Array.from(root.querySelectorAll<HTMLElement>("[data-element-id]")).map(
      (n) => [n.dataset.elementId!, n],
    ),
  );
  const propertyNames = {
    "transform.x": "x",
    "transform.y": "y",
    "transform.rotation": "rotate",
    "transform.scaleX": "scaleX",
    "transform.scaleY": "scaleY",
    "appearance.opacity": "opacity",
  } as const;
  const duration = slide.motion?.stages[stageIndex]
    ? stageDuration(slide.motion.stages[stageIndex])
    : 0;
  const compiled = compileMotionStage(slide, stageIndex);
  const initial = resolveMotion(slide, stageIndex, 0);
  const bindings = new Map<
    string,
    {
      node: HTMLElement;
      visual: HTMLElement;
      renderedAlpha: boolean;
      originalVisualOpacity: string;
      values: Record<string, MotionValue<number>>;
      original: {
        transform: string;
        opacity: string;
        willChange: string;
        alphaProperty?: string;
        alpha: string;
      };
      detach: () => void;
    }
  >();
  const presenceIds = new Set(
    slide.motion?.stages.flatMap((s) =>
      (s.blocks ?? []).flatMap((b) =>
        b.binding?.kind === "presence" ? [b.binding.elementId] : [],
      ),
    ) ?? [],
  );
  let localTime = 0;
  let presenceFrame = 0;
  const visibility = new Map<
    string,
    {
      visibility: string;
      pointerEvents: string;
      contentVisibility: string;
      inert: boolean;
    }
  >();
  const visualSample = (
    id: string,
    overlay: ReturnType<typeof resolveMotion>,
  ): MotionVisualSample => {
    const presence = sampleElementPresence(
      slide.motion,
      id,
      stageIndex,
      localTime,
      clocks?.(),
    );
    const element = presenceElement(
      motionElement(elements.get(id)!, overlay),
      presence,
    );
    return {
      elementId: id,
      frame: element.frame,
      opacity: element.appearance.opacity,
      present: presence.present,
    };
  };
  const valuesFor = ({ elementId, frame: f, opacity }: MotionVisualSample) => {
    const base = elements.get(elementId)!.frame;
    return {
      x: f.x - base.x,
      y: f.y - base.y,
      rotate: f.rotation,
      scaleX: (f.flipX ? -1 : 1) * f.scaleX,
      scaleY: (f.flipY ? -1 : 1) * f.scaleY,
      opacity,
    };
  };
  for (const id of new Set([...Object.keys(initial), ...presenceIds])) {
    const node = nodes.get(id);
    if (!node || !elements.has(id)) continue;
    const values = Object.fromEntries(
      Object.entries(valuesFor(visualSample(id, initial))).map(
        ([key, value]) => [key, motionValue(value)],
      ),
    );
    visibility.set(id, {
      visibility: node.style.visibility,
      pointerEvents: node.style.pointerEvents,
      contentVisibility: node.style.contentVisibility,
      inert: node.inert,
    });
    const original = {
      transform: node.style.transform,
      opacity: node.style.opacity,
      willChange: node.style.willChange,
      alphaProperty: node.dataset.nativeOpacity,
      alpha: node.dataset.nativeOpacity
        ? node.style.getPropertyValue(node.dataset.nativeOpacity)
        : "",
    };
    if (compiled.some((track) => track.elementId === id))
      node.style.willChange = "transform";
    const visual =
      node.querySelector<HTMLElement>(":scope > [data-composition-visual]") ??
      node;
    const originalVisualOpacity = visual.style.opacity;
    const renderedAlpha = renderer?.ownsOpacity?.(id) ?? false;
    const { opacity, ...transport } = values;
    const detachTransport = styleEffect(
      node,
      original.alphaProperty
        ? { ...transport, [original.alphaProperty]: values.opacity }
        : visual === node && !renderedAlpha
          ? values
          : transport,
    );
    const detachAlpha =
      visual === node ? () => {} : styleEffect(visual, { opacity });
    const detach = () => {
      detachTransport();
      detachAlpha();
    };
    styleEffect.flush(node);
    if (visual !== node) styleEffect.flush(visual);
    bindings.set(id, {
      node,
      visual,
      renderedAlpha,
      originalVisualOpacity,
      values,
      original,
      detach,
    });
  }
  const controls = Array.from(bindings).flatMap(([id, binding]) => {
    const targets: Record<string, number[]> = {};
    const transitions: StyleTransitions = {};
    for (const track of compiled.filter(
      (t) => t.elementId === id && !presenceIds.has(id),
    )) {
      if (!duration) continue;
      if (!(track.property in propertyNames)) continue;
      const name = propertyNames[track.property as keyof typeof propertyNames];
      const frame = elements.get(id)!.frame;
      targets[name] = track.values.map((value) =>
        name === "x"
          ? value - frame.x
          : name === "y"
            ? value - frame.y
            : name === "scaleX"
              ? value * (frame.flipX ? -1 : 1)
              : name === "scaleY"
                ? value * (frame.flipY ? -1 : 1)
                : value,
      );
      transitions[name] = {
        duration: duration / 1000,
        times: track.times,
        ease: track.ease,
        autoplay: false,
      };
    }
    const alpha = targets.opacity;
    if ((binding.visual !== binding.node || binding.renderedAlpha) && alpha) {
      delete targets.opacity;
      return [
        animate(binding.values.opacity, alpha, transitions.opacity),
        ...(Object.keys(targets).length
          ? [animate(binding.node, targets, transitions)]
          : []),
      ];
    }
    return Object.keys(targets).length
      ? [animate(binding.node, targets, transitions)]
      : [];
  });
  const effectBindings = Array.from(
    root.querySelectorAll<HTMLElement>("[data-effect-id]"),
  ).flatMap((node) => {
    const elementId =
      node.closest<HTMLElement>("[data-element-id]")?.dataset.elementId;
    const element = elementId && elements.get(elementId);
    const surface = effectSurface(node);
    const instance =
      element && element.effects?.find((e) => e.id === node.dataset.effectId);
    const definition = instance && slide.effectResources?.[instance.resourceId];
    if (!element || !surface || !instance || !definition) return [];
    const values = numericEffectParameters(definition).map((parameter) => {
      const property = effectProperty(instance.id, parameter.key);
      const value = motionValue(
        initial[element.id]?.[property] ??
          (typeof instance.parameters[parameter.key] === "number"
            ? (instance.parameters[parameter.key] as number)
            : undefined) ??
          parameter.default,
      );
      const detach = value.on("change", (latest) =>
        surface.set(parameter.key, latest),
      );
      const track = compiled.find(
        (t) => t.elementId === element.id && t.property === property,
      );
      if (track && duration)
        controls.push(
          animate(value, track.values, {
            duration: duration / 1000,
            times: track.times,
            ease: track.ease,
            autoplay: false,
          }),
        );
      return { property, parameter, value, detach };
    });
    return [{ element, instance, surface, values }];
  });
  const clock = motionValue(0);
  // Effects-only stages still have the same presentation clock.
  const detachClock = clock.on("change", (time) => {
    const overlay = resolveMotion(slide, stageIndex, time);
    effectBindings.forEach(({ element, instance, surface }) => {
      surface.setTransport(semanticWorldTransform(element.id, overlay));
      surface.setTiming(
        effectTiming(
          slide.motion,
          stageIndex,
          time,
          element.id,
          instance.id,
          clocks?.(),
          slide.effectResources?.[instance.resourceId]?.timeControl,
        ),
      );
    });
  });
  if (duration && (!controls.length || effectBindings.length))
    controls.push(
      animate(clock, [0, duration], {
        duration: duration / 1000,
        ease: "linear",
        autoplay: false,
      }),
    );
  const materialize = (time: number, presenceOnly = false) => {
    localTime = time;
    const overlay = resolveMotion(slide, stageIndex, time);
    const samples: MotionVisualSample[] = [];
    bindings.forEach((binding, id) => {
      if (presenceOnly && !presenceIds.has(id) && !renderer) return;
      const sample = visualSample(id, overlay);
      if (renderer) samples.push(sample);
      if (presenceOnly && !presenceIds.has(id)) return;
      if (presenceIds.has(id)) {
        binding.node.style.visibility = sample.present
          ? visibility.get(id)!.visibility
          : "hidden";
        binding.node.style.pointerEvents = sample.present
          ? visibility.get(id)!.pointerEvents
          : "none";
        binding.node.style.contentVisibility = sample.present
          ? visibility.get(id)!.contentVisibility
          : "hidden";
        binding.node.inert = sample.present ? visibility.get(id)!.inert : true;
        if (binding.node.dataset.presentationAbsent !== String(!sample.present))
          binding.node.dataset.presentationAbsent = String(!sample.present);
      }
      Object.entries(valuesFor(sample)).forEach(([name, value]) =>
        binding.values[name].set(value),
      );
      styleEffect.flush(binding.node);
      if (binding.visual !== binding.node) styleEffect.flush(binding.visual);
    });
    renderer?.apply(samples);
    effectBindings.forEach(({ element, surface }) =>
      surface.setTransport(semanticWorldTransform(element.id, overlay)),
    );
    if (presenceOnly) return;
    effectBindings.forEach(({ element, instance, surface, values }) => {
      if (
        !sampleElementPresence(
          slide.motion,
          element.id,
          stageIndex,
          time,
          clocks?.(),
        ).present
      )
        return;
      values.forEach(({ property, parameter, value }) => {
        const sample =
          overlay[element.id]?.[property] ??
          (typeof instance.parameters[parameter.key] === "number"
            ? (instance.parameters[parameter.key] as number)
            : undefined) ??
          parameter.default;
        value.set(sample);
        surface.set(parameter.key, sample);
      });
      surface.setTiming(
        effectTiming(
          slide.motion,
          stageIndex,
          time,
          element.id,
          instance.id,
          clocks?.(),
          slide.effectResources?.[instance.resourceId]?.timeControl,
        ),
      );
    });
    void flushEffectSurfaces(root);
  };
  finish();
  return {
    samplePresence(time: number) {
      if (presenceIds.size) materialize(time, true);
    },
    get controlCount() {
      return controls.length;
    },
    get time() {
      return presenceIds.size ? localTime : (controls[0]?.time ?? 0) * 1000;
    },
    sync(state: MotionPlaybackState, now = Date.now()) {
      const synced = presentationSpan("motion-sync", slide.id, {
        stageIndex,
        running: state.running,
        time: motionTime(state, duration, now),
        duration,
      });
      const time = motionTime(state, duration, now);
      for (const control of controls) {
        control.pause();
        control.time = time / 1000;
        if (time >= duration) control.complete();
        else if (state.running) control.play();
      }
      const sampleTime =
        state.time + (state.running ? Math.max(0, now - state.startedAt) : 0);
      materialize(sampleTime);
      cancelAnimationFrame(presenceFrame);
      if ((presenceIds.size || renderer) && state.running) {
        const tick = () => {
          materialize(
            state.time + Math.max(0, Date.now() - state.startedAt),
            true,
          );
          presenceFrame = requestAnimationFrame(tick);
        };
        presenceFrame = requestAnimationFrame(tick);
      }
      synced();
    },
    pause() {
      controls.forEach((c) => c.pause());
      const seconds = controls[0]?.time ?? 0;
      controls.forEach((c) => {
        c.time = seconds;
      });
      materialize(seconds * 1000);
    },
    play() {
      controls.forEach((c) => c.play());
    },
    complete() {
      controls.forEach((c) => c.complete());
      materialize(duration);
    },
    cancel() {
      cancelAnimationFrame(presenceFrame);
      // cancel() rewinds to the first key and schedules a DOM write. Stop the
      // controls so that a queued rewind cannot overwrite the restored frame.
      controls.forEach((c) => c.stop());
      effectBindings.forEach(({ surface, values }) => {
        values.forEach(({ value, detach }) => {
          detach();
          value.destroy();
        });
        surface.reset();
      });
      detachClock();
      clock.destroy();
      bindings.forEach(
        ({ node, visual, originalVisualOpacity, values, original, detach }) => {
          detach();
          Object.values(values).forEach((value) => value.destroy());
          node.style.transform = original.transform;
          node.style.opacity = original.opacity;
          if (original.alphaProperty) {
            if (original.alpha)
              node.style.setProperty(original.alphaProperty, original.alpha);
            else node.style.removeProperty(original.alphaProperty);
          }
          node.style.willChange = original.willChange;
          if (visual !== node) visual.style.opacity = originalVisualOpacity;
          const saved = visibility.get(node.dataset.elementId!);
          if (saved) {
            node.style.visibility = saved.visibility;
            node.style.pointerEvents = saved.pointerEvents;
            node.style.contentVisibility = saved.contentVisibility;
            node.inert = saved.inert;
          }
          delete node.dataset.presentationAbsent;
        },
      );
      renderer?.reset();
    },
  };
}
