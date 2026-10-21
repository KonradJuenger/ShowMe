import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import {
  effectPlacement,
  type ElementEffect,
  type EffectResources,
} from "../core/effects";

/** Derived render operations. None of these are document fields or surfaces.
 * In particular a group does not imply allocation, isolation, or a backdrop root. */
export type Composition =
  | { kind: "sequence"; items: Composition[] }
  | { kind: "source" }
  | { kind: "fill" }
  | { kind: "stroke" }
  | { kind: "children" }
  | { kind: "clip"; input: Composition }
  | { kind: "effect"; effect: ElementEffect; input?: Composition };

export type EffectRef = { elementId: string; effectId: string };
export type EffectInput =
  | { kind: "none" }
  | { kind: "text" | "content"; operation: Composition }
  | { kind: "native"; operation?: Composition }
  | { kind: "backdrop"; elementId: string };

export type VisualGroup = {
  element: Element;
  parentId?: string;
  /** Geometry and alpha retain separate responsibilities, without moving DOM. */
  transport: Element["frame"];
  opacity: number;
  visual: Composition;
  children: VisualGroup[];
  inputs: Map<string, EffectInput>;
};

const sequence = (...items: Composition[]): Composition => ({
  kind: "sequence",
  items,
});

/** Preserve v1 paint semantics, including upstream JS and the change of scope
 * at the first content-input shader. Later content wrappers contain the stroke
 * and overlay too. Do not simplify this into a flat background/content/overlay list. */
export function compileVisualGroup(
  element: Element,
  resources: EffectResources,
  editingTextId?: string | null,
): VisualGroup {
  const effects = (element.effects ?? []).filter(
    (e) => e.enabled && resources[e.resourceId],
  );
  const inputs = new Map<string, EffectInput>();
  const effect = (
    instance: ElementEffect,
    input?: Composition,
  ): Composition => {
    const definition = resources[instance.resourceId];
    inputs.set(
      instance.id,
      definition.input === "backdrop"
        ? { kind: "backdrop", elementId: element.id }
        : definition.kind === "text-js" && input
          ? { kind: "text", operation: input }
          : definition.input === "content" && input
            ? { kind: "content", operation: input }
            : definition.kind === "css"
              ? { kind: "native", operation: input }
              : { kind: "none" },
    );
    return { kind: "effect", effect: instance, input };
  };
  const lane = (placement: ElementEffect["placement"]) =>
    effects.filter(
      (e) => effectPlacement(resources[e.resourceId], e) === placement,
    );
  let content = sequence({ kind: "source" }, { kind: "children" });
  if (element.id !== editingTextId)
    for (const instance of lane("content").filter(
      (e) => resources[e.resourceId].kind === "text-js",
    ))
      content = effect(instance, content);

  // Build each background/overlay operation only once: these are the same
  // stages even when content wrappers expand to encompass the entire visual.
  const background = lane("background").map((e) => effect(e));
  const overlay = lane("overlay").map((e) => effect(e));
  const base = (inner: Composition) =>
    sequence(
      {
        kind: "clip",
        input: sequence(
          ...(element.appearance.fill ? [{ kind: "fill" } as const] : []),
          ...background,
          inner,
          ...overlay,
        ),
      },
      ...(element.appearance.strokeWidth > 0
        ? [{ kind: "stroke" } as const]
        : []),
    );
  let visual = base(content),
    wholeVisual = false;
  if (element.id !== editingTextId)
    for (const instance of lane("content").filter(
      (e) => resources[e.resourceId].kind !== "text-js",
    )) {
      wholeVisual ||= resources[instance.resourceId].input === "content";
      if (wholeVisual) visual = effect(instance, visual);
      else {
        content = effect(instance, content);
        visual = base(content);
      }
    }
  return {
    element,
    transport: element.frame,
    opacity: element.appearance.opacity,
    visual,
    inputs,
    children: element.children.map((child) =>
      compileVisualGroup(child, resources, editingTextId),
    ),
  };
}

/** A prefix is persistent structural data: complete earlier groups and a chain
 * of unfinished ancestor scopes. Materialization remains a backend decision. */
export type ScenePrefix = {
  parent?: ScenePrefix;
  earlier: readonly VisualGroup[];
  ancestor?: VisualGroup;
};

function prefixChain(prefix?: ScenePrefix) {
  const chain: ScenePrefix[] = [];
  for (let current = prefix; current; current = current.parent)
    chain.push(current);
  return chain.reverse();
}

export type CompositionPlan = {
  roots: VisualGroup[];
  groups: ReadonlyMap<string, VisualGroup>;
  prefixes: ReadonlyMap<string, ScenePrefix>;
  dependencies(ref: EffectRef): EffectRef[];
};

