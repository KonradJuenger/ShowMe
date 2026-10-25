import type {
  ImageOutputProfile,
  ImageReadiness,
  PreparedImage,
  PreparedSlideImages,
} from "./presentationImages";

export interface RenderFontSource {
  id: string;
  weight: number;
  italic: boolean;
  data: Uint8Array;
}

export interface RenderFontFamily {
  family: string;
  weights: number[];
  sources?: RenderFontSource[];
}

export interface RenderResources {
  assetUrl(id: string, preview?: boolean): Promise<string | null>;
  releaseUrl(url: string): void;
  managedFonts?(documentId?: string): Promise<RenderFontFamily[]>;
  retainUrl?(url: string): void;
  preparedImage?(
    documentId: string,
    slideId: string,
    elementId: string,
    profile?: ImageOutputProfile,
  ): Promise<PreparedImage | null>;
  preparedSlideImages?(
    documentId: string,
    slideId: string,
    profile?: ImageOutputProfile,
  ): Promise<PreparedSlideImages>;
  onImageReadiness?(
    callback: (status: ImageReadiness | null) => void,
  ): () => void;
}

let defaultRenderResources: RenderResources | null = null;

export function setDefaultRenderResources(resources: RenderResources) {
  defaultRenderResources = resources;
}

export function getDefaultRenderResources() {
  return defaultRenderResources;
}
