import type { Deck, Slide } from "./document";
import { planPresentationImages, type ImageOutputProfile } from "./presentationImages";

export const AUDIENCE_RESIDENT_IMAGE_BYTES = 256 * 1024 * 1024;

/** Pin incoming/outgoing output; optional lookahead is admitted by unique raster bytes. */
export function audienceImageWindow(deck: Deck, slides: ReadonlyMap<string, Slide>, ids: readonly string[], index: number,
  profile: ImageOutputProfile, heldId?: string, budget = AUDIENCE_RESIDENT_IMAGE_BYTES) {
  const required = [ids[index], ids[index + 1], heldId].filter((id): id is string => !!id);
  const selected = new Set(required);
  const bytes = (values: Set<string>) => {
    const variants = new Map<string, number>();
    for (const id of values) {
      const slide = slides.get(id);
      if (!slide) return Infinity;
      for (const requirement of planPresentationImages(deck, [slide], profile, true)) {
        variants.set(`${requirement.assetId}:${requirement.width}x${requirement.height}`, requirement.width * requirement.height * 4);
      }
    }
    return [...variants.values()].reduce((sum, value) => sum + value, 0);
  };
  for (const id of [ids[index - 1], ids[index + 2]]) {
    if (!id || selected.has(id)) continue;
    const candidate = new Set([...selected, id]);
    if (bytes(candidate) <= budget) selected.add(id);
  }
  return [...selected];
}
