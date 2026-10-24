import type { SystemFontFamily } from "../platform/api";
import type {
  ImageOutputProfile,
  ImageReadiness,
  PreparedImage,
  PreparedSlideImages,
} from "./presentationImages";

export interface RenderResources {
  assetUrl(id: string, preview?: boolean): Promise<string | null>;
  releaseUrl(url: string): void;
  managedFonts?(documentId?: string): Promise<SystemFontFamily[]>;
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
