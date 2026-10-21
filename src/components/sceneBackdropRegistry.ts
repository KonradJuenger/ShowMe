/** Resolve native backdrop restoration after its effect cohort is ready. */
export const sceneBackdropBackends = new WeakMap<
  HTMLElement,
  { sample(): void; flush(): Promise<boolean> }
>();

/** Motion has just flushed its DOM values; update restoration before paint. */
export function sampleSceneBackdrops(root: HTMLElement) {
  if (sceneBackdropBackends.has(root))
    sceneBackdropBackends.get(root)!.sample();
  else
    root
      .querySelectorAll<HTMLElement>(".slide-renderer")
      .forEach((slide) => sceneBackdropBackends.get(slide)?.sample());
}

export async function flushSceneBackdrops(roots: Iterable<HTMLElement>) {
  return (
    await Promise.all(
      [...new Set(roots)].map((root) =>
        sceneBackdropBackends.get(root)?.flush(),
      ),
    )
  ).every((ready) => ready !== false);
}
