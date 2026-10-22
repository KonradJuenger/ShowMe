import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import { effectPlacement } from "../core/effects";
import type { RenderDensity } from "../core/renderProfile";
import {
  prefixElements,
  type BackdropPoint,
  type CompositionPlan,
} from "./compositionPlan";
import {
  createScenePrefixRasterSource,
  type RasterContext,
} from "./elementRaster";
import { effectSurface } from "./effectRuntime";

export type PrefixSurfaceRef = {
  id: string;
  elements: readonly Element[];
};

export type MaterializedPrefix = {
  ref: PrefixSurfaceRef;
  canvas: HTMLCanvasElement;
  revision: number;
};

const references = new WeakMap<
  CompositionPlan,
  Map<string, PrefixSurfaceRef>
>();

function supportsOwnedElement(element: Element, slide: Slide): boolean {
  if (element.cssClasses?.length) return false;
  if (element.content && element.content.type !== "image") return false;
  for (const instance of element.effects ?? []) {
    if (!instance.enabled) continue;
    const definition = slide.effectResources?.[instance.resourceId];
    if (
      !definition ||
      definition.kind !== "fragment-glsl" ||
      definition.input !== "none" ||
      effectPlacement(definition, instance) === "content"
    )
      return false;
  }
  return element.children.every((child) => supportsOwnedElement(child, slide));
}

/** Resolve a semantic backdrop point to one renderer-local retained source.
 * Equal ordered owned-source prefixes inside one CompositionPlan share identity.
 * Restoration consumers can be omitted only when their caller has already
 * proven that they cannot contribute to the requested regions. */
export function planOwnedPrefixSurface(
  plan: CompositionPlan,
  slide: Slide,
  point: BackdropPoint,
  ignoredElements: ReadonlySet<string> = new Set(),
): PrefixSurfaceRef | null {
  if (point.kind === "effect-entry") {
    const input = plan.groups.get(point.elementId)?.inputs.get(point.effectId);
    if (input?.kind !== "styled" || !input.backdrop) return null;
  }
  const prefix = prefixElements(plan, point.elementId);
  if (prefix.partial.size) return null;
  const elements = prefix.elements.filter(
    (element) => !ignoredElements.has(element.id),
  );
  if (!elements.every((element) => supportsOwnedElement(element, slide)))
    return null;

  let byKey = references.get(plan);
  if (!byKey) {
    byKey = new Map();
    references.set(plan, byKey);
  }
  const key = elements.map((element) => element.id).join("\u001f");
  let ref = byKey.get(key);
  if (!ref) {
    ref = {
      id: `prefix:${key || "slide-background"}`,
      elements,
    };
    byKey.set(key, ref);
  }
  return ref;
}

type RetainedSource = {
  ref: PrefixSurfaceRef;
  source: ReturnType<typeof createScenePrefixRasterSource>;
  nodes: HTMLElement[];
  observer: MutationObserver;
  eventDirty: EventListener;
};

export type PrefixMaterializerDiagnostics = {
  surfaces: number;
  materializeCalls: number;
  builds: number;
  reuses: number;
  invalidations: number;
  revisions: Record<string, number>;
};

function ownedNodes(root: HTMLElement, ref: PrefixSurfaceRef) {
  const ids = new Set(ref.elements.map((element) => element.id));
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-element-id]"),
  ).filter((node) => !!node.dataset.elementId && ids.has(node.dataset.elementId));
}

/** Canvas2D is deliberately the retained representation for this prototype.
 * Source-specific knowledge remains in elementRaster/effectRuntime. The
 * materializer owns identity, invalidation and reuse, not paint semantics. */
export function createPrefixMaterializer(
  root: HTMLElement,
  slide: Slide,
  deck: Deck,
  density: Pick<RenderDensity, "x" | "y">,
  invalidated: () => void,
) {
  const retained = new Map<string, RetainedSource>();
  let materializeCalls = 0,
    builds = 0,
    reuses = 0,
    invalidations = 0,
    disposed = false;

  const ensure = (ref: PrefixSurfaceRef) => {
    const existing = retained.get(ref.id);
    if (existing) return existing;

    const nodes = ownedNodes(root, ref);
    if (nodes.length !== ref.elements.length)
      throw new Error("Scene prefix source is not fully mounted");

    let source!: ReturnType<typeof createScenePrefixRasterSource>;
    const markDirty = () => {
      if (disposed) return;
      invalidations++;
      source.markDirty();
    };
    const context: RasterContext = {
      root,
      resources: slide.effectResources ?? {},
      beforeEffect: "",
      flush: () => {},
    };
    source = createScenePrefixRasterSource(
      ref.elements,
      () => ({ slide, deck }),
      context,
      () => {
        if (!disposed) invalidated();
      },
    );

    const observer = new MutationObserver(markDirty);
    for (const node of nodes)
      observer.observe(node, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["style", "class", "src"],
      });
    const eventDirty: EventListener = () => markDirty();
    for (const node of nodes) {
      node.addEventListener("showme-effect-output", eventDirty);
      node.addEventListener("load", eventDirty, true);
      node.addEventListener("error", eventDirty, true);
    }
    const state = { ref, source, nodes, observer, eventDirty };
    retained.set(ref.id, state);
    return state;
  };

  const prepareOwnedResources = async (state: RetainedSource) => {
    const images = state.nodes.flatMap((node) =>
      Array.from(node.querySelectorAll<HTMLImageElement>("img")),
    );
    await Promise.all(
      images.map(async (image) => {
        if (!image.complete || !image.naturalWidth) await image.decode();
        if (!image.naturalWidth)
          throw new Error("Scene prefix image failed to decode");
      }),
    );
    for (const node of state.nodes)
      for (const effect of node.querySelectorAll<HTMLElement>("[data-effect-id]")) {
        if (effect.dataset.effectError)
          throw new Error(effect.dataset.effectError);
        effectSurface(effect)?.materialize();
        if (effect.dataset.effectStarted !== "false" && !effect.querySelector("canvas"))
          throw new Error("Scene prefix effect output is unavailable");
      }
  };

  return {
    async materialize(ref: PrefixSurfaceRef): Promise<MaterializedPrefix> {
      if (disposed) throw new Error("Prefix materializer is disposed");
      materializeCalls++;
      const state = ensure(ref);
      await prepareOwnedResources(state);
      if (!(density.x > 0 && density.y > 0))
        throw new Error("Scene prefix density is unavailable");
      const width = Math.max(1, Math.ceil(deck.width * density.x));
      const height = Math.max(1, Math.ceil(deck.height * density.y));
      const changed = state.source.update(width, height);
      if (changed) builds++;
      else reuses++;
      return {
        ref,
        canvas: state.source.canvas,
        revision: state.source.revision,
      };
    },
    diagnostics(): PrefixMaterializerDiagnostics {
      return {
        surfaces: retained.size,
        materializeCalls,
        builds,
        reuses,
        invalidations,
        revisions: Object.fromEntries(
          [...retained.values()].map((state) => [
            state.ref.id,
            state.source.revision,
          ]),
        ),
      };
    },
    dispose() {
      disposed = true;
      for (const state of retained.values()) {
        state.observer.disconnect();
        for (const node of state.nodes) {
          node.removeEventListener("showme-effect-output", state.eventDirty);
          node.removeEventListener("load", state.eventDirty, true);
          node.removeEventListener("error", state.eventDirty, true);
        }
        state.source.dispose();
      }
      retained.clear();
    },
  };
}

export type PrefixMaterializer = ReturnType<typeof createPrefixMaterializer>;
