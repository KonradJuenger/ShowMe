import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let query: MediaQueryList | null = null;
const read = () => window.devicePixelRatio || 1;
function changed() {
  query?.removeEventListener("change", changed);
  query = window.matchMedia(`(resolution: ${read()}dppx)`);
  query.addEventListener("change", changed);
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("resize", changed);
    changed();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("resize", changed);
      query?.removeEventListener("change", changed);
      query = null;
    }
  };
}
/** One density subscription per renderer, including monitor moves without resize. */
export function useDisplayDensity() {
  return useSyncExternalStore(subscribe, read);
}
