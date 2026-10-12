/** Shared by shader sampling and the canonical primitive/backdrop painter. */
export function nodeTransform(node: HTMLElement) {
  const style = getComputedStyle(node);
  const [x, y] = style.transformOrigin.split(" ").map(parseFloat);
  let matrix = new DOMMatrix(
    style.transform === "none" ? undefined : style.transform,
  );
  // Typed transforms retain rotation precision lost by serialized CSS matrices.
  const typed = node.computedStyleMap?.().get("transform") as
    { toMatrix?(): DOMMatrix } | undefined;
  if (typed?.toMatrix) {
    try {
      matrix = typed.toMatrix();
    } catch {
      /* Percentage transforms require the browser's resolved matrix. */
    }
  }
  return new DOMMatrix()
    .translate(parseFloat(style.left) || 0, parseFloat(style.top) || 0)
    .translate(x || 0, y || 0)
    .multiply(matrix)
    .translate(-(x || 0), -(y || 0));
}

/** Exclude the view's outer fit/zoom: its output profile already includes it. */
export function elementWorldTransform(node: HTMLElement, root: HTMLElement) {
  const chain: HTMLElement[] = [];
  for (
    let current: HTMLElement | null = node;
    current && current !== root;
    current = current.parentElement
  )
    chain.unshift(current);
  return chain.reduce(
    (world, element) => world.multiply(nodeTransform(element)),
    new DOMMatrix(),
  );
}
