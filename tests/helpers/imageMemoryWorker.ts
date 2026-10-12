import "../../src/platform/imageWorker";
const original = OffscreenCanvasRenderingContext2D.prototype.getImageData;
let peakReadbackBytes = 0;
OffscreenCanvasRenderingContext2D.prototype.getImageData = function (x, y, width, height, settings) {
  peakReadbackBytes = Math.max(peakReadbackBytes, width * height * 4);
  return original.call(this, x, y, width, height, settings);
};
const post = self.postMessage.bind(self);
self.postMessage = (message: unknown) => post({ ...(message as object), peakReadbackBytes });
