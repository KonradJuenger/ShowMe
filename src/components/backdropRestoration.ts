import type { RestorationPlan } from "./compositionBackendPlan";
import type { Deck } from "../core/document";
import type { MotionRenderSink, MotionVisualSample } from "./motionRuntime";
import type { RenderDensity } from "../core/renderProfile";
import type { SceneSurfaceRef } from "./compositionPlan";
import type {
  MaterializedSurface,
  SceneSurfaceMaterializer,
  SurfaceRegion,
} from "./compositionSurface";

type Material = {
  id: string;
  surface: SceneSurfaceRef;
  owner: HTMLElement;
  paint: HTMLElement;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  output: CanvasRenderingContext2D;
  sample: MotionVisualSample;
  crop: SurfaceRegion;
  sourceRevision: number;
  populated: boolean;
};

/** Restores B over the native material R at 1-alpha. It consumes semantic
 * frames; it neither samples Motion nor reads animated values from the DOM.
 * Backdrop pixels come only from the scene-scoped materializer. This module
 * intentionally knows nothing about image transforms, shader canvases, source
 * invalidation or shape rasterization. */
export function mountBackdropRestoration(
  root: HTMLElement,
  plan: RestorationPlan,
  deck: Deck,
  failed: (ids: readonly string[], error: unknown) => void,
  density: Pick<RenderDensity, "x" | "y">,
  materializer: SceneSurfaceMaterializer,
) {
  let disposed = false;
  let inFlight: Promise<boolean> | undefined;
  let scheduled = false;
  let rerun = false;
  const failedSurfaces = new Set<string>();
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
    const output = canvas?.getContext("2d");
    const surface = plan.surfaces.get(id);
    if (!paint || !overlay || !canvas || !output || !surface)
      throw new Error("Renderer restoration output is unavailable");
    const element = plan.plan.groups.get(id)!.element;
    return {
      id,
      surface,
      owner,
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
      const { sample, crop, overlay, paint, populated, owner } = material;
      const rejected = failedSurfaces.has(material.surface.id);
      if (rejected) {
        set(paint, "contentVisibility", "");
        set(overlay, "opacity", "0");
        set(overlay, "visibility", "hidden");
        set(owner, "opacity", String(sample.opacity));
        continue;
      }
      set(owner, "opacity", "1");
      const restoring = sample.present && sample.opacity < 1;
      set(paint, "contentVisibility", restoring && !populated ? "hidden" : "");
      set(overlay, "visibility", sample.present ? "visible" : "hidden");
      set(
        overlay,
        "opacity",
        restoring && populated ? String(1 - sample.opacity) : "0",
      );
      if (restoring) {
        const { frame } = sample;
        const pad = plan.padding;
        set(
          overlay,
          "clipPath",
          "inset(" +
            (frame.y - crop.y - pad) +
            "px " +
            (crop.x + crop.width - frame.x - frame.width - pad) +
            "px " +
            (crop.y + crop.height - frame.y - frame.height - pad) +
            "px " +
            (frame.x - crop.x - pad) +
            "px)",
        );
      }
    }
  };

  const rejectSurface = (surface: SceneSurfaceRef, error: unknown) => {
    if (disposed || failedSurfaces.has(surface.id)) return;
    failedSurfaces.add(surface.id);
    const ids = materials
      .filter((material) => material.surface.id === surface.id)
      .map((material) => material.id);
    for (const material of materials) {
      if (material.surface.id !== surface.id) continue;
      material.populated = false;
      material.overlay.style.opacity = "0";
      material.paint.style.contentVisibility = "";
    }
    failed(ids, error);
    present();
  };

  const requestRender = () => {
    if (disposed) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) void flush();
    });
  };

  const unsubscribe = materializer.subscribeInvalidation(requestRender);

  const regionFor = (surface: SceneSurfaceRef): SurfaceRegion => {
    const entries = materials.filter(
      (material) =>
        material.surface.id === surface.id &&
        !failedSurfaces.has(material.surface.id),
    );
    if (!entries.length)
      return { x: 0, y: 0, width: deck.width, height: deck.height };
    const left = Math.max(
      0,
      Math.min(
        ...entries.map(
          (material) => plan.envelopes.get(material.id)!.left - plan.padding,
        ),
      ),
    );
    const top = Math.max(
      0,
      Math.min(
        ...entries.map(
          (material) => plan.envelopes.get(material.id)!.top - plan.padding,
        ),
      ),
    );
    const right = Math.min(
      deck.width,
      Math.max(
        ...entries.map(
          (material) => plan.envelopes.get(material.id)!.right + plan.padding,
        ),
      ),
    );
    const bottom = Math.min(
      deck.height,
      Math.max(
        ...entries.map(
          (material) => plan.envelopes.get(material.id)!.bottom + plan.padding,
        ),
      ),
    );
    if (right <= left || bottom <= top)
      throw new Error("Restoration region is outside the output");
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const cropFor = (
    material: Material,
    source: MaterializedSurface,
  ) => {
    if (source.source.kind !== "canvas-image")
      throw new Error("Restoration requires a canvas-readable scene surface");
    const bounds = plan.envelopes.get(material.id)!;
    const p = plan.padding;
    const logical = source.logicalBounds;
    const sx = source.density.x;
    const sy = source.density.y;
    const x = Math.max(
      0,
      Math.floor((Math.max(logical.x, bounds.left - p) - logical.x) * sx),
    );
    const y = Math.max(
      0,
      Math.floor((Math.max(logical.y, bounds.top - p) - logical.y) * sy),
    );
    const right = Math.min(
      source.pixelSize.width,
      Math.ceil(
        (Math.min(logical.x + logical.width, bounds.right + p) - logical.x) *
          sx,
      ),
    );
    const bottom = Math.min(
      source.pixelSize.height,
      Math.ceil(
        (Math.min(logical.y + logical.height, bounds.bottom + p) - logical.y) *
          sy,
      ),
    );
    if (right <= x || bottom <= y)
      throw new Error("Restoration crop is outside the materialized surface");
    return {
      x,
      y,
      width: right - x,
      height: bottom - y,
      logical: {
        x: logical.x + x / sx,
        y: logical.y + y / sy,
        width: (right - x) / sx,
        height: (bottom - y) / sy,
      },
    };
  };

  const render = async () => {
    if (disposed) return false;
    let complete = true;
    const exactSurfaces = new Map<string, SceneSurfaceRef>();
    for (const material of materials)
      if (!failedSurfaces.has(material.surface.id))
        exactSurfaces.set(material.surface.id, material.surface);

    const resolved = new Map<string, MaterializedSurface>();
    for (const surface of exactSurfaces.values()) {
      try {
        const materialized = await materializer.materialize({
          surface,
          region: regionFor(surface),
          density,
          irrelevantElementIds: plan.irrelevantConsumers,
        });
        resolved.set(surface.id, materialized);
      } catch (error) {
        complete = false;
        rejectSurface(surface, error);
      }
    }
    if (disposed) return false;

    for (const material of materials) {
      if (failedSurfaces.has(material.surface.id)) continue;
      const source = resolved.get(material.surface.id);
      if (!source) continue;
      if (material.populated && material.sourceRevision === source.revision)
        continue;
      try {
        const crop = cropFor(material, source);
        if (
          (source.pixelSize.width * source.pixelSize.height +
            2 * crop.width * crop.height) *
            4 >
          256 * 1024 * 1024
        )
          throw new Error("Backdrop restoration exceeds its surface budget");
        if (material.canvas.width !== crop.width)
          material.canvas.width = crop.width;
        if (material.canvas.height !== crop.height)
          material.canvas.height = crop.height;
        material.output.clearRect(0, 0, crop.width, crop.height);
        if (source.source.kind !== "canvas-image")
          throw new Error(
            "Restoration requires a canvas-readable scene surface",
          );
        material.output.drawImage(
          source.source.value,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          crop.width,
          crop.height,
        );
        material.crop = crop.logical;
        for (const [property, value] of [
          ["left", crop.logical.x],
          ["top", crop.logical.y],
          ["width", crop.logical.width],
          ["height", crop.logical.height],
        ] as const)
          set(material.overlay, property, String(value) + "px");
        material.sourceRevision = source.revision;
        material.populated = true;
      } catch (error) {
        complete = false;
        rejectSurface(material.surface, error);
      }
    }

    if (!disposed) present();
    return !disposed && complete;
  };

  function flush() {
    if (inFlight) return inFlight;
    inFlight = render()
      .catch((error) => {
        console.error("Backdrop restoration failed", error);
        return false;
      })
      .finally(() => {
        inFlight = undefined;
        if (rerun && !disposed) {
          rerun = false;
          requestRender();
        }
      });
    return inFlight;
  }

  const sink: MotionRenderSink = {
    ownsOpacity(id) {
      return materials.some(
        (material) =>
          material.id === id && !failedSurfaces.has(material.surface.id),
      );
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
      return {
        consumers: materials.length,
        uniquePrefixes: new Set(materials.map((material) => material.surface.id))
          .size,
        prefixes: materializer.diagnostics(),
      };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const material of materials) {
        material.paint.style.contentVisibility = "";
        material.overlay.style.opacity = "0";
        material.output.clearRect(
          0,
          0,
          material.canvas.width,
          material.canvas.height,
        );
        material.canvas.width = material.canvas.height = 1;
      }
    },
  };
}
