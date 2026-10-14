import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import type {
  ImageOutputProfile,
  PreparedImage,
} from "../core/presentationImages";
import { useImageGeneration } from "./useImageGeneration";
import type { SlideImagePlan } from "./useSlideImagePlan";

/** Resolve before original decoding; cached intrinsic dimensions remain source dimensions. */
export function usePreparedImage(
  documentId: string | null,
  slideId: string,
  elementId: string,
  assetId: string,
  enabled: boolean,
  profile?: ImageOutputProfile,
  deferUpdates = false,
  plan?: SlideImagePlan,
) {
  const [result, setResult] = useState<{
    id: string;
    key: string;
    image: PreparedImage | null;
    settled: boolean;
  } | null>(null);
  const ownedUrl = useRef<string | null>(null);
  const usingPlan = plan !== undefined;
  const planImages = plan?.images;
  const planKey = plan?.key;
  const displayedImage = useRef<PreparedImage | null>(null);
  useLayoutEffect(() => {
    const nextUrl = result?.image?.url ?? null;
    if (usingPlan && nextUrl && ownedUrl.current !== nextUrl)
      platform.retainUrl?.(nextUrl);
    if (ownedUrl.current && ownedUrl.current !== nextUrl)
      platform.releaseUrl(ownedUrl.current);
    ownedUrl.current = nextUrl;
  }, [result?.image?.url, usingPlan]);
  useEffect(
    () => () => {
      if (ownedUrl.current) platform.releaseUrl(ownedUrl.current);
    },
    [],
  );
  const generation = useImageGeneration(documentId);
  const key = `${documentId}:${slideId}:${elementId}:${assetId}:${planKey ?? generation}:${profile?.width}:${profile?.height}`;
  const identity = `${documentId}:${slideId}:${elementId}:${assetId}`;
  useEffect(() => {
    // A gesture keeps the displayed variant, including when an older request
    // finishes in flight. On release, resolve the latest accepted geometry.
    if (!enabled || !documentId || !platform.preparedImage || deferUpdates)
      return;
    if (usingPlan && !planImages) return;
    let live = true;
    const resolve = async () => {
      const image = usingPlan
        ? (planImages![elementId] ?? null)
        : await platform.preparedImage!(
            documentId,
            slideId,
            elementId,
            profile,
          );
      if (image && live && displayedImage.current?.hash !== image.hash) {
        const probe = new Image();
        probe.crossOrigin = "anonymous";
        probe.src = image.url;
        try {
          await probe.decode();
        } catch {
          if (!usingPlan) platform.releaseUrl(image.url);
          return null;
        }
      }
      return image;
    };
    void resolve()
      .then((image) => {
        if (!live) {
          if (image && !usingPlan) platform.releaseUrl(image.url);
          return;
        }
        // A readiness update or profile change may resolve to identical pixels.
        // Keep decoded pixels when a request resolves to the same variant.
        const current = displayedImage.current;
        if (image && current?.hash === image.hash) {
          if (!usingPlan) platform.releaseUrl(image.url);
          setResult({
            id: identity,
            key,
            image: usingPlan ? image : current,
            settled: true,
          });
          return;
        }
        displayedImage.current = image;
        setResult({ id: identity, key, image, settled: true });
      })
      .catch(() => {
        if (live) {
          displayedImage.current = null;
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
    usingPlan,
    planImages,
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
      ((usingPlan && !planImages) ||
        result?.id !== identity ||
        result.key !== key ||
        !result.settled),
    ),
  };
}
