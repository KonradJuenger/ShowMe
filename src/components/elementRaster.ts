import { nodeTransform, elementWorldTransform } from "./elementDomTransform";
import { resizeRasterCanvas } from "./canvasAllocation";
import type { Element, MediaContent } from "../core/element";
import type { Deck, Slide } from "../core/document";
import { effectPlacement, type EffectResources } from "../core/effects";
import {
  resolveTextTypography,
  type TextStyleSource,
} from "../core/textTypography";

/** A primitive renderer, not a DOM screenshot. DOM bindings supply already
 * decoded resources and Motion's current local transform/font measurements. */
let sourceScans = 0;
export function rasterSourceDiagnostics() { return { scans: sourceScans }; }

export type RasterContext = {
  root: HTMLElement;
  resources: EffectResources;
  beforeEffect: string;
  flush(node: HTMLElement): void;
  typographySource?: () => TextStyleSource;
  /** Ancestors whose paint stops at the backdrop target. */
  partial?: ReadonlySet<string>;
};

function owned<T extends HTMLElement>(node: HTMLElement, selector: string) {
  return Array.from(node.querySelectorAll<T>(selector)).filter(
    (n) => n.closest("[data-element-id]") === node,
  );
}
function visualNode(element: Element, root: HTMLElement) {
  if (root.dataset.elementId === element.id) return root;
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-element-id]")).find(
      (n) => n.dataset.elementId === element.id,
    ) ?? null
  );
}
function sourceEffect(
  element: Element,
  node: HTMLElement,
  context: RasterContext,
) {
  const effects = (element.effects ?? []).filter((e) => e.enabled);
  // Instance IDs are scoped to an Element (clipboard/duplication retains them).
  // Only the target's pipeline stops here; descendants finish their own stacks.
  const stop =
    node === context.root
      ? effects.findIndex((e) => e.id === context.beforeEffect)
      : -1;
  const earlier = stop < 0 ? effects : effects.slice(0, stop);
  for (const effect of effects) {
    const surface = owned(node, "[data-effect-id]").find(
      (n) => n.dataset.effectId === effect.id,
    );
    if (surface?.dataset.effectStarted === "false") continue;
    const definition = context.resources[effect.resourceId];
    if (definition?.kind === "css" || definition?.kind === "text-js")
      throw new Error(
        "Content rasterization cannot include CSS or text-function effects. Use content shaders for this compositing group.",
      );
  }
  if (context.partial?.has(element.id)) return null;
  for (const prior of earlier.slice().reverse()) {
    if (context.resources[prior.resourceId]?.input !== "content") continue;
    const surface = owned(node, "[data-effect-id]").find(
      (n) => n.dataset.effectId === prior.id,
    );
    if (!surface) continue;
    context.flush(surface);
    if (
      surface.dataset.effectStarted !== "false" &&
      !surface.dataset.effectError
    )
      return surface;
  }
  return null;
}

function transform(ctx: CanvasRenderingContext2D, node: HTMLElement) {
  const matrix = nodeTransform(node);
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
}

function path(ctx: CanvasRenderingContext2D, element: Element, inset = 0) {
  const { width, height } = element.frame;
  ctx.beginPath();
  if (element.geometry.type === "ellipse")
    ctx.ellipse(
      width / 2,
      height / 2,
      Math.max(0, width / 2 - inset),
      Math.max(0, height / 2 - inset),
      0,
      0,
      Math.PI * 2,
    );
  else
    ctx.roundRect(
      inset,
      inset,
      Math.max(0, width - inset * 2),
      Math.max(0, height - inset * 2),
      Math.max(
        0,
        Math.min(element.appearance.radius, width / 2, height / 2) - inset,
      ),
    );
}

/** Preserve explicit newlines/spaces; break long words just as overflow-wrap:anywhere.
 * Canvas shapes each complete line, rather than drawing individual glyphs. */
export function wrapRasterText(
  text: string,
  width: number,
  measure: (text: string) => number,
  wrap: boolean,
) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!wrap || !paragraph) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const token of paragraph.match(/\S+|\s+/gu) ?? []) {
      if (line && measure(line + token) > width) {
        lines.push(line);
        line = "";
      }
      for (const letter of Array.from(token)) {
        if (line && measure(line + letter) > width) {
          lines.push(line);
          line = "";
        }
        line += letter;
      }
    }
    lines.push(line);
  }
  return lines;
}

