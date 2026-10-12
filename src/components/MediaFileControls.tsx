import { useEffect, useState } from "react";
import type { Asset } from "../core/assets";
import { platform } from "../platform";
import { enrichAsset } from "./mediaEnrichment";
import "./MediaFileControls.css";

export function useMediaAsset(assetId: string | null) {
  const [asset, setAsset] = useState<Asset | null>(null);
  useEffect(() => {
    let live = true;
    setAsset(null);
    if (assetId)
      void platform
        .getAsset(assetId)
        .then(async (value) => {
          if (value.type === "video" && !value.duration) {
            try {
              return (await enrichAsset(value)) ?? value;
            } catch {
              return value;
            }
          }
          return value;
        })
        .then((value) => {
          if (live) setAsset(value);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [assetId]);
  return asset;
}

export function MediaFileControls({
  asset,
  kind,
  onReplace,
  onSaveAs,
  canSaveMedia,
}: {
  asset: Asset | null;
  kind: "image" | "video";
  onReplace: () => void;
  onSaveAs: () => void;
  canSaveMedia: boolean;
}) {
  return (
    <div className="element-wide">
      <div className="movie-file-name" title={asset?.names[0]}>
        ▤ {asset?.names[0] ?? `Loading ${kind}…`}
      </div>
      <div className="media-file-actions">
        <button className="movie-replace" type="button" onClick={onReplace}>
          Replace…
        </button>
        <button
          className="movie-replace"
          type="button"
          onClick={onSaveAs}
          disabled={!canSaveMedia}
          title={
            canSaveMedia
              ? undefined
              : platform.saveMediaAs
                ? "Media export is disabled in ShowMe for this package"
                : "Available in the desktop app"
          }
        >
          Save Media As…
        </button>
      </div>
    </div>
  );
}

export function ImageFileControls({
  assetId,
  onReplace,
  onSaveAs,
  canSaveMedia,
}: {
  assetId: string;
  onReplace: () => void;
  onSaveAs: () => void;
  canSaveMedia: boolean;
}) {
  const asset = useMediaAsset(assetId);
  return (
    <MediaFileControls
      asset={asset}
      kind={asset?.type === "video" ? "video" : "image"}
      onReplace={onReplace}
      onSaveAs={onSaveAs}
      canSaveMedia={canSaveMedia}
    />
  );
}
