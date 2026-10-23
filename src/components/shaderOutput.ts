export type ShaderOutput = {
  gl: WebGL2RenderingContext;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  revision: number;
};
const outputs = new Set<ShaderOutput>();
let allocations = 0;

export function shaderOutputDiagnostics() {
  return { allocations, liveOutputs: outputs.size };
}

/** Logical RGBA8 output texture allocation, not measured GPU residency. */
export function shaderOutputTextureBytes() {
  return [...outputs].reduce(
    (sum, output) => sum + output.width * output.height * 4,
    0,
  );
}
export function disposeShaderOutput(output: ShaderOutput) {
  outputs.delete(output);
  if (output.gl.isFramebuffer(output.framebuffer))
    output.gl.deleteFramebuffer(output.framebuffer);
  if (output.gl.isTexture(output.texture))
    output.gl.deleteTexture(output.texture);
}

/** GPU-only presentation of an explicitly retained terminal output. */
export function presentShaderOutput(output: ShaderOutput) {
  const { gl, width, height } = output;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, output.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
export function allocateShaderOutput(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  previous: ShaderOutput | null,
) {
  if (
    previous?.gl === gl &&
    gl.isTexture(previous.texture) &&
    gl.isFramebuffer(previous.framebuffer) &&
    previous.width === width &&
    previous.height === height
  )
    return previous;
  const texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    throw new Error("Cannot allocate shader output surface");
  }
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
    allocations++;
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