function text(
  ctx: CanvasRenderingContext2D,
  element: Element,
  node: HTMLElement,
  context: RasterContext,
) {
  const content = element.content;
  if (content?.type !== "text") return;
  const view = owned(node, "[data-text-content]")[0];
  if (!view)
    throw new Error(
      "Text is being edited; the original Element remains visible.",
    );
  const style = getComputedStyle(view);
  const typography = resolveTextTypography(
    context.typographySource?.(),
    content,
  );
  const fontSize = parseFloat(style.fontSize),
    lineHeight =
      parseFloat(style.lineHeight) || fontSize * typography.lineHeight;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
  ctx.letterSpacing = style.letterSpacing;
  ctx.fillStyle = style.color;
  ctx.textAlign = style.textAlign as CanvasTextAlign;
  const lines = wrapRasterText(
    content.text,
    element.frame.width,
    (value) => ctx.measureText(value).width,
    content.autoSize !== "both",
  );
  const metrics = ctx.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent,
    descent = metrics.fontBoundingBoxDescent;
  const height = lines.length * lineHeight;
  const top =
    style.justifyContent === "center"
      ? (element.frame.height - height) / 2
      : style.justifyContent === "flex-end"
        ? element.frame.height - height
        : 0;
  const x =
    style.textAlign === "center"
      ? element.frame.width / 2
      : style.textAlign === "right"
        ? element.frame.width
        : 0;
  lines.forEach((line, index) =>
    ctx.fillText(
      content.autoSize === "both" ? line : line.trimEnd(),
      x,
      top +
        index * lineHeight +
        Math.floor((lineHeight - ascent - descent) / 2) +
        ascent,
    ),
  );
}

function media(
  ctx: CanvasRenderingContext2D,
  content: MediaContent,
  node: HTMLElement,
) {
  const view = owned(node, "[data-media-asset-id]")[0];
  if (!view)
    throw new Error(
      "Media is unavailable; the original Element remains visible.",
    );
  const video = view.querySelector("video");
  const image = Array.from(view.querySelectorAll("img")).find(
    (n) =>
      getComputedStyle(n).display !== "none" && n.complete && n.naturalWidth,
  );
  const resource =
    video && video.readyState >= 2 && video.style.visibility === "visible"
      ? video
      : image;
  if (!resource)
    throw new Error(
      "Waiting for decoded media; the original Element remains visible.",
    );
  ctx.save();
  transform(ctx, view);
  ctx.globalAlpha *= content.opacity;
  const style = getComputedStyle(view);
  ctx.drawImage(
    resource,
    0,
    0,
    parseFloat(style.width),
    parseFloat(style.height),
  );
  ctx.restore();
}

function paintShaderSurfaces(
  ctx: CanvasRenderingContext2D,
  element: Element,
  node: HTMLElement,
  context: RasterContext,
  placement: "background" | "overlay",
) {
  for (const effect of element.effects ?? []) {
    if (
      !effect.enabled ||
      effectPlacement(context.resources[effect.resourceId], effect) !==
        placement
    )
      continue;
    const surface = owned(node, "[data-effect-id]").find(
      (n) => n.dataset.effectId === effect.id,
    );
    if (!surface) continue;
    context.flush(surface);
    const canvas = surface.querySelector("canvas");
    if (
      canvas &&
      surface.dataset.effectStarted !== "false" &&
      !surface.dataset.effectError
    )
      ctx.drawImage(canvas, 0, 0, element.frame.width, element.frame.height);
  }
}

function render(
  ctx: CanvasRenderingContext2D,
  element: Element,
  context: RasterContext,
  target: boolean,
) {
  const node = visualNode(element, context.root);
  if (!node) throw new Error("Element visual is not mounted yet.");
  if (node.closest('[data-presentation-absent="true"]')) return;
  ctx.save();
  if (!target) transform(ctx, node);
  // The target's own transform/opacity is applied once by the ordinary outer DOM
  // owner. Child opacity requires a compositing group, not per-primitive alpha.
  const opacity = target ? 1 : Number(getComputedStyle(node).opacity);
  const previous = sourceEffect(element, node, context);
  if (previous && !previous.dataset.effectError) {
    const output = previous.querySelector("canvas");
    if (output) {
      ctx.globalAlpha *= opacity;
      ctx.drawImage(output, 0, 0, element.frame.width, element.frame.height);
      ctx.restore();
      return;
    }
  }
  if (opacity < 1) {
    // Isolate alpha in the current target viewport. A non-clipping child may
    // extend beyond its own frame; cropping it here would change group behavior.
    const layer = document.createElement("canvas");
    layer.width = ctx.canvas.width;
    layer.height = ctx.canvas.height;
    const group = layer.getContext("2d")!;
    group.setTransform(ctx.getTransform());
    paint(group, element, node, context);
    ctx.save();
    ctx.resetTransform();
    ctx.globalAlpha *= opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    layer.width = layer.height = 1;
  } else paint(ctx, element, node, context);
  ctx.restore();
}
function paint(
  ctx: CanvasRenderingContext2D,
  element: Element,
  node: HTMLElement,
  context: RasterContext,
) {
  if (element.appearance.fill) {
    path(ctx, element);
    ctx.fillStyle = element.appearance.fill;
    ctx.fill();
  }
  ctx.save();
  if (element.clipChildren) {
    path(ctx, element);
    ctx.clip();
  }
  paintShaderSurfaces(ctx, element, node, context, "background");
  if (element.content?.type === "text") text(ctx, element, node, context);
  else if (element.content) media(ctx, element.content, node);
  for (const child of element.children) render(ctx, child, context, false);
  if (!context.partial?.has(element.id))
    paintShaderSurfaces(ctx, element, node, context, "overlay");
  ctx.restore();
  if (!context.partial?.has(element.id) && element.appearance.strokeWidth > 0) {
    path(ctx, element, element.appearance.strokeWidth / 2);
    ctx.strokeStyle = element.appearance.strokeColor;
    ctx.lineWidth = element.appearance.strokeWidth;
    ctx.stroke();
  }
}

