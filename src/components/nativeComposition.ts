import type { Deck, Slide } from "../core/document";
import type { CompositionPlan } from "./compositionPlan";

/** A native lowering is legal only if the backdrop stage and the group's entry
 * have identical paint inputs and bounds. Keep opaque CSS on the original path.
 * This is a backend capability check, never a different Effect representation. */
export function nativeBackdropGroups(
  plan: CompositionPlan,
  slide: Slide,
  deck: Deck,
) {
  const eligible = new Map<string, { effectId: string; filter: string }>();
  // Admit the verified native compositor, not just CSS syntax support. Chromium
  // 153 accepts the same declarations but failed resolved-group alpha pixels in
  // both the app fixture and an independent DOM probe. Unknown engines retain
  // the correctness lowering until its pixel contract is verified there.
  if (
    !/\bElectron\//.test(navigator.userAgent) ||
    !/\bChrome\/152\./.test(navigator.userAgent)
  )
    return eligible;
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
    if (input.kind !== "native" || !input.operation) continue;
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
    if (
      definition.kind !== "css" ||
      !/^\s*:scope\s*\{[^{}]*\}\s*$/.test(definition.source) ||
      /\b(?:var|env|attr|url)\s*\(/i.test(definition.source)
    )
      continue;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(definition.source);
    const rule = sheet.cssRules[0];
    if (!(rule instanceof CSSStyleRule)) continue;
    const style = rule.style,
      filter = style.backdropFilter;
    if (
      !filter ||
      filter === "none" ||
      style.getPropertyPriority("backdrop-filter") ||
      Array.from(style).some(
        (key) =>
          !/^(?:backdrop-filter|background(?:-.*)?|border(?:-.*)?|box-shadow|color)$/.test(
            key,
          ),
      ) ||
      [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ].some((radius) => radius && !/^0(?:px|%)?$/.test(radius))
    )
      continue;
    eligible.set(element.id, { effectId, filter });
  }
  return eligible;
}
