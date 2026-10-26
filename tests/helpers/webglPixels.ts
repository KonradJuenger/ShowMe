import { effectSurface } from "../../src/components/effectRuntime";

export function readWebGlPixel(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
) {
  const surface = effectSurface(canvas.parentElement!);
  surface?.materialize();
  const output = surface?.gpuOutput();
  if (!output) throw new Error("Expected a retained shader output");
  const gl = output.gl;
  const pixel = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
  gl.readPixels(
    x,
    Math.max(0, canvas.height - 1 - y),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return Array.from(pixel);
}

export function readWebGlPixels(canvas: HTMLCanvasElement) {
  const surface = effectSurface(canvas.parentElement!);
  surface?.materialize();
  const output = surface?.gpuOutput();
  if (!output) throw new Error("Expected a retained shader output");
  const gl = output.gl;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
  gl.readPixels(
    0,
    0,
    canvas.width,
    canvas.height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  return pixels;
}

/** Sample bitmaprenderer output without requesting an incompatible 2D context. */
export function readPresentedPixel(canvas: HTMLCanvasElement, x: number, y: number) {
  effectSurface(canvas.parentElement!)?.materialize();
  const probe = new OffscreenCanvas(1, 1);
  const context = probe.getContext("2d")!;
  context.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data);
}
