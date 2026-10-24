import type { Deck, Slide } from "../../core/document";
import type { Element } from "../../core/element";
import type {
  BackdropPoint,
  Composition,
  CompositionPlan,
  VisualGroup,
} from "../../components/compositionPlan";
import { compileCompositionPlan } from "../../components/compositionPlan";
import type {
  EffectDefinition,
  EffectResources,
  ElementEffect,
} from "../../core/effects";

export type GpuSourceKind =
  | "none"
  | "native-text"
  | "image"
  | "svg"
  | "video";

export type GpuEffectInputKind =
  | "none"
  | "content"
  | "backdrop"
  | "native";

export type GpuRenderOperation =
  | { kind: "sequence"; items: GpuRenderOperation[] }
  | { kind: "source"; elementId: string; source: GpuSourceKind }
  | { kind: "fill"; elementId: string }
  | { kind: "stroke"; elementId: string }
  | { kind: "children"; elementId: string; children: string[] }
  | { kind: "clip"; elementId: string; input: GpuRenderOperation }
  | {
      kind: "effect";
      elementId: string;
      effect: ElementEffect;
      definition: EffectDefinition | undefined;
      inputKind: GpuEffectInputKind;
      backdrop?: BackdropPoint;
      input?: GpuRenderOperation;
    };

export type GpuRenderGroup = {
  id: string;
  parentId?: string;
  element: Element;
  opacity: number;
  transport: Element["frame"];
  clipChildren: boolean;
  children: string[];
  visual: GpuRenderOperation;
};

export type GpuRenderGraph = {
  slide: Slide;
  deck: Deck;
  plan: CompositionPlan;
  resources: EffectResources;
  roots: string[];
  groups: ReadonlyMap<string, GpuRenderGroup>;
};

function sourceKind(element: Element): GpuSourceKind {
  switch (element.content?.type) {
    case "text":
      return "native-text";
    case "image":
      return "image";
    case "svg":
      return "svg";
    case "video":
      return "video";
    default:
      return "none";
  }
}

function lower(
  operation: Composition,
  group: VisualGroup,
  resources: EffectResources,
): GpuRenderOperation {
  switch (operation.kind) {
    case "sequence":
      return {
        kind: "sequence",
        items: operation.items.map((item) => lower(item, group, resources)),
      };
    case "source":
      return {
        kind: "source",
        elementId: group.element.id,
        source: sourceKind(group.element),
      };
    case "fill":
      return { kind: "fill", elementId: group.element.id };
    case "stroke":
      return { kind: "stroke", elementId: group.element.id };
    case "children":
      return {
        kind: "children",
        elementId: group.element.id,
        children: group.children.map((child) => child.element.id),
      };
    case "clip":
      return {
        kind: "clip",
        elementId: group.element.id,
        input: lower(operation.input, group, resources),
      };
    case "effect": {
      const semanticInput = group.inputs.get(operation.effect.id);
      const definition = resources[operation.effect.resourceId];
      let inputKind: GpuEffectInputKind = "none";
      let backdrop: BackdropPoint | undefined;
      if (definition?.kind !== "fragment-glsl") inputKind = "native";
      else if (semanticInput?.kind === "backdrop") {
        inputKind = "backdrop";
        backdrop = semanticInput.backdrop;
      } else if (semanticInput?.kind === "content") inputKind = "content";
      else if (semanticInput?.kind === "styled") {
        inputKind = "native";
        backdrop = semanticInput.backdrop;
      }
      return {
        kind: "effect",
        elementId: group.element.id,
        effect: operation.effect,
        definition,
        inputKind,
        ...(backdrop ? { backdrop } : {}),
        ...(operation.input
          ? { input: lower(operation.input, group, resources) }
          : {}),
      };
    }
  }
}

/**
 * Compile the current ShowMe composition semantics into an experiment-only GPU
 * graph. The graph retains Element and CompositionPlan identity instead of
 * introducing a parallel document or paint-order model.
 */
export function compileGpuRenderGraph(
  slide: Slide,
  deck: Deck,
  editingTextId?: string | null,
): GpuRenderGraph {
  const resources = slide.effectResources ?? {};
  const plan = compileCompositionPlan(
    slide,
    deck,
    editingTextId,
    resources,
  );
  const groups = new Map<string, GpuRenderGroup>();
  for (const group of plan.groups.values())
    groups.set(group.element.id, {
      id: group.element.id,
      parentId: group.parentId,
      element: group.element,
      opacity: group.opacity,
      transport: group.transport,
      clipChildren: group.element.clipChildren,
      children: group.children.map((child) => child.element.id),
      visual: lower(group.visual, group, resources),
    });
  return {
    slide,
    deck,
    plan,
    resources,
    roots: plan.roots.map((group) => group.element.id),
    groups,
  };
}

export function walkGpuOperation(
  operation: GpuRenderOperation,
  visit: (operation: GpuRenderOperation) => void,
) {
  visit(operation);
  if (operation.kind === "sequence")
    operation.items.forEach((item) => walkGpuOperation(item, visit));
  else if (operation.kind === "clip") walkGpuOperation(operation.input, visit);
  else if (operation.kind === "effect" && operation.input)
    walkGpuOperation(operation.input, visit);
}
