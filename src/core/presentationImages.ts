import type { Deck, Slide } from "./document";
import { resolveMediaFrame, walkElements, type Element } from "./element";
import { resolveMotion, resolveMotionValue } from "./motion";

export const IMAGE_RECIPE = "png-lanczos3-tiled-source-sdr-v1";
// Generous allowance: almost twice an 8K frame (about 256 MiB of RGBA pixels).
export const MAX_PREPARED_IMAGE_PIXELS = 64 * 1024 * 1024;

/** Derivatives only reduce source sampling; enlargement stays with the renderer. */
export function canPrepareImage(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) {
  return (
    [sourceWidth, sourceHeight, width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) &&
    width <= sourceWidth &&
    height <= sourceHeight &&
    width * height <= MAX_PREPARED_IMAGE_PIXELS
  );
}

export interface ImageOutputProfile {
  width: number;
  height: number;
}
/** Canvas sampling is disposable; audience and export profiles stay exact. */
export interface ImageRequestProfile extends ImageOutputProfile {
  sampling?: "canvas";
}
export interface ImageRequirement {
  assetId: string;
  size: number;
  width: number;
  height: number;
  slideIds: string[];
  instances: Array<{ slideId: string; elementId: string }>;
  estimatedBytes: number;
}
export interface PreparedImage {
  assetId: string;
  hash: string;
  size: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  mime: "image/png";
  recipe: string;
  url: string;
}
export interface ImageReadiness {
  documentId: string;
  epoch: string;
  revision: number;
  profile: ImageOutputProfile;
  generation: number;
  state: "checking" | "preparing" | "ready" | "failed";
  total: number;
  completed: number;
  failures: Array<{ assetId: string; slideIds: string[]; message: string }>;
}

export function imagePixels(required: number) {
  if (!Number.isFinite(required) || required <= 0)
    throw new Error("Invalid image sampling requirement");
  return Math.max(1, Math.ceil(required));
}

/** Round upwards so a canvas variant never undersamples its requested size. */
export function canvasImagePixels(required: number) {
  return Math.ceil(imagePixels(required) / 256) * 256;
}

const scalePlans = new WeakMap<
  Slide,
  Map<number | undefined, Map<string, { x: number; y: number; rotates?: true }>>
>();
export function maximumElementScale(
  slide: Slide,
  element: Element,
  stageIndex?: number,
) {
  let plans = scalePlans.get(slide);
  if (!plans) scalePlans.set(slide, (plans = new Map()));
  let maxima = plans.get(stageIndex);
  if (!maxima) {
    maxima = new Map();
    const elements = new Map(
      walkElements(slide.nodes.flatMap((root) => root.children)).map((item) => [
        item.id,
        item,
      ]),
    );
    const entering =
      stageIndex === undefined
        ? undefined
        : resolveMotion(slide, stageIndex - 1, Infinity);
    for (const item of elements.values())
      maxima.set(item.id, {
        ...(item.frame.rotation || entering?.[item.id]?.["transform.rotation"]
          ? { rotates: true as const }
          : {}),
        x: Math.max(
          Math.abs(item.frame.scaleX),
          Math.abs(
            entering?.[item.id]?.["transform.scaleX"] ?? item.frame.scaleX,
          ),
        ),
        y: Math.max(
          Math.abs(item.frame.scaleY),
          Math.abs(
            entering?.[item.id]?.["transform.scaleY"] ?? item.frame.scaleY,
          ),
        ),
      });
    const stages =
      stageIndex === undefined
        ? (slide.motion?.stages ?? [])
        : (slide.motion?.stages.slice(stageIndex, stageIndex + 1) ?? []);
    for (const stage of stages)
      for (const track of stage.tracks) {
        if (track.property === "transform.rotation") {
          const maximum = maxima.get(track.elementId);
          if (maximum) maximum.rotates = true;
        }
        if (
          track.property !== "transform.scaleX" &&
          track.property !== "transform.scaleY"
        )
          continue;
        const item = elements.get(track.elementId);
        if (!item) continue;
        const base =
          track.property === "transform.scaleX"
            ? item.frame.scaleX
            : item.frame.scaleY;
        const axis = track.property === "transform.scaleX" ? "x" : "y";
        let maximum = maxima.get(item.id)![axis];
        if (track.initial)
          maximum = Math.max(
            maximum,
            Math.abs(resolveMotionValue(track.initial, base)),
          );
        for (const key of track.keyframes)
          maximum = Math.max(
            maximum,
            Math.abs(resolveMotionValue(key.value, base)),
          );
        for (let i = 0; i + 1 < track.keyframes.length; i++) {
          const key = track.keyframes[i],
            next = track.keyframes[i + 1];
          if (!Array.isArray(key.easeToNext)) continue;
          const from = resolveMotionValue(key.value, base),
            to = resolveMotionValue(next.value, base);
          for (const progress of [key.easeToNext[1], key.easeToNext[3]])
            maximum = Math.max(
              maximum,
              Math.abs(from + (to - from) * progress),
            );
        }
        maxima.get(item.id)![axis] = maximum;
      }
    plans.set(stageIndex, maxima);
  }
  return (
    maxima.get(element.id) ?? {
      x: Math.abs(element.frame.scaleX),
      y: Math.abs(element.frame.scaleY),
    }
  );
}

