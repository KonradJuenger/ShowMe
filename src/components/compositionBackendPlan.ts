import type { Deck, Slide } from "../core/document";
import type { CompositionPlan, VisualGroup } from "./compositionPlan";
import { presenceElement } from "../core/presence";
import { resolveMotionValue } from "../core/motion";
import {
  localMatrix,
  transformPoint,
  walkElements,
} from "../core/element";
import {
  compositorCapabilities,
  backdropStyleCapabilities,
} from "./compositionCapabilities";
import {
  planOwnedPrefixSurface,
  type PrefixSurfaceRef,
} from "./compositionSurface";
/** A native lowering is legal only if the backdrop stage and the group's entry
 * have identical paint inputs and bounds. Keep opaque CSS on the original path.
 * This is a backend capability check, never a different Effect representation. */
function nativeBackdropGroups(plan: CompositionPlan, slide: Slide, deck: Deck) {
  const eligible = new Map<string, { effectId: string; filter: string }>();
  if (deck.stylesheet) return eligible;
  const alphaMotion = new Set<string>();
  for (const stage of slide.motion?.stages ?? []) {
    for (const track of stage.tracks)
      if (track.property === "appearance.opacity")
        alphaMotion.add(track.elementId);
    for (const block of stage.blocks ?? [])
      if (block.binding?.kind === "presence")
        alphaMotion.add(block.binding.elementId);
  }
  for (const group of plan.groups.values()) {
    const element = group.element;
    // A rounded stage and an enclosing rounded overflow clip can rasterize
    // different boundary coverage. No rounded lowering is enabled without proof.
    if (
      element.appearance.fill ||
      element.appearance.radius ||
      element.geometry.type !== "rect" ||
      element.cssClasses?.length
    )
      continue;
    const stages = [...group.inputs];
    if (stages.length !== 1) continue;
    const [effectId, input] = stages[0];
    if (input.kind !== "styled" || !input.operation) continue;
    let safe = true;
    for (let parentId = group.parentId; parentId;) {
      const parent = plan.groups.get(parentId)!;
      const ancestor = parent.element;
      if (
        ancestor.appearance.opacity !== 1 ||
        alphaMotion.has(ancestor.id) ||
        ancestor.cssClasses?.length ||
        parent.inputs.size
      )
        safe = false;
      parentId = parent.parentId;
    }
    if (!safe) continue;
    const descendants = [...group.children];
    for (let i = 0; i < descendants.length; i++) {
      const child = descendants[i];
      if (child.inputs.size || child.element.cssClasses?.length) safe = false;
      descendants.push(...child.children);
    }
    if (!safe) continue;
    const instance = element.effects!.find((effect) => effect.id === effectId)!;
    const definition = slide.effectResources![instance.resourceId];
    const material = backdropStyleCapabilities(definition);
    if (!material?.nativeGroup) continue;
    const filter = material.filter;
    eligible.set(element.id, { effectId, filter });
  }
  return eligible;
}

