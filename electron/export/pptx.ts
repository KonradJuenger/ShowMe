import { resolveSlideTransition } from "../../src/core/slideTransitions";
import { resolveTextTypography } from "../../src/core/textTypography";
import PptxGenJS from "pptxgenjs";
import { promises as fs } from "node:fs";
import { findElement } from "../../src/core/scene";
import type { Element, Matrix } from "../../src/core/element";
import {
  IDENTITY,
  localMatrix,
  multiply,
  resolveMediaFrame,
  transformPoint,
} from "../../src/core/element";
import type {
  ExportDocument,
  ExportResult,
  ExportWarning,
} from "../../src/export/shared";

type Resolver = (id: string) => Promise<string | null>;
type IntrinsicResolver = (
  id: string,
) => Promise<{ width: number; height: number } | null>;
type ConvertWebP = (bytes: Buffer) => Buffer | null;
const color = (value: string) => value.replace("#", "");
const opacity = (value: number) => Math.round((1 - value) * 100);

export function coordinates(width: number, height: number) {
  const slideHeight = 7.5;
  const scale = slideHeight / height;
  return {
    width: width * scale,
    height: slideHeight,
    inch: (value: number) => value * scale,
    point: (value: number) => value * scale * 72,
  };
}

interface WorldPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

// PowerPoint represents orthogonal column axes (rotation with sized bounds).
// Canonical S R and nested transforms may have oblique columns: warn before approximation.
function hasObliqueAxes(world: Matrix): boolean {
  return (
    Math.abs(world[0] * world[2] + world[1] * world[3]) >
    1e-7 * Math.hypot(world[0], world[1]) * Math.hypot(world[2], world[3])
  );
}
function worldPlacement(
  frame: Element["frame"],
  world: Matrix,
): WorldPlacement {
  const center = transformPoint(world, {
    x: frame.width / 2,
    y: frame.height / 2,
  });
  const determinant = world[0] * world[3] - world[1] * world[2];
  const flipX = determinant < 0;
  const direction = flipX ? -1 : 1;
  const width = frame.width * Math.hypot(world[0], world[1]);
  const height = frame.height * Math.hypot(world[2], world[3]);
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation:
      (Math.atan2(world[1] * direction, world[0] * direction) * 180) / Math.PI,
    flipX,
    flipY: false,
  };
}

export function textOptions(
  element: Element,
  world: Matrix,
  inheritedOpacity: number,
  unit: ReturnType<typeof coordinates>,
  deck?: import("../../src/core/document").Deck,
): PptxGenJS.TextPropsOptions {
  if (element.content?.type !== "text")
    throw new Error("Text options require a text Element");
  const content = {
    ...element.content,
    ...resolveTextTypography(deck, element.content),
  };
  const box = worldPlacement(element.frame, world);
  return {
    x: unit.inch(box.x),
    y: unit.inch(box.y),
    w: unit.inch(box.width),
    h: unit.inch(box.height),
    fontFace: content.fontFamily,
    fontSize: unit.point(content.fontSize),
    bold: content.bold || content.fontWeight >= 600,
    italic: content.italic,
    color: color(content.color),
    align: content.align,
    valign: content.verticalAlign,
    lineSpacingMultiple: content.lineHeight,
    charSpacing: unit.point(content.letterSpacing),
    transparency: opacity(inheritedOpacity * element.appearance.opacity),
    rotate: box.rotation,
    flipH: box.flipX,
    flipV: box.flipY,
    margin: 0,
    breakLine: false,
    fit: "none",
  };
}

