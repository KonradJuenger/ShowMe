import { createDomRasterSource } from "./domRaster";
import { resizeRasterCanvas } from "./canvasAllocation";
import { elementWorldTransform } from "./elementDomTransform";
import { backdropPrefix, createBackdropRasterSource } from "./elementRaster";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";
import { walkElements } from "../core/element";
import { cssBackdropOutputs } from "./cssBackdropOutput";

/** Replay the scene behind a CSS material inside its compositing group. Chromium
 * stops a descendant backdrop-filter at an ancestor's group opacity. Supplying
 * those pixels inside the group lets the browser resolve the material first,
 * then fade the complete result (including overlapping text/fills) once.
 * This is renderer-local paint, never a document or an alternate slide renderer.
 */
export function createCssBackdrop(
  node: HTMLElement,
  invalidate: () => void,
  prepare: (nodes: HTMLElement[]) => void,
  content?: {
    element: Element;
    resources: EffectResources;
    scene?: () => { slide: Slide; deck: Deck };
  },
) {
  const scene = node.closest<HTMLElement>(".slide-renderer");
  if (!scene) return null;
  let raster: ReturnType<typeof createDomRasterSource> | undefined;
  let primitive: ReturnType<typeof createBackdropRasterSource> | undefined;
  let disposed = false;
  let publishedRevision = -1;
  let padding = 0;
  let foreground: ReturnType<typeof createDomRasterSource> | undefined;
  let foregroundOpacity = "";
  let composite = false;
  const filtered = document.createElement("canvas");
  let declarationCache:
    | {
        slide: Slide;
        deck: Deck;
        element: Element;
        definition: unknown;
        entries: ReadonlyArray<readonly [string, string]> | null;
      }
    | undefined;
  let preparingForeground: Promise<void> | undefined;
  const declarations = () => {
    const state = content?.scene?.();
    const instance = content?.element.effects?.find(
      (effect) => effect.id === node.dataset.effectId,
    );
    const definition =
      instance && state?.slide.effectResources?.[instance.resourceId];
    if (
      state &&
      content &&
      declarationCache?.slide === state.slide &&
      declarationCache.deck === state.deck &&
      declarationCache.element === content.element &&
      declarationCache.definition === definition
    )
      return declarationCache.entries;
    if (
      !state ||
      !content ||
      definition?.kind !== "css" ||
      instance?.placement !== "content" ||
      !content.element.clipChildren ||
      content.element.appearance.strokeWidth ||
      content.element.effects?.filter((effect) => effect.enabled).length !==
        1 ||
      /url\(/i.test(definition.source) ||
      !stableStyleKey()
    )
      return null;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(definition.source);
    const rule = sheet.cssRules[0];
    if (!(rule instanceof CSSStyleRule)) return null;
    const entries = Array.from(rule.style).map(
      (key) => [key, rule.style.getPropertyValue(key)] as const,
    );
    if (
      entries.some(
        ([key]) =>
          !/^(?:background(?:-.*)?|border(?:-.*)?|box-shadow|overflow(?:-.*)?|(?:-webkit-)?backdrop-filter|color|font(?:-.*)?|text(?:-.*)?|line-height|letter-spacing|padding(?:-.*)?)$/.test(
            key,
          ),
      )
    )
      return null;
    const descendants = walkElements(content.element.children),
      ids = new Set(descendants.map((element) => element.id));
    if (
      descendants.some(
        (element) =>
          element.effects?.some((effect) => effect.enabled) ||
          element.content?.type === "video",
      ) ||
      state.slide.motion?.stages.some(
        (stage) =>
          stage.tracks.some((track) => ids.has(track.elementId)) ||
          stage.blocks?.some(
            (block) =>
              block.binding &&
              "elementId" in block.binding &&
              ids.has(block.binding.elementId),
          ),
      )
    )
      return null;
    declarationCache = {
      ...state,
      element: content.element,
      definition,
      entries,
    };
    return entries;
  };
  const needsMaterial = () =>
    Array.from(scene.querySelectorAll<HTMLElement>("[data-effect-id]")).some(
      (candidate) => {
        if (
          candidate === node ||
          node.contains(candidate) ||
          candidate.contains(node) ||
          !(
            node.compareDocumentPosition(candidate) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        )
          return false;
        const owner = candidate.closest<HTMLElement>("[data-element-id]");
        return (
          owner &&
          Number(getComputedStyle(owner).opacity) < 1 &&
          !!candidate
            .querySelector("style")
            ?.textContent?.includes("backdrop-filter")
        );
      },
    );
  let plannedMaterial = false;
  const prepareForeground = async (density: number) => {
    const rules = declarations();
    const needed = !!rules && needsMaterial();
    if (needed !== plannedMaterial) {
      plannedMaterial = needed;
      invalidate();
    }
    if (!needed || !rules || !content) return;
    if (preparingForeground) return preparingForeground;
    const task = async () => {
      if (!foreground) {
        foregroundOpacity = node.style.opacity;
        foreground = createDomRasterSource(
          () => node,
          () => true,
          (original, clone) => {
            // Presence may hide the card during preparation. Its static material
            // is captured before the entrance; group alpha remains on the owner.
            clone.style.setProperty("visibility", "visible", "important");
            if (original === node) {
              rules.forEach(([key, value]) =>
                clone.style.setProperty(key, value, "important"),
              );
              clone.style.setProperty("backdrop-filter", "none", "important");
              clone.style.setProperty("opacity", "1", "important");
              clone.style.setProperty("box-sizing", "border-box", "important");
              clone.style.setProperty(
                "width",
                `${content.element.frame.width}px`,
                "important",
              );
              clone.style.setProperty(
                "height",
                `${content.element.frame.height}px`,
                "important",
              );
            }
          },
          invalidate,
          async () => {},
          () => new DOMMatrix(),
          true,
          stableStyleKey,
        );
        invalidate();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      if (disposed || !foreground) return;
      await foreground.update(
        Math.ceil(content.element.frame.width * density),
        Math.ceil(content.element.frame.height * density),
        content.element.frame.width,
        content.element.frame.height,
      );
    };
    preparingForeground = task().finally(() => {
      preparingForeground = undefined;
    });
    return preparingForeground;
  };
  const stopComposite = () => {
    cssBackdropOutputs.delete(node);
    if (foreground) {
      foreground.dispose();
      foreground = undefined;
      node.style.opacity = foregroundOpacity;
    }
    if (composite) {
      replay.style.visibility = "hidden";
      primitive?.dispose();
      primitive = undefined;
      composite = false;
    }
  };
  const replay = document.createElement("canvas");
  replay.dataset.cssBackdrop = "true";
  replay.setAttribute("aria-hidden", "true");
  replay.style.cssText =
    "position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0;visibility:hidden;";
  const precedes = (candidate: HTMLElement) =>
    candidate !== replay &&
    !node.contains(candidate) &&
    !!(
      candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  const inputs = () =>
    Array.from(scene.querySelectorAll<HTMLElement>("[data-effect-id]")).filter(
      (candidate) => !candidate.contains(node) && precedes(candidate),
    );
  let frozenScene:
    | {
        slide: Slide;
        deck: Deck;
        resources: EffectResources | undefined;
        key: object | null;
      }
    | undefined;
  const stableStyleKey = () => {
    const value = content?.scene?.();
    if (!value || value.deck.stylesheet) return null;
    if (
      frozenScene?.slide !== value.slide ||
      frozenScene.deck !== value.deck ||
      frozenScene.resources !== value.slide.effectResources
    ) {
      const constant = Object.values(value.slide.effectResources ?? {}).every(
        (definition) =>
          definition.kind === "fragment-glsl" ||
          (definition.kind === "css" &&
            /^\s*:scope\s*\{[^{}]*\}\s*$/.test(definition.source) &&
            !/\b(?:var|env|attr)\s*\(|(?:animation|transition)[\w-]*\s*:/i.test(
              definition.source,
            )),
      );
      frozenScene = {
        ...value,
        resources: value.slide.effectResources,
        key: constant ? {} : null,
      };
    }
    return frozenScene.key;
  };
  const observer = new MutationObserver((records) => {
    if (
      !raster &&
      records.some(
        ({ target }) =>
          target instanceof HTMLElement &&
          target !== node &&
          (target.contains(node) || precedes(target)),
      )
    ) {
      primitive?.markDirty();
      invalidate();
    }
  });
  observer.observe(scene, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  const changed = (event: Event) => {
    if (event.target instanceof HTMLElement && precedes(event.target)) {
      raster?.markDirty();
      primitive?.markDirty();
      invalidate();
    }
  };
  scene.addEventListener("showme-effect-output", changed);
  return {
    inputs,
    prepare: prepareForeground,
    hide() {
      stopComposite();
      replay.style.visibility = "hidden";
    },
    async update(density: number) {
      const filter = getComputedStyle(node).backdropFilter;
      padding = [...filter.matchAll(/blur\(([\d.]+)px\)/g)].reduce(
        (sum, match) => sum + Math.ceil(Number(match[1]) * 3),
        0,
      );
      if (filter === "none" || !filter) {
        stopComposite();
        replay.style.visibility = "hidden";
        return;
      }
      // Keep native CSS on the fast path when no ancestor blocks its backdrop.
      let blocked = false;
      for (
        let ancestor = node.parentElement;
        ancestor && ancestor !== scene;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const boundary =
          Number(style.opacity) < 1 ||
          style.willChange.split(",").some((part) => part.trim() === "opacity");
        blocked ||= boundary;
      }
      const state = content?.scene?.();
      const authored =
        content &&
        state &&
        content.element.effects?.find(
          (effect) => effect.id === node.dataset.effectId,
        );
      const definition =
        authored && state?.slide.effectResources?.[authored.resourceId];
      const childIds = new Set(
        content
          ? walkElements(content.element.children).map((element) => element.id)
          : [],
      );
      const dynamicChildren = state?.slide.motion?.stages.some(
        (stage) =>
          stage.tracks.some((track) => childIds.has(track.elementId)) ||
          stage.blocks?.some(
            (block) =>
              block.binding &&
              "elementId" in block.binding &&
              childIds.has(block.binding.elementId),
          ),
      );
      const descendants = content ? walkElements(content.element.children) : [];
      const style = getComputedStyle(node),
        clipStyle = node.parentElement && getComputedStyle(node.parentElement);
      const laterNeedsPixels = needsMaterial();
      const materialWorld = laterNeedsPixels
        ? elementWorldTransform(node.parentElement!, scene)
        : undefined;
      const material = !!(
        state &&
        content &&
        definition?.kind === "css" &&
        authored?.placement === "content" &&
        stableStyleKey() &&
        declarations() &&
        content.element.clipChildren &&
        !content.element.appearance.strokeWidth &&
        content.element.effects?.filter((effect) => effect.enabled).length ===
          1 &&
        descendants.every(
          (element) =>
            !element.effects?.some((effect) => effect.enabled) &&
            element.content?.type !== "video",
        ) &&
        !dynamicChildren &&
        laterNeedsPixels &&
        /^\d+(?:\.\d+)?px$/.test(style.borderRadius) &&
        clipStyle?.borderRadius === style.borderRadius &&
        style.filter === "none" &&
        style.mixBlendMode === "normal" &&
        style.maskImage === "none" &&
        !/url\(|drop-shadow\(/.test(filter) &&
        materialWorld &&
        Math.abs(Math.hypot(materialWorld.a, materialWorld.b) - 1) < 0.001 &&
        Math.abs(Math.hypot(materialWorld.c, materialWorld.d) - 1) < 0.001 &&
        (composite || style.opacity === "1")
      );
      if (!material) stopComposite();
      if (!blocked && !material) {
        replay.style.visibility = "hidden";
        raster?.dispose();
        primitive?.dispose();
        raster = undefined;
        primitive = undefined;
        publishedRevision = -1;
        replay.remove();
        replay.width = replay.height = 1;
        return;
      }
      // The canonical primitive backdrop painter can synchronously reuse live
      // shader canvases. Native DOM capture remains necessary for contributing
      // text/CSS. Text outside the sampling window cannot change these pixels.
      const target = node.closest<HTMLElement>("[data-element-id]");
      const area = node.getBoundingClientRect();
      const margin =
        padding *
        Math.max(
          area.width / node.offsetWidth,
          area.height / node.offsetHeight,
        );
      const intersects = (candidate: HTMLElement) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.right > area.left - margin &&
          rect.left < area.right + margin &&
          rect.bottom > area.top - margin &&
          rect.top < area.bottom + margin
        );
      };
      const prefix =
        state && content
          ? backdropPrefix(state.slide, state.deck, content.element.id)
          : null;
      const domEffects = (elements: Element[]): boolean =>
        elements.some((element) => {
          const surfaces = Array.from(
            scene.querySelectorAll<HTMLElement>("[data-effect-id]"),
          );
          if (
            surfaces.some(
              (surface) =>
                surface.closest<HTMLElement>("[data-element-id]")?.dataset
                  .elementId === element.id && cssBackdropOutputs.has(surface),
            )
          )
            return false;
          return (
            element.effects?.some(
              (effect) =>
                effect.enabled &&
                state?.slide.effectResources?.[effect.resourceId]?.kind !==
                  "fragment-glsl",
            ) || domEffects(element.children)
          );
        });
      const simple =
        state &&
        content &&
        target &&
        prefix &&
        !state.deck.stylesheet &&
        !domEffects(prefix.elements) &&
        content.element.effects?.filter((effect) => effect.enabled).length ===
          1 &&
        content.element.effects[0].placement !== "overlay" &&
        !Array.from(
          scene.querySelectorAll<HTMLElement>("[data-text-content]"),
        ).some(
          (candidate) =>
            precedes(candidate) &&
            intersects(candidate) &&
            !cssBackdropOutputs.has(
              candidate.closest<HTMLElement>("[data-effect-id]")!,
            ),
        );
      if (material && !composite) {
        primitive?.dispose();
        primitive = undefined;
        composite = true;
      }
      if (material) await prepareForeground(density);
      const compose = (
        input: HTMLCanvasElement,
        width: number,
        height: number,
        matrix = new DOMMatrix(),
      ) => {
        if (!material || !foreground) return false;
        const ctx = resizeRasterCanvas(
          replay,
          Math.max(1, Math.ceil(width * density)),
          Math.max(1, Math.ceil(height * density)),
        );
        ctx.resetTransform();
        ctx.clearRect(0, 0, replay.width, replay.height);
        ctx.scale(density, density);
        const drawInput = () => {
          ctx.save();
          ctx.transform(
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            matrix.e,
            matrix.f,
          );
          ctx.drawImage(input, 0, 0, width, height);
          ctx.restore();
        };
        drawInput();
        // Only the low-pass backdrop is reduced. Native foreground text/borders
        // remain at output density, and group alpha is still applied once.
        const sigma = /^blur\(([\d.]+)px\)/.exec(filter);
        const filterDensity =
          sigma && Number(sigma[1]) >= 8
            ? Math.min(density, Math.max(0.25, 4 / Number(sigma[1])))
            : density;
        const filteredContext = resizeRasterCanvas(
          filtered,
          Math.max(1, Math.ceil(width * filterDensity)),
          Math.max(1, Math.ceil(height * filterDensity)),
        );
        filteredContext.resetTransform();
        filteredContext.clearRect(0, 0, filtered.width, filtered.height);
        filteredContext.scale(filterDensity, filterDensity);
        filteredContext.filter = filter.replace(
          /blur\(([\d.]+)px\)/g,
          (_, radius: string) => `blur(${Number(radius) * filterDensity}px)`,
        );
        filteredContext.transform(
          matrix.a,
          matrix.b,
          matrix.c,
          matrix.d,
          matrix.e,
          matrix.f,
        );
        filteredContext.drawImage(input, 0, 0, width, height);
        filteredContext.filter = "none";
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(
          padding,
          padding,
          content!.element.frame.width,
          content!.element.frame.height,
          parseFloat(style.borderRadius),
        );
        ctx.clip();
        ctx.drawImage(filtered, 0, 0, width, height);
        ctx.restore();
        ctx.drawImage(
          foreground.canvas,
          padding,
          padding,
          content!.element.frame.width,
          content!.element.frame.height,
        );
        node.style.opacity = "0";
        cssBackdropOutputs.set(node, {
          canvas: replay,
          padding,
          width,
          height,
        });
        if (!replay.parentElement) node.before(replay);
        replay.style.width = `${width}px`;
        replay.style.height = `${height}px`;
        replay.style.transform = `translate(${-padding}px, ${-padding}px)`;
        replay.style.visibility = "visible";
        replay.dataset.rasterRevision = String(
          Number(replay.dataset.rasterRevision ?? 0) + 1,
        );
        replay.dataset.cssBackdropBackend = "material";
        return true;
      };
      if (simple) {
        if (raster) {
          raster.dispose();
          raster = undefined;
          publishedRevision = -1;
        }
        const unfaded = new Set<string>();
        for (
          let ancestor = node.parentElement;
          ancestor && ancestor !== scene;
          ancestor = ancestor.parentElement
        )
          if (ancestor.dataset.elementId)
            unfaded.add(ancestor.dataset.elementId);
        primitive ??= createBackdropRasterSource(
          content.element,
          content.scene!,
          {
            root: scene,
            get resources() {
              return content.scene!().slide.effectResources ?? {};
            },
            beforeEffect: "",
            unfaded,
            outputCanvas: material ? undefined : replay,
            typographySource: () => content.scene!().deck,
            flush: (dependency) => prepare([dependency]),
          },
          invalidate,
          { padding: () => padding, includeTargetFill: true },
        );
        const width = content.element.frame.width + 2 * padding,
          height = content.element.frame.height + 2 * padding;
        primitive.update(
          Math.max(1, Math.ceil(width * density)),
          Math.max(1, Math.ceil(height * density)),
        );
        if (compose(primitive.canvas, width, height)) return;
        if (!replay.parentElement) node.before(replay);
        replay.style.width = `${width}px`;
        replay.style.height = `${height}px`;
        replay.style.transform = `translate(${-padding}px, ${-padding}px)`;
        replay.style.visibility = "visible";
        replay.dataset.rasterRevision = String(primitive.revision);
        replay.dataset.cssBackdropBackend = "primitive";
        return;
      }
      if (primitive) {
        primitive.dispose();
        primitive = undefined;
        publishedRevision = -1;
      }
      if (!raster) {
        node.before(replay);
        raster = createDomRasterSource(
          () => scene,
          (candidate) =>
            candidate !== node &&
            (candidate === scene ||
              candidate.contains(node) ||
              precedes(candidate)),
          (original, clone) => {
            if (original.contains(node)) {
              clone.style.setProperty("opacity", "1", "important");
              clone.style.setProperty("will-change", "auto", "important");
            }
          },
          invalidate,
          async () => prepare(inputs()),
          () =>
            new DOMMatrix()
              .translate(padding, padding)
              .multiply(
                elementWorldTransform(node.parentElement!, scene).inverse(),
              ),
          true,
          stableStyleKey,
        );
        // Native layoutsubtree canvases must enter layout before requestPaint.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      if (disposed) return;
      const width = node.offsetWidth + padding * 2,
        height = node.offsetHeight + padding * 2;
      // A strongly blurred, fully clipped backdrop has no visible sharp pixels.
      // Sample its input at four pixels per blur sigma, then let Chromium apply
      // the authored filter in logical CSS units. Text/content stays native at
      // output resolution; only this low-pass material input is reduced.
      const blur = /^blur\(([\d.]+)px\)/.exec(filter);
      const clip = node.parentElement && getComputedStyle(node.parentElement);
      const reduced =
        blur &&
        Number(blur[1]) >= 8 &&
        clip?.overflow === "hidden" &&
        clip.borderRadius === getComputedStyle(node).borderRadius;
      const inputDensity = reduced
        ? Math.min(density, Math.max(0.25, 4 / Number(blur[1])))
        : density;
      await raster.update(
        Math.max(1, Math.ceil(width * inputDensity)),
        Math.max(1, Math.ceil(height * inputDensity)),
        width,
        height,
      );
      if (disposed) return;
      const inverse = elementWorldTransform(
        node.parentElement!,
        scene,
      ).inverse();
      const captured = new DOMMatrix(raster.canvas.dataset.domRasterTransform);
      if (
        compose(
          raster.canvas,
          width,
          height,
          new DOMMatrix()
            .translate(padding, padding)
            .multiply(inverse)
            .multiply(captured.inverse()),
        )
      )
        return;
      if (publishedRevision !== raster.revision) {
        if (replay.width !== raster.canvas.width)
          replay.width = raster.canvas.width;
        if (replay.height !== raster.canvas.height)
          replay.height = raster.canvas.height;
        const context = replay.getContext("2d")!;
        context.clearRect(0, 0, replay.width, replay.height);
        context.drawImage(raster.canvas, 0, 0);
        publishedRevision = raster.revision;
      }
      replay.style.width = `${width}px`;
      replay.style.height = `${height}px`;
      // A capture can complete after Motion has advanced. Keep its pixels in
      // scene coordinates until the next snapshot instead of moving them with
      // the card (which makes the backdrop visibly swim during an entrance).
      replay.style.transform = inverse.multiply(captured.inverse()).toString();
      replay.style.visibility = "visible";
      replay.dataset.rasterRevision = String(raster.revision);
      replay.dataset.cssBackdropBackend = "native";
    },
    dispose() {
      disposed = true;
      stopComposite();
      observer.disconnect();
      scene.removeEventListener("showme-effect-output", changed);
      raster?.dispose();
      primitive?.dispose();
      replay.remove();
      replay.width = replay.height = 1;
      filtered.width = filtered.height = 1;
    },
  };
}