/** Pure whole-source sampling plan; clipping never reduces required detail. */
export function planPresentationImages(
  deck: Deck,
  slides: readonly Slide[],
  profile: ImageRequestProfile,
  includeHiddenSlides = false,
): ImageRequirement[] {
  if (
    ![profile.width, profile.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error("Invalid output profile");
  const density = Math.min(
    profile.width / deck.width,
    profile.height / deck.height,
  );
  const requirements = new Map<string, ImageRequirement>();
  const pixels =
    profile.sampling === "canvas" ? canvasImagePixels : imagePixels;
  for (const slide of slides) {
    if (!includeHiddenSlides && deck.slideMeta[slide.id]?.hidden) continue;
    const visit = (
      elements: readonly Element[],
      parentScale: { x: number; y: number },
    ) => {
      for (const element of elements) {
        const maximum = maximumElementScale(slide, element);
        const scale = {
          x: parentScale.x * maximum.x,
          y: parentScale.y * maximum.y,
        };
        // Rotation mixes physical axes. Keep a conservative envelope for
        // those branches; axis-aligned Frames remain independently exact.
        if (maximum.rotates) scale.x = scale.y = Math.max(scale.x, scale.y);
        const content = element.content;
        // GIF/APNG/WebP can be animated. The processor verifies page counts too.
        if (content?.type === "image" && !/\.svg$/i.test(content.filename)) {
          const frame = resolveMediaFrame(element);
          const sampling = {
            x: scale.x * Math.abs(frame?.scaleX ?? 1),
            y: scale.y * Math.abs(frame?.scaleY ?? 1),
          };
          if (frame?.rotation)
            sampling.x = sampling.y = Math.max(sampling.x, sampling.y);
          // Use the entire resolved image rectangle, including pixels outside its crop.
          const width = pixels(
            Math.max(1, (frame?.width ?? 8192) * sampling.x * density),
          );
          const height = pixels(
            Math.max(1, (frame?.height ?? 8192) * sampling.y * density),
          );
          const key = `${content.assetId}:${width}x${height}`;
          const existing = requirements.get(key);
          if (existing) {
            existing.slideIds.push(slide.id);
            existing.instances.push({
              slideId: slide.id,
              elementId: element.id,
            });
          } else
            requirements.set(key, {
              assetId: content.assetId,
              size: Math.max(width, height),
              width,
              height,
              slideIds: [slide.id],
              instances: [{ slideId: slide.id, elementId: element.id }],
              estimatedBytes:
                content.transform.rule !== "free" &&
                content.transform.intrinsicWidth &&
                content.transform.intrinsicHeight
                  ? content.transform.intrinsicWidth *
                    content.transform.intrinsicHeight *
                    24
                  : 512 * 1024 * 1024,
            });
        }
        visit(element.children, scale);
      }
    };
    for (const root of slide.nodes)
      if (!deck.layers.find((layer) => layer.id === root.id)?.hidden)
        visit(root.children, { x: 1, y: 1 });
  }
  return Array.from(requirements.values()).map((value) => ({
    ...value,
    slideIds: [...new Set(value.slideIds)],
  }));
}

export function imageDimensions(
  sourceWidth: number,
  sourceHeight: number,
  size: number,
) {
  const ratio = size / Math.max(sourceWidth, sourceHeight);
  return {
    width: Math.max(1, Math.ceil(sourceWidth * ratio)),
    height: Math.max(1, Math.ceil(sourceHeight * ratio)),
  };
}
export function imageIdentity(assetId: string, width: number, height: number) {
  return `${IMAGE_RECIPE}:${assetId}:${width}x${height}`;
}
