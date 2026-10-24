// Installed before the research page imports its renderer. Counts API requests,
// not driver-internal work or physical GPU completion.
export function installResourceProbe() {
  const metrics = { rafCallbacks: 0, drawArrays: 0, blits: 0, framebufferBinds: 0,
    textureBinds: 0, uploads: 0, allocations: 0, clears: 0, viewportPixelUpperBound: 0 };
  const textures = new Map(), fbos = new Set(), bound = new WeakMap(), viewports = new WeakMap();
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ["createTexture", "deleteTexture", "createFramebuffer", "deleteFramebuffer", "bindTexture", "texImage2D", "texStorage2D", "viewport", "drawArrays", "blitFramebuffer", "bindFramebuffer", "clear"]) {
    const original = proto[name];
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      if (name === "createTexture") textures.set(result, {width:0,height:0});
      if (name === "deleteTexture") textures.delete(args[0]);
      if (name === "createFramebuffer") fbos.add(result);
      if (name === "deleteFramebuffer") fbos.delete(args[0]);
      if (name === "bindTexture") { metrics.textureBinds++; if(args[0] === this.TEXTURE_2D) bound.set(this,args[1]); }
      if (name === "texImage2D" || name === "texStorage2D") {
        const source = args.at(-1);
        const width = name === "texStorage2D" || args.length === 9 ? args[3] : source?.width ?? source?.videoWidth ?? source?.codedWidth;
        const height = name === "texStorage2D" || args.length === 9 ? args[4] : source?.height ?? source?.videoHeight ?? source?.codedHeight;
        if (textures.has(bound.get(this))) textures.set(bound.get(this), {width, height});
        if (name === "texStorage2D" || source === null) metrics.allocations++; else metrics.uploads++;
      }
      if (name === "viewport") viewports.set(this,args[2]*args[3]);
      if (name === "drawArrays") {metrics.drawArrays++; metrics.viewportPixelUpperBound += viewports.get(this) ?? 0;}
      if (name === "blitFramebuffer") metrics.blits++;
      if (name === "bindFramebuffer") metrics.framebufferBinds++;
      if (name === "clear") metrics.clears++;
      return result;
    };
  }
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => raf.call(window,(time)=>{metrics.rafCallbacks++;callback(time);});
  window.resourceProbe = () => ({...metrics, textures: textures.size, fbos: fbos.size,
    logicalBytes: [...textures.values()].reduce((sum, size) => sum + (size.width||0)*(size.height||0)*4,0)});
}
