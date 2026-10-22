import type { RestorationPlan } from "./compositionBackendPlan";
import type { Deck } from "../core/document";
import type { MotionRenderSink, MotionVisualSample } from "./motionRuntime";
import type { RenderDensity } from "../core/renderProfile";
import {
  createPrefixMaterializer,
  type PrefixSurfaceRef,
} from "./compositionSurface";

type Crop = { x: number; y: number; width: number; height: number };
type Material = {
  id: string;
  surface: PrefixSurfaceRef;
  paint: HTMLElement;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  output: ImageBitmapRenderingContext;
  sample: MotionVisualSample;
  crop: Crop;
  sourceRevision: number;
  populated: boolean;
};

/** Restores B over the native material R at 1-alpha. It consumes semantic
 * frames; it neither samples Motion nor reads animated values from the DOM.
 * Backdrop pixels come only from the generic prefix materializer. This module
 * intentionally knows nothing about image transforms, shader canvases or shape
 * rasterization. */
export function mountBackdropRestoration(
  root: HTMLElement,
  plan: RestorationPlan,
  deck: Deck,
  failed: (ids: readonly string[], error: unknown) => void,
  density: Pick<RenderDensity, "x" | "y">,
) {
  let disposed = false,
    rejected = false,
    inFlight: Promise<boolean> | undefined,
    scheduled = false;
  const nodes = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-element-id]")].map((node) => [
      node.dataset.elementId!,
      node,
    ]),
  );
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
    const surface = plan.surfaces.get(id);
    if (!paint || !overlay || !canvas || !output || !surface)
      throw new Error("Renderer restoration output is unavailable");
    const element = plan.plan.groups.get(id)!.element;
    return {
      id,
      surface,
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
      sourceRevision: -1,
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
  const requestRender = () => {
    if (disposed || rejected || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed && !rejected) void flush();
    });
  };
  const materializer = createPrefixMaterializer(
    root,
    plan.slide,
    deck,
    density,
    requestRender,
  );

  const render = async () => {
    if (disposed || rejected) return false;
    const resolved = new Map<
      PrefixSurfaceRef,
      Awaited<ReturnType<typeof materializer.materialize>>
    >();
    for (const ref of new Set(materials.map((material) => material.surface)))
      resolved.set(ref, await materializer.materialize(ref));
    if (disposed || rejected) return false;

    const pendingMaterials = materials.filter((material) => {
      const source = resolved.get(material.surface)!;
      return !material.populated || material.sourceRevision !== source.revision;
    });
    if (!pendingMaterials.length) {
      present();
      return true;
    }

    const crops = pendingMaterials.map((material) => {
      const source = resolved.get(material.surface)!;
      const width = source.canvas.width,
        height = source.canvas.height,
        sx = width / deck.width,
        sy = height / deck.height,
        bounds = plan.envelopes.get(material.id)!,
        p = plan.padding;
      const x = Math.max(0, Math.floor((bounds.left - p) * sx)),
        y = Math.max(0, Math.floor((bounds.top - p) * sy));
      const right = Math.min(width, Math.ceil((bounds.right + p) * sx));
      const bottom = Math.min(height, Math.ceil((bounds.bottom + p) * sy));
      if (right <= x || bottom <= y)
        throw new Error("Restoration region is outside the output");
      return {
        material,
        source,
        x,
        y,
        width: right - x,
        height: bottom - y,
        sx,
        sy,
      };
    });

    const uniqueSources = new Set(crops.map((crop) => crop.source));
    const sourcePixels = [...uniqueSources].reduce(
      (sum, source) => sum + source.canvas.width * source.canvas.height,
      0,
    );
    if (
      (sourcePixels +
        crops.reduce((sum, crop) => sum + 2 * crop.width * crop.height, 0)) *
        4 >
      256 * 1024 * 1024
    )
      throw new Error("Backdrop restoration exceeds its surface budget");

    const pending = await Promise.allSettled(
      crops.map(async (crop) => ({
        ...crop,
        bitmap: await createImageBitmap(
          crop.source.canvas,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
        ),
      })),
    );
    try {
      const failure = pending.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of pending)
        if (result.status === "fulfilled") {
          const {
            material,
            source,
            bitmap,
            x,
            y,
            width,
            height,
            sx,
            sy,
          } = result.value;
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
            material.sourceRevision = source.revision;
            material.populated = true;
          }
        }
    } finally {
      for (const result of pending)
        if (result.status === "fulfilled") result.value.bitmap.close();
    }
    if (!disposed && !rejected) present();
    return !disposed && !rejected;
  };

  function flush() {
    return (inFlight ??= render()
      .catch((error) => {
        reject([...plan.glass], error);
        return false;
      })
      .finally(() => {
        inFlight = undefined;
      }));
  }

  const sink: MotionRenderSink = {
    ownsOpacity(id) {
      return plan.glass.has(id);
    },
    apply(samples) {
      for (const sample of samples) {
        const material = materials.find((entry) => entry.id === sample.elementId);
        if (material) material.sample = sample;
      }
      present();
    },
    reset() {
      for (const material of materials) {
        const element = plan.plan.groups.get(material.id)!.element;
        material.sample = {
          elementId: element.id,
          frame: element.frame,
          opacity: element.appearance.opacity,
          present: true,
        };
      }
      present();
    },
  };

  present();
  return {
    ...sink,
    flush,
    diagnostics() {
      const prefixes = materializer.diagnostics();
      return {
        consumers: materials.length,
        uniquePrefixes: new Set(materials.map((material) => material.surface))
          .size,
        prefixes,
      };
    },
    dispose() {
      disposed = true;
      materializer.dispose();
      for (const material of materials) {
        material.paint.style.contentVisibility = "";
        material.overlay.style.opacity = "0";
        material.output.transferFromImageBitmap(null);
        material.canvas.width = material.canvas.height = 1;
      }
    },
  };
}
