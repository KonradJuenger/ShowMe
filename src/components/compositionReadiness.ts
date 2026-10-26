const outputs = new WeakMap<HTMLElement, { flush(): Promise<boolean> }>();
/** Effect execution depends on readiness, not on a particular compositor. */
export function registerCompositionOutput(
  root: HTMLElement,
  output: { flush(): Promise<boolean> },
) {
  outputs.set(root, output);
  return () => {
    if (outputs.get(root) === output) outputs.delete(root);
  };
}
export async function flushCompositionOutputs(roots: Iterable<HTMLElement>) {
  return (
    await Promise.all(
      [...new Set(roots)].map((root) => outputs.get(root)?.flush()),
    )
  ).every((ready) => ready !== false);
}
