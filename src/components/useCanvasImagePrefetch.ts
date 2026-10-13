import { useEffect, type RefObject } from "react";
import type { Deck } from "../core/document";
import { slideHierarchyRows } from "../core/slideHierarchy";
import {
  planPresentationImages,
  type ImageRequestProfile,
} from "../core/presentationImages";
import { resolveVisualSlide } from "../core/templates";
import { platform } from "../platform";
import { waitForSlideImages } from "./audienceImagePreparation";

/** Warm the next editor slide at its actual canvas tier after current pixels settle. */
export function useCanvasImagePrefetch(
  root: RefObject<HTMLDivElement | null>,
  deck: Deck,
  slideId: string,
  profile: ImageRequestProfile | undefined,
  enabled: boolean,
) {
  useEffect(() => {
    if (
      !enabled ||
      !profile ||
      !root.current ||
      !platform.renderProjection ||
      !platform.preparedImage
    )
      return;
    const ids = slideHierarchyRows(deck).map((row) => row.id);
    void platform.prioritizeCanvasImages!(deck.id, slideId).catch(() => {});
    const nextId = ids[ids.indexOf(slideId) + 1];
    if (!nextId || !ids.includes(slideId)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const warm = async () => {
      const projection = await platform.renderProjection!(deck.id, nextId);
      if (abort.signal.aborted) return;
      const slide = resolveVisualSlide(
        projection.deck,
        projection.slide,
        projection.templates ?? {},
      ).slide;
      const requirements = planPresentationImages(
        projection.deck,
        [slide],
        profile,
        true,
      );
      // One in-flight neighbour image; navigation cancels the remaining work.
      for (const requirement of requirements) {
        if (abort.signal.aborted) return;
        const image = await platform.preparedImage!(
          deck.id,
          nextId,
          requirement.instances[0].elementId,
          profile,
        );
        if (image) platform.releaseUrl(image.url);
      }
    };
    void waitForSlideImages(root.current, abort.signal).then(() => {
      if (!abort.signal.aborted)
        timer = setTimeout(() => {
          void warm().catch(() => {});
        }, 80);
    });
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [root, deck, slideId, profile, enabled]);
}
