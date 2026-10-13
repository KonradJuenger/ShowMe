export type ShaderOutput = {
  gl: WebGL2RenderingContext;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  revision: number;
};
const outputs = new Set<ShaderOutput>();
/** Logical RGBA8 output texture allocation, not measured GPU residency. */
export function shaderOutputTextureBytes() {
  return [...outputs].reduce(
    (sum, output) => sum + output.width * output.height * 4,
    0,
  );
}
export function disposeShaderOutput(output: ShaderOutput) {
  outputs.delete(output);
  output.gl.deleteFramebuffer(output.framebuffer);
  output.gl.deleteTexture(output.texture);
}
export function allocateShaderOutput(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  previous: ShaderOutput | null,
) {
  if (
    previous?.gl === gl &&
    previous.width === width &&
    previous.height === height
  )
    return previous;
  const texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer)
    throw new Error("Cannot allocate shader output surface");
  try {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE ||
      gl.getError() !== gl.NO_ERROR
    )
      throw new Error(
        `Cannot allocate ${width} × ${height} shader output texture`,
      );
    if (previous) disposeShaderOutput(previous);
    const output = {
      gl,
      texture,
      framebuffer,
      width,
      height,
      revision: previous?.revision ?? 0,
    };
    outputs.add(output);
    return output;
  } catch (error) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }
}

/** A direct GPU handoff is valid only when DOM paint adds nothing between the
 * two shaders. CSS filters, transforms, clipping, blending and pseudo-elements
 * must still pass through the browser painter. The source opacity is the
 * renderer's display bypass and is deliberately excluded from this test. */
export function neutralShaderBridge(
  source: HTMLElement,
  stage: HTMLElement,
  canvas: HTMLCanvasElement,
  size: { width: number; height: number },
) {
  for (const node of [source, stage, canvas]) {
    const style = getComputedStyle(node);
    if (
      style.filter !== "none" ||
      style.backdropFilter !== "none" ||
      style.transform !== "none" ||
      style.clipPath !== "none" ||
      style.clip !== "auto" ||
      style.mixBlendMode !== "normal" ||
      style.boxShadow !== "none" ||
      style.backgroundImage !== "none" ||
      style.maskImage !== "none" ||
      style.translate !== "none" ||
      style.rotate !== "none" ||
      style.scale !== "none" ||
      style.display !== "block" ||
      style.visibility !== "visible" ||
      (node !== source && style.opacity !== "1") ||
      style.objectFit !== "fill" ||
      style.imageRendering !== "auto" ||
      !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor) ||
      Math.abs(parseFloat(style.width) - size.width) > 0.02 ||
      Math.abs(parseFloat(style.height) - size.height) > 0.02 ||
      parseFloat(style.borderTopLeftRadius) !== 0 ||
      parseFloat(style.borderTopRightRadius) !== 0 ||
      parseFloat(style.borderBottomLeftRadius) !== 0 ||
      parseFloat(style.borderBottomRightRadius) !== 0 ||
      parseFloat(style.borderTopWidth) !== 0 ||
      parseFloat(style.borderBottomWidth) !== 0 ||
      parseFloat(style.borderLeftWidth) !== 0 ||
      parseFloat(style.borderRightWidth) !== 0 ||
      parseFloat(style.paddingTop) !== 0 ||
      parseFloat(style.paddingLeft) !== 0 ||
      parseFloat(style.paddingBottom) !== 0 ||
      parseFloat(style.paddingRight) !== 0 ||
      parseFloat(style.marginTop) !== 0 ||
      parseFloat(style.marginLeft) !== 0 ||
      parseFloat(style.marginBottom) !== 0 ||
      parseFloat(style.marginRight) !== 0 ||
      !["auto", "0px"].includes(style.left) ||
      !["auto", "0px"].includes(style.top) ||
      style.zoom !== "1"
    )
      return false;
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(node, pseudo).content;
      if (content !== "none" && content !== "normal") return false;
    }
  }
  return true;
}
