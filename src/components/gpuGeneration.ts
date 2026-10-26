/** Owned resources are valid until their context is lost; never probe them per draw. */
const contexts = new WeakMap<WebGL2RenderingContext, { generation: number }>();
export function gpuGeneration(gl: WebGL2RenderingContext) {
  let state = contexts.get(gl);
  if (!state) {
    state = { generation: 0 };
    contexts.set(gl, state);
    const owned = state;
    gl.canvas.addEventListener("webglcontextlost", () => {
      owned.generation++;
    });
  }
  return state.generation;
}