export async function createPowerPoint(
  document: ExportDocument,
  resolve: Resolver,
  resolvePoster?: Resolver,
  convertWebP?: ConvertWebP,
  resolveIntrinsic?: IntrinsicResolver,
): Promise<{ pptx: PptxGenJS; warnings: ExportWarning[] }> {
  const pptx = new PptxGenJS();
  const warnings: ExportWarning[] = [];
  const unit = coordinates(document.deck.width, document.deck.height);
  for (const id of document.deck.slideIds) {
    if (
      resolveSlideTransition(
        document.deck.slideMeta[id]?.transition,
        document.deck.transitionDefaults,
      ).kind !== "none"
    )
      warnings.push({
        slideId: id,
        code: "slide-transition-omitted",
        message:
          "PowerPoint omits the incoming ShowMe slide transition. The slide is exported in its authored static state.",
      });
  }
  pptx.defineLayout({ name: "SHOWME", width: unit.width, height: unit.height });
  pptx.layout = "SHOWME";

  if (document.deck.stylesheet)
    warnings.push({
      slideId: document.deck.slideIds[0],
      code: "custom-css",
      message:
        "PowerPoint exports structured Element styles; the custom browser stylesheet is preserved in PDF and presentation rendering.",
    });
  const byId = new Map(document.slides.map((slide) => [slide.id, slide]));

  for (const id of document.deck.slideIds) {
    const source = byId.get(id);
    if (!source) throw new Error(`Slide not found: ${id}`);
    const animated = new Set(
      source.motion?.stages.flatMap((stage) =>
        stage.tracks.map((track) => track.elementId),
      ) ?? [],
    );
    const presence = new Set(
      source.motion?.stages.flatMap((stage) =>
        (stage.blocks ?? []).flatMap((block) =>
          block.binding?.kind === "presence" ? [block.binding.elementId] : [],
        ),
      ) ?? [],
    );
    for (const elementId of animated) {
      const label = findElement(source, elementId)?.name ?? elementId;
      warnings.push({
        slideId: id,
        elementId,
        code: "motion-omitted",
        message: `${label}: PowerPoint omits ShowMe Motion. Authored static properties are exported, without sampling a playback time or click.`,
      });
    }
    for (const elementId of presence) {
      const label = findElement(source, elementId)?.name ?? elementId;
      warnings.push({
        slideId: id,
        elementId,
        code: "presence-omitted",
        message: `${label}: PowerPoint omits ShowMe Presence timing and transitions. The object is exported in its authored static state.`,
      });
    }
    const slide = pptx.addSlide();
    slide.background = { color: color(source.background) };
    slide.hidden = document.deck.slideMeta[id]?.hidden ?? false;
    if (source.notes) slide.addNotes(source.notes);
    const layers = new Map(
      document.deck.layers.map((layer) => [layer.id, layer]),
    );
    const warn = (element: Element, code: string, message: string) =>
      warnings.push({ slideId: id, elementId: element.id, code, message });

    const addMedia = async (
      element: Element,
      world: Matrix,
      inheritedOpacity: number,
    ) => {
      const content = element.content;
      if (!content || content.type === "text") return;
      const file = await resolve(content.assetId);
      if (!file) {
        warn(element, "missing-media", "Media could not be resolved");
        return;
      }
      let intrinsic: { width: number; height: number } | undefined;
      let mediaFrame = resolveMediaFrame(element);
      if (!mediaFrame && resolveIntrinsic) {
        intrinsic = (await resolveIntrinsic(content.assetId)) ?? undefined;
        mediaFrame = resolveMediaFrame(element, intrinsic);
      }
      if (!mediaFrame) {
        warn(
          element,
          "missing-intrinsic-size",
          "Media intrinsic size is unavailable; PowerPoint uses the frame bounds",
        );
        mediaFrame = {
          scaleX: 1,
          scaleY: 1,
          originX: 0.5,
          originY: 0.5,
          x: 0,
          y: 0,
          width: element.frame.width,
          height: element.frame.height,
          rotation: 0,
          flipX: false,
          flipY: false,
        };
      }
      const mediaWorld = multiply(world, localMatrix(mediaFrame));
      if (hasObliqueAxes(mediaWorld))
        warn(
          element,
          "media-transform-shear",
          "PowerPoint cannot preserve oblique media axes exactly; placement is approximated",
        );
      const mediaBox = worldPlacement(mediaFrame, mediaWorld);
      const outerBox = worldPlacement(element.frame, world);
      const effectiveOpacity =
        inheritedOpacity * element.appearance.opacity * content.opacity;
      const extension = content.filename.split(".").pop()?.toLowerCase();
      const canCrop =
        element.clipChildren &&
        mediaFrame.rotation === 0 &&
        !mediaFrame.flipX &&
        !mediaFrame.flipY &&
        mediaFrame.x <= 0 &&
        mediaFrame.y <= 0 &&
        mediaFrame.x + mediaFrame.width >= element.frame.width &&
        mediaFrame.y + mediaFrame.height >= element.frame.height;

      if (content.type === "video") {
        if (extension !== "mp4") {
          warn(element, "video-format", "Only MP4 video can be embedded");
          return;
        }
        try {
          const posterFile = await resolvePoster?.(content.assetId);
          const cover = posterFile
            ? `data:image/jpeg;base64,${(await fs.readFile(posterFile)).toString("base64")}`
            : null;
          slide.addMedia({
            type: "video",
            path: file,
            extn: "mp4",
            ...(cover ? { cover } : {}),
            x: unit.inch(canCrop ? outerBox.x : mediaBox.x),
            y: unit.inch(canCrop ? outerBox.y : mediaBox.y),
            w: unit.inch(canCrop ? outerBox.width : mediaBox.width),
            h: unit.inch(canCrop ? outerBox.height : mediaBox.height),
          });
          warn(
            element,
            "video-behavior",
            "PowerPoint does not preserve ShowMe video timing, looping, mute or autoplay behavior",
          );
          if (element.clipChildren && !canCrop)
            warn(
              element,
              "media-clipping",
              "PowerPoint cannot preserve this clipped video transform exactly",
            );
        } catch {
          warn(element, "video-error", "Video could not be embedded");
        }
        return;
      }

      try {
        const mime = (
          {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            svg: "image/svg+xml",
            webp: "image/png",
          } as Record<string, string>
        )[extension ?? ""];
        if (!mime) {
          warn(
            element,
            "image-format",
            "Image format cannot be embedded in PowerPoint",
          );
          return;
        }
        const sourceBytes = await fs.readFile(file);
        const bytes =
          extension === "webp" ? convertWebP?.(sourceBytes) : sourceBytes;
        if (!bytes) {
          warn(
            element,
            "image-format",
            "WebP image could not be converted to PNG",
          );
          return;
        }
        const options: PptxGenJS.ImageProps = {
          data: `data:${mime};base64,${bytes.toString("base64")}`,
          x: unit.inch(canCrop ? outerBox.x : mediaBox.x),
          y: unit.inch(canCrop ? outerBox.y : mediaBox.y),
          w: unit.inch(canCrop ? outerBox.width : mediaBox.width),
          h: unit.inch(canCrop ? outerBox.height : mediaBox.height),
          rotate: canCrop ? outerBox.rotation : mediaBox.rotation,
          flipH: canCrop ? outerBox.flipX : mediaBox.flipX,
          flipV: canCrop ? outerBox.flipY : mediaBox.flipY,
          transparency: opacity(effectiveOpacity),
        };
        if (canCrop) {
          options.sizing = {
            type: "crop",
            x: unit.inch(-mediaFrame.x),
            y: unit.inch(-mediaFrame.y),
            w: unit.inch(element.frame.width),
            h: unit.inch(element.frame.height),
          };
        }
        slide.addImage(options);
        if (element.clipChildren && !canCrop)
          warn(
            element,
            "media-clipping",
            "PowerPoint cannot preserve this clipped media transform exactly",
          );
        if (
          element.clipChildren &&
          (element.geometry.type === "ellipse" || element.appearance.radius > 0)
        )
          warn(
            element,
            "rounded-clipping",
            "Rounded or elliptical media clipping may differ in PowerPoint",
          );
      } catch {
        warn(element, "media-error", "Media could not be embedded");
      }
    };

    const visit = async (
      element: Element,
      parentWorld: Matrix,
      inheritedOpacity: number,
      clippedByAncestor: boolean,
    ): Promise<void> => {
      const world = multiply(parentWorld, localMatrix(element.frame));
      if (element.effects?.some((effect) => effect.enabled))
        warn(
          element,
          "custom-effect",
          "PowerPoint exports the original structured Element; custom effects are preserved in ShowMe and PDF rendering.",
        );
      if (hasObliqueAxes(world))
        warn(
          element,
          "element-transform-shear",
          "PowerPoint cannot preserve oblique Element axes exactly; placement is approximated",
        );
      const box = worldPlacement(element.frame, world);
      const effectiveOpacity = inheritedOpacity * element.appearance.opacity;
      const position = {
        x: unit.inch(box.x),
        y: unit.inch(box.y),
        w: unit.inch(box.width),
        h: unit.inch(box.height),
        rotate: box.rotation,
        flipH: box.flipX,
        flipV: box.flipY,
      };

      if (clippedByAncestor)
        warn(
          element,
          "ancestor-clipping",
          "PowerPoint cannot preserve clipping inherited from a parent Frame",
        );

      if (element.content?.type === "text") {
        slide.addText(
          element.content.text,
          textOptions(element, world, inheritedOpacity, unit, document.deck),
        );
      } else {
        const hasShape =
          Boolean(element.appearance.fill) ||
          element.appearance.strokeWidth > 0;
        if (hasShape) {
          const shape =
            element.geometry.type === "ellipse"
              ? pptx.ShapeType.ellipse
              : element.appearance.radius > 0
                ? pptx.ShapeType.roundRect
                : pptx.ShapeType.rect;
          slide.addShape(shape, {
            ...position,
            fill: element.appearance.fill
              ? {
                  color: color(element.appearance.fill),
                  transparency: opacity(effectiveOpacity),
                }
              : { color: "FFFFFF", transparency: 100 },
            line:
              element.appearance.strokeWidth > 0
                ? {
                    color: color(element.appearance.strokeColor),
                    width: unit.point(element.appearance.strokeWidth),
                    transparency: opacity(effectiveOpacity),
                  }
                : { color: "FFFFFF", transparency: 100 },
          });
        }
        if (element.content) await addMedia(element, world, inheritedOpacity);
      }

      if (element.clipChildren && element.children.length)
        warn(
          element,
          "container-clipping",
          "PowerPoint cannot clip nested Elements to a parent Frame exactly",
        );
      for (const child of element.children)
        await visit(
          child,
          world,
          effectiveOpacity,
          clippedByAncestor || element.clipChildren,
        );
    };

    for (const root of source.nodes) {
      if (layers.get(root.id)?.hidden) continue;
      for (const element of root.children)
        await visit(element, IDENTITY, 1, false);
    }
  }
  return { pptx, warnings };
}

export async function exportPowerPoint(
  document: ExportDocument,
  resolve: Resolver,
  file: string,
  resolvePoster?: Resolver,
  convertWebP?: ConvertWebP,
  resolveIntrinsic?: IntrinsicResolver,
): Promise<ExportResult> {
  const { pptx, warnings } = await createPowerPoint(
    document,
    resolve,
    resolvePoster,
    convertWebP,
    resolveIntrinsic,
  );
  await pptx.writeFile({ fileName: file });
  return { warnings };
}
