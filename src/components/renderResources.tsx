import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { SystemFontFamily } from "../platform/api";

export interface RenderResources {
  assetUrl(id: string, preview?: boolean): Promise<string | null>;
  releaseUrl(url: string): void;
  managedFonts?(documentId?: string): Promise<SystemFontFamily[]>;
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
