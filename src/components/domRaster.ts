import { resizeRasterCanvas } from "./canvasAllocation";

type PaintCanvas = HTMLCanvasElement & { requestPaint?: () => void };
type PaintContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: HTMLElement, x: number, y: number) => DOMMatrix;
};
export type DomRasterBackend = "svg" | "native" | "native-naive";
let experimentBackend: DomRasterBackend = "native";
let captureId = 0;
// Electron's decoded callback route regresses decoder drops under many-video
// load. Poll until that route has matching playback and freshness evidence.
let videoInvalidation: "decoded" | "poll" = "poll";
let refreshMode: "batched" | "interleaved" = "batched";
export function setDomRasterRefreshExperiment(mode: "batched" | "interleaved") {
  refreshMode = mode;
}
/** Runtime-only matched benchmark control; sampled when a source is created. */
export function setDomRasterVideoExperiment(mode: "decoded" | "poll") {
  videoInvalidation = mode;
}
/** In-memory benchmark control. Production always starts with native capture. */
export function setDomRasterExperimentBackend(backend: DomRasterBackend) {
  experimentBackend = backend;
}
const metrics = {
  captures: 0,
  clones: 0,
  styleReads: 0,
  styleMs: 0,
  paintMs: 0,
  mediaCopies: 0,
  mediaCopyBytes: 0,
  videoSamples: 0,
  videoSampleAgeMs: 0,
};
export function domRasterDiagnostics() {
  return { ...metrics };
}

/** A renderer-local snapshot, never a second document or a live editor subtree.
 * Freeze computed styles at ShowMe's clock; user code stays in its existing worker. */
