/** Resolve native backdrop restoration after its effect cohort is ready. */
export const sceneBackdropBackends = new WeakMap<
  HTMLElement,
  { flush(): Promise<boolean> }
>();

export async function flushSceneBackdrops(roots: Iterable<HTMLElement>) {
  return (
    await Promise.all(
      [...new Set(roots)].map((root) =>
        sceneBackdropBackends.get(root)?.flush(),
      ),
    )
  ).every((ready) => ready !== false);
}
