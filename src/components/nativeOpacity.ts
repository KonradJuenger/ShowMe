import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";

export type NativeOpacity = {
  property: string;
  value: string;
  distribute: boolean;
};

/** A paint-only scoped material has no independent alpha/clip/filter/JS boundary.
 * Unknown CSS keeps its authored native semantics. This is alpha routing, never
 * CSS backend selection: no route can request capture or reconstruct a backdrop. */
function material(source: string) {
  const block = /^\s*:scope\s*\{([^{}\\]*)\}\s*$/.exec(source);
  return (
    !!block &&
    block[1]
      .split(";")
      .every(
        (declaration) =>
          !declaration.trim() ||
          /^\s*(?:-webkit-backdrop-filter|backdrop-filter|background(?:-[\w-]+)?|border(?:-[\w-]+)?|box-shadow|color|overflow(?:-[\w-]+)?)\s*:[^{}!]*$/i.test(
            declaration,
          ),
      )
  );
}

/** Compile once per accepted tree. CSS inheritance carries changing alpha to
 * pre-bound visual nodes; Motion never walks descendants or replans per frame.
 * A group containing glass uses per-visual alpha, an intentional overlap
 * approximation. Ordinary groups retain exact native group opacity.
 */
export function nativeOpacityPlan(
  elements: readonly Element[],
  resources: EffectResources,
  stylesheet = "",
): ReadonlyMap<string, NativeOpacity> {
  const plan = new Map<string, NativeOpacity>();
  // Arbitrary stylesheet selectors can introduce additional backdrop boundaries.
  if (stylesheet.trim()) return plan;
  const distributing = new Set<string>();
  const passToChildren = new Set<string>();
  const inspect = (element: Element): boolean => {
    const childBackdrop = element.children.map(inspect).some(Boolean);
    const effects = (element.effects ?? [])
      .filter((effect) => effect.enabled)
      .filter((effect) => !!resources[effect.resourceId]);
    const definitions = effects.map((effect) => resources[effect.resourceId]);
    const ownBackdrop = definitions.some(
      (definition) =>
        definition.kind === "css" &&
        [
          ...definition.source.matchAll(
            /(?:^|[;{])\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;}]+)/gi,
          ),
        ].some((match) => match[1].trim().toLowerCase() !== "none"),
    );
    const safe =
      definitions.length === 0 ||
      (definitions.length === 1 &&
        definitions[0].kind === "css" &&
        effects[0].placement === "content" &&
        material(definitions[0].source) &&
        !childBackdrop);
    const distribute = safe && (ownBackdrop || childBackdrop);
    if (distribute) distributing.add(element.id);
    if (distribute && !definitions.length) passToChildren.add(element.id);
    return distribute;
  };
  elements.forEach(inspect);
  let index = 0;
  const visit = (element: Element, ancestors: readonly string[]) => {
    const distribute = distributing.has(element.id);
    const property = `--showme-visual-alpha-${index++}`;
    if (distribute || ancestors.length) {
      const factors = [...ancestors, `var(${property})`];
      plan.set(element.id, {
        property,
        value:
          factors.length === 1 ? factors[0] : `calc(${factors.join(" * ")})`,
        distribute,
      });
      element.children.forEach((child) =>
        visit(child, passToChildren.has(element.id) ? factors : []),
      );
    } else element.children.forEach((child) => visit(child, []));
  };
  elements.forEach((element) => visit(element, []));
  return plan;
}