export function createDomRasterSource(
  source: () => HTMLElement,
  include: (node: HTMLElement) => boolean,
  normalize: (node: HTMLElement, clone: HTMLElement) => void,
  invalidate: () => void,
  dependencies: () => Promise<void>,
  sourceTransform: () => DOMMatrix = () => new DOMMatrix(),
  refined = false,
) {
  const canvas = document.createElement("canvas") as PaintCanvas;
  const context = canvas.getContext("2d") as PaintContext | null;
  if (!context) throw new Error("Cannot allocate DOM source surface");
  const backend: DomRasterBackend = experimentBackend;
  const decodedVideo = refined && videoInvalidation === "decoded";
  const batchReads = refined && refreshMode === "batched";
  const scope = `capture-${++captureId}`;
  if (backend !== "svg" && (!context.drawElementImage || !canvas.requestPaint))
    throw new Error(
      "Native HTML-in-Canvas capture is unavailable in this Electron runtime.",
    );
  canvas.dataset.domRaster = backend;
  canvas.setAttribute("aria-hidden", "true");
  canvas.setAttribute("inert", "");
  canvas.style.cssText =
    "position:fixed;left:0;top:0;z-index:-2147483648;pointer-events:none;";
  if (backend !== "svg") {
    canvas.setAttribute("layoutsubtree", "");
    document.body.append(canvas);
  }
  let root: HTMLElement | null = null;
  let pairs: Array<{
    original: HTMLElement;
    clone: HTMLElement;
    style: string;
    revision: string;
    children: number[];
    bitmap?: HTMLCanvasElement;
  }> = [];
  let dirty = true,
    structureDirty = true,
    disposed = false,
    revision = 0;
  let inFlight: Promise<void> | null = null;
  let cancelPaint: (() => void) | null = null;
  type SnapshotValue = string | number | boolean | undefined;
  let lastSnapshot: SnapshotValue[] | null = null;
  let fontRevision = 0;
  let lastLogicalWidth = 0,
    lastLogicalHeight = 0;
  let lastTransform = "";
  let animationFrame = 0;
  let wasDynamic = false;
  let sampledVideos: number[] = [];
  let bitmapWritten = false;
  let structureRevision = 0;
  const videoFrames = new Map<HTMLVideoElement, number>();
  const included = (node: HTMLElement) => {
    for (
      let ancestor: HTMLElement | null = node;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (!include(ancestor)) return false;
      if (ancestor === originalRoot) return true;
    }
    return false;
  };
  const syncVideos = () => {
    if (!decodedVideo) return;
    const current = new Set(
      Array.from(
        originalRoot.querySelectorAll<HTMLVideoElement>("video"),
      ).filter(included),
    );
    for (const [video, id] of videoFrames)
      if (!current.has(video)) {
        video.cancelVideoFrameCallback(id);
        videoFrames.delete(video);
      }
    for (const video of current)
      if (
        !videoFrames.has(video) &&
        typeof video.requestVideoFrameCallback === "function"
      ) {
        const decoded = () => {
          if (disposed) return;
          markDirty();
          videoFrames.set(video, video.requestVideoFrameCallback(decoded));
        };
        videoFrames.set(video, video.requestVideoFrameCallback(decoded));
      }
  };
  const pollAnimations = () => {
    animationFrame = 0;
    if (disposed) return;
    const animated = originalRoot
      .getAnimations({ subtree: true })
      .some((animation) => animation.playState === "running");
    const playing = Array.from(originalRoot.querySelectorAll("video")).some(
      (video) =>
        (!refined || included(video)) &&
        !video.paused &&
        (!decodedVideo ||
          typeof video.requestVideoFrameCallback !== "function"),
    );
    if (animated || playing || wasDynamic) {
      dirty = true;
      invalidate();
    }
    wasDynamic = animated || playing;
    if (wasDynamic) animationFrame = requestAnimationFrame(pollAnimations);
  };
  const images = new Map<string, Promise<string>>();
  const markDirty = () => {
    if (disposed) return;
    dirty = true;
    invalidate();
    if (!animationFrame && !disposed)
      animationFrame = requestAnimationFrame(pollAnimations);
  };
  const observer = new MutationObserver((records) => {
    const relevant = records.filter((record) => {
      const target =
        record.target instanceof HTMLElement
          ? record.target
          : record.target.parentElement;
      return (
        target &&
        (target.closest("head,style") ||
          ((refined ? included(target) : include(target)) &&
            target.tagName !== "CANVAS" &&
            !record.attributeName?.startsWith("data-effect")))
      );
    });
    if (!relevant.length) return;
    if (
      relevant.some((record) => {
        if (record.type !== "childList") return false;
        if (
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => node.nodeType === Node.ELEMENT_NODE,
          )
        )
          return true;
        const pair = pairs.find((pair) => pair.original === record.target);
        if (!pair) return false;
        const children = pair.original.childNodes;
        return (
          children.length !== pair.children.length ||
          Array.from(children).some(
            (child, index) => child.nodeType !== pair.children[index],
          )
        );
      })
    )
      structureDirty = true;
    markDirty();
  });
  const observe = () => {
    observer.disconnect();
    observer.observe(source(), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    source()
      .closest(".slide-renderer")
      ?.querySelectorAll("style")
      .forEach((style) => {
        observer.observe(style, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
  };
  observe();
  const fontChanged = () => {
    fontRevision++;
    markDirty();
  };
  document.fonts.addEventListener("loadingdone", fontChanged);
  const loaded = () => markDirty();
  source().addEventListener("load", loaded, true);
  const originalRoot = source();
  syncVideos();
  animationFrame = requestAnimationFrame(pollAnimations);
  // Freeze pseudo-elements too. Copying entire stylesheets into an SVG image
  // would apply application body/:root rules to the image's own document.
  const styles = document.createElement("style");
  const viewport = document.createElement("div");
  const build = () => {
    pairs = [];
    const visit = (original: HTMLElement): HTMLElement | null => {
      if (
        !include(original) ||
        original.tagName === "STYLE" ||
        original.tagName === "SCRIPT"
      )
        return null;
      const bitmap =
        original instanceof HTMLCanvasElement ||
        original instanceof HTMLVideoElement
          ? document.createElement("canvas")
          : undefined;
      // Chromium's experimental painter records nested canvas pixels at their
      // intrinsic size, ignoring CSS resizing. Keep the original paint/layout
      // on a wrapper, and explicitly transform its bitmap into that CSS box.
      const clone = bitmap
        ? document.createElement("div")
        : (original.cloneNode(false) as HTMLElement);
      if (bitmap) clone.append(bitmap);
      if (clone instanceof HTMLImageElement) {
        clone.removeAttribute("srcset");
        clone.removeAttribute("sizes");
        clone.removeAttribute("loading");
      }
      for (const attribute of Array.from(clone.attributes))
        if (
          attribute.name.startsWith("on") ||
          attribute.name.startsWith("data-") ||
          attribute.name === "id" ||
          attribute.name === "class"
        )
          clone.removeAttribute(attribute.name);
      clone.dataset.domRasterNode = `${scope}-node-${pairs.length}`;
      pairs.push({
        original,
        clone,
        bitmap,
        style: "",
        revision: "",
        children: Array.from(original.childNodes, (child) => child.nodeType),
      });
      for (const child of original.childNodes) {
        if (child instanceof HTMLElement) {
          const copied = visit(child);
          if (copied) clone.append(copied);
        } else if (child.nodeType === Node.TEXT_NODE)
          clone.append(child.cloneNode());
      }
      return clone;
    };
    root = visit(source());
    if (!root) throw new Error("DOM shader input is unavailable.");
    // A fresh snapshot is assembled off-tree, then atomically replaces its predecessor.
    viewport.replaceChildren(root);
    canvas.replaceChildren(styles, viewport);
    structureDirty = false;
    structureRevision++;
    metrics.clones++;
  };
  let properties: string[] | null = null;
  const declarations = (style: CSSStyleDeclaration) => {
    const keys =
      properties ??
      Array.from(style).filter(
        (key) =>
          !key.startsWith("--") &&
          !key.startsWith("animation") &&
          !key.startsWith("transition"),
      );
    if (refined) properties = keys;
    return keys
      .map((key) => `${key}:${style.getPropertyValue(key)} !important;`)
      .join("");
  };
  const refresh = () => {
    const start = performance.now();
    sampledVideos = [];
    bitmapWritten = false;
    if (refined) {
      syncVideos();
      const structural = Array.from(
        originalRoot.querySelectorAll<HTMLElement>("[data-effect-source]"),
      ).map((node) => [node.parentElement?.dataset.effectId, include(node)]);
      const key = JSON.stringify(structural);
      if (key !== structureKey) {
        structureKey = key;
        structureDirty = true;
      }
    }
    if (backend !== "native" || structureDirty || !root) build();
    const pseudoRules: string[] = [];
    const read = (pair: (typeof pairs)[number]) => {
      const { original, clone } = pair;
      const computed = getComputedStyle(original);
      metrics.styleReads++;
      const value = declarations(computed);
      // CSSStyleDeclaration is live. Copy geometry/fit values before any writes.
      const media = {
        width: computed.width,
        height: computed.height,
        objectFit: computed.objectFit,
        objectPosition: computed.objectPosition,
      };
      const key = clone.dataset.domRasterNode!;
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(original, pseudo);
        if (style.content !== "none" && style.content !== "normal")
          pseudoRules.push(
            `[data-dom-raster-node="${key}"]${pseudo}{${declarations(style)}animation:none!important;transition:none!important;}`,
          );
      }
      return { value, media };
    };
    const reads = batchReads ? pairs.map(read) : null;
    for (const [index, pair] of pairs.entries()) {
      const { original, clone } = pair;
      const { value, media } = reads?.[index] ?? read(pair);
      if (value !== pair.style) {
        clone.style.cssText = value;
        clone.style.setProperty("animation", "none", "important");
        clone.style.setProperty("transition", "none", "important");
        pair.style = value;
      }
      normalize(original, clone);
      const texts = Array.from(original.childNodes).filter(
        (child) => child.nodeType === Node.TEXT_NODE,
      );
      const copies = Array.from(clone.childNodes).filter(
        (child) => child.nodeType === Node.TEXT_NODE,
      );
      // textContent="" removes the live text node. It must also remove the
      // retained mirror's node, or an empty JS result would keep old glyphs.
      if (!texts.length) copies.forEach((copy) => copy.remove());
      if (texts.length && !copies.length)
        clone.prepend(
          document.createTextNode(
            texts.map((text) => text.textContent).join(""),
          ),
        );
      texts.forEach((text, index) => {
        if (copies[index]?.textContent !== text.textContent && copies[index])
          copies[index].textContent = text.textContent;
      });
      if (
        original instanceof HTMLImageElement &&
        clone instanceof HTMLImageElement &&
        clone.src !== (original.currentSrc || original.src)
      )
        clone.src = original.currentSrc || original.src;
      if (
        original instanceof HTMLCanvasElement ||
        original instanceof HTMLVideoElement
      ) {
        const next =
          original instanceof HTMLCanvasElement
            ? `${original.closest<HTMLElement>("[data-effect-id]")?.dataset.effectRevision}:${original.width}:${original.height}`
            : `${original.currentTime}:${original.videoWidth}:${original.videoHeight}`;
        if (next !== pair.revision || backend === "svg") {
          const output = pair.bitmap!;
          const bitmapWidth =
            original instanceof HTMLCanvasElement
              ? original.width
              : original.videoWidth;
          const bitmapHeight =
            original instanceof HTMLCanvasElement
              ? original.height
              : original.videoHeight;
          if (output.width !== bitmapWidth) output.width = bitmapWidth;
          if (output.height !== bitmapHeight) output.height = bitmapHeight;
          if (output.width && output.height) {
            const bitmapContext = output.getContext("2d")!;
            bitmapContext.clearRect(0, 0, output.width, output.height);
            bitmapContext.drawImage(original, 0, 0);
            bitmapWritten = true;
            metrics.mediaCopies++;
            metrics.mediaCopyBytes += output.width * output.height * 4;
            if (original instanceof HTMLVideoElement)
              sampledVideos.push(performance.now());
          }
          pair.revision = next;
        }
        const bitmap = pair.bitmap!;
        const boxWidth = parseFloat(media.width),
          boxHeight = parseFloat(media.height);
        if (bitmap.width && bitmap.height && boxWidth > 0 && boxHeight > 0) {
          let width = boxWidth,
            height = boxHeight;
          const fit = media.objectFit;
          if (fit !== "fill") {
            let factor =
              fit === "cover"
                ? Math.max(boxWidth / bitmap.width, boxHeight / bitmap.height)
                : Math.min(boxWidth / bitmap.width, boxHeight / bitmap.height);
            if (fit === "none") factor = 1;
            if (fit === "scale-down") factor = Math.min(1, factor);
            width = bitmap.width * factor;
            height = bitmap.height * factor;
          }
          const position = media.objectPosition.split(" ");
          const offset = (value: string, free: number) =>
            value.endsWith("%")
              ? (parseFloat(value) * free) / 100
              : parseFloat(value) || 0;
          bitmap.style.cssText = `position:absolute;left:${offset(position[0], boxWidth - width)}px;top:${offset(position[1] ?? position[0], boxHeight - height)}px;width:${bitmap.width}px;height:${bitmap.height}px;transform:scale(${width / bitmap.width},${height / bitmap.height});transform-origin:0 0;`;
          // Replaced media clips its fitted bitmap to its own content box.
          clone.style.setProperty("overflow", "hidden", "important");
        }
      }
    }
    const css = pseudoRules.join("\n");
    if (styles.textContent !== css) styles.textContent = css;
    root!.style.setProperty("position", "relative", "important");
    root!.style.setProperty("left", "0px", "important");
    root!.style.setProperty("top", "0px", "important");
    metrics.styleMs += performance.now() - start;
  };
  let structureKey = "";
  const embedImage = (url: string) => {
    if (!images.has(url))
      images.set(
        url,
        fetch(url)
          .then((response) => {
            if (!response.ok)
              throw new Error("Cannot load DOM shader image input");
            return response.blob();
          })
          .then(
            (blob) =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () =>
                  reject(new Error("Cannot embed DOM shader image input"));
                reader.readAsDataURL(blob);
              }),
          ),
      );
    return images.get(url)!;
  };
  const svgPaint = async (
    width: number,
    height: number,
    logicalWidth: number,
    logicalHeight: number,
  ) => {
    const copy = root!.cloneNode(true) as HTMLElement;
    const originals = Array.from(root!.querySelectorAll("canvas,img"));
    const copies = Array.from(copy.querySelectorAll("canvas,img"));
    await Promise.all(
      originals.map(async (original, index) => {
        const node = copies[index];
        if (original instanceof HTMLCanvasElement) {
          const image = document.createElement("img");
          image.style.cssText = (node as HTMLElement).style.cssText;
          image.src = original.toDataURL();
          node.replaceWith(image);
        } else if (original instanceof HTMLImageElement && original.src) {
          (node as HTMLImageElement).src = original.src.startsWith("data:")
            ? original.src
            : await embedImage(original.currentSrc || original.src);
        }
      }),
    );
    const serialized = new XMLSerializer().serializeToString(copy);
    const css = new XMLSerializer().serializeToString(styles);
    const matrix = sourceTransform();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${logicalWidth} ${logicalHeight}"><g transform="matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})"><foreignObject width="${root!.style.width}" height="${root!.style.height}">${css}${serialized}</foreignObject></g></svg>`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    if (disposed) return;
    context.resetTransform();
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
  };
  return {
    canvas,
    backend,
    get revision() {
      return revision;
    },
    get isDirty() {
      return dirty;
    },
    markDirty,
    update(
      width: number,
      height: number,
      logicalWidth: number,
      logicalHeight: number,
    ): void | Promise<void> {
      if (disposed) return;
      if (inFlight) return inFlight;
      const requestedTransform = sourceTransform().toString();
      const animated = originalRoot
        .getAnimations({ subtree: true })
        .some((animation) => animation.playState === "running");
      const video = Array.from(originalRoot.querySelectorAll("video")).some(
        (node) =>
          (!refined || included(node)) &&
          !node.paused &&
          (!decodedVideo ||
            typeof node.requestVideoFrameCallback !== "function"),
      );
      if (
        !dirty &&
        canvas.width === width &&
        canvas.height === height &&
        lastLogicalWidth === logicalWidth &&
        lastLogicalHeight === logicalHeight &&
        lastTransform === requestedTransform &&
        !animated &&
        !video
      )
        return;
      const start = performance.now();
      let captured = false;
      const paint = dependencies().then(async () => {
        if (disposed) return;
        dirty = false;
        refresh();
        // Original readiness does not establish readiness of its independent
        // native mirror, especially after a currentSrc change.
        await Promise.all(
          pairs.map(({ clone }) =>
            clone instanceof HTMLImageElement &&
            clone.src &&
            (!clone.complete || !clone.naturalWidth)
              ? clone.decode()
              : undefined,
          ),
        );
        if (disposed) return;
        resizeRasterCanvas(canvas, width, height);
        canvas.style.width = `${logicalWidth}px`;
        canvas.style.height = `${logicalHeight}px`;
        const matrix = sourceTransform();
        canvas.dataset.domRasterTransform = matrix.toString();
        viewport.style.cssText = `position:relative;width:${logicalWidth}px;height:${logicalHeight}px;overflow:hidden;`;
        if (backend !== "svg") {
          // Capture a viewport whose descendant carries the world transform.
          // Native recording omits its root transform and can cull untransformed
          // content outside the ancestor canvas (notably at fractional Windows DPR).
          root!.style.setProperty("transform", matrix.toString(), "important");
          root!.style.setProperty("transform-origin", "0 0", "important");
        }
        // Compare the same paint inputs without concatenating/escaping every
        // node's complete declarations into another large JSON string.
        const snapshot: SnapshotValue[] = [
          width,
          height,
          logicalWidth,
          logicalHeight,
          matrix.toString(),
          fontRevision,
          structureRevision,
          styles.textContent,
          ...pairs.flatMap((pair) => [
            pair.clone.style.cssText,
            pair.clone.textContent,
            pair.revision,
            pair.bitmap?.style.cssText,
            pair.original instanceof HTMLImageElement
              ? pair.original.currentSrc
              : undefined,
            pair.original instanceof HTMLImageElement
              ? pair.original.complete
              : undefined,
          ]),
        ];
        if (
          backend === "native" &&
          lastSnapshot?.length === snapshot.length &&
          snapshot.every((value, index) => value === lastSnapshot![index])
        )
          return;
        captured = true;
        return (
          backend === "svg"
            ? svgPaint(width, height, logicalWidth, logicalHeight)
            : new Promise<void>((resolve, reject) => {
                const finish = () => {
                  clearTimeout(timer);
                  canvas.removeEventListener("paint", painted);
                  canvas.removeEventListener("paint", primed);
                  cancelPaint = null;
                };
                const painted = () => {
                  finish();
                  if (disposed) {
                    resolve();
                    return;
                  }
                  try {
                    context.resetTransform();
                    context.clearRect(0, 0, width, height);
                    // drawElementImage already maps the element's CSS viewport
                    // into this canvas's bitmap size. Applying sampling density
                    // again would double both editor zoom and display scaling.
                    context.drawElementImage!(viewport, 0, 0);
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                };
                const primed = () => {
                  if (disposed) return;
                  canvas.addEventListener("paint", painted, { once: true });
                  canvas.requestPaint!();
                };
                const timer = setTimeout(() => {
                  finish();
                  reject(new Error("DOM shader input paint timed out"));
                }, 1500);
                cancelPaint = () => {
                  finish();
                  resolve();
                };
                // A nested canvas's latest bitmap is committed during paint. Waiting
                // one paint before recording avoids sampling the preceding shader frame.
                if (bitmapWritten) {
                  canvas.addEventListener("paint", primed, { once: true });
                } else
                  canvas.addEventListener("paint", painted, { once: true });
                canvas.requestPaint!();
              })
        ).then(() => {
          lastSnapshot = snapshot;
          lastLogicalWidth = logicalWidth;
          lastLogicalHeight = logicalHeight;
          lastTransform = matrix.toString();
        });
      });
      inFlight = paint
        .then(() => {
          if (!disposed && captured) {
            const completed = performance.now();
            metrics.videoSamples += sampledVideos.length;
            metrics.videoSampleAgeMs += sampledVideos.reduce(
              (sum, sampled) => sum + completed - sampled,
              0,
            );
            revision++;
            metrics.captures++;
            metrics.paintMs += performance.now() - start;
          }
        })
        .catch((error) => {
          if (!disposed) dirty = true;
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    dispose() {
      disposed = true;
      cancelPaint?.();
      cancelAnimationFrame(animationFrame);
      for (const [video, id] of videoFrames) video.cancelVideoFrameCallback(id);
      videoFrames.clear();
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fontChanged);
      originalRoot.removeEventListener("load", loaded, true);
      canvas.remove();
      canvas.width = canvas.height = 1;
      pairs = [];
      root = null;
      images.clear();
    },
  };
}
