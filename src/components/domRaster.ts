import { resizeRasterCanvas } from "./canvasAllocation";

type PaintCanvas = HTMLCanvasElement & { requestPaint?: () => void };
type PaintContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: HTMLElement, x: number, y: number) => DOMMatrix;
};
let captureId = 0;
let refreshMode: "batched" | "interleaved" = "batched";
/** Pixel-parity reference control. Production batches reads. */
export function setDomRasterReadBatchingForTests(
  mode: "batched" | "interleaved",
) {
  refreshMode = mode;
}
const metrics = { captures: 0, clones: 0, styleReads: 0, activeSources: 0 };
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
  stableStyles?: () => unknown,
  bitmapFill?: string,
) {
  const canvas = document.createElement("canvas") as PaintCanvas;
  const context = canvas.getContext("2d") as PaintContext | null;
  if (!context) throw new Error("Cannot allocate DOM source surface");
  const backend = "native" as const;
  const batchReads = refined && refreshMode === "batched";
  const scope = `capture-${++captureId}`;
  if (!context.drawElementImage || !canvas.requestPaint)
    throw new Error(
      "Native HTML-in-Canvas capture is unavailable in this Electron runtime.",
    );
  canvas.dataset.domRaster = backend;
  canvas.setAttribute("aria-hidden", "true");
  canvas.setAttribute("inert", "");
  canvas.style.cssText =
    "position:fixed;left:0;top:0;z-index:-2147483648;pointer-events:none;";
  canvas.setAttribute("layoutsubtree", "");
  document.body.append(canvas);
  let root: HTMLElement | null = null;
  let pairs: Array<{
    original: HTMLElement;
    clone: HTMLElement;
    style: string;
    revision: string;
    children: number[];
    bitmap?: HTMLCanvasElement;
    paint?: {
      value: string;
      media: {
        width: string;
        height: string;
        objectFit: string;
        objectPosition: string;
      };
      pseudos: string[];
      transport: Record<string, string>;
    };
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
  let bitmapWritten = false;
  let structureRevision = 0;
  let styleEpoch = 0;
  let frozenKey: unknown;
  let frozenEpoch = -1;
  let frozenInline = "";
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
  const semanticStyles = () => stableStyles?.() != null;
  const hasRunningAnimations = () =>
    !semanticStyles() &&
    originalRoot.getAnimations({ subtree: true }).some((animation) => {
      if (animation.playState !== "running") return false;
      if (!refined || !(animation.effect instanceof KeyframeEffect))
        return true;
      const target = animation.effect.target;
      return target instanceof HTMLElement && included(target);
    });
  // Polling preserves decoder throughput in the native capture route.
  const pollAnimations = () => {
    animationFrame = 0;
    if (disposed) return;
    const animated = hasRunningAnimations();
    const playing =
      !semanticStyles() &&
      Array.from(originalRoot.querySelectorAll("video")).some(
        (video) => (!refined || included(video)) && !video.paused,
      );
    if (animated || playing || wasDynamic) {
      dirty = true;
      invalidate();
    }
    wasDynamic = animated || playing;
    if (wasDynamic) animationFrame = requestAnimationFrame(pollAnimations);
  };
  const markDirty = () => {
    if (disposed) return;
    dirty = true;
    invalidate();
    if (!semanticStyles() && !animationFrame)
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
          target.contains(source()) ||
          ((refined ? included(target) : include(target)) &&
            target.tagName !== "CANVAS" &&
            !record.attributeName?.startsWith("data-effect")))
      );
    });
    if (!relevant.length) return;
    if (
      relevant.some(
        ({ target }) =>
          target instanceof HTMLElement &&
          (!!target.closest("head,style") || !source().contains(target)),
      )
    )
      styleEpoch++;
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
    if (!semanticStyles())
      for (
        let ancestor = source().parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      )
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: ["class", "style"],
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
  animationFrame = requestAnimationFrame(pollAnimations);
  // Freeze pseudo-elements without copying global page styles into the mirror.
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
    bitmapWritten = false;
    if (structureDirty || !root) build();
    // This opt-in is used only for a scene of constant scoped CSS declarations.
    // Motion still supplies live computed transforms/alpha/visibility. Other
    // authoring, stylesheet, font and topology changes invalidate the cache.
    const transport = new Set([
      "transform",
      "transform-origin",
      "opacity",
      "visibility",
      "content-visibility",
      "pointer-events",
      "will-change",
      "display",
    ]);
    const key = stableStyles?.();
    const frozen = key !== undefined && key !== null;
    if (frozen) {
      const inline = pairs
        .map(({ original }) =>
          [
            original.className,
            ...Array.from(original.style)
              .filter(
                (property) =>
                  !property.startsWith("--") && !transport.has(property),
              )
              .map(
                (property) =>
                  `${property}:${original.style.getPropertyValue(property)}`,
              ),
          ].join(";"),
        )
        .join("\n");
      if (
        key !== frozenKey ||
        frozenEpoch !== styleEpoch ||
        inline !== frozenInline
      )
        pairs.forEach((pair) => {
          pair.paint = undefined;
        });
      frozenKey = key;
      frozenEpoch = styleEpoch;
      frozenInline = inline;
    } else
      pairs.forEach((pair) => {
        pair.paint = undefined;
      });
    const pseudoRules: string[] = [];
    const read = (pair: (typeof pairs)[number]) => {
      if (frozen && pair.paint) {
        pseudoRules.push(...pair.paint.pseudos);
        return pair.paint;
      }
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
      const pseudos: string[] = [];
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(original, pseudo);
        metrics.styleReads++;
        if (style.content !== "none" && style.content !== "normal")
          pseudos.push(
            `[data-dom-raster-node="${key}"]${pseudo}{${declarations(style)}animation:none!important;transition:none!important;}`,
          );
      }
      pseudoRules.push(...pseudos);
      const transportValues = Object.fromEntries(
        [...transport].map((property) => [
          property,
          computed.getPropertyValue(property),
        ]),
      );
      const paint = { value, media, pseudos, transport: transportValues };
      if (frozen) pair.paint = paint;
      return paint;
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
      if (frozen) {
        for (const property of transport) {
          const inline = original.style.getPropertyValue(property);
          clone.style.setProperty(
            property,
            inline || pair.paint!.transport[property] || "",
            "important",
          );
        }
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
            ? `${original.dataset.rasterRevision ?? original.closest<HTMLElement>("[data-effect-id]")?.dataset.effectRevision}:${original.width}:${original.height}`
            : `${original.currentTime}:${original.videoWidth}:${original.videoHeight}`;
        if (next !== pair.revision) {
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
            if (bitmapFill) {
              bitmapContext.fillStyle = bitmapFill;
              bitmapContext.fillRect(0, 0, output.width, output.height);
            } else bitmapContext.drawImage(original, 0, 0);
            bitmapWritten = true;
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
  };
  metrics.activeSources++;
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
      const animated = hasRunningAnimations();
      const video =
        !semanticStyles() &&
        Array.from(originalRoot.querySelectorAll("video")).some(
          (node) => (!refined || included(node)) && !node.paused,
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
        // Capture a viewport whose descendant carries the world transform.
        // Native recording omits its root transform and can cull untransformed
        // content outside the ancestor canvas (notably at fractional Windows DPR).
        root!.style.setProperty("transform", matrix.toString(), "important");
        root!.style.setProperty("transform-origin", "0 0", "important");
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
          lastSnapshot?.length === snapshot.length &&
          snapshot.every((value, index) => value === lastSnapshot![index])
        )
          return;
        captured = true;
        return new Promise<void>((resolve, reject) => {
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
          } else canvas.addEventListener("paint", painted, { once: true });
          canvas.requestPaint!();
        }).then(() => {
          lastSnapshot = snapshot;
          lastLogicalWidth = logicalWidth;
          lastLogicalHeight = logicalHeight;
          lastTransform = matrix.toString();
        });
      });
      inFlight = paint
        .then(() => {
          if (!disposed && captured) {
            revision++;
            metrics.captures++;
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
      if (disposed) return;
      disposed = true;
      metrics.activeSources--;
      cancelPaint?.();
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fontChanged);
      originalRoot.removeEventListener("load", loaded, true);
      canvas.remove();
      canvas.width = canvas.height = 1;
      pairs = [];
      root = null;
    },
  };
}
