import { makeIndependent } from "./templateCommands";
import type { Asset } from "./assets";
import {
  createSlide,
  insertElements,
  setSlideBackground,
  setSlideNotes,
  setDeckProperties,
  updateSlideMeta,
  type EditorSnapshot,
} from "./editorCommands";
import { walkElements } from "./element";
import { createMediaElement } from "./media";
import { uid } from "./ids";
import type { ImportedPowerPointSlide } from "./powerpointImport";

export function createPowerPointSlides(
  snapshot: EditorSnapshot,
  imported: ImportedPowerPointSlide[],
  assets: Asset[],
  insertionAfter = snapshot.slide.id,
  fillInitialSlide = false,
) {
  if (!imported.length)
    throw new Error("PowerPoint presentation has no slides");
  if (
    assets.length !==
    imported.reduce((count, slide) => count + slide.media.length, 0)
  )
    throw new Error("Could not import all media from the PowerPoint file");
  let next = fillInitialSlide
    ? setDeckProperties(snapshot, {
        width: imported[0].width,
        height: imported[0].height,
      })
    : snapshot;
  let afterId = insertionAfter;
  let imageIndex = 0;
  for (const source of imported) {
    const elements = structuredClone(source.elements);
    const byId = new Map(
      walkElements(elements).map((element) => [element.id, element]),
    );
    for (const image of source.media) {
      const element = byId.get(image.elementId);
      if (!element) throw new Error("Imported media element is missing");
      const media = createMediaElement(element.id, assets[imageIndex++]);
      const content = media.content;
      if (!content || content.type === "text")
        throw new Error("Could not create imported media");
      const cropWidth = 1 - image.crop.left - image.crop.right;
      const cropHeight = 1 - image.crop.top - image.crop.bottom;
      const width = element.frame.width / cropWidth;
      const height = element.frame.height / cropHeight;
      element.content = {
        ...content,
        lockAspect: false,
        transform: {
          rule: "free",
          local: {
            ...media.frame,
            x: image.crop.left ? -image.crop.left * width : 0,
            y: image.crop.top ? -image.crop.top * height : 0,
            width,
            height,
          },
        },
      };
    }
    if (fillInitialSlide && source === imported[0]) {
      if (snapshot.slide.nodes.some((root) => root.children.length))
        throw new Error("PowerPoint import requires an empty initial slide");
      next = makeIndependent(next);
      next = setSlideBackground(next, source.background);
      next = setSlideNotes(next, source.notes);
      next = updateSlideMeta(next, snapshot.slide.id, {
        name: source.name.slice(0, 200),
      });
      next = insertElements(next, elements, snapshot.deck.layers[0].id);
      afterId = snapshot.slide.id;
      continue;
    }
    const slide = {
      version: snapshot.slide.version,
      id: uid(),
      background: source.background,
      notes: source.notes,
      nodes: snapshot.deck.layers.map((layer, index) => ({
        type: "layer" as const,
        id: layer.id,
        children: index === 0 ? elements : [],
      })),
    };
    next = createSlide(
      next,
      slide,
      {
        templateId: null,
        name: source.name.slice(0, 200),
        section: "",
        hidden: false,
      },
      afterId,
    );
    afterId = slide.id;
  }
  return { snapshot: next, lastSlideId: afterId };
}
