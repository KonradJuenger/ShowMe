import type { RenderResources } from "./renderResources";

const providers = new WeakMap<
  RenderResources,
  Map<string, Promise<string | null>>
>();
function postersFor(resources: RenderResources) {
  let cache = providers.get(resources);
  if (!cache) {
    cache = new Map();
    providers.set(resources, cache);
  }
  return cache;
}

async function capture(
  resources: RenderResources,
  assetId: string,
  startTime: number,
): Promise<string | null> {
  const url = await resources.assetUrl(assetId);
  if (!url) return null;
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  try {
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const render = () => {
        if (settled) return;
        finish(captureVideoPoster(assetId, startTime, video, resources));
      };
      const draw = () => {
        if ("requestVideoFrameCallback" in video) {
          video.requestVideoFrameCallback(() => render());
          setTimeout(render, 70);
        } else render();
      };
      const timer = setTimeout(() => finish(null), 12000);
      video.onerror = () => finish(null);
      video.onloadeddata = () => {
        const target = Math.min(startTime, Math.max(0, video.duration - 0.05));
        if (target < 0.01) draw();
        else {
          video.onseeked = draw;
          video.currentTime = target;
        }
      };
      video.src = url;
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    resources.releaseUrl(url);
  }
}

const posterKey = (assetId: string, startTime: number) =>
  `${assetId}:${startTime.toFixed(3)}`;

/** Cache the prepared player's frame without opening a second video decoder. */
export function captureVideoPoster(
  assetId: string,
  startTime: number,
  video: HTMLVideoElement,
  resources: RenderResources,
): string | null {
  const posters = postersFor(resources);
  if (
    video.seeking ||
    video.readyState < 2 ||
    !video.videoWidth ||
    !video.videoHeight
  )
    return null;
  const scale = Math.min(1, 960 / video.videoWidth, 960 / video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/jpeg", 0.82);
    const key = posterKey(assetId, startTime);
    if (!posters.has(key) && posters.size >= 30)
      posters.delete(posters.keys().next().value!);
    posters.set(key, Promise.resolve(result));
    return result;
  } catch {
    return null;
  }
}

export function videoPoster(
  resources: RenderResources,
  assetId: string,
  startTime: number,
  captureMissing = true,
) {
  const posters = postersFor(resources);
  const key = posterKey(assetId, startTime);
  let result = posters.get(key);
  if (!result && !captureMissing) return Promise.resolve(null);
  if (!result) {
    result = capture(resources, assetId, startTime).then((value) => {
      if (!value && posters.get(key) === result) posters.delete(key);
      return value;
    });
    if (posters.size >= 30) posters.delete(posters.keys().next().value!);
    posters.set(key, result);
  }
  return result;
}
