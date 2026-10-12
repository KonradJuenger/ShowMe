import {
  defaultTextStyles,
  textStyleSchema,
  textStyleNameKey,
} from "./textTypography";
import { slideMotionSchema, validateMotionTargets } from "./motionModel";
import { z } from "zod";
import { idSchema, uid } from "./ids";
import { slideMetaSchema } from "./slideMetadata";
import { guideSetSchema } from "./guideModel";
import { elementSchema, validateElementForest, walkElements } from "./element";
import { effectResourcesSchema, validateEffects } from "./effects";
import {
  DEFAULT_TRANSITION,
  transitionDefaultsSchema,
} from "./slideTransitions";

/** Canonical persisted document schema for the production editor. */
export const DOCUMENT_VERSION = 1 as const;
export const PRESENTATION_FILE_VERSION = 1 as const;
export const canvasDimensionSchema = z.number().finite().positive();

export const layerRootSchema = z
  .object({
    type: z.literal("layer"),
    id: idSchema,
    children: z.array(elementSchema).max(10000),
  })
  .strict();
export type LayerRoot = z.infer<typeof layerRootSchema>;

const visualPageShape = {
  version: z.literal(DOCUMENT_VERSION),
  id: idSchema,
  background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  effectResources: effectResourcesSchema.optional(),
  nodes: z.array(layerRootSchema).min(1).max(10000),
};

const visualPageSchema = z.object(visualPageShape).strict();
export type VisualPage = z.infer<typeof visualPageSchema>;
function validateVisualPage(slide: VisualPage, context: z.RefinementCtx) {
  try {
    validateElementForest(slide.nodes.flatMap((root) => root.children));
    const elements = walkElements(slide.nodes.flatMap((root) => root.children));
    validateEffects(elements, slide.effectResources);

    const rootIds = new Set(slide.nodes.map((root) => root.id));
    if (
      rootIds.size !== slide.nodes.length ||
      walkElements(slide.nodes.flatMap((root) => root.children)).some(
        (element) => rootIds.has(element.id),
      )
    )
      throw new Error("Layer root IDs must be distinct from Element IDs");
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });
  }
}
export const templatePageSchema =
  visualPageSchema.superRefine(validateVisualPage);
export type TemplatePage = z.infer<typeof templatePageSchema>;
const currentSlideSchema = z
  .object({
    ...visualPageShape,
    notes: z.string().max(100000),
    motion: slideMotionSchema.optional(),
  })
  .strict()
  .superRefine((slide, context) => {
    validateVisualPage(slide, context);
    try {
      if (slide.motion)
        validateMotionTargets(
          slide.motion,
          walkElements(slide.nodes.flatMap((r) => r.children)),
          slide.effectResources,
        );
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });
    }
  });
export const slideSchema = currentSlideSchema;
export type Slide = z.infer<typeof slideSchema>;

export const layerSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(200),
    hidden: z.boolean(),
    locked: z.boolean(),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  })
  .strict();

