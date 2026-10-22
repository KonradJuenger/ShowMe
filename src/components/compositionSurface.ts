import type { Deck, Slide } from "../core/document";
import type { Element as ShowMeElement } from "../core/element";
import { effectPlacement } from "../core/effects";
import type { RenderDensity } from "../core/renderProfile";
import type { SceneSurfaceRef } from "./compositionPlan";
import {
  createScenePrefixRasterSource,
  type RasterContext,
} from "./elementRaster";
import { effectSurface } from "./effectRuntime";

export type SurfaceRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MaterializeRequest = {
  surface: SceneSurfaceRef;
  region: SurfaceRegion;
  density: Pick<RenderDensity, "x" | "y">;
  /** Backend proof only. It can optimize materialization but never changes
   * SceneSurfaceRef identity or semantic paint ordering. */
  irrelevantElementIds?: ReadonlySet<string>;
};

export type MaterializedSurfaceSource =
  | { kind: "canvas-image"; value: CanvasImageSource }
  | { kind: "gpu-texture"; value: WebGLTexture };

export type MaterializedSurface = {
  surface: SceneSurfaceRef;
  source: MaterializedSurfaceSource;
  revision: number;
  logicalBounds: SurfaceRegion;
  density: Pick<RenderDensity, "x" | "y">;
  pixelSize: { width: number; height: number };
};

type SourceProjection = {
  key: string;
  elements: readonly ShowMeElement[];
  dependencyIds: ReadonlySet<string>;
};

type RetainedSource = {
  projection: SourceProjection;
  source: ReturnType<typeof createScenePrefixRasterSource>;
  published?: Omit<MaterializedSurface, "surface">;
  pending?: Promise<Omit<MaterializedSurface, "surface">>;
};

interface PixelSourceProvider {
  project(
    surface: SceneSurfaceRef,
    slide: Slide,
    irrelevantElementIds: ReadonlySet<string>,
  ): SourceProjection | null;
  create(
    projection: SourceProjection,
    root: HTMLElement,
    slide: Slide,
    deck: Deck,
    invalidated: () => void,
  ): ReturnType<typeof createScenePrefixRasterSource>;
  prepare(
    projection: SourceProjection,
    root: HTMLElement,
  ): Promise<void>;
}

function effectKey(refs: readonly { elementId: string; effectId: string }[]) {
  return JSON.stringify(refs.map((ref) => [ref.elementId, ref.effectId]));
}

function ownedElementSupported(element: ShowMeElement, slide: Slide): boolean {
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
  return element.children.every((child) => ownedElementSupported(child, slide));
}

function dependencyIds(elements: readonly ShowMeElement[]) {
  const ids = new Set<string>();
  const visit = (element: ShowMeElement) => {
    ids.add(element.id);
    element.children.forEach(visit);
  };
  elements.forEach(visit);
  return ids;
}

function nodesFor(
  root: HTMLElement,
  projection: SourceProjection,
): HTMLElement[] {
  const ids = new Set(projection.elements.map((element) => element.id));
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-element-id]"),
  ).filter((node) => !!node.dataset.elementId && ids.has(node.dataset.elementId));
}

/** Capability and execution live together so admission cannot drift from the
 * primitive painter. Unsupported browser-owned paint remains on fallback. */
