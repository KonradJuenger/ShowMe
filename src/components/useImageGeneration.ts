import { useCallback, useSyncExternalStore } from "react";
import type { RenderResources } from "./renderResources";
import { useRenderResources } from "./renderResources";

const states = new WeakMap<
  RenderResources,
  {
    generations: Map<string, number>;
    listeners: Set<() => void>;
    invalidations: number;
    unsubscribe?: () => void;
  }
>();

function stateFor(resources: RenderResources) {
  let state = states.get(resources);
  if (!state) {
    state = {
      generations: new Map(),
      listeners: new Set(),
      invalidations: 0,
    };
    states.set(resources, state);
  }
  return state;
}

function subscribeResources(resources: RenderResources, listener: () => void) {
  const state = stateFor(resources);
  state.listeners.add(listener);
  state.unsubscribe ??= resources.onImageReadiness?.((status) => {
    if (!status) {
      state.invalidations++;
      for (const notify of state.listeners) notify();
      return;
    }
    if (state.generations.get(status.documentId) === status.generation) return;
    state.generations.set(status.documentId, status.generation);
    for (const notify of state.listeners) notify();
  });
  return () => {
    state.listeners.delete(listener);
    if (!state.listeners.size) {
      state.unsubscribe?.();
      state.unsubscribe = undefined;
    }
  };
}

export function useImageGeneration(documentId: string | null) {
  const resources = useRenderResources();
  const subscribe = useCallback(
    (listener: () => void) => subscribeResources(resources, listener),
    [resources],
  );
  const snapshot = useCallback(() => {
    const state = stateFor(resources);
    return `${documentId ? (state.generations.get(documentId) ?? 0) : 0}:${state.invalidations}`;
  }, [documentId, resources]);
  return useSyncExternalStore(subscribe, snapshot);
}
