import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  getDefaultRenderResources,
  type RenderResources,
} from "../core/renderResources";

export type { RenderResources } from "../core/renderResources";
const unavailableRenderResources: RenderResources = {
  async assetUrl() {
    return null;
  },
  releaseUrl() {},
};
const RenderResourcesContext = createContext<RenderResources | null>(null);

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
    getDefaultRenderResources() ??
    unavailableRenderResources
  );
}
