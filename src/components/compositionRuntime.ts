import { mountBackdropRestoration } from "./backdropRestoration";
import type { RestorationPlan } from "./legacyCssBackdropValidation";
import type { Deck, Slide } from "../core/document";
import type { MotionRenderSink } from "./motionRuntime";
import { registerCompositionOutput } from "./compositionReadiness";
import type { RenderDensity } from "../core/renderProfile";
import { createSceneSurfaceMaterializer } from "./compositionSurface";

/** Legacy validation runtime for the retired CSS backdrop/restoration path.
 * Normal SlideRenderer rendering does not mount this runtime. */
export function mountCompositionRuntime(
  root: HTMLElement,
  scene: { slide: Slide; deck: Deck },
  options: {
    restoration?: RestorationPlan | null;
    failed: (ids: readonly string[], error: unknown) => void;
    density: Pick<RenderDensity, "x" | "y">;
  },
) {
  const materializer = createSceneSurfaceMaterializer(
    root,
    scene.slide,
    scene.deck,
  );
  let restoration: ReturnType<typeof mountBackdropRestoration> | null = null;
  try {
    if (options.restoration)
      restoration = mountBackdropRestoration(
        root,
        options.restoration,
        scene.deck,
        options.failed,
        options.density,
        materializer,
      );
  } catch (error) {
    materializer.dispose();
    throw error;
  }

  const flush = () => restoration?.flush() ?? Promise.resolve(true);
  const unregister = registerCompositionOutput(root, { flush });
  if (restoration) root.dataset.compositionBackend = "native-backdrop-restore";

  const sink: MotionRenderSink = {
    ownsOpacity(id) {
      return restoration?.ownsOpacity?.(id) ?? false;
    },
    apply(samples) {
      restoration?.apply(samples);
    },
    reset() {
      restoration?.reset();
    },
  };

  return {
    ...sink,
    flush,
    materializer,
    diagnostics() {
      return (
        restoration?.diagnostics() ?? {
          consumers: 0,
          uniquePrefixes: 0,
          prefixes: materializer.diagnostics(),
        }
      );
    },
    dispose() {
      unregister();
      delete root.dataset.compositionBackend;
      restoration?.dispose();
      materializer.dispose();
    },
  };
}
export type CompositionRuntime = MotionRenderSink &
  ReturnType<typeof mountCompositionRuntime>;