const ownedPrimitiveProvider: PixelSourceProvider = {
  project(surface, slide, irrelevantElementIds) {
    // The current primitive provider is proven for complete element-entry
    // prefixes. Internal effect-entry paint remains exact in CompositionPlan,
    // but falls back until a provider can reproduce every preceding operation.
    if (surface.point.kind !== "element-entry" || surface.partial.size)
      return null;
    const elements = surface.elements.filter(
      (element) => !irrelevantElementIds.has(element.id),
    );
    if (!elements.every((element) => ownedElementSupported(element, slide)))
      return null;

    const relevantEntry = surface.entryEffects.filter(
      (ref) => !irrelevantElementIds.has(ref.elementId),
    );
    const relevantPaint = surface.paintEffects.filter(
      (ref) => !irrelevantElementIds.has(ref.elementId),
    );
    // The element projection can reproduce exactly the element-entry paint.
    // Extra same-element effect-entry paint is not approximated.
    if (effectKey(relevantEntry) !== effectKey(relevantPaint)) return null;

    const ids = elements.map((element) => element.id);
    return {
      key: JSON.stringify([ids, effectKey(relevantPaint)]),
      elements,
      dependencyIds: dependencyIds(elements),
    };
  },
  create(projection, root, slide, deck, invalidated) {
    const context: RasterContext = {
      root,
      resources: slide.effectResources ?? {},
      beforeEffect: "",
      flush: () => {},
    };
    return createScenePrefixRasterSource(
      projection.elements,
      () => ({ slide, deck }),
      context,
      invalidated,
      false,
    );
  },
  async prepare(projection, root) {
    const nodes = nodesFor(root, projection);
    if (nodes.length !== projection.elements.length)
      throw new Error("Scene surface source is not fully mounted");

    const images = nodes.flatMap((node) =>
      Array.from(node.querySelectorAll<HTMLImageElement>("img")),
    );
    await Promise.all(
      images.map(async (image) => {
        if (!image.complete || !image.naturalWidth) await image.decode();
        if (!image.naturalWidth)
          throw new Error("Scene surface image failed to decode");
      }),
    );
    for (const node of nodes)
      for (const effect of node.querySelectorAll<HTMLElement>("[data-effect-id]")) {
        if (effect.dataset.effectError)
          throw new Error(effect.dataset.effectError);
        effectSurface(effect)?.materialize();
        if (
          effect.dataset.effectStarted !== "false" &&
          !effect.querySelector("canvas")
        )
          throw new Error("Scene surface effect output is unavailable");
      }
  },
};

const providers: readonly PixelSourceProvider[] = [ownedPrimitiveProvider];

function projectionFor(
  surface: SceneSurfaceRef,
  slide: Slide,
  irrelevantElementIds: ReadonlySet<string>,
) {
  for (const provider of providers) {
    const projection = provider.project(surface, slide, irrelevantElementIds);
    if (projection) return { provider, projection };
  }
  return null;
}

export function canMaterializeOwnedSurface(
  surface: SceneSurfaceRef,
  slide: Slide,
  irrelevantElementIds: ReadonlySet<string> = new Set(),
) {
  return !!projectionFor(surface, slide, irrelevantElementIds);
}

export type SceneSurfaceMaterializerDiagnostics = {
  surfaces: number;
  semanticSurfaces: number;
  materializeCalls: number;
  builds: number;
  reuses: number;
  invalidations: number;
  revisions: Record<string, number>;
};

function ownerId(target: EventTarget | Node | null) {
  const node =
    target instanceof HTMLElement || target instanceof SVGElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return node?.closest<HTMLElement>("[data-element-id]")?.dataset.elementId;
}

function closePublished(
  published: Omit<MaterializedSurface, "surface"> | undefined,
) {
  if (published?.source.kind !== "canvas-image") return;
  if (published.source.value instanceof ImageBitmap)
    published.source.value.close();
  else if (published.source.value instanceof HTMLCanvasElement) {
    published.source.value.width = 1;
    published.source.value.height = 1;
  }
}

/** One scene-scoped materializer owns retained source lifetime and immutable
 * publication. Consumers request semantic surfaces plus regions; Canvas2D may
 * still retain a full-slide implementation without exposing that assumption. */
