export function waitForSlideImages(root: HTMLElement, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      observer.disconnect();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (signal.aborted || !root.querySelector('[data-media-loading="true"]'))
        done();
    };
    const observer = new MutationObserver(check);
    signal.addEventListener("abort", done, { once: true });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-media-loading"],
    });
    check();
  });
}
