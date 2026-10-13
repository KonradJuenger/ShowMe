import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Deck, Slide } from "../core/document";
import type { ImageRequestProfile, PreparedSlideImages } from "../core/presentationImages";
import { platform } from "../platform";
import { useImageGeneration } from "./useImageGeneration";

export interface SlideImagePlan {
  key: string;
  images: PreparedSlideImages | null;
}

function release(images: PreparedSlideImages) {
  for (const url of new Set(Object.values(images).flatMap(image => image ? [image.url] : []))) platform.releaseUrl(url);
}

/** A slide owns one bulk result; individual media views borrow its URL leases. */
export function useSlideImagePlan(slide: Slide, deck: Deck, profile: ImageRequestProfile | undefined, enabled: boolean, defer: boolean, canvasSignature?: string): SlideImagePlan | undefined {
  const generation = useImageGeneration(deck.id);
  const width = profile?.width, height = profile?.height, sampling = profile?.sampling;
  const pixels = sampling === "canvas" ? canvasSignature : `${width}x${height}`;
  const canvasImageCount = canvasSignature ? (JSON.parse(canvasSignature) as unknown[]).length : 0;
  const invalidation = sampling === "canvas" ? generation.slice(generation.lastIndexOf(":") + 1) : generation;
  const key = `${deck.id}:${slide.id}:${pixels}:${sampling}:${invalidation}`;
  const [result, setResult] = useState<{ slide: Slide; key: string; images: PreparedSlideImages } | null>(null);
  const owned = useRef<PreparedSlideImages | null>(null);
  const retained = useRef<{ slide: Slide; key: string; images: PreparedSlideImages } | null>(null);
  useLayoutEffect(() => {
    if (owned.current && owned.current !== result?.images) release(owned.current);
    owned.current = result?.images ?? null;
  }, [result]);
  useEffect(() => () => { if (owned.current) release(owned.current); }, []);
  useEffect(() => {
    if (!enabled || defer || !width || !height) return;
    if (sampling === "canvas" && retained.current?.key === key &&
        Object.keys(retained.current.images).length === canvasImageCount) {
      setResult({ ...retained.current, slide });
      return;
    }
    let live = true;
    void platform.preparedSlideImages!(deck.id, slide.id, { width, height, ...(sampling ? { sampling } : {}) })
      .then(images => { if (live) { retained.current = { slide, key, images }; setResult(retained.current); } else release(images); })
      .catch(() => { if (live) setResult({ slide, key, images: {} }); });
    return () => { live = false; };
  }, [enabled, defer, deck.id, slide, key, width, height, sampling, canvasImageCount]);
  return useMemo(() => {
    if (!enabled) return undefined;
    if (defer && result) return { key: result.key, images: result.images };
    return { key, images: result?.key === key && result.slide === slide ? result.images : null };
  }, [enabled, defer, result, key, slide]);
}
