import { useSyncExternalStore } from "react";
import { platform } from "../platform";

const generations = new Map<string, number>();
const listeners = new Set<() => void>();
let invalidations = 0;
let unsubscribe: (() => void) | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  unsubscribe ??= platform.onImageReadiness?.((status) => {
    if (!status) { invalidations++; for (const notify of listeners) notify(); return; }
    if (generations.get(status.documentId) === status.generation) return;
    generations.set(status.documentId, status.generation);
    for (const notify of listeners) notify();
  });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
export function useImageGeneration(documentId: string | null) {
  return useSyncExternalStore(subscribe, () =>
    `${documentId ? (generations.get(documentId) ?? 0) : 0}:${invalidations}`,
  );
}
