import { createContext, type RefObject } from "react";
import type { RenderDensity } from "../core/renderProfile";

export const EffectRenderContext = createContext<{
  density: RenderDensity;
  root: RefObject<HTMLDivElement | null>;
  retain: boolean;
  staticFrame?: boolean;
  sceneRevision?: object;
  deckRevision?: object;
  envelopes?: ReadonlyMap<string, number>;
} | null>(null);
