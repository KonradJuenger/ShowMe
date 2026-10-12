import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import type {
  ImageRequestProfile,
  ImageRequirement,
  PreparedImage,
} from "../core/presentationImages";
import { useImageGeneration } from "./useImageGeneration";

/** Resolve before original decoding; cached intrinsic dimensions remain source dimensions. */
export function usePreparedImage(
  documentId: string | null,
  slideId: string,
  elementId: string,
  assetId: string,
  enabled: boolean,
  profile?: ImageRequestProfile,
  deferUpdates = false,
  canvasRequirement?: Pick<ImageRequirement, "assetId" | "width" | "height">,
) {
  const [result, setResult] = useState<{
    id: string;
    key: string;
    image: PreparedImage | null;
    settled: boolean;
  } | null>(null);
  const ownedUrl = useRef<string | null>(null);
  const displayedImage = useRef<PreparedImage | null>(null);
  const displayedRequest = useRef<{
    identity: string;
    requirement: string;
    invalidation: string;
  } | null>(null);
  useLayoutEffect(() => {
    const nextUrl = result?.image?.url ?? null;
    if (ownedUrl.current && ownedUrl.current !== nextUrl)
      platform.releaseUrl(ownedUrl.current);
    ownedUrl.current = nextUrl;
  }, [result?.image?.url]);
  useEffect(
    () => () => {
      if (ownedUrl.current) platform.releaseUrl(ownedUrl.current);
    },
    [],
  );
  const generation = useImageGeneration(documentId);
  // Accepted-revision preparation generations do not invalidate canvas pixels.
  // Explicit cache clears/settings changes are the suffix of this token.
  const invalidation = generation.slice(generation.lastIndexOf(":") + 1);
  const canvasAssetId = canvasRequirement?.assetId;
  const canvasWidth = canvasRequirement?.width;
  const canvasHeight = canvasRequirement?.height;
  const requirementKey = canvasRequirement
    ? `${canvasRequirement.assetId}:${canvasRequirement.width}x${canvasRequirement.height}`
    : undefined;
  const key = `${documentId}:${slideId}:${elementId}:${assetId}:${generation}:${profile?.width}:${profile?.height}:${profile?.sampling}:${requirementKey}`;
  const identity = `${documentId}:${slideId}:${elementId}:${assetId}`;
  useEffect(() => {
    // A gesture keeps the displayed variant, including when an older request
    // finishes in flight. On release, resolve the latest accepted geometry.
    if (!enabled || !documentId || !platform.preparedImage || deferUpdates)
      return;
    if (
      profile?.sampling === "canvas" &&
      canvasAssetId !== undefined &&
      canvasWidth !== undefined &&
      canvasHeight !== undefined &&
      displayedImage.current &&
      displayedRequest.current?.identity === identity &&
      displayedRequest.current.requirement === requirementKey &&
      displayedRequest.current.invalidation === invalidation
    ) {
      setResult({
        id: identity,
        key,
        image: displayedImage.current,
        settled: true,
      });
      return;
    }
    let live = true;
    const resolve = async () => {
      const image = await platform.preparedImage!(
        documentId,
        slideId,
        elementId,
        profile,
      );
      if (
        image &&
        live &&
        !(
          profile?.sampling === "canvas" &&
          displayedImage.current?.hash === image.hash
        )
      ) {
        const probe = new Image();
        probe.crossOrigin = "anonymous";
        probe.src = image.url;
        try {
          await probe.decode();
        } catch {
          platform.releaseUrl(image.url);
          return null;
        }
      }
      return image;
    };
    void resolve()
      .then((image) => {
        if (!live) {
          if (image) platform.releaseUrl(image.url);
          return;
        }
        // Canvas requests may resolve to the same tier after a document revision
        // or a small zoom change. Keep the existing decoded URL in that case.
        const current = displayedImage.current;
        displayedRequest.current =
          image &&
          canvasAssetId !== undefined &&
          canvasWidth !== undefined &&
          canvasHeight !== undefined &&
          requirementKey &&
          image.assetId === canvasAssetId &&
          image.width === Math.min(image.sourceWidth, canvasWidth) &&
          image.height === Math.min(image.sourceHeight, canvasHeight)
            ? { identity, requirement: requirementKey, invalidation }
            : null;
        if (
          image &&
          profile?.sampling === "canvas" &&
          current?.hash === image.hash
        ) {
          if (current.url !== image.url) platform.releaseUrl(image.url);
          setResult({ id: identity, key, image: current, settled: true });
          return;
        }
        displayedImage.current = image;
        setResult({ id: identity, key, image, settled: true });
      })
      .catch(() => {
        if (live) {
          displayedImage.current = null;
          displayedRequest.current = null;
          setResult({ id: identity, key, image: null, settled: true });
        }
      });
    return () => {
      live = false;
    };
  }, [
    key,
    identity,
    generation,
    documentId,
    slideId,
    elementId,
    assetId,
    enabled,
    profile,
    deferUpdates,
    canvasAssetId,
    canvasWidth,
    canvasHeight,
    requirementKey,
    invalidation,
  ]);
  const available = enabled && documentId && platform.preparedImage;
  return {
    image: !available
      ? null
      : result?.id === identity
        ? result.image
        : undefined,
    checking: Boolean(
      available &&
      (result?.id !== identity || result.key !== key || !result.settled),
    ),
  };
}
