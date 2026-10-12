import { useEffect, useState, type RefObject } from "react";
import type { Slide } from "../core/document";
import { presentationSpan } from "./presentationDiagnostics";
import { useImageGeneration } from "./useImageGeneration";
import { useDisplayDensity } from "./useDisplayDensity";
import { waitForSlideImages } from "./audienceImagePreparation";

/** Prepare mounted neighbours too; changing which slide is active keeps their rasters. */
export function usePreparedSlideImages(
  root: RefObject<HTMLElement | null>,
  slide: Slide | null,
  scale: number,
  documentId: string,
) {
  const generation = useImageGeneration(documentId);
  const pixelRatio = useDisplayDensity();
  const [ready, setReady] = useState<{
    slide: Slide;
    scale: number;
    generation: string;
    pixelRatio: number;
  } | null>(null);
  useEffect(() => {
    if (!slide || !root.current || scale <= 0) return;
    const node = root.current;
    const finish = presentationSpan("image-preparation", slide.id);
    const abort = new AbortController();
    let mounted = true;
    const prepare = async () => {
      const loaded = presentationSpan("media-load", slide.id);
      await waitForSlideImages(node, abort.signal);
      loaded();
      if (abort.signal.aborted) return;
      const fonts = presentationSpan("fonts-ready", slide.id);
      await document.fonts?.ready;
      fonts();
      // MediaSurface clears its loading marker only after decode or a deliberate
      // missing-asset transition. Recheck after fonts in case sources changed.
      await waitForSlideImages(node, abort.signal);
      if (!abort.signal.aborted && mounted)
        setReady({ slide, scale, generation, pixelRatio });
    };
    void prepare()
      .catch(() => {})
      .finally(() => {
        finish({ cancelled: abort.signal.aborted, mounted });
      });
    return () => {
      mounted = false;
      abort.abort();
    };
  }, [root, slide, scale, generation, pixelRatio]);
  return (
    ready?.slide === slide &&
    ready?.scale === scale &&
    ready?.generation === generation &&
    ready.pixelRatio === pixelRatio
  );
}
