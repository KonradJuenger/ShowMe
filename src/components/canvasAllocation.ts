/** Validate new allocations only; ordinary frames reuse the current backing store. */
export function resizeRasterCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const changed = canvas.width !== width || canvas.height !== height;
  if (changed) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(`Cannot allocate ${width} × ${height} raster surface`);
  if (changed) {
    try {
      context.getImageData(0, 0, 1, 1);
    } catch {
      throw new Error(`Cannot allocate ${width} × ${height} raster surface`);
    }
  }
  return context;
}
