import { useLayoutEffect, useMemo, useRef } from "react";
import type { EffectDefinition, ElementEffect } from "../core/effects";
import type { Element } from "../core/element";
import type { EditorSnapshot } from "../core/editorCommands";
import { createEmptyFrame, createBasicShape } from "../core/elementFactory";
import { effectSurface, flushEffectSurfaces } from "./effectRuntime";
import { getWorldBounds } from "../core/scene";
import { SlideRenderer } from "./SlideRenderer";

/** Preview uses the production primitive renderer and the selected visual's
 * decoded resources. Without a selection, use a small representative RGBA group. */
export function ContentEffectPreview({
  definition,
  instance,
  element,
  snapshot,
  progress,
  duration,
  time,
  clocks,
  active = true,
  started = true,
  wholeSlide = false,
  viewport = { width: 280, height: 140 },
  sampleSize = { width: 280, height: 140 },
}: {
  definition: EffectDefinition;
  instance: ElementEffect;
  element: Element | null;
  snapshot: EditorSnapshot;
  progress: number;
  duration: number;
  time: number;
  clocks?: {
    presentationTime: number;
    slideTime: number;
    stepTime: number;
    stepIndex?: number;
    slideIndex?: number;
    slideCount?: number;
    slideSeed?: number;
    previousSlideIndex?: number;
    previousSlideSeed?: number;
  };
  active?: boolean;
  started?: boolean;
  wholeSlide?: boolean;
  viewport?: { width: number; height: number };
  sampleSize?: { width: number; height: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => {
    const visual = element
      ? structuredClone(element)
      : createEmptyFrame("content-preview");
    if (!element) {
      visual.frame.width = sampleSize.width;
      visual.frame.height = sampleSize.height;
      visual.appearance.fill = "#245684";
      const shape = createBasicShape("preview-shape", "ellipse", {
        x: 15,
        y: 15,
      });
      shape.frame.width = shape.frame.height = 80;
      shape.appearance.fill = "#ffbc53";
      const label = createBasicShape("preview-label", "rectangle", {
        x: 110,
        y: 30,
      });
      label.frame.width = 160;
      label.frame.height = 90;
      label.appearance.fill = null;
      label.content = {
        type: "text",
        text: "ShowMe\nPixels",
        placeholder: false,
        format: {
          kind: "local",
          typography: {
            fontFamily: "sans-serif",
            fontWeight: 700,
            fontSize: 26,
            bold: true,
            italic: false,
            color: "#ffffff",
            align: "left",
            verticalAlign: "middle",
            lineHeight: 1.2,
            letterSpacing: 0,
          },
        },
        autoSize: "none",
      };
      visual.children = [shape, label];
    }
    if (definition.input === "backdrop") {
      const previewEffect = {
        ...instance,
        resourceId: "content-preview-effect",
      };
      const slide = structuredClone(snapshot.slide);
      slide.motion = undefined;
      slide.effectResources = {
        ...slide.effectResources,
        "content-preview-effect": definition,
      };
      if (wholeSlide) {
        const lens = createEmptyFrame("studio-slide-lens", { x: 0, y: 0 });
        lens.frame.width = snapshot.deck.width;
        lens.frame.height = snapshot.deck.height;
        lens.effects = [previewEffect];
        slide.nodes.at(-1)!.children.push(lens);
        return {
          slide,
          deck: snapshot.deck,
          scale: Math.min(
            viewport.width / snapshot.deck.width,
            viewport.height / snapshot.deck.height,
          ),
          x: 0,
          y: 0,
        };
      }
      if (element) {
        const replace = (children: Element[]) => {
          for (const child of children) {
            if (child.id === element.id) child.effects = [previewEffect];
            else replace(child.children);
          }
        };
        slide.nodes.forEach((layer) => replace(layer.children));
        const bounds = getWorldBounds(slide, element.id);
        return {
          slide,
          deck: snapshot.deck,
          scale: Math.min(
            viewport.width / bounds.width,
            viewport.height / bounds.height,
          ),
          x: bounds.x,
          y: bounds.y,
        };
      }
      const lens = createEmptyFrame("backdrop-preview");
      lens.frame.width = visual.frame.width;
      lens.frame.height = visual.frame.height;
      lens.effects = [previewEffect];
      visual.effects = [];
      slide.nodes = [{ ...slide.nodes[0], children: [visual, lens] }];
      return {
        slide,
        deck: snapshot.deck,
        scale: Math.min(
          viewport.width / sampleSize.width,
          viewport.height / sampleSize.height,
        ),
        x: 0,
        y: 0,
      };
    }
    visual.frame = {
      ...visual.frame,
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      flipX: false,
      flipY: false,
    };
    visual.effects = [instance];
    const slide = {
      ...snapshot.slide,
      motion: undefined,
      background: "transparent",
      effectResources: {
        ...snapshot.slide.effectResources,
        "content-preview-effect": definition,
      },
      nodes: [
        {
          ...snapshot.slide.nodes[0],
          children: [
            {
              ...visual,
              effects: [{ ...instance, resourceId: "content-preview-effect" }],
            },
          ],
        },
      ],
    };
    const deck = snapshot.deck;
    return {
      slide,
      deck,
      scale: Math.min(
        viewport.width / visual.frame.width,
        viewport.height / visual.frame.height,
      ),
      x: 0,
      y: 0,
    };
  }, [
    definition,
    instance,
    element,
    snapshot.slide,
    snapshot.deck,
    wholeSlide,
    viewport.width,
    viewport.height,
    sampleSize.width,
    sampleSize.height,
  ]);
  useLayoutEffect(() => {
    const node = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-effect-id]") ?? [],
    ).find((node) => node.dataset.effectId === instance.id);
    if (node) {
      const surface = effectSurface(node);
      surface?.setTiming({
        progress,
        time,
        duration: duration / 1000,
        ...clocks,
        active,
        started,
      });
      void flushEffectSurfaces(root.current!);
    }
  }, [preview, progress, duration, time, clocks, active, started, instance.id]);
  return (
    <div
      ref={root}
      style={{
        transform: `scale(${preview.scale})`,
        transformOrigin: "top left",
      }}
    >
      <div style={{ transform: `translate(${-preview.x}px, ${-preview.y}px)` }}>
        <SlideRenderer
          slide={preview.slide}
          deck={preview.deck}
          staticVideo
          renderScale={preview.scale}
        />
      </div>
    </div>
  );
}