export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
const bounds = (g: VisualGroup): Bounds => {
  const f = g.element.frame,
    m = localMatrix(f);
  const points = [
    { x: 0, y: 0 },
    { x: f.width, y: 0 },
    { x: 0, y: f.height },
    { x: f.width, y: f.height },
  ].map((p) => transformPoint(m, p));
  return {
    left: Math.min(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    right: Math.max(...points.map((p) => p.x)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
};
const overlap = (a: Bounds, b: Bounds, padding: number) =>
  a.left - padding < b.right + padding &&
  b.left - padding < a.right + padding &&
  a.top - padding < b.bottom + padding &&
  b.top - padding < a.bottom + padding;

/** Backdrop restoration implements mix(B,R,a) as R overlaid with B at
 * 1-alpha. Admission now asks the compositor for the semantic prefix surface;
 * source-type knowledge lives behind that boundary. The first prototype keeps
 * consumers top-level and disjoint so an earlier glass card cannot contribute
 * pixels to a later card's requested crop. */
function restorationPlan(
  plan: CompositionPlan,
  slide: Slide,
  deck: Deck,
  padding = 2,
) {
  if (deck.stylesheet) return null;

  const glass = new Set<string>(),
    envelopes = new Map<string, Bounds>();
  for (const group of plan.roots)
    envelopes.set(group.element.id, bounds(group));

  for (const group of plan.groups.values()) {
    const e = group.element;
    if (!group.inputs.size || group.parentId) continue;
    if (
      walkElements([e]).some(
        (child) =>
          child.cssClasses?.length ||
          (child.content && child.content.type !== "text") ||
          (child !== e && child.effects?.some((effect) => effect.enabled)),
      )
    )
      continue;
    if (
      group.inputs.size !== 1 ||
      !(e.appearance.fill || e.appearance.radius) ||
      e.geometry.type !== "rect" ||
      !e.clipChildren ||
      e.appearance.strokeWidth ||
      e.frame.rotation ||
      e.frame.scaleX !== 1 ||
      e.frame.scaleY !== 1 ||
      e.frame.flipX ||
      e.frame.flipY
    )
      continue;
    const [id, entry] = [...group.inputs][0],
      effect = e.effects!.find((instance) => instance.id === id)!,
      definition = slide.effectResources![effect.resourceId];
    if (
      definition.kind !== "css" ||
      effect.placement !== "content" ||
      entry.kind !== "styled" ||
      !entry.operation ||
      !entry.backdrop
    )
      continue;
    if (!backdropStyleCapabilities(definition)?.restoration) continue;
    glass.add(e.id);
  }
  if (!glass.size) return null;

  const rootFor = (id: string) => {
    let group = plan.groups.get(id);
    while (group?.parentId) group = plan.groups.get(group.parentId);
    return group;
  };

  // Consumer Motion changes only the crop/alpha. Expand the conservative crop
  // envelope without creating a second animation state. Unsupported consumer
  // transforms stay on the existing fallback route.
  for (const stage of slide.motion?.stages ?? []) {
    for (const track of stage.tracks) {
      const owner = rootFor(track.elementId);
      if (!owner || !glass.has(owner.element.id)) continue;
      if (track.property === "appearance.opacity") continue;
      if (
        owner.element.id !== track.elementId ||
        owner.element.frame.rotation ||
        owner.element.frame.scaleX !== 1 ||
        owner.element.frame.scaleY !== 1 ||
        !["transform.x", "transform.y"].includes(track.property) ||
        track.keyframes.some(
          (key) =>
            Array.isArray(key.easeToNext) &&
            (key.easeToNext[1] < 0 ||
              key.easeToNext[1] > 1 ||
              key.easeToNext[3] < 0 ||
              key.easeToNext[3] > 1),
        )
      ) {
        glass.delete(owner.element.id);
        continue;
      }
      const box = envelopes.get(owner.element.id)!;
      const axis = track.property === "transform.x" ? "x" : "y";
      const base = owner.element.frame[axis];
      for (const key of track.keyframes) {
        const value = resolveMotionValue(key.value, base);
        if (axis === "x") {
          box.left = Math.min(box.left, value);
          box.right = Math.max(box.right, value + owner.element.frame.width);
        } else {
          box.top = Math.min(box.top, value);
          box.bottom = Math.max(box.bottom, value + owner.element.frame.height);
        }
      }
    }

    for (const block of stage.blocks ?? []) {
      if (!block.binding || !("elementId" in block.binding)) continue;
      const group = rootFor(block.binding.elementId);
      if (!group || !glass.has(group.element.id)) continue;
      if (
        block.binding.kind !== "presence" ||
        group.element.id !== block.binding.elementId
      ) {
        glass.delete(group.element.id);
        continue;
      }
      const box = envelopes.get(group.element.id)!;
      for (const [transition, entrance] of [
        [block.presenceSchedule?.enterTransition, true],
        [block.presenceSchedule?.exitTransition, false],
      ] as const) {
        if (!transition) continue;
        if (
          !["none", "fade", "move"].includes(transition.kind) ||
          (Array.isArray(transition.easing) &&
            (transition.easing[1] < 0 ||
              transition.easing[1] > 1 ||
              transition.easing[3] < 0 ||
              transition.easing[3] > 1))
        ) {
          glass.delete(group.element.id);
          continue;
        }
        for (const progress of [0, 1]) {
          const moved = presenceElement(group.element, {
            present: true,
            phase: entrance ? "entering" : "exiting",
            entrance,
            transition,
            transitionProgress: progress,
          });
          box.left = Math.min(box.left, moved.frame.x);
          box.top = Math.min(box.top, moved.frame.y);
          box.right = Math.max(box.right, moved.frame.x + moved.frame.width);
          box.bottom = Math.max(box.bottom, moved.frame.y + moved.frame.height);
        }
      }
    }
  }

  for (const id of [...glass]) {
    const box = envelopes.get(id)!;
    if (
      box.right + padding <= 0 ||
      box.bottom + padding <= 0 ||
      box.left - padding >= deck.width ||
      box.top - padding >= deck.height
    )
      glass.delete(id);
  }

  // The prototype shares a lower prefix only where consumer cards are provably
  // disjoint. Otherwise an earlier card is part of the later card's backdrop.
  const conflicts = new Set<string>();
  const consumers = [...glass];
  for (let i = 0; i < consumers.length; i++)
    for (let j = i + 1; j < consumers.length; j++)
      if (
        overlap(
          envelopes.get(consumers[i])!,
          envelopes.get(consumers[j])!,
          padding,
        )
      ) {
        conflicts.add(consumers[i]);
        conflicts.add(consumers[j]);
      }
  for (const id of conflicts) glass.delete(id);
  if (!glass.size) return null;

  const ignoredConsumers = new Set(consumers);
  const surfaces = new Map<string, PrefixSurfaceRef>();
  for (const id of [...glass]) {
    const group = plan.groups.get(id)!;
    const [, entry] = [...group.inputs][0];
    const ref =
      entry.kind === "styled" && entry.backdrop
        ? planOwnedPrefixSurface(
            plan,
            slide,
            entry.backdrop,
            ignoredConsumers,
          )
        : null;
    if (!ref) glass.delete(id);
    else surfaces.set(id, ref);
  }
  if (!glass.size) return null;

  return { plan, slide, glass, surfaces, envelopes, padding };
}

export type RestorationPlan = NonNullable<ReturnType<typeof restorationPlan>>;
export function planCompositionBackends(
  plan: CompositionPlan,
  slide: Slide,
  deck: Deck,
  options: {
    restoration: boolean;
    padding: number;
    exclude?: ReadonlySet<string>;
  },
) {
  const native = new Map<string, { effectId: string; filter: string }>();
  let restoration: RestorationPlan | null = null;
  if (compositorCapabilities().resolvedBackdrop) {
    for (const [id, route] of nativeBackdropGroups(plan, slide, deck))
      native.set(id, route);
    if (options.restoration)
      restoration = restorationPlan(plan, slide, deck, options.padding);
  }
  if (restoration && options.exclude) {
    for (const id of options.exclude) restoration.glass.delete(id);
    if (!restoration.glass.size) restoration = null;
  }
  const routes = new Map<
    string,
    "native-group" | "backdrop-restoration" | "fallback"
  >();
  for (const [id, group] of plan.groups)
    if (group.inputs.size)
      routes.set(
        id,
        native.has(id)
          ? "native-group"
          : restoration?.glass.has(id)
            ? "backdrop-restoration"
            : "fallback",
      );
  return { native, restoration, routes };
}
export type CompositionBackends = ReturnType<typeof planCompositionBackends>;
