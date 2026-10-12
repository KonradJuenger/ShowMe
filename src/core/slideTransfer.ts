import { textStyleSchema, type TextStyle } from "./textTypography";
import {
  collectReferencedTextStyles,
  importTextStyles,
  remapTextStyles,
  validateTextStyleReferences,
} from "./textStyles";
import { resolveVisualSlide } from "./templates";
import { resolveSlideTransition } from "./slideTransitions";
import { cloneMotion } from "./motion";
import { z } from "zod";
import { hashSchema } from "./assets";
import { idSchema, uid } from "./ids";
import { slideMetaSchema } from "./slideMetadata";
import { layerSchema, slideSchema, type Deck, type Slide } from "./document";
import { walkElements } from "./element";
import { cloneSubtree } from "./scene";

export const SLIDE_TRANSFER_FORMAT = "showme-slide-transfer" as const;
export const SLIDE_TRANSFER_VERSION = 1 as const;
export const SLIDE_TRANSFER_MIME = "application/x-showme-slide-transfer";
export const SLIDE_TRANSFER_FILE_EXTENSION = ".showme-slide-transfer";

const transferEntrySchema = z
  .object({
    slide: slideSchema,
    resolvedSlide: slideSchema,
    meta: slideMetaSchema,
  })
  .strict();

const transferAssetSchema = z
  .object({
    id: hashSchema,
    filename: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[^/\\]+$/),
  })
  .strict();

const transferBundleObject = z
  .object({
    format: z.literal(SLIDE_TRANSFER_FORMAT),
    version: z.literal(SLIDE_TRANSFER_VERSION),
    source: z
      .object({
        documentId: idSchema,
        textStyles: z.array(textStyleSchema).max(10000),
        layers: z.array(layerSchema).min(1).max(10000),
      })
      .strict(),
    slides: z.array(transferEntrySchema).min(1).max(10000),
    assets: z.array(transferAssetSchema).max(100000),
  })
  .strict();

export function collectSlideAssets(
  slide: Slide,
): Array<{ id: string; filename: string }> {
  const output = new Map<string, { id: string; filename: string }>();
  for (const element of walkElements(
    slide.nodes.flatMap((root) => root.children),
  )) {
    if (
      element.content &&
      "assetId" in element.content &&
      !output.has(element.content.assetId)
    )
      output.set(element.content.assetId, {
        id: element.content.assetId,
        filename: element.content.filename,
      });
  }
  return [...output.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function collectSlideAssetIds(slide: Slide): string[] {
  return collectSlideAssets(slide).map(({ id }) => id);
}

function transferAssets(
  slides: readonly { slide: Slide }[],
): Array<{ id: string; filename: string }> {
  const output = new Map<string, { id: string; filename: string }>();
  for (const { slide } of slides)
    for (const asset of collectSlideAssets(slide))
      if (!output.has(asset.id)) output.set(asset.id, asset);
  return [...output.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

const currentSlideTransferBundleSchema = transferBundleObject.superRefine(
  (bundle, context) => {
    try {
      validateTextStyleReferences(
        bundle.source.textStyles,
        bundle.slides.flatMap((e) =>
          [...e.slide.nodes, ...e.resolvedSlide.nodes].flatMap(
            (r) => r.children,
          ),
        ),
      );
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });
    }
    const slideIds = bundle.slides.map((entry) => entry.slide.id);
    if (new Set(slideIds).size !== slideIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate slide IDs in transfer bundle",
        path: ["slides"],
      });

    const declaredIds = bundle.assets.map(({ id }) => id);
    if (new Set(declaredIds).size !== declaredIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate asset IDs in transfer bundle",
        path: ["assets"],
      });

    const actual = transferAssets(
      bundle.slides.map((entry) => ({ slide: entry.resolvedSlide })),
    );
    const declared = [...bundle.assets].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (
      actual.length !== declared.length ||
      actual.some(
        (asset, index) =>
          asset.id !== declared[index]?.id ||
          asset.filename !== declared[index]?.filename,
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Transfer asset manifest does not match slide contents",
        path: ["assets"],
      });
  },
);

export const slideTransferBundleSchema = currentSlideTransferBundleSchema;

export type SlideTransferBundle = z.infer<typeof slideTransferBundleSchema>;

export function parseSlideTransferBundle(input: unknown): SlideTransferBundle {
  return slideTransferBundleSchema.parse(input);
}

export interface PreparedSlideTransferImport {
  textStyles: TextStyle[];
  layers: Deck["layers"];
  slides: Slide[];
  slideMeta: Record<string, Deck["slideMeta"][string]>;
  importedSlideIds: string[];
  assetIds: string[];
}

