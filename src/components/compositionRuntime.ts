import { mountBackdropRestoration } from "./backdropRestoration";
import type { RestorationPlan } from "./compositionBackendPlan";
import type { Deck } from "../core/document";
import type { MotionRenderSink } from "./motionRuntime";
import { registerCompositionOutput } from "./compositionReadiness";
import type { RenderDensity } from "../core/renderProfile";
import { createSceneSurfaceMaterializer } from "./compositionSurface";

/** Renderer activation owns one scene materializer and all consumer lifetimes.
 * Motion receives only the resulting sink; Effect readiness flushes the same
 * coordinator after its ordered cohort. */
export function mountCompositionRuntime(
  root: HTMLElement,
  plan: RestorationPlan,
  deck: Deck,
  failed: (ids: readonly string[], error: unknown) => void,
  density: Pick<RenderDensity, "x" | "y">,
) {
  const materializer = createSceneSurfaceMaterializer(
    root,
    plan.slide,
    deck,
  );
  let backend: ReturnType<typeof mountBackdropRestoration>;
  try {
    backend = mountBackdropRestoration(
      root,
      plan,
      deck,
      failed,
      density,
      materializer,
    );
  } catch (error) {
    materializer.dispose();
    throw error;
  }
  const unregister = registerCompositionOutput(root, backend);
  root.dataset.compositionBackend = "native-backdrop-restore";
  return {
    ...backend,
    materializer,
    dispose() {
      unregister();
      delete root.dataset.compositionBackend;
      backend.dispose();
      materializer.dispose();
    },
  };
}
export type CompositionRuntime = MotionRenderSink &
  ReturnType<typeof mountCompositionRuntime>;
