import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { platform } from "../../src/platform";
import { usePreparedImage } from "../../src/components/usePreparedImage";
import {
  IMAGE_RECIPE,
  type PreparedImage,
} from "../../src/core/presentationImages";

export function mountPreparedImageHarness() {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const requests = document.createElement("output");
  requests.setAttribute("aria-label", "Requests");
  requests.textContent = "0";
  const released = document.createElement("output");
  released.setAttribute("aria-label", "Released images");
  released.textContent = "0";
  const activeReleases = document.createElement("output");
  activeReleases.setAttribute("aria-label", "Displayed URL releases");
  activeReleases.textContent = "0";
  host.append(requests, released, activeReleases);
  const pending: Array<() => void> = [];
  let count = 0;
  let releases = 0;
  let displayedReleases = 0;
  platform.releaseUrl = (url) => {
    if (host.querySelector("img")?.src === url)
      activeReleases.textContent = String(++displayedReleases);
    URL.revokeObjectURL(url);
    released.textContent = String(++releases);
  };
  platform.preparedImage = (_document, _slide, _element, profile) => {
    requests.textContent = String(++count);
    const { width, height } = profile!;
    return new Promise((resolve) => {
      pending.push(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2;
        canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
        canvas.toBlob((blob) => {
          const image: PreparedImage = {
            assetId: "asset",
            hash: `${width}x${height}`,
            size: Math.max(width, height),
            width,
            height,
            sourceWidth: 4096,
            sourceHeight: 4096,
            recipe: IMAGE_RECIPE,
            mime: "image/png",
            url: URL.createObjectURL(blob!),
          };
          resolve(image);
        });
      });
    });
  };
  function Harness() {
    const [paused, setPaused] = useState(false);
    const [size, setSize] = useState(100);
    const profile = useMemo(
      () => ({
        width: size,
        height: size,
      }),
      [size],
    );
    const { image } = usePreparedImage(
      "document",
      "slide",
      "element",
      "asset",
      true,
      profile,
      paused,
    );
    return (
      <>
        <button onClick={() => setPaused(true)}>Begin resize</button>
        <button onClick={() => setSize((value) => value + 100)}>Enlarge</button>
        <button onClick={() => setPaused(false)}>End resize</button>
        <button onClick={() => pending.shift()?.()}>Finish preparation</button>
        <button onClick={() => void platform.clearPresentationImages?.()}>
          Clear cache
        </button>
        <output aria-label="Gesture">{paused ? "resizing" : "idle"}</output>
        <output aria-label="Displayed resolution">
          {image?.width ?? "waiting"}
        </output>
        {image && <img src={image.url} alt="Canvas image" />}
      </>
    );
  }
  const root = document.createElement("div");
  host.append(root);
  createRoot(root).render(<Harness />);
}