export const deckSchema = z
  .object({
    version: z.literal(DOCUMENT_VERSION),
    id: idSchema,
    name: z.string().min(1).max(200),
    textStyles: z.array(textStyleSchema).min(2).max(10000),
    stylesheet: z.string().max(100000).optional(),
    width: canvasDimensionSchema,
    height: canvasDimensionSchema,
    transitionDefaults: transitionDefaultsSchema,
    slideIds: z.array(idSchema).min(1).max(10000),
    slideMeta: z.record(idSchema, slideMetaSchema),
    templateIds: z.array(idSchema).min(1).max(10000),
    templateMeta: z.record(
      idSchema,
      z
        .object({
          label: z
            .string()
            .max(8)
            .regex(/^[A-Z]+$/),
        })
        .strict(),
    ),
    defaultTemplateId: idSchema,
    guideSets: z.record(idSchema, guideSetSchema),
    defaultGuideSetId: idSchema.nullable(),
    layers: z.array(layerSchema).min(1).max(10000),
  })
  .strict()
  .superRefine((deck, context) => {
    if (
      new Set(deck.textStyles.map((s) => s.id)).size !==
        deck.textStyles.length ||
      new Set(deck.textStyles.map((s) => textStyleNameKey(s.name))).size !==
        deck.textStyles.length ||
      deck.textStyles.filter((s) => s.defaultKind === "heading").length !== 1 ||
      deck.textStyles.filter((s) => s.defaultKind === "text").length !== 1 ||
      deck.textStyles.some(
        (s) =>
          (s.defaultKind === "heading" && s.name !== "Heading") ||
          (s.defaultKind === "text" && s.name !== "Text"),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid default Text Styles or duplicate IDs/names",
      });
    if (
      new Set(deck.templateIds).size !== deck.templateIds.length ||
      !deck.templateIds.includes(deck.defaultTemplateId) ||
      deck.templateMeta[deck.defaultTemplateId]?.label !== "A" ||
      Object.keys(deck.templateMeta).length !== deck.templateIds.length ||
      deck.templateIds.some(
        (id) => !deck.templateMeta[id] || deck.slideIds.includes(id),
      ) ||
      new Set(Object.values(deck.templateMeta).map((meta) => meta.label))
        .size !== deck.templateIds.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid template metadata",
      });
    if (
      Object.values(deck.slideMeta).some(
        (meta) =>
          meta.templateId !== null &&
          !deck.templateIds.includes(meta.templateId),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dangling template reference",
      });
    if (new Set(deck.slideIds).size !== deck.slideIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate slide IDs",
      });
    if (
      new Set(deck.layers.map((layer) => layer.id)).size !== deck.layers.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate Layer IDs",
      });
    if (deck.slideIds.some((id) => !deck.slideMeta[id]))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Missing slide metadata",
      });
    if (Object.entries(deck.guideSets).some(([id, guide]) => guide.id !== id))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Guide set key mismatch",
      });
    if (deck.defaultGuideSetId && !deck.guideSets[deck.defaultGuideSetId])
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dangling guide set",
      });
  });
export type Deck = z.infer<typeof deckSchema>;

