import { app, nativeImage } from "electron";
import path from "node:path";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  promises as fs,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashSchema } from "../src/core/assets";
import {
  SLIDE_TRANSFER_FILE_EXTENSION,
  parseSlideTransferBundle,
} from "../src/core/slideTransfer";

const SLIDE_TRANSFER_TRANSPORT_VERSION = 1 as const;
const slideTransferRoot = () =>
  path.join(app.getPath("temp"), "show-me-slide-transfer");

const transportAssetSchema = z
  .object({
    id: hashSchema,
    file: z.string().min(1).max(1000),
  })
  .strict();

const transportEnvelopeSchema = z
  .object({
    transportVersion: z.literal(SLIDE_TRANSFER_TRANSPORT_VERSION),
    bundle: z.unknown(),
    assets: z.array(transportAssetSchema).max(100000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.assets.map(({ id }) => id)).size !== value.assets.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate transfer asset",
        path: ["assets"],
      });
  });

type ResolvePortableAsset = (
  documentId: string,
  assetId: string,
) => string | null;

type EnsurePortableAsset = (
  assetId: string,
  file: string | null,
) => Promise<void>;

export async function cleanStaleSlideTransfers() {
  const root = slideTransferRoot();
  try {
    const now = Date.now();
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      try {
        if (now - (await fs.stat(file)).mtimeMs > 24 * 60 * 60 * 1000)
          await fs.rm(file, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

export function writeSlideTransferDescriptor(
  input: unknown,
  resolvePortableAsset?: ResolvePortableAsset,
) {
  const bundle = parseSlideTransferBundle(input);
  const root = slideTransferRoot();
  mkdirSync(root, { recursive: true });
  const transferId = randomUUID();
  const file = path.join(
    root,
    transferId + SLIDE_TRANSFER_FILE_EXTENSION,
  );
  const assetDirectory = path.join(root, transferId + ".assets");
  const assets: Array<{ id: string; file: string }> = [];

  try {
    for (const asset of bundle.assets) {
      const source = resolvePortableAsset?.(
        bundle.source.documentId,
        asset.id,
      );
      if (!source) continue;
      mkdirSync(assetDirectory, { recursive: true });
      const target = path.join(
        assetDirectory,
        asset.id + path.extname(asset.filename).toLowerCase(),
      );
      try {
        linkSync(source, target);
      } catch {
        copyFileSync(source, target);
      }
      assets.push({
        id: asset.id,
        file: path.relative(root, target),
      });
    }

    const data = JSON.stringify({
      transportVersion: SLIDE_TRANSFER_TRANSPORT_VERSION,
      bundle,
      assets,
    });
    if (data.length > 50_000_000) throw new Error("Slide transfer is too large");
    writeFileSync(file, data, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(assetDirectory, { recursive: true, force: true });
    throw error;
  }

  void cleanStaleSlideTransfers();
  return { bundle, file };
}

function containedPath(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolved = path.resolve(candidate);
  return resolved.startsWith(resolvedRoot) ? resolved : null;
}

export async function readSlideTransferPaths(
  input: unknown,
  ensurePortableAsset?: EnsurePortableAsset,
) {
  const paths = z.array(z.string()).max(20).parse(input);
  const root = slideTransferRoot();
  for (const candidate of paths) {
    const file = containedPath(root, candidate);
    if (!file || !file.endsWith(SLIDE_TRANSFER_FILE_EXTENSION))
      continue;

    const envelope = transportEnvelopeSchema.parse(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
    const bundle = parseSlideTransferBundle(envelope.bundle);
    const assets = envelope.assets;

    if (ensurePortableAsset) {
      const byId = new Map(assets.map((asset) => [asset.id, asset.file]));
      for (const asset of bundle.assets) {
        const relative = byId.get(asset.id);
        const assetFile = relative
          ? containedPath(root, path.resolve(path.dirname(file), relative))
          : null;
        if (relative && !assetFile)
          throw new Error("Slide transfer asset path is invalid");
        await ensurePortableAsset(asset.id, assetFile);
      }
    }
    return bundle;
  }
  return null;
}

export function slideTransferIcon(count: number) {
  const label = String(count);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="52">' +
    '<rect x="2" y="2" width="76" height="48" rx="8" fill="#ffffff" stroke="#707070" stroke-width="2"/>' +
    '<rect x="10" y="10" width="42" height="24" rx="2" fill="#e8e8e5" stroke="#b8b8b4"/>' +
    '<circle cx="62" cy="36" r="12" fill="#2b78c8"/>' +
    '<text x="62" y="40" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="#fff">' +
    label +
    "</text></svg>";
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
  );
}
