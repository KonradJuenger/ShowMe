/** Published renderer-local CSS material pixels for later backdrop consumers. */
export const cssBackdropOutputs = new WeakMap<
  HTMLElement,
  {
    canvas: HTMLCanvasElement;
    padding: number;
    width: number;
    height: number;
  }
>();
