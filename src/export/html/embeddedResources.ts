import type { RenderResources } from "../../core/renderResources";
import type {
  HtmlEmbeddedAsset,
  HtmlEmbeddedFontFamily,
} from "./types";

function decodeBase64(value: string): Uint8Array {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4) - padding);
  let offset = 0;
  const chunkSize = 32768;
  for (let index = 0; index < value.length; index += chunkSize) {
    const binary = atob(value.slice(index, index + chunkSize));
    for (let byte = 0; byte < binary.length; byte++)
      bytes[offset++] = binary.charCodeAt(byte);
  }
  return bytes;
}

export class EmbeddedRenderResources implements RenderResources {
  private readonly assets: Map<string, HtmlEmbeddedAsset>;
  private readonly urls = new Map<
    string,
    { assetId: string; url: string; references: number }
  >();
  private readonly assetUrls = new Map<string, string>();
  private readonly faces = new Set<FontFace>();

  constructor(
    assets: readonly HtmlEmbeddedAsset[],
    private readonly fonts: readonly HtmlEmbeddedFontFamily[],
  ) {
    this.assets = new Map(assets.map((asset) => [asset.id, asset]));
  }

  async assetUrl(id: string): Promise<string | null> {
    const existingUrl = this.assetUrls.get(id);
    if (existingUrl) {
      const existing = this.urls.get(existingUrl);
      if (existing) {
        existing.references++;
        return existing.url;
      }
    }
    const asset = this.assets.get(id);
    if (!asset) return null;
    const blob = new Blob([decodeBase64(asset.data)], { type: asset.mime });
    const url = URL.createObjectURL(blob);
    this.assetUrls.set(id, url);
    this.urls.set(url, { assetId: id, url, references: 1 });
    return url;
  }

  releaseUrl(url: string): void {
    const current = this.urls.get(url);
    if (!current) return;
    current.references--;
    if (current.references > 0) return;
    URL.revokeObjectURL(url);
    this.urls.delete(url);
    if (this.assetUrls.get(current.assetId) === url)
      this.assetUrls.delete(current.assetId);
  }

  async installFonts(): Promise<void> {
    if (typeof FontFace === "undefined" || !document.fonts) return;
    for (const family of this.fonts) {
      for (const source of family.sources) {
        const bytes = decodeBase64(source.data);
        const face = new FontFace(family.family, bytes.buffer, {
          weight: String(source.weight),
          style: source.italic ? "italic" : "normal",
        });
        await face.load();
        document.fonts.add(face);
        this.faces.add(face);
      }
    }
    await document.fonts.ready;
  }

  async managedFonts() {
    return this.fonts.map((family) => ({
      family: family.family,
      weights: [...family.weights],
      sources: family.sources.map((source) => ({
        id: source.id,
        weight: source.weight,
        italic: source.italic,
        data: decodeBase64(source.data),
      })),
    }));
  }

  dispose() {
    for (const url of this.urls.keys()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.assetUrls.clear();
    for (const face of this.faces) document.fonts.delete(face);
    this.faces.clear();
  }
}
