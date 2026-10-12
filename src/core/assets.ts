import { z } from "zod";

export const ASSET_VERSION = 1 as const;

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const locator = {
  filename: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^/\\]+$/),
  mediaType: z.enum(["image", "video", "audio", "font", "other"]),
};

export const assetSchema = z.object({
  version: z.literal(ASSET_VERSION),
  id: hashSchema,
  ...locator,
  type: z.enum(["image", "video", "svg"]),
  mime: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
  ]),
  names: z.array(z.string()).min(1),
  bytes: z.number().nonnegative(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  duration: z.number().nonnegative().optional(),
  createdAt: z.string(),
});

export type Asset = z.infer<typeof assetSchema>;

export type AssetCategory = "images" | "videos";

export const assetCategory = (
  asset: Pick<Asset, "type">,
): AssetCategory => (asset.type === "video" ? "videos" : "images");

export const compareAssetsByCategoryAndName = (
  a: Pick<Asset, "type" | "names">,
  b: Pick<Asset, "type" | "names">,
) => {
  const categoryDelta =
    (assetCategory(a) === "videos" ? 1 : 0) -
    (assetCategory(b) === "videos" ? 1 : 0);
  return categoryDelta || a.names[0].localeCompare(b.names[0]);
};

export const assetCategoryCounts = (
  assets: Iterable<Pick<Asset, "type">>,
): Record<AssetCategory, number> => {
  const counts: Record<AssetCategory, number> = { images: 0, videos: 0 };
  for (const asset of assets) counts[assetCategory(asset)]++;
  return counts;
};

export const mediaType = (
  name: string,
): { mime: Asset["mime"]; type: Asset["type"] } => {
  const ext = name.split(".").pop()?.toLowerCase();
  const m: Record<string, Asset["mime"]> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  const mime = ext && m[ext];
  if (!mime)
    throw new Error("Unsupported file. Use PNG, JPEG, WebP, GIF, SVG or MP4.");
  return {
    mime,
    type: mime.startsWith("video")
      ? "video"
      : mime === "image/svg+xml"
        ? "svg"
        : "image",
  };
};
