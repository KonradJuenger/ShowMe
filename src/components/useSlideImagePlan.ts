import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Deck, Slide } from "../core/document";
import type {
  ImageOutputProfile,
  PreparedSlideImages,
} from "../core/presentationImages";
import { useRenderResources, type RenderResources } from "./renderResources";
import { useImageGeneration } from "./useImageGeneration";

export interface SlideImagePlan {
  key: string;
  images: PreparedSlideImages | null;
}

function release(resources: RenderResources, images: PreparedSlideImages) {
  for (const url of new Set(
    Object.values(images).flatMap((image) => (image ? [image.url] : [])),
  ))
    resources.releaseUrl(url);
}

/** A slide owns one bulk result; individual media views borrow its URL leases. */
export function useSlideImagePlan(
  slide: Slide,
  deck: Deck,
  profile: ImageOutputProfile | undefined,
  enabled: boolean,
  defer: boolean,
): SlideImagePlan | undefined {
  const resources = useRenderResources();
  const generation = useImageGeneration(deck.id);
  const width = profile?.width,
    height = profile?.height;
  const key = `${deck.id}:${slide.id}:${width ?? "audience"}x${height ?? "audience"}:${generation}`;
  const [result, setResult] = useState<{
    slide: Slide;
    key: string;
    images: PreparedSlideImages;
  } | null>(null);
  const owned = useRef<PreparedSlideImages | null>(null);
  useLayoutEffect(() => {
    if (owned.current && owned.current !== result?.images)
      release(resources, owned.current);
    owned.current = result?.images ?? null;
  }, [result, resources]);
  useEffect(
    () => () => {
      if (owned.current) release(resources, owned.current);
    },
    [resources],
  );
  useEffect(() => {
    if (!enabled || defer || !resources.preparedSlideImages) return;
    let live = true;
    void resources.preparedSlideImages!(
      deck.id,
      slide.id,
      width && height ? { width, height } : undefined,
    )
      .then((images) => {
        if (live) {
          setResult({ slide, key, images });
        } else release(resources, images);
      })
      .catch(() => {
        if (live) setResult({ slide, key, images: {} });
      });
    return () => {
      live = false;
    };
  }, [enabled, defer, deck.id, slide, key, width, height, resources]);
  return useMemo(() => {
    if (!enabled) return undefined;
    if (defer && result) return { key: result.key, images: result.images };
    return {
      key,
      images:
        result?.key === key && result.slide === slide ? result.images : null,
    };
  }, [enabled, defer, result, key, slide]);
}
