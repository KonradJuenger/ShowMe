import { effectSurface } from "./effectRuntime";
import { elementWorldTransform } from "./elementDomTransform";
import type { RestorationPlan, Bounds } from "./compositionBackendPlan";
import type { Deck } from "../core/document";
import type { MotionRenderSink, MotionVisualSample } from "./motionRuntime";

type Crop = { x: number; y: number; width: number; height: number };
type Material = {
  id: string;
  paint: HTMLElement;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  output: ImageBitmapRenderingContext;
  sample: MotionVisualSample;
  crop: Crop;
  populated: boolean;
};

/** Restores B over the native material R at 1-alpha. It consumes semantic
 * frames; it neither samples Motion nor reads animated values from the DOM.
 * Nodes belong to SlideRenderer. Only resource readiness and output styles
 * belong to this backend, never the Presence owner's paint/visibility fields. */
export function mountBackdropRestoration(
  root: HTMLElement,
  plan: RestorationPlan,
  deck: Deck,
  failed: (ids: readonly string[], error: unknown) => void,
) {
  let disposed = false,
    rejected = false,
    inFlight: Promise<boolean> | undefined;
  let revision = "";
  const nodes = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-element-id]")].map((node) => [
      node.dataset.elementId!,
      node,
    ]),
  );
  const background = nodes.get(plan.background.element.id)!;
  const fx = background.querySelector<HTMLElement>("[data-effect-id]")!;
  const source = document.createElement("canvas");
  source.width = source.height = 1;
  const context = source.getContext("2d");
  if (!context) throw new Error("Backdrop restoration is unavailable");
  const materials: Material[] = [...plan.glass].map((id) => {
    const owner = nodes.get(id)!;
    const paint = owner.querySelector<HTMLElement>(
      ":scope > [data-composition-paint]",
    );
    const overlay = [
      ...root.querySelectorAll<HTMLElement>("[data-backdrop-restore]"),
    ].find((node) => node.dataset.backdropRestore === id);
    const canvas = overlay?.querySelector("canvas");
    const output = canvas?.getContext("bitmaprenderer");
    if (!paint || !overlay || !canvas || !output)
      throw new Error("Renderer restoration output is unavailable");
    const element = plan.plan.groups.get(id)!.element;
    return {
      id,
      paint,
      overlay,
      canvas,
      output,
      sample: {
        elementId: id,
        frame: element.frame,
        opacity: element.appearance.opacity,
        present: true,
      },
      crop: { x: 0, y: 0, width: deck.width, height: deck.height },
      populated: false,
    };
  });
  const set = (
    node: HTMLElement,
    key:
      | "contentVisibility"
      | "visibility"
      | "opacity"
      | "clipPath"
      | "left"
      | "top"
      | "width"
      | "height",
    value: string,
  ) => {
    if (node.style[key] !== value) node.style[key] = value;
  };
  const present = () => {
    for (const material of materials) {
      const { sample, crop, overlay, paint, populated } = material;
      const restoring = sample.present && sample.opacity < 1;
      set(paint, "contentVisibility", restoring && !populated ? "hidden" : "");
      set(overlay, "visibility", sample.present ? "visible" : "hidden");
      set(
        overlay,
        "opacity",
        restoring && populated ? String(1 - sample.opacity) : "0",
      );
      if (restoring) {
        const { frame } = sample,
          pad = plan.padding;
        set(
          overlay,
          "clipPath",
          `inset(${frame.y - crop.y - pad}px ${crop.x + crop.width - frame.x - frame.width - pad}px ${crop.y + crop.height - frame.y - frame.height - pad}px ${frame.x - crop.x - pad}px)`,
        );
      }
    }
  };
  const reject = (ids: readonly string[], error: unknown) => {
    if (!disposed && !rejected) {
      rejected = true;
      failed(ids, error);
    }
  };
  // Native glyph ink can exceed model frames. Validate once after fonts load,
  // rather than doing layout readback for every animated composition sample.
  const validateText = () => {
    if (disposed) return;
    const viewport = root.getBoundingClientRect();
    const sx = viewport.width / deck.width,
      sy = viewport.height / deck.height;
    if (!(sx > 0 && sy > 0))
      throw new Error("Native output bounds are unavailable");
    const invalid = new Set<string>();
    for (const group of plan.plan.roots) {
      if (group.element.content?.type !== "text") continue;
      const owner = nodes.get(group.element.id)!;
      const text = owner.querySelector<HTMLElement>("[data-text-content]");
      if (!text) throw new Error("Native text bounds are unavailable");
      const range = document.createRange();
      range.selectNodeContents(text);
      const world = elementWorldTransform(owner, root),
        box = plan.envelopes.get(group.element.id)!;
      const overhang = parseFloat(getComputedStyle(text).fontSize);
      for (const rect of range.getClientRects()) {
        const ink: Bounds = {
          left:
            box.left + (rect.left - viewport.left) / sx - world.e - overhang,
          top: box.top + (rect.top - viewport.top) / sy - world.f - overhang,
          right:
            box.right -
            group.element.frame.width +
            (rect.right - viewport.left) / sx -
            world.e +
            overhang,
          bottom:
            box.bottom -
            group.element.frame.height +
            (rect.bottom - viewport.top) / sy -
            world.f +
            overhang,
        };
        for (const material of materials) {
          const target = plan.envelopes.get(material.id)!,
            p = plan.padding;
          if (
            target.left - p < ink.right + p &&
            target.right + p > ink.left - p &&
            target.top - p < ink.bottom + p &&
            target.bottom + p > ink.top - p
          )
            invalid.add(material.id);
        }
      }
    }
    if (invalid.size)
      reject(
        [...invalid],
        new Error("Native text contributes to a restoration region"),
      );
  };
  const ready = document.fonts.ready.then(validateText);
  const fontsChanged = () => {
    try {
      validateText();
    } catch (error) {
      reject([...plan.glass], error);
    }
  };
  document.fonts.addEventListener("loadingdone", fontsChanged);
  const render = async () => {
    await ready;
    if (disposed || rejected) return false;
    if (fx.dataset.effectError) throw new Error(fx.dataset.effectError);
    if (fx.dataset.effectReady !== "true") return false;
    effectSurface(fx)?.materialize();
    const shader = fx.querySelector("canvas")!;
    if (!shader.width || !shader.height) return false;
    const visible = shader.style.visibility !== "hidden";
    const key = `${fx.dataset.effectRevision}:${shader.width}:${shader.height}:${visible}`;
    if (key === revision && materials.every((m) => m.populated)) return true;
    const sx = shader.width / deck.width,
      sy = shader.height / deck.height;
    const crops = materials.map((material) => {
      const bounds = plan.envelopes.get(material.id)!,
        p = plan.padding;
      const x = Math.max(0, Math.floor((bounds.left - p) * sx)),
        y = Math.max(0, Math.floor((bounds.top - p) * sy));
      const right = Math.min(shader.width, Math.ceil((bounds.right + p) * sx));
      const bottom = Math.min(
        shader.height,
        Math.ceil((bounds.bottom + p) * sy),
      );
      if (right <= x || bottom <= y)
        throw new Error("Restoration region is outside the output");
      return { material, x, y, width: right - x, height: bottom - y };
    });
    if (
      (shader.width * shader.height +
        crops.reduce((sum, c) => sum + 2 * c.width * c.height, 0)) *
        4 >
      256 * 1024 * 1024
    )
      throw new Error("Backdrop restoration exceeds its surface budget");
    if (source.width !== shader.width) source.width = shader.width;
    if (source.height !== shader.height) source.height = shader.height;
    context.resetTransform();
    context.globalAlpha = 1;
    context.fillStyle = root.style.background;
    context.fillRect(0, 0, source.width, source.height);
    context.fillStyle =
      plan.background.element.appearance.fill || "transparent";
    context.fillRect(0, 0, source.width, source.height);
    if (visible) context.drawImage(shader, 0, 0, source.width, source.height);
    // Prepare every admitted region during existing audience readiness, even
    // before Presence starts. Keep these small surfaces through replay.
    const pending = await Promise.allSettled(
      crops.map(async (crop) => ({
        ...crop,
        bitmap: await createImageBitmap(
          source,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
        ),
      })),
    );
    try {
      const failure = pending.find((r) => r.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of pending)
        if (result.status === "fulfilled") {
          const { material, bitmap, x, y, width, height } = result.value;
          if (!disposed && !rejected) {
            if (material.canvas.width !== width) material.canvas.width = width;
            if (material.canvas.height !== height)
              material.canvas.height = height;
            material.output.transferFromImageBitmap(bitmap);
            material.crop = {
              x: x / sx,
              y: y / sy,
              width: width / sx,
              height: height / sy,
            };
            for (const [property, value] of [
              ["left", x / sx],
              ["top", y / sy],
              ["width", width / sx],
              ["height", height / sy],
            ] as const)
              set(material.overlay, property, `${value}px`);
            material.populated = true;
          }
        }
      revision = key;
    } finally {
      for (const result of pending)
        if (result.status === "fulfilled") result.value.bitmap.close();
    }
    if (!disposed && !rejected) present();
    return !disposed && !rejected;
  };
  const sink: MotionRenderSink = {
    ownsOpacity(id) {
      return plan.glass.has(id);
    },
    apply(samples) {
      for (const sample of samples) {
        const material = materials.find((m) => m.id === sample.elementId);
        if (material) material.sample = sample;
      }
      present();
    },
    reset() {
      for (const material of materials) {
        const e = plan.plan.groups.get(material.id)!.element;
        material.sample = {
          elementId: e.id,
          frame: e.frame,
          opacity: e.appearance.opacity,
          present: true,
        };
      }
      present();
    },
  };
  present();
  void ready.catch((error) => reject([...plan.glass], error));
  return {
    ...sink,
    flush() {
      return (inFlight ??= render()
        .catch((error) => {
          reject([...plan.glass], error);
          return false;
        })
        .finally(() => {
          inFlight = undefined;
        }));
    },
    dispose() {
      disposed = true;
      document.fonts.removeEventListener("loadingdone", fontsChanged);
      for (const m of materials) {
        m.paint.style.contentVisibility = "";
        m.overlay.style.opacity = "0";
        m.output.transferFromImageBitmap(null);
        m.canvas.width = m.canvas.height = 1;
      }
      source.width = source.height = 1;
    },
  };
}
