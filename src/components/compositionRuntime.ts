import { mountBackdropRestoration } from "./backdropRestoration";
import type { RestorationPlan } from "./compositionBackendPlan";
import type { Deck } from "../core/document";
import type { MotionRenderSink } from "./motionRuntime";
import { registerCompositionOutput } from "./compositionReadiness";

/** Renderer activation owns backend lifetime. Motion receives only this sink;
 * Effect readiness flushes the same coordinator after its ordered cohort. */
export function mountCompositionRuntime(
  root: HTMLElement,
  plan: RestorationPlan,
  deck: Deck,
  failed: (ids: readonly string[], error: unknown) => void,
) {
  const backend = mountBackdropRestoration(root, plan, deck, failed);
  const unregister = registerCompositionOutput(root, backend);
  root.dataset.compositionBackend = "native-backdrop-restore";
  return {
    ...backend,
    dispose() {
      unregister();
      delete root.dataset.compositionBackend;
      backend.dispose();
    },
  };
}
export type CompositionRuntime = MotionRenderSink &
  ReturnType<typeof mountCompositionRuntime>;
