import { useEffect, useState } from "react";
import type { ImageOutputProfile } from "../core/presentationImages";
import { platform } from "../platform";
import { useDisplayDensity } from "./useDisplayDensity";
import { useImageGeneration } from "./useImageGeneration";

/** Negotiate settled geometry before any audience image view mounts. */
export function useAudienceImageProfile(documentId: string | undefined, revision: number | undefined, onError: (cause: unknown) => void) {
  const pixelRatio = useDisplayDensity();
  const generation = useImageGeneration(documentId ?? null);
  const [viewport, setViewport] = useState(() => `${innerWidth}x${innerHeight}`);
  const [result, setResult] = useState<{ documentId: string; profile: ImageOutputProfile } | null>(null);
  useEffect(() => {
    const resize = () => setViewport(`${innerWidth}x${innerHeight}`);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    void platform.prepareAudience!(documentId).then(profile => {
      if (live) setResult(old => old?.documentId === documentId && old.profile.width === profile.width && old.profile.height === profile.height ? old : { documentId, profile });
    }).catch(cause => { if (live) onError(cause); });
    return () => { live = false; };
  }, [documentId, revision, viewport, pixelRatio, generation, onError]);
  return result && result.documentId === documentId ? result.profile : null;
}
