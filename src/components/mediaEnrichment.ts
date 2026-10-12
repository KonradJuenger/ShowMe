import type { Asset } from "../core/assets";
import { platform } from "../platform";

export async function enrichAsset(asset: Asset) {
  const url = await platform.assetUrl(asset.id);
  if (!url) return;
  const media =
    asset.type === "video" ? document.createElement("video") : new Image();
  media.crossOrigin = "anonymous";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Metadata timeout")),
        15000,
      );
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      media.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not decode media"));
      };
      if (media instanceof HTMLVideoElement) {
        media.muted = true;
        media.preload = "metadata";
        media.onloadeddata = done;
      } else media.onload = done;
      media.src = url;
    });
    const width =
        media instanceof HTMLVideoElement
          ? media.videoWidth
          : media.naturalWidth,
      height =
        media instanceof HTMLVideoElement
          ? media.videoHeight
          : media.naturalHeight;
    const next = {
      ...asset,
      width,
      height,
      ...(media instanceof HTMLVideoElement && Number.isFinite(media.duration)
        ? { duration: media.duration }
        : {}),
    };
    await platform.updateAsset(next);
    if (width && height) {
      const canvas = document.createElement("canvas"),
        previewSize = asset.type === "video" ? 1280 : 256,
        scale = Math.min(1, previewSize / width, previewSize / height);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas
        .getContext("2d")!
        .drawImage(media, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/jpeg", 0.8),
      );
      if (blob)
        await platform.storePreview(
          asset.id,
          new Uint8Array(await blob.arrayBuffer()),
        );
    }
    return next;
  } finally {
    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    } else media.src = "";
    platform.releaseUrl(url);
  }
}

export async function prepareMediaAsset(asset: Asset): Promise<Asset> {
  if (asset.width && asset.height) return asset;
  const enriched = await enrichAsset(asset);
  if (!enriched?.width || !enriched.height)
    throw new Error("Could not determine media dimensions.");
  return enriched;
}
