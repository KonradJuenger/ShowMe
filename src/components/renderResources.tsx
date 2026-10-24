import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { RenderResources } from "../core/renderResources";

export type { RenderResources } from "../core/renderResources";

let defaultResources: RenderResources | null = null;
const unavailableRenderResources: RenderResources = {
  async assetUrl() {
    return null;
  },
  releaseUrl() {},
};
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
  return (
    useContext(RenderResourcesContext) ??
    defaultResources ??
    unavailableRenderResources
  );
}
