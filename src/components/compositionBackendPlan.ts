import type { Deck, Slide } from "../core/document";
import type { CompositionPlan, VisualGroup } from "./compositionPlan";
import { presenceElement } from "../core/presence";
import { resolveMotionValue } from "../core/motion";
import {
  localMatrix,
  transformPoint,
  multiply,
  resolveMediaFrame,
  walkElements,
} from "../core/element";
import {
  compositorCapabilities,
  backdropStyleCapabilities,
} from "./compositionCapabilities";
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

/** Backdrop restoration implements mix(B,R,a) as R overlaid with B at 1-a.
 * R remains entirely native, including fill-before-filter and rounded AA. The
 * current capability is disjoint flat cards over one procedural background;
 * prior cards cannot contribute pixels inside another card's swept bounds.
 * Unsupported overlap, nested alpha and mixed stacks retain the usual backend. */
function restorationPlan(
  plan: CompositionPlan,
  slide: Slide,
  deck: Deck,
  padding = 2,
) {
  if (
    deck.stylesheet ||
    !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(slide.background)
  )
    return null;
  const background = plan.roots[0];
  if (!background) return null;
  const bg = background.element,
    frame = bg.frame;
  if (
    bg.geometry.type !== "rect" ||
    frame.x ||
    frame.y ||
    frame.width !== deck.width ||
    frame.height !== deck.height ||
    frame.rotation ||
    frame.scaleX !== 1 ||
    frame.scaleY !== 1 ||
    frame.flipX ||
    frame.flipY ||
    bg.appearance.opacity !== 1 ||
    bg.appearance.radius ||
    bg.appearance.strokeWidth ||
    bg.content ||
    bg.children.length ||
    background.inputs.size !== 1
  )
    return null;
  const [effectId, input] = [...background.inputs][0],
    instance = bg.effects!.find((i) => i.id === effectId)!;
  if (
    input.kind !== "none" ||
    instance.placement !== "background" ||
    slide.effectResources![instance.resourceId].kind !== "fragment-glsl"
  )
    return null;
  const glass = new Set<string>(),
    envelopes = new Map<string, Bounds>();
  for (const group of plan.groups.values()) {
    const e = group.element;
    if (!group.parentId) envelopes.set(e.id, bounds(group));
    if (!group.inputs.size || group === background || group.parentId) continue;
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
      group.parentId ||
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
      effect = e.effects!.find((i) => i.id === id)!,
      definition = slide.effectResources![effect.resourceId];
    if (
      definition.kind !== "css" ||
      effect.placement !== "content" ||
      entry.kind !== "styled" ||
      !entry.operation
    )
      continue;
    if (!backdropStyleCapabilities(definition)?.restoration) continue;
    glass.add(e.id);
  }
  if (!glass.size) return null;
  const unbounded = new Set<string>();
  const rootFor = (id: string) => {
    let group = plan.groups.get(id);
    while (group?.parentId) group = plan.groups.get(group.parentId);
    return group;
  };
  for (const stage of slide.motion?.stages ?? []) {
    if (
      stage.tracks.some((track) => track.elementId === bg.id) ||
      stage.blocks?.some(
        (block) =>
          block.binding &&
          "elementId" in block.binding &&
          block.binding.elementId === bg.id,
      )
    )
      return null;
    for (const track of stage.tracks) {
      const owner = rootFor(track.elementId);
      if (!owner) continue;
      if (track.property === "appearance.opacity") continue;
      glass.delete(owner.element.id);
      // Ordinary translation of a root has a finite sweep. Other transforms
      // and descendant animation need a proven paint envelope before admission.
      if (
        owner.element.id !== track.elementId ||
        owner.element.frame.rotation ||
        owner.element.frame.scaleX !== 1 ||
        owner.element.frame.scaleY !== 1 ||
        !["transform.x", "transform.y"].includes(track.property) ||
        track.keyframes.some(
          (k) =>
            Array.isArray(k.easeToNext) &&
            (k.easeToNext[1] < 0 ||
              k.easeToNext[1] > 1 ||
              k.easeToNext[3] < 0 ||
              k.easeToNext[3] > 1),
        )
      ) {
        unbounded.add(owner.element.id);
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
      if (!group) continue;
      if (
        block.binding.kind !== "presence" ||
        group.element.id !== block.binding.elementId
      ) {
        glass.delete(group.element.id);
        unbounded.add(group.element.id);
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
          unbounded.add(group.element.id);
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
  // A bounded native object elsewhere cannot disable an unrelated material.
  // Arbitrary stylesheet paint remains unbounded until it can be proven local.
  for (const group of plan.roots) {
    if (group === background || glass.has(group.element.id)) continue;
    const e = group.element;
    const boundedEffects =
      e.clipChildren &&
      [...group.inputs].every(([id]) => {
        const instance = e.effects!.find((effect) => effect.id === id)!;
        const definition = slide.effectResources![instance.resourceId];
        return (
          definition.kind === "css" &&
          !!backdropStyleCapabilities(definition)?.captureMaterial
        );
      });
    if (
      e.cssClasses?.length ||
      (group.inputs.size && !boundedEffects) ||
      (group.children.length && !e.clipChildren)
    )
      unbounded.add(e.id);
    if (e.content && e.content.type !== "text") {
      const media = resolveMediaFrame(e);
      if (media && !e.clipChildren) {
        const box = envelopes.get(e.id)!;
        const base = bounds(group);
        const delta = {
          left: box.left - base.left,
          right: box.right - base.right,
          top: box.top - base.top,
          bottom: box.bottom - base.bottom,
        };
        const m = multiply(localMatrix(e.frame), localMatrix(media));
        for (const x of [0, media.width])
          for (const y of [0, media.height]) {
            const point = transformPoint(m, { x, y });
            box.left = Math.min(box.left, point.x + delta.left);
            box.right = Math.max(box.right, point.x + delta.right);
            box.top = Math.min(box.top, point.y + delta.top);
            box.bottom = Math.max(box.bottom, point.y + delta.bottom);
          }
      }
    }
  }
  // Cull preceding sources only when they cannot contribute to a restore rect.
  // Native backdrop filtering still sees their actual pixels outside that rect.
  for (const id of glass)
    for (const [other, box] of envelopes) {
      if (other === id || other === bg.id) continue;
      if (unbounded.has(other)) {
        glass.delete(id);
        break;
      }
      const element = plan.groups.get(other)!.element;
      if (
        element.content?.type === "text" &&
        !element.appearance.fill &&
        !element.appearance.strokeWidth
      )
        continue; // Check native line bounds after fonts are ready.
      const stroke =
        (element.appearance.strokeWidth / 2) *
        Math.max(element.frame.scaleX, element.frame.scaleY);
      if (
        overlap(
          envelopes.get(id)!,
          {
            left: box.left - stroke,
            top: box.top - stroke,
            right: box.right + stroke,
            bottom: box.bottom + stroke,
          },
          padding,
        )
      )
        glass.delete(id);
    }
  for (const id of glass) {
    const box = envelopes.get(id)!;
    if (
      box.right + padding <= 0 ||
      box.bottom + padding <= 0 ||
      box.left - padding >= deck.width ||
      box.top - padding >= deck.height
    )
      glass.delete(id);
  }
  if (!glass.size) return null;
  return { plan, glass, background, envelopes, padding };
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