export function createSlideTransferBundle(
  documentId: string,
  deck: Deck,
  slides: readonly Slide[],
  templates: Readonly<Record<string, import("./document").TemplatePage>> = {},
): SlideTransferBundle {
  if (deck.id !== documentId)
    throw new Error("Transfer source document does not match the deck");

  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  const ordered = deck.slideIds
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id)!);
  if (
    ordered.length !== slides.length ||
    new Set(slides.map(({ id }) => id)).size !== slides.length
  )
    throw new Error(
      "Transfer contains slides that are not uniquely present in the source deck",
    );

  const entries = ordered.map((slide) => ({
    slide: structuredClone(slide),
    resolvedSlide: structuredClone(
      resolveVisualSlide(deck, slide, templates).slide,
    ),
    meta: {
      ...structuredClone(deck.slideMeta[slide.id]),
      transition: resolveSlideTransition(
        deck.slideMeta[slide.id].transition,
        deck.transitionDefaults,
      ),
    },
  }));
  return slideTransferBundleSchema.parse({
    format: SLIDE_TRANSFER_FORMAT,
    version: SLIDE_TRANSFER_VERSION,
    source: {
      documentId,
      textStyles: collectReferencedTextStyles(
        deck,
        entries.flatMap((e) =>
          [...e.slide.nodes, ...e.resolvedSlide.nodes].flatMap(
            (r) => r.children,
          ),
        ),
      ),
      layers: structuredClone(deck.layers),
    },
    slides: entries,
    assets: transferAssets(
      entries.map((entry) => ({ slide: entry.resolvedSlide })),
    ),
  });
}

export function prepareSlideTransferImport(
  input: unknown,
  destinationDeck: Deck,
  newId: () => string = uid,
): PreparedSlideTransferImport {
  const bundle = parseSlideTransferBundle(input);
  const importedStyles = importTextStyles(
    destinationDeck,
    bundle.source.textStyles,
    newId,
    bundle.source.documentId === destinationDeck.id,
  );
  for (const entry of bundle.slides) {
    remapTextStyles(
      entry.slide.nodes.flatMap((r) => r.children),
      importedStyles.remap,
    );
    remapTextStyles(
      entry.resolvedSlide.nodes.flatMap((r) => r.children),
      importedStyles.remap,
    );
  }
  const layers = structuredClone(destinationDeck.layers);
  const usedLayerIds = new Set<string>();
  const layerIdMap = new Map<string, string>();

  for (const sourceLayer of bundle.source.layers) {
    let destination =
      bundle.source.documentId === destinationDeck.id
        ? layers.find((layer) => layer.id === sourceLayer.id)
        : undefined;
    destination ??= layers.find(
      (layer) => !usedLayerIds.has(layer.id) && layer.name === sourceLayer.name,
    );
    if (!destination) {
      destination = { ...structuredClone(sourceLayer), id: newId() };
      layers.push(destination);
    }
    usedLayerIds.add(destination.id);
    layerIdMap.set(sourceLayer.id, destination.id);
  }

  const sourceToImported = new Map(
    bundle.slides.map(({ slide }) => [slide.id, newId()]),
  );
  const sourceLayerForDestination = new Map(
    [...layerIdMap].map(([sourceId, destinationId]) => [
      destinationId,
      sourceId,
    ]),
  );
  const slideMeta: Record<string, Deck["slideMeta"][string]> = {};
  const slides = bundle.slides.map(({ slide: local, resolvedSlide, meta }) => {
    const source =
      bundle.source.documentId === destinationDeck.id ? local : resolvedSlide;
    const id = sourceToImported.get(source.id)!;
    const roots = new Map(source.nodes.map((root) => [root.id, root]));
    const elementMap = new Map<string, string>();
    const clonedRoots = new Map(
      source.nodes.map((root) => {
        const before = walkElements(root.children);
        let cursor = 0;
        const children = root.children.map((element) =>
          cloneSubtree(element, () => {
            const id = newId();
            elementMap.set(before[cursor++].id, id);
            return id;
          }),
        );
        return [root.id, children] as const;
      }),
    );
    const motion = cloneMotion(source.motion, elementMap, newId);
    const slide = slideSchema.parse({
      ...structuredClone(source),
      id,
      ...(motion ? { motion } : {}),
      nodes: layers.map((layer) => {
        const sourceLayerId = sourceLayerForDestination.get(layer.id);
        const sourceRoot = sourceLayerId ? roots.get(sourceLayerId) : undefined;
        return {
          type: "layer" as const,
          id: layer.id,
          children: sourceRoot ? (clonedRoots.get(sourceRoot.id) ?? []) : [],
        };
      }),
    });
    slideMeta[id] = {
      ...structuredClone(meta),
      templateId:
        bundle.source.documentId === destinationDeck.id
          ? meta.templateId
          : null,
      section: meta.section ? (sourceToImported.get(meta.section) ?? "") : "",
    };
    return slide;
  });

  return {
    textStyles: importedStyles.textStyles,
    layers,
    slides,
    slideMeta,
    importedSlideIds: slides.map(({ id }) => id),
    assetIds: bundle.assets.map(({ id }) => id),
  };
}
