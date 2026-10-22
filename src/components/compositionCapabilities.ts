import type { EffectDefinition } from "../core/effects";

/** Pixel-tested capabilities, deliberately stricter than CSS syntax support.
 * Engine upgrades change this single table after the native pixel contracts
 * pass. All backend selection consumes the same result. */
const testedChromium = new Set([152]);
export function compositorCapabilities(userAgent = navigator.userAgent) {
  const version = /\bChrome\/(\d+)\./.exec(userAgent);
  return {
    resolvedBackdrop:
      /\bElectron\//.test(userAgent) &&
      !!version &&
      testedChromium.has(Number(version[1])),
  };
}

const declarations = new WeakMap<
  EffectDefinition,
  CSSStyleDeclaration | null
>();
/** Parse authored scoped declarations once. Capability policy belongs to the
 * backend planner; fallback materialization may accept a broader declaration set. */
export function scopedStyle(definition: EffectDefinition) {
  if (declarations.has(definition)) return declarations.get(definition)!;
  let style: CSSStyleDeclaration | null = null;
  if (
    definition.kind === "css" &&
    /^\s*:scope\s*\{[^{}]*\}\s*$/.test(definition.source)
  ) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(definition.source);
    const rule = sheet.cssRules[0];
    if (rule instanceof CSSStyleRule) style = rule.style;
  }
  declarations.set(definition, style);
  return style;
}

/** Declaration capabilities are shared by all three implementations. Topology
 * and paint-region proofs are evaluated once by compositionBackendPlan. */
export function backdropStyleCapabilities(definition: EffectDefinition) {
  const style = scopedStyle(definition);
  if (!style) return null;
  const properties = Array.from(style);
  const materialProperty = (key: string) =>
    /^(?:backdrop-filter|background(?:-.*)?|border(?:-.*)?|box-shadow)$/.test(
      key,
    );
  const constant = !/\b(?:var|env|attr|url)\s*\(/i.test(definition.source);
  const filter = style.backdropFilter;
  const nativeGroup =
    constant &&
    !!filter &&
    filter !== "none" &&
    !style.getPropertyPriority("backdrop-filter") &&
    properties.every((key) => materialProperty(key) || key === "color") &&
    [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomLeftRadius,
      style.borderBottomRightRadius,
    ].every((radius) => !radius || /^0(?:px|%)?$/.test(radius));
  const restoration =
    constant &&
    /^blur\(([\d.]+)px\)(?: saturate\(([\d.]+)%\))?$/.test(filter) &&
    properties.every(
      (key) =>
        (materialProperty(key) || /^overflow(?:-.*)?$/.test(key)) &&
        !style.getPropertyPriority(key),
    );
  const captureMaterial =
    !/url\(/i.test(definition.source) &&
    properties.every(
      (key) =>
        materialProperty(key) ||
        /^(?:overflow(?:-.*)?|color|font(?:-.*)?|text(?:-.*)?|line-height|letter-spacing|padding(?:-.*)?)$/.test(
          key,
        ),
    );
  return { style, filter, nativeGroup, restoration, captureMaterial };
}
