import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { SystemFontFamily } from "../platform/api";
import type {
  ImageOutputProfile,
  ImageReadiness,
  PreparedImage,
  PreparedSlideImages,
} from "../core/presentationImages";

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

let defaultResources: RenderResources | null = null;
const RenderResourcesContext = createContext<RenderResources | null>(null);

/**
 * Installs the normal application resource provider without coupling renderer
 * modules to the complete desktop/browser Platform interface.
 */
export function setDefaultRenderResources(resources: RenderResources) {
  defaultResources = resources;
}

export function RenderResourcesProvider({
  resources,
  children,
}: {
  resources: RenderResources;
  children: ReactNode;
}) {
  return (
    <RenderResourcesContext.Provider value={resources}>
      {children}
    </RenderResourcesContext.Provider>
  );
}

export function useRenderResources(): RenderResources {
  const resources = useContext(RenderResourcesContext) ?? defaultResources;
  if (!resources)
    throw new Error("Render resources are unavailable in this rendering host");
  return resources;
}