export function renderElementToSurface(
  element: Element,
  canvas: HTMLCanvasElement,
  context: RasterContext,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot allocate content source surface");
  ctx.resetTransform();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(
    canvas.width / element.frame.width,
    canvas.height / element.frame.height,
  );
  render(ctx, element, context, true);
}

/** Source invalidation is independent of the shader clock. Only relevant primitive
 * styles/resources and earlier effect outputs participate in this signature. */
export function createElementRasterSource(
  element: Element,
  context: RasterContext,
  invalidate: () => void,
) {
  return createRasterSource(
    context,
    invalidate,
    (scan) => scan(element, true),
    (canvas) => renderElementToSurface(element, canvas, context),
  );
}

function createRasterSource(
  context: RasterContext,
  invalidate: () => void,
  signatureFor: (
    scan: (element: Element, target: boolean) => unknown[],
  ) => unknown,
  paintSource: (canvas: HTMLCanvasElement) => void,
) {
  const canvas = document.createElement("canvas");
  const videos = new Map<HTMLVideoElement, { id: number; revision: number }>();
  let signature = "",
    revision = 0,
    disposed = false,
    fonts = 0,
    dirty = true;
  const markDirty = () => { dirty = true; invalidate(); };
  const fontChanged = () => {
    fonts++;
    markDirty();
  };
  document.fonts.addEventListener("loadingdone", fontChanged);
  const styleObserver = new MutationObserver(markDirty);
  styleObserver.observe(document.head, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let ancestor = context.root.parentElement; ancestor; ancestor = ancestor.parentElement) styleObserver.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
  const seenVideos = new Set<HTMLVideoElement>();
  const scan = (current: Element, target: boolean): unknown[] => {
    const node = visualNode(current, context.root);
    if (!node) return ["unmounted", current.id];
    if (node.closest('[data-presentation-absent="true"]'))
      return ["absent", current.id];
    const previous = sourceEffect(current, node, context);
    if (previous && !previous.dataset.effectError)
      return [
        previous.dataset.effectRevision,
        // Mounting a changed lower definition can restart its output revision.
        current.effects?.map((effect) => [
          effect,
          context.resources[effect.resourceId],
        ]),
        target ? "" : node.style.cssText,
      ];
    const primitives = owned(node, "[data-showme-part='content']").map(
      (view) => {
        const style = getComputedStyle(view);
        return [
          view.style.cssText,
          style.fontFamily,
          style.fontWeight,
          style.fontStyle,
          style.fontSize,
          style.color,
          style.lineHeight,
          style.letterSpacing,
          ...Array.from(
            view.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
              "img,video",
            ),
          ).map((resource) => {
            if (resource instanceof HTMLVideoElement) {
              seenVideos.add(resource);
              if (!videos.has(resource)) {
                const state = { id: 0, revision: 0 };
                const update = () => {
                  if (disposed) return;
                  state.revision++;
                  markDirty();
                  state.id = resource.requestVideoFrameCallback(update);
                };
                videos.set(resource, state);
                if (typeof resource.requestVideoFrameCallback === "function")
                  state.id = resource.requestVideoFrameCallback(update);
              }
              return [
                resource.currentSrc,
                resource.readyState,
                videos.get(resource)!.revision,
                typeof resource.requestVideoFrameCallback === "function"
                  ? 0
                  : resource.currentTime,
                getComputedStyle(resource).display,
                resource.style.visibility,
              ];
            }
            return [
              resource.currentSrc,
              resource.complete,
              resource.naturalWidth,
              getComputedStyle(resource).display,
              resource.style.visibility,
            ];
          }),
        ];
      },
    );
    const effects = (current.effects ?? [])
      .filter(
        (e) =>
          e.enabled &&
          effectPlacement(context.resources[e.resourceId], e) !== "content" &&
          (!context.partial?.has(current.id) ||
            effectPlacement(context.resources[e.resourceId], e) ===
              "background"),
      )
      .map((effect) => {
        const surface = owned(node, "[data-effect-id]").find(
          (n) => n.dataset.effectId === effect.id,
        );
        if (surface) context.flush(surface);
        return [
          effect,
          context.resources[effect.resourceId],
          surface?.dataset.effectRevision,
          surface?.dataset.effectError,
        ];
      });
    return [
      { ...current, children: undefined, effects: undefined },
      target ? "" : node.style.cssText,
      primitives,
      effects,
      ...current.children.map((child) => scan(child, false)),
    ];
  };
  return {
    canvas,
    get revision() {
      return revision;
    },
    markDirty,
    update(width: number, height: number) {
      // Browser-driven CSS animations and video without frame callbacks remain
      // conservative dynamic inputs, even for custom unregistered content.
      const animated = context.root.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
      const dynamicVideo = [...videos.keys()].some(video => typeof video.requestVideoFrameCallback !== "function" && !video.paused);
      if (!dirty && canvas.width === width && canvas.height === height && !animated && !dynamicVideo) return false;
      const force = dirty || animated || dynamicVideo;
      dirty = false;
      sourceScans++;
      seenVideos.clear();
      const next = JSON.stringify([width, height, fonts, signatureFor(scan)]);
      videos.forEach((state, video) => {
        if (!seenVideos.has(video)) {
          if (state.id) video.cancelVideoFrameCallback(state.id);
          videos.delete(video);
        }
      });
      if (signature === next && !force) return false;
      resizeRasterCanvas(canvas, width, height);
      paintSource(canvas);
      signature = next;
      revision++;
      return true;
    },
    dispose() {
      disposed = true;
      styleObserver.disconnect();
      document.fonts.removeEventListener("loadingdone", fontChanged);
      videos.forEach((state, video) => {
        if (state.id) video.cancelVideoFrameCallback(state.id);
      });
      videos.clear();
      canvas.width = canvas.height = 1;
    },
  };
}

