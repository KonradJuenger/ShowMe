import type { Deck, Slide } from "../../src/core/document";
import { planPresentationImages, audienceImageProfile } from "../../src/core/presentationImages";
import { platform } from "../../src/platform";

/** Isolated renderer tests replace IO but keep the production bulk consumer contract. */
export function installPreparedSlideImagesMock(deck: Deck, slides: Record<string, Slide>) {
  platform.preparedSlideImages = async (documentId, slideId, profile) => Object.fromEntries(
    (await Promise.all(planPresentationImages(deck, [slides[slideId]], profile, true).map(async requirement => {
      const image = await platform.preparedImage!(documentId, slideId, requirement.instances[0].elementId, profile);
      return requirement.instances.map(instance => [instance.elementId, image]);
    }))).flat(),
  );
  platform.prepareAudience = async () => audienceImageProfile(innerWidth, innerHeight, devicePixelRatio);
  platform.audienceImageProfile = platform.prepareAudience;
}
