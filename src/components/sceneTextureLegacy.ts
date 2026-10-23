import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";
import { effectPlacement } from "../core/effects";
import { elementWorldTransform } from "./elementDomTransform";
import {
  backdropPrefix,
  createBackdropRasterSource,
  createElementRasterSource,
} from "./elementRaster";
import { createDomRasterSource, domRasterDiagnostics } from "./domRaster";
import { EffectSources } from "./effectSources";
import type {
  SceneTexture,
  SceneTextureContext,
  SceneTextureProvider,
  SceneTextureRequest,
  SceneTextureSampling,
} from "./sceneTexture";

type PrimitiveRaster = ReturnType<typeof createElementRasterSource>;
type DomRaster = ReturnType<typeof createDomRasterSource>;
type Raster = (PrimitiveRaster | DomRaster) & { readonly immutable?: boolean };

/** Own only the resulting bitmap: no source DOM, callbacks or capture observers. */
function staticPixelSnapshot(raster: Raster): Raster {
  const canvas = document.createElement("canvas");
  canvas.width = raster.canvas.width;
  canvas.height = raster.canvas.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot retain SceneTexture pixels");
  context.drawImage(raster.canvas, 0, 0);
  return {
    canvas,
    backend: "native",
    revision: raster.revision,
    isDirty: false,
    immutable: true,
    update() {},
    markDirty() {},
    dispose() {
      canvas.width = canvas.height = 1;
    },
  };
}

type SharedSources = {
  cache: EffectSources<Raster>;
  users: number;
};
const sharedSources = new WeakMap<HTMLElement, SharedSources>();
const liveSources = new Set<SharedSources>();
const retainedStaticSources = new EffectSources<Raster>(8);
const countedRevisions = new WeakMap<Raster, number>();
const fontRevisions = new WeakMap<Document, { value: number }>();
function fontRevision(document: Document) {
  let revision = fontRevisions.get(document);
  if (!revision) {
    revision = { value: 0 };
    fontRevisions.set(document, revision);
    const state = revision;
    // Retained pixels can outlive every mounted consumer. Font completion must
    // invalidate their semantic key even while no provider is subscribed.
    document.fonts.addEventListener("loadingdone", () => state.value++);
    document.fonts.addEventListener("loadingerror", () => state.value++);
  }
  return revision.value;
}
const metrics = {
  activeProviders: 0,
  preparations: 0,
  cacheHits: 0,
  retainedReuses: 0,
  captures: 0,
  preparationMs: 0,
  qualificationBuilds: 0,
  retainedSnapshots: 0,
};

export function legacySceneTextureDiagnostics() {
  return {
    ...metrics,
    retainedTextureBytes: retainedStaticSources.textureBytes,
    retainedPixelBytes: retainedStaticSources.pixelBytes,
    domRaster: domRasterDiagnostics(),
  };
}

function sourcesFor(root: HTMLElement) {
  let shared = sharedSources.get(root);
  if (!shared) {
    shared = { cache: new EffectSources<Raster>(), users: 0 };
    sharedSources.set(root, shared);
    liveSources.add(shared);
  }
  shared.users++;
  return shared;
}

export function legacySceneTextureTextureBytes() {
  return (
    retainedStaticSources.textureBytes +
    [...liveSources].reduce((sum, shared) => sum + shared.cache.textureBytes, 0)
  );
}

function hasText(elements: readonly Element[]): boolean {
  return elements.some(
    (element) => element.content?.type === "text" || hasText(element.children),
  );
}

function hasVideo(elements: readonly Element[]): boolean {
  return elements.some(
    (element) =>
      element.content?.type === "video" || hasVideo(element.children),
  );
}

function hasDomEffects(
  elements: readonly Element[],
  resources: EffectResources,
  ignoredEffectId?: string,
): boolean {
  return elements.some(
    (element) =>
      element.effects?.some(
        (effect) =>
          effect.id !== ignoredEffectId &&
          effect.enabled &&
          resources[effect.resourceId] &&
          resources[effect.resourceId].kind !== "fragment-glsl",
      ) || hasDomEffects(element.children, resources, ignoredEffectId),
  );
}