export function createSceneSurfaceMaterializer(
  root: HTMLElement,
  slide: Slide,
  deck: Deck,
) {
  const retained = new Map<string, RetainedSource>();
  const semanticSurfaces = new Set<string>();
  const listeners = new Set<() => void>();
  let materializeCalls = 0;
  let builds = 0;
  let reuses = 0;
  let invalidations = 0;
  let disposed = false;

  const notify = () => {
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  const markElementDirty = (elementId: string | undefined) => {
    if (!elementId || disposed) return;
    for (const state of retained.values()) {
      if (!state.projection.dependencyIds.has(elementId)) continue;
      invalidations++;
      state.source.markDirty();
    }
  };

  const observer = new MutationObserver((records) => {
    const dirty = new Set<string>();
    for (const record of records) {
      const id = ownerId(record.target);
      if (id) dirty.add(id);
      if (record.type === "childList")
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          const childId = ownerId(node);
          if (childId) dirty.add(childId);
        }
    }
    dirty.forEach(markElementDirty);
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "style",
      "class",
      "src",
      "data-effect-revision",
      "data-effect-error",
      "data-effect-started",
      "data-presentation-absent",
    ],
  });

  const sourceSignal = (event: Event) => markElementDirty(ownerId(event.target));
  root.addEventListener("showme-effect-output", sourceSignal);
  root.addEventListener("load", sourceSignal, true);
  root.addEventListener("error", sourceSignal, true);

  const ensure = (request: MaterializeRequest) => {
    const irrelevant = request.irrelevantElementIds ?? new Set<string>();
    const selected = projectionFor(request.surface, slide, irrelevant);
    if (!selected)
      throw new Error("Scene surface is not materializable by an owned provider");
    const density = request.density;
    const key =
      selected.projection.key +
      "|density:" +
      density.x +
      "x" +
      density.y;
    const existing = retained.get(key);
    if (existing) return existing;
    const source = selected.provider.create(
      selected.projection,
      root,
      slide,
      deck,
      notify,
    );
    const state: RetainedSource = {
      projection: selected.projection,
      source,
    };
    retained.set(key, state);
    return state;
  };

  const build = async (
    state: RetainedSource,
    request: MaterializeRequest,
  ): Promise<Omit<MaterializedSurface, "surface">> => {
    const irrelevant = request.irrelevantElementIds ?? new Set<string>();
    const selected = projectionFor(request.surface, slide, irrelevant);
    if (!selected || selected.projection.key !== state.projection.key)
      throw new Error("Scene surface provider changed during materialization");
    await selected.provider.prepare(selected.projection, root);

    const { density } = request;
    if (!(density.x > 0 && density.y > 0))
      throw new Error("Scene surface density is unavailable");
    const width = Math.max(1, Math.ceil(deck.width * density.x));
    const height = Math.max(1, Math.ceil(deck.height * density.y));
    const changed = state.source.update(width, height);
    if (
      !changed &&
      state.published &&
      state.published.revision === state.source.revision
    ) {
      reuses++;
      return state.published;
    }

    builds++;
    // Publish from a fresh backing store. This copy is synchronous, so a DOM
    // Motion write and its retained source revision can settle in the same
    // microtask checkpoint instead of exposing an async bitmap-conversion gap.
    const snapshot = document.createElement("canvas");
    snapshot.width = width;
    snapshot.height = height;
    const context = snapshot.getContext("2d");
    if (!context) throw new Error("Cannot allocate scene publication surface");
    context.drawImage(state.source.canvas, 0, 0);
    if (disposed) {
      snapshot.width = snapshot.height = 1;
      throw new Error("Scene surface materializer is disposed");
    }

    const next: Omit<MaterializedSurface, "surface"> = {
      source: { kind: "canvas-image", value: snapshot },
      revision: state.source.revision,
      logicalBounds: {
        x: 0,
        y: 0,
        width: deck.width,
        height: deck.height,
      },
      density: { x: density.x, y: density.y },
      pixelSize: { width, height },
    };
    const previous = state.published;
    state.published = next;
    closePublished(previous);
    return next;
  };

  return {
    async materialize(request: MaterializeRequest): Promise<MaterializedSurface> {
      if (disposed) throw new Error("Scene surface materializer is disposed");
      if (
        !Number.isFinite(request.region.x) ||
        !Number.isFinite(request.region.y) ||
        !(request.region.width > 0) ||
        !(request.region.height > 0)
      )
        throw new Error("Scene surface region is invalid");
      materializeCalls++;
      semanticSurfaces.add(request.surface.id);
      const state = ensure(request);
      const existing = state.pending;
      const pending = existing ?? build(state, request);
      if (existing) reuses++;
      else state.pending = pending;
      try {
        const published = await pending;
        return { surface: request.surface, ...published };
      } finally {
        if (state.pending === pending) state.pending = undefined;
      }
    },
    subscribeInvalidation(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    diagnostics(): SceneSurfaceMaterializerDiagnostics {
      return {
        surfaces: retained.size,
        semanticSurfaces: semanticSurfaces.size,
        materializeCalls,
        builds,
        reuses,
        invalidations,
        revisions: Object.fromEntries(
          [...retained.entries()].map(([key, state]) => [
            key,
            state.published?.revision ?? state.source.revision,
          ]),
        ),
      };
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      root.removeEventListener("showme-effect-output", sourceSignal);
      root.removeEventListener("load", sourceSignal, true);
      root.removeEventListener("error", sourceSignal, true);
      listeners.clear();
      for (const state of retained.values()) {
        closePublished(state.published);
        state.source.dispose();
      }
      retained.clear();
    },
  };
}

export type SceneSurfaceMaterializer = ReturnType<
  typeof createSceneSurfaceMaterializer
>;
