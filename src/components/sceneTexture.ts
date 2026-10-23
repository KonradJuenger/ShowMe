import {
  createGpuSceneTextureProvider,
  gpuSceneTextureDiagnostics,
} from "./sceneTextureGpu";
import type { Deck, Slide } from "../core/document";
import type { Element } from "../core/element";
import type { EffectResources } from "../core/effects";
import {
  createLegacySceneTextureProvider,
  legacySceneTextureDiagnostics,
  legacySceneTextureTextureBytes,
} from "./sceneTextureLegacy";

export type SceneTextureRequest =
  | {
      kind: "element";
      elementId: string;
      effectId: string;
    }
  | {
      kind: "backdrop";
      elementId: string;
      effectId: string;
    };

export type SceneTextureSampling = {
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
};

/** Rendered scene pixels exposed without leaking the capture backend. */
export interface SceneTexture {
  readonly revision: number;
  prepareGpu?(gl: WebGL2RenderingContext): void;
  bind(gl: WebGL2RenderingContext): void;
}

export interface SceneTextureProvider {
  prepare(sampling: SceneTextureSampling): void | Promise<void>;
  acquire(sampling: SceneTextureSampling): SceneTexture | Promise<SceneTexture>;
  invalidate(): void;
  dispose(): void;
}

/** Renderer-owned context used only to construct the temporary legacy adapter.
 * Consumers of SceneTexture never see raster/canvas/DOM-capture details. */
export type SceneTextureContext = {
  effectNode: HTMLElement;
  owner: HTMLElement;
  inputRoot: HTMLElement;
  element: Element;
  resources(): EffectResources;
  scene?: () => { slide: Slide; deck: Deck };
  refined: boolean;
  flushEffect(node: HTMLElement): void | Promise<void>;
  materializeEffect(node: HTMLElement): void;
  invalidate(): void;
};

export function createSceneTextureProvider(
  request: SceneTextureRequest,
  context: SceneTextureContext,
): SceneTextureProvider {
  return (
    createGpuSceneTextureProvider(request, context) ??
    createLegacySceneTextureProvider(request, context)
  );
}

export function sceneTextureTextureBytes() {
  return legacySceneTextureTextureBytes();
}

export function sceneTextureDiagnostics() {
  return {
    ...legacySceneTextureDiagnostics(),
    gpu: gpuSceneTextureDiagnostics(),
  };
}
