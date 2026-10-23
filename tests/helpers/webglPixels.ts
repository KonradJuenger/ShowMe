export function readWebGlPixel(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("Expected a WebGL shader canvas");
  const pixel = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("Expected a WebGL shader canvas");
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