/** Complete lower subtrees plus unfinished ancestors. Never visits the target,
 * its descendants, or higher peers. Both sources share the primitive painter. */
function backdropPrefix(slide: Slide, deck: Deck, targetId: string) {
  const partial = new Set<string>();
  let reached = false;
  const visit = (children: readonly Element[]): Element[] => {
    const result: Element[] = [];
    for (const element of children) {
      if (element.id === targetId) {
        reached = true;
        break;
      }
      const earlier = visit(element.children);
      if (reached) {
        partial.add(element.id);
        result.push({ ...element, children: earlier });
        break;
      }
      result.push(element);
    }
    return result;
  };
  const elements: Element[] = [];
  for (const layer of slide.nodes) {
    const definition = deck.layers.find((entry) => entry.id === layer.id);
    if (!definition || definition.hidden) continue;
    elements.push(...visit(layer.children));
    if (reached) break;
  }
  if (!reached) throw new Error("Backdrop target is not in the visible scene.");
  return { elements, partial };
}

export function createBackdropRasterSource(
  element: Element,
  scene: () => { slide: Slide; deck: Deck },
  context: RasterContext,
  invalidate: () => void,
) {
  let prefix = backdropPrefix(scene().slide, scene().deck, element.id);
  const painting = {
    ...context,
    get resources() {
      return context.resources;
    },
    partial: prefix.partial,
  };
  const target = () => {
    const node = visualNode(element, context.root);
    if (!node) throw new Error("Backdrop frame is not mounted yet.");
    return elementWorldTransform(node, context.root);
  };
  return createRasterSource(
    painting,
    invalidate,
    (scan) => {
      const { slide, deck } = scene();
      prefix = backdropPrefix(slide, deck, element.id);
      painting.partial = prefix.partial;
      return [
        slide.background,
        deck.width,
        deck.height,
        target().toString(),
        ...prefix.elements.map((entry) => scan(entry, false)),
      ];
    },
    (canvas) => {
      const { slide, deck } = scene();
      const ctx = canvas.getContext("2d")!;
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(
        canvas.width / element.frame.width,
        canvas.height / element.frame.height,
      );
      const world = target().inverse();
      ctx.transform(world.a, world.b, world.c, world.d, world.e, world.f);
      ctx.beginPath();
      ctx.rect(0, 0, deck.width, deck.height);
      ctx.clip();
      ctx.fillStyle = slide.background;
      ctx.fillRect(0, 0, deck.width, deck.height);
      for (const entry of prefix.elements) render(ctx, entry, painting, false);
    },
  );
}