function hasAnyEffects(
  elements: readonly Element[],
  resources: EffectResources,
  ignoredEffectId?: string,
): boolean {
  return elements.some(
    (element) =>
      element.effects?.some(
        (effect) =>
          effect.id !== ignoredEffectId &&
          effect.enabled &&
          resources[effect.resourceId],
      ) || hasAnyEffects(element.children, resources, ignoredEffectId),
  );
}

/** Temporary implementation of SceneTexture using the existing primitive and
 * Chromium DOM-capture machinery. This module is the only production adapter
 * allowed to know those mechanisms for shader scene input. */
export function createLegacySceneTextureProvider(
  request: SceneTextureRequest,
  context: SceneTextureContext,
  excludedElements: ReadonlySet<string> = new Set(),
  transparentRoot = false,
  coverageMask = false,
): SceneTextureProvider {
  const observationRoot =
    request.kind === "backdrop" ? context.inputRoot : context.owner;
  const shared = sourcesFor(observationRoot);
  metrics.activeProviders++;
  let disposed = false;
  let dirty = true;
  let dirtyVersion = 0;
  let preparedKey = "";
  let pending: Promise<void> | null = null;
  let lease: ReturnType<EffectSources<Raster>["acquire"]> | null = null;
  let leaseKey = "";
  let leaseRetained = false;
  let publicRevision = 0;
  let publishedLeaseKey = "";
  let publishedSourceRevision = -1;
  let allowed = new Set<string>();
  let partial = new Set<string>();
  const prefixElements = new Map<string, Element>();
  let qualificationDirty = true;

  const invalidateProvider = () => {
    if (disposed) return;
    dirty = true;
    dirtyVersion++;
    context.invalidate();
  };

  const sourceChanged = () => {
    if (lease?.source.immutable) lease.invalidate();
    else if (lease) lease.source.markDirty();
    else invalidateProvider();
  };

  const refreshPrefix = () => {
    if (request.kind !== "backdrop" || !context.scene) return;
    const { slide, deck } = context.scene();
    const prefix = backdropPrefix(slide, deck, context.element.id);
    partial = prefix.partial;
    allowed = new Set<string>();
    prefixElements.clear();
    const visit = (elements: readonly Element[]) =>
      elements.forEach((element) => {
        if (excludedElements.has(element.id)) return;
        allowed.add(element.id);
        prefixElements.set(element.id, element);
        visit(element.children);
      });
    visit(prefix.elements);
  };

  const resolveInputElements = () => {
    if (request.kind !== "backdrop" || !context.scene) return [context.element];
    const { slide, deck } = context.scene();
    return backdropPrefix(slide, deck, context.element.id)
      .elements.filter((element) => !excludedElements.has(element.id))
      .map((element) => (coverageMask ? { ...element, effects: [] } : element));
  };

  let qualified: {
    slide: unknown;
    textStyles: unknown;
    stylesheet: string | undefined;
    resources: EffectResources;
    fonts: number;
    dom: boolean;
    retain: boolean;
    semanticRevision: string;
    stableStyleKey: unknown;
  } | null = null;
  const qualification = () => {
    const scene = context.scene?.();
    const resources = context.resources();
    const fonts = fontRevision(context.inputRoot.ownerDocument);
    if (
      !qualificationDirty &&
      qualified &&
      qualified.slide === scene?.slide &&
      qualified.textStyles === scene?.deck.textStyles &&
      qualified.stylesheet === scene?.deck.stylesheet &&
      qualified.resources === resources &&
      qualified.fonts === fonts
    )
      return qualified;
    qualificationDirty = false;
    metrics.qualificationBuilds++;
    const elements = resolveInputElements();
    const effects = hasAnyEffects(elements, resources, request.effectId);
    const retain = !!(
      context.refined &&
      scene &&
      !scene.deck.stylesheet &&
      !scene.slide.motion &&
      !hasVideo(elements) &&
      !effects
    );
    qualified = {
      slide: scene?.slide,
      textStyles: scene?.deck.textStyles,
      stylesheet: scene?.deck.stylesheet,
      resources,
      fonts,
      dom:
        coverageMask ||
        !!scene?.deck.stylesheet ||
        hasText(elements) ||
        hasDomEffects(elements, resources),
      retain,
      semanticRevision: retain
        ? JSON.stringify([elements, scene!.deck.textStyles, fonts])
        : "",
      stableStyleKey:
        context.refined && scene && !scene.deck.stylesheet && !effects
          ? scene.slide
          : undefined,
    };
    refreshPrefix();
    return qualified;
  };
  const stableStyleKey = () => qualification().stableStyleKey;

  const collectDependencies = () => {
    if (coverageMask) return [];
    qualification();
    const candidates = Array.from(
      context.inputRoot.querySelectorAll<HTMLElement>("[data-effect-id]"),
    )
      .filter((dependency) => {
        if (
          dependency === context.effectNode ||
          dependency.contains(context.effectNode)
        )
          return false;
        if (dependency.closest('[data-presentation-absent="true"]'))
          return false;
        const owner =
          dependency.closest<HTMLElement>("[data-element-id]")?.dataset
            .elementId;
        return (
          request.kind !== "backdrop" ||
          (!!owner && allowed.has(owner) && !partial.has(owner))
        );
      })
      .reverse();
    return candidates;
  };

  const flushDependencies = async () => {
    for (const dependency of collectDependencies()) {
      await context.flushEffect(dependency);
      if (!context.refined) continue;
      let hidden = false;
      for (
        let ancestor = dependency.parentElement;
        ancestor && ancestor !== context.inputRoot;
        ancestor = ancestor.parentElement
      ) {
        if (
          ancestor.hasAttribute("data-effect-source") &&
          ancestor.style.opacity === "0" &&
          !partial.has(
            ancestor.closest<HTMLElement>("[data-element-id]")?.dataset
              .elementId ?? "",
          )
        ) {
          hidden = true;
          break;
        }
      }
      if (!hidden) context.materializeEffect(dependency);
    }
  };

  const rasterContext = {
    root: observationRoot,
    get resources() {
      return context.resources();
    },
    beforeEffect: request.effectId,
    typographySource: context.scene ? () => context.scene!().deck : undefined,
    flush: (dependency: HTMLElement) => context.materializeEffect(dependency),
  };

  const createPrimitiveRaster = (invalidate: () => void): PrimitiveRaster => {
    if (request.kind === "backdrop") {
      if (!context.scene)
        throw new Error("Backdrop SceneTexture requires a slide scene.");
      return createBackdropRasterSource(
        context.element,
        context.scene,
        rasterContext,
        invalidate,
      );
    }
    return createElementRasterSource(
      context.element,
      rasterContext,
      invalidate,
    );
  };

  const createNativeRaster = (invalidate: () => void) =>
    createDomRasterSource(
      () => {
        qualification();
        return context.inputRoot;
      },
      (candidate) => {
        if (
          context.refined &&
          candidate !== context.inputRoot &&
          candidate.hasAttribute("data-effect-source") &&
          candidate.style.opacity === "0" &&
          !partial.has(
            candidate.closest<HTMLElement>("[data-element-id]")?.dataset
              .elementId ?? "",
          ) &&
          candidate.parentElement?.dataset.effectStarted === "true" &&
          !candidate.parentElement.dataset.effectError
        )
          return false;
        if (candidate.closest('[data-presentation-absent="true"]'))
          return false;
        const owner = candidate.closest<HTMLElement>("[data-element-id]");
        if (
          request.kind === "backdrop" &&
          owner &&
          !allowed.has(owner.dataset.elementId!)
        )
          return false;
        if (owner && partial.has(owner.dataset.elementId!)) {
          if (candidate.hasAttribute("data-element-stroke")) return false;
          const effectId =
            candidate.closest<HTMLElement>("[data-effect-id]")?.dataset
              .effectId;
          const instance = prefixElements
            .get(owner.dataset.elementId!)
            ?.effects?.find((effect) => effect.id === effectId);
          if (instance?.placement === "overlay") return false;
          if (
            candidate instanceof HTMLCanvasElement &&
            instance &&
            effectPlacement(
              context.resources()[instance.resourceId],
              instance,
            ) === "content"
          )
            return false;
        }
        return true;
      },
      (original, clone) => {
        if (
          original.hasAttribute("data-effect-source") &&
          (original === context.inputRoot ||
            partial.has(
              original.closest<HTMLElement>("[data-element-id]")?.dataset
                .elementId ?? "",
            ))
        )
          clone.style.setProperty("opacity", "1", "important");
        if (original === context.inputRoot && request.kind === "backdrop") {
          if (transparentRoot)
            clone.style.setProperty(
              "background",
              coverageMask ? "#000000" : "transparent",
              "important",
            );
          clone.style.setProperty("transform", "none", "important");
          clone.style.setProperty("transform-origin", "0 0", "important");
        }
      },
      invalidate,
      flushDependencies,
      () =>
        request.kind === "backdrop"
          ? elementWorldTransform(context.owner, context.inputRoot).inverse()
          : new DOMMatrix(),
      context.refined,
      stableStyleKey,
      coverageMask ? "#ffffff" : undefined,
    );

  const ensureLease = (sampling: SceneTextureSampling) => {
    const { dom, retain, semanticRevision } = qualification();
    const key =
      request.kind +
      ":" +
      context.element.id +
      (request.kind === "element" && !retain ? ":" + request.effectId : "") +
      "|" +
      (dom ? "dom" : "primitive") +
      "|" +
      sampling.width +
      "x" +
      sampling.height +
      "|" +
      sampling.logicalWidth +
      "x" +
      sampling.logicalHeight +
      (retain ? "|semantic:" + semanticRevision : "") +
      (transparentRoot ? "|transparent" : "") +
      (coverageMask ? "|coverage" : "");
    if (key === leaseKey && lease?.isCurrent()) return;
    lease?.release();
    const cache = retain ? retainedStaticSources : shared.cache;
    lease = cache.acquire(
      key,
      dom ? createNativeRaster : createPrimitiveRaster,
      invalidateProvider,
    );
    leaseKey = key;
    leaseRetained = retain;
    if (retain && lease.reused && lease.source.revision > 0) {
      dirty = false;
      preparedKey = JSON.stringify(sampling);
      metrics.retainedReuses++;
    } else {
      dirty = true;
      preparedKey = "";
    }
  };

  const finishPreparation = (
    version: number,
    key: string,
    activeLease: NonNullable<typeof lease>,
  ) => {
    if (disposed || lease !== activeLease) return;
    preparedKey = key;
    const sourceRevision = activeLease.source.revision;
    if (
      publishedLeaseKey !== leaseKey ||
      publishedSourceRevision !== sourceRevision
    ) {
      publicRevision++;
      publishedLeaseKey = leaseKey;
      publishedSourceRevision = sourceRevision;
    }
    if (dirtyVersion === version) dirty = false;
  };

  const prepare = (sampling: SceneTextureSampling): void | Promise<void> => {
    if (disposed) return;
    ensureLease(sampling);
    if (!lease) throw new Error("SceneTexture source is unavailable.");
    const key = JSON.stringify(sampling);
    if (!dirty && preparedKey === key) {
      metrics.cacheHits++;
      return;
    }
    if (pending)
      return pending.then(() => {
        const next = prepare(sampling);
        return next instanceof Promise ? next : undefined;
      });
    const version = dirtyVersion;
    const activeLease = lease;
    const update = () => {
      const raster = activeLease.source;
      const beforeRevision = raster.revision;
      const started = performance.now();
      metrics.preparations++;
      const completed = () => {
        metrics.preparationMs += performance.now() - started;
        if (
          raster.revision !== beforeRevision &&
          raster.revision > (countedRevisions.get(raster) ?? 0)
        ) {
          metrics.captures +=
            raster.revision - (countedRevisions.get(raster) ?? 0);
          countedRevisions.set(raster, raster.revision);
        }
        if (
          !disposed &&
          lease === activeLease &&
          activeLease.isCurrent() &&
          activeLease.source === raster &&
          leaseRetained &&
          !raster.immutable &&
          raster.revision > 0
        ) {
          activeLease.replaceSource(staticPixelSnapshot(raster));
          metrics.retainedSnapshots++;
        }
        finishPreparation(version, key, activeLease);
      };
      const result =
        "backend" in raster
          ? raster.update(
              sampling.width,
              sampling.height,
              sampling.logicalWidth,
              sampling.logicalHeight,
            )
          : raster.update(sampling.width, sampling.height);
      if (result instanceof Promise) return result.then(completed);
      completed();
    };
    const dependencies = collectDependencies();
    if (dependencies.length) {
      pending = flushDependencies()
        .then(update)
        .finally(() => {
          pending = null;
        });
      return pending;
    }
    const result = update();
    if (result instanceof Promise) {
      pending = result.finally(() => {
        pending = null;
      });
      return pending;
    }
  };

  const acquire = (
    sampling: SceneTextureSampling,
  ): SceneTexture | Promise<SceneTexture> => {
    const prepared = prepare(sampling);
    const texture = () => {
      if (!lease) throw new Error("SceneTexture source is unavailable.");
      const activeLease = lease;
      return {
        get revision() {
          return publicRevision;
        },
        bind(gl: WebGL2RenderingContext, unit = 0) {
          activeLease.upload(gl, unit);
        },
      };
    };
    return prepared instanceof Promise ? prepared.then(texture) : texture();
  };

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type !== "attributes"))
      qualificationDirty = true;
    const normalizedStyle = (value: string | null) =>
      (value ?? "")
        .replace(/(?:^|;)\s*opacity\s*:[^;]*/g, "")
        .replace(/\s/g, "");
    if (
      records.some(
        (record) =>
          record.type === "childList" ||
          record.type === "characterData" ||
          ((record.target instanceof HTMLElement ||
            record.target instanceof SVGElement) &&
            !(
              record.target === context.inputRoot &&
              record.target.hasAttribute("data-effect-source") &&
              record.attributeName === "style" &&
              normalizedStyle(record.oldValue) ===
                normalizedStyle(record.target.getAttribute("style"))
            ) &&
            (request.kind === "backdrop" || record.target !== context.owner) &&
            !record.target.dataset.effectId &&
            record.target.tagName !== "CANVAS" &&
            !record.attributeName?.startsWith("data-effect")),
      )
    )
      sourceChanged();
  });
  observer.observe(observationRoot, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });
  const outputChanged = (event: Event) => {
    if (coverageMask) return;
    if (
      event.target instanceof Node &&
      event.target !== context.effectNode &&
      !(
        event.target instanceof HTMLElement &&
        excludedElements.has(
          event.target.closest<HTMLElement>("[data-element-id]")?.dataset
            .elementId ?? "",
        )
      ) &&
      observationRoot.contains(event.target)
    )
      sourceChanged();
  };
  observationRoot.addEventListener("load", sourceChanged, true);
  observationRoot.addEventListener("loadeddata", sourceChanged, true);
  observationRoot.addEventListener("seeked", sourceChanged, true);
  observationRoot.addEventListener("timeupdate", sourceChanged, true);
  observationRoot.addEventListener("showme-effect-output", outputChanged);

  return {
    prepare,
    acquire,
    invalidate: sourceChanged,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      observationRoot.removeEventListener("load", sourceChanged, true);
      observationRoot.removeEventListener("loadeddata", sourceChanged, true);
      observationRoot.removeEventListener("seeked", sourceChanged, true);
      observationRoot.removeEventListener("timeupdate", sourceChanged, true);
      observationRoot.removeEventListener(
        "showme-effect-output",
        outputChanged,
      );
      if (leaseRetained && lease && !lease.source.immutable) lease.invalidate();
      lease?.release();
      lease = null;
      shared.users--;
      metrics.activeProviders--;
      if (!shared.users) {
        liveSources.delete(shared);
        sharedSources.delete(observationRoot);
      }
    },
  };
}