const currentPresentationDocumentSchema = z
  .object({
    kind: z.literal("showme-presentation"),
    version: z.literal(PRESENTATION_FILE_VERSION),
    documentId: idSchema,
    deck: deckSchema,
    slides: z.record(idSchema, slideSchema),
    templates: z.record(idSchema, templatePageSchema),
    recovery: z
      .object({
        originalPath: z.string().nullable(),
        documentId: idSchema,
        originalRevision: z.string().nullable(),
        originalLastSavedAt: z.string().datetime().nullable(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PresentationDocument = z.infer<
  typeof currentPresentationDocumentSchema
>;
export const presentationDocumentSchema =
  currentPresentationDocumentSchema.superRefine((document, context) =>
    validatePresentationReferences(document, context),
  );

/** Cross-page invariants shared by full boundary and scoped transaction validation. */
export function validatePresentationReferences(
  document: PresentationDocument,
  context: z.RefinementCtx,
  pageIds?: readonly string[],
) {
  const slideIds = pageIds
    ? pageIds.filter((id) => !!document.slides[id])
    : document.deck.slideIds;
  const templateIds = pageIds
    ? pageIds.filter((id) => !!document.templates[id])
    : document.deck.templateIds;

  if (document.deck.id !== document.documentId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Deck ID mismatch",
    });
  if (document.recovery && document.recovery.documentId !== document.documentId)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery document ID mismatch",
    });
  const styleIds = new Set(document.deck.textStyles.map((s) => s.id));
  for (const page of [
    ...slideIds.map((id) => document.slides[id]),
    ...templateIds.map((id) => document.templates[id]),
  ])
    for (const element of walkElements(
      page?.nodes.flatMap((r) => r.children) ?? [],
    ))
      if (
        element.content?.type === "text" &&
        element.content.format.kind === "style" &&
        !styleIds.has(element.content.format.styleId)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Dangling Text Style reference",
        });
  const layerIds = document.deck.layers.map((layer) => layer.id);
  if (!pageIds) {
    if (
      Object.keys(document.deck.slideMeta).length !==
      document.deck.slideIds.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unlisted slide metadata",
      });
    if (Object.keys(document.slides).length !== document.deck.slideIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unlisted slide",
      });
    if (
      Object.keys(document.templates).length !==
      document.deck.templateIds.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unlisted template",
      });
  }
  for (const id of templateIds) {
    const page = document.templates[id];
    if (
      !page ||
      page.id !== id ||
      page.nodes.length !== layerIds.length ||
      page.nodes.some((root, index) => root.id !== layerIds[index])
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid template " + id,
      });
  }
  for (const slideId of slideIds) {
    const slide = document.slides[slideId];
    if (!slide || slide.id !== slideId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing slide ${slideId}`,
      });
      continue;
    }
    const templateId = document.deck.slideMeta[slideId]?.templateId;
    const template = templateId ? document.templates[templateId] : undefined;
    if (template) {
      const localIds = new Set(
        walkElements(slide.nodes.flatMap((root) => root.children)).map(
          (element) => element.id,
        ),
      );
      if (
        walkElements(template.nodes.flatMap((root) => root.children)).some(
          (element) => localIds.has(element.id),
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ambiguous resolved Element identity",
        });
      const requiredResources = new Set(
        walkElements(template.nodes.flatMap((root) => root.children)).flatMap(
          (element) =>
            (element.effects ?? []).map((effect) => effect.resourceId),
        ),
      );
      for (const [id, definition] of Object.entries(
        template.effectResources ?? {},
      ).filter(([id]) => requiredResources.has(id)))
        if (
          slide.effectResources?.[id] &&
          JSON.stringify(slide.effectResources[id]) !==
            JSON.stringify(definition)
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Conflicting resolved effect resource",
          });
    }
    if (
      slide.nodes.length !== layerIds.length ||
      slide.nodes.some((root, index) => root.id !== layerIds[index])
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Layer roots mismatch on slide ${slideId}`,
      });
  }
}

export function forkPresentationDocument(
  document: PresentationDocument,
): PresentationDocument {
  const documentId = uid();
  const clone = structuredClone(document);
  delete clone.recovery;
  return presentationDocumentSchema.parse({
    ...clone,
    documentId,
    deck: { ...clone.deck, id: documentId },
  });
}

export function newPresentationDocument(name: string): PresentationDocument {
  const documentId = uid(),
    slideId = uid(),
    layerId = uid(),
    templateId = uid();
  return presentationDocumentSchema.parse({
    kind: "showme-presentation",
    version: PRESENTATION_FILE_VERSION,
    documentId,
    deck: {
      version: DOCUMENT_VERSION,
      id: documentId,
      name: name.trim() || "Untitled",
      textStyles: defaultTextStyles(),
      width: 1920,
      height: 1080,
      transitionDefaults: DEFAULT_TRANSITION,
      slideIds: [slideId],
      templateIds: [templateId],
      templateMeta: { [templateId]: { label: "A" } },
      defaultTemplateId: templateId,
      slideMeta: {
        [slideId]: { name: "Slide 1", section: "", hidden: false, templateId },
      },
      guideSets: {},
      defaultGuideSetId: null,
      layers: [
        {
          id: layerId,
          name: "Layer 1",
          hidden: false,
          locked: false,
          color: "#858f9c",
        },
      ],
    },
    templates: {
      [templateId]: {
        version: DOCUMENT_VERSION,
        id: templateId,
        background: "#ffffff",
        nodes: [{ type: "layer", id: layerId, children: [] }],
      },
    },
    slides: {
      [slideId]: {
        version: DOCUMENT_VERSION,
        id: slideId,
        background: "#ffffff",
        notes: "",
        nodes: [{ type: "layer", id: layerId, children: [] }],
      },
    },
  });
}