export function compileCompositionPlan(
  slide: Slide,
  deck: Pick<Deck, "layers">,
  editingTextId?: string | null,
  resources: EffectResources = slide.effectResources ?? {},
): CompositionPlan {
  const roots = slide.nodes
    .filter((root) =>
      deck.layers.some((layer) => layer.id === root.id && !layer.hidden),
    )
    .flatMap((root) =>
      root.children.map((element) =>
        compileVisualGroup(element, resources, editingTextId),
      ),
    );
  const groups = new Map<string, VisualGroup>(),
    prefixes = new Map<string, ScenePrefix>();
  const index = (
    siblings: VisualGroup[],
    parent?: ScenePrefix,
    ancestor?: VisualGroup,
  ) => {
    // Shared arrays + a slice per scope entry would store quadratic prefixes.
    // Instead each step adds only the preceding group to a persistent chain.
    let prefix: ScenePrefix = { parent, earlier: [], ancestor };
    for (const group of siblings) {
      if (groups.has(group.element.id))
        throw new Error("Duplicate composition element identity");
      groups.set(group.element.id, group);
      group.parentId = ancestor?.element.id;
      prefixes.set(group.element.id, prefix);
      index(group.children, prefix, group);
      prefix = { parent: prefix, earlier: [group] };
    }
  };
  index(roots);
  const terminals = (
    operation: Composition,
    group: VisualGroup,
  ): EffectRef[] => {
    switch (operation.kind) {
      case "effect":
        return [{ elementId: group.element.id, effectId: operation.effect.id }];
      case "sequence":
        return operation.items.flatMap((item) => terminals(item, group));
      case "clip":
        return terminals(operation.input, group);
      case "children":
        return group.children.flatMap((child) =>
          terminals(child.visual, child),
        );
      default:
        return [];
    }
  };
  const dependencies = ({ elementId, effectId }: EffectRef): EffectRef[] => {
    const group = groups.get(elementId),
      input = group?.inputs.get(effectId);
    if (!group || !input) return [];
    if (
      input.kind === "text" ||
      input.kind === "content" ||
      input.kind === "native"
    )
      return input.operation ? terminals(input.operation, group) : [];
    if (input.kind !== "backdrop") return [];
    const result: EffectRef[] = [];
    for (const prefix of prefixChain(prefixes.get(input.elementId))) {
      // Unfinished ancestor effects are deliberately excluded, as in the v1
      // background-lens contract. Their completed output depends on this child.
      for (const prior of prefix.earlier)
        result.push(...terminals(prior.visual, prior));
    }
    return result;
  };
  return { roots, groups, prefixes, dependencies };
}

const plans = new WeakMap<
  Slide,
  WeakMap<
    Deck,
    {
      resources: EffectResources | undefined;
      layers: Deck["layers"];
      plan: CompositionPlan;
    }
  >
>();

/** Accepted scene revisions are immutable. Raster consumers of the same scene
 * share the structural plan, while resource replacement also refreshes mounted
 * diagnostic scenes without retaining obsolete document revisions. */
export function compositionPlanFor(slide: Slide, deck: Deck) {
  let decks = plans.get(slide);
  if (!decks) {
    decks = new WeakMap();
    plans.set(slide, decks);
  }
  let cached = decks.get(deck);
  if (
    !cached ||
    cached.resources !== slide.effectResources ||
    cached.layers !== deck.layers
  ) {
    cached = {
      resources: slide.effectResources,
      layers: deck.layers,
      plan: compileCompositionPlan(slide, deck),
    };
    decks.set(deck, cached);
  }
  return cached.plan;
}

/** Existing primitive/capture adapters consume element-shaped prefix slices.
 * Keep this projection at the boundary, rather than deriving paint order from DOM. */
export function prefixElements(plan: CompositionPlan, elementId: string) {
  const prefix = plan.prefixes.get(elementId);
  if (!prefix) throw new Error("Backdrop target is not in the visible scene.");
  const partial = new Set<string>();
  const elements: Element[] = [];
  for (const current of prefixChain(prefix)) {
    // Append inside the active unfinished ancestor, not to its parent's peers.
    let children = elements;
    while (children.length && partial.has(children[children.length - 1].id))
      children = children[children.length - 1].children;
    if (current.ancestor) {
      partial.add(current.ancestor.element.id);
      const ancestor = {
        ...current.ancestor.element,
        children: [] as Element[],
      };
      children.push(ancestor);
      children = ancestor.children;
    }
    children.push(...current.earlier.map((group) => group.element));
  }
  return { elements, partial };
}
