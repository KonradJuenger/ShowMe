import { textStyleSchema, textFormatSchema } from "./textTypography";
import {
  editTextStyleDeck,
  editTextStylePage,
  validateTextStyleLayouts,
} from "./textStyles";
import { editablePage, makeIndependentSlide } from "./templates";
import { slideMotionSchema } from "./motionModel";
import {
  effectResourcesSchema,
  elementEffectsSchema,
  filterEffectMotion,
  numericEffectParameter,
} from "./effects";
import { filterMotion } from "./motion";
import { walkElements } from "./element";
import { z } from "zod";
import { idSchema } from "./ids";
import { slideMetaSchema } from "./slideMetadata";
import { guideSetSchema } from "./guideModel";
import { transitionDefaultsSchema } from "./slideTransitions";
import {
  templatePageSchema,
  canvasDimensionSchema,
  deckSchema,
  layerRootSchema,
  layerSchema,
  slideSchema,
  presentationDocumentSchema,
  validatePresentationReferences,
  type LayerRoot,
  type PresentationDocument,
  type Slide,
} from "./document";
import {
  appearanceSchema,
  containerStateSchema,
  contentSchema,
  elementSchema,
  frameSchema,
  geometrySchema,
} from "./element";
import {
  findElement,
  getChildren,
  insertElement,
  removeElements,
  reorderElement,
  reparentElements,
  replaceElement,
  replaceElements,
  frameElements,
  unframeElement,
} from "./scene";

const elementChanges = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .array(
      z
        .object({
          elementId: idSchema,
          value: schema,
        })
        .strict(),
    )
    .min(1)
    .max(100)
    .refine(
      (entries) =>
        new Set(entries.map(({ elementId }) => elementId)).size ===
        entries.length,
      "Duplicate Element change",
    );
const elementIds = z
  .array(idSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate Element ID");
const replacementElements = z
  .array(elementSchema)
  .min(1)
  .max(100)
  .refine(
    (elements) =>
      new Set(elements.map(({ id }) => id)).size === elements.length,
    "Duplicate replacement Element ID",
  );

/** Canonical document mutations. Property operations replace complete semantic values.
 * elements.frame.set is the persistent transform operation. Move, resize, and rotate
 * remain editor gesture intents rather than separate persisted operation types.
 */
export const documentOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text-style.set"),
      styleId: idSchema,
      value: textStyleSchema.nullable(),
      expectedValue: textStyleSchema.nullable().optional(),
      restoreFormats: z
        .record(idSchema, z.record(idSchema, textFormatSchema))
        .optional(),
      layouts: z
        .record(
          idSchema,
          z.record(
            idSchema,
            z
              .object({
                expectedContent: contentSchema,
                expectedFrame: frameSchema,
                frame: frameSchema,
              })
              .strict(),
          ),
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("template.create"),
      template: templatePageSchema,
      label: z
        .string()
        .max(8)
        .regex(/^[A-Z]+$/),
      afterId: idSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("template.delete"), templateId: idSchema })
    .strict(),
  z
    .object({
      type: z.literal("slide.template.set"),
      slideId: idSchema,
      templateId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.independent"),
      slideId: idSchema,
      slide: slideSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.visual.restore"),
      slideId: idSchema,
      slide: slideSchema,
      templateId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.effects.set"),
      slideId: idSchema,
      resources: effectResourcesSchema.nullable().optional(),
      changes: elementChanges(elementEffectsSchema.nullable()).optional(),
      motion: slideMotionSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.motion.set"),
      slideId: idSchema,
      motion: slideMotionSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deck.properties.set"),
      changes: z
        .object({
          name: z.string().min(1).max(200).optional(),
          stylesheet: z.string().max(100000).optional(),
          width: canvasDimensionSchema.optional(),
          height: canvasDimensionSchema.optional(),
          transitionDefaults: transitionDefaultsSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deck.layers.set"),
      layers: z.array(layerSchema).min(1).max(10000),
      restoreRoots: z
        .record(idSchema, z.record(idSchema, layerRootSchema))
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deck.guides.set"),
      guideSets: z.record(idSchema, guideSetSchema),
      defaultGuideSetId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.create"),
      slide: slideSchema,
      meta: slideMetaSchema,
      afterId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.duplicate"),
      sourceSlideId: idSchema,
      slide: slideSchema,
      meta: slideMetaSchema,
      afterId: idSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("slide.delete"), slideId: idSchema }).strict(),
  z
    .object({
      type: z.literal("slide.reorder"),
      slideId: idSchema,
      afterId: idSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.meta.set"),
      slideId: idSchema,
      meta: slideMetaSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.notes.set"),
      slideId: idSchema,
      notes: z.string().max(100000),
    })
    .strict(),
  z
    .object({
      type: z.literal("slide.background.set"),
      slideId: idSchema,
      background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.insert"),
      slideId: idSchema,
      parentId: idSchema,
      index: z.number().int().nonnegative().optional(),
      elements: z.array(elementSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.remove"),
      slideId: idSchema,
      elementIds,
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.reorder"),
      slideId: idSchema,
      elementId: idSchema,
      index: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.reparent"),
      slideId: idSchema,
      elementIds,
      parentId: idSchema,
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.replace"),
      slideId: idSchema,
      elements: replacementElements,
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.frame"),
      slideId: idSchema,
      elementIds,
      frameId: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.unframe"),
      slideId: idSchema,
      frameId: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.frame.set"),
      slideId: idSchema,
      changes: elementChanges(frameSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.appearance.set"),
      slideId: idSchema,
      changes: elementChanges(appearanceSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.geometry.set"),
      slideId: idSchema,
      changes: elementChanges(geometrySchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.content.set"),
      slideId: idSchema,
      changes: elementChanges(contentSchema.nullable()),
    })
    .strict(),
  z
    .object({
      type: z.literal("elements.container.set"),
      slideId: idSchema,
      changes: elementChanges(containerStateSchema),
    })
    .strict(),
]);
export type DocumentOperation = z.infer<typeof documentOperationSchema>;

function insertAfter<T>(
  items: readonly T[],
  item: T,
  afterId: string | null,
  id: (value: T) => string,
): T[] {
  const index =
    afterId === null ? -1 : items.findIndex((entry) => id(entry) === afterId);
  if (afterId !== null && index < 0)
    throw new Error("Unknown insertion anchor");
  return [...items.slice(0, index + 1), item, ...items.slice(index + 1)];
}
function requireSlide(doc: PresentationDocument, id: string): Slide {
  const slide = editablePage(doc, id);
  if (!slide) throw new Error("Unknown slide");
  return slide;
}
function withSlide(
  doc: PresentationDocument,
  id: string,
  slide: Slide,
  validate = true,
): PresentationDocument {
  if (doc.templates[id]) {
    const { notes: _notes, motion: _motion, ...visual } = slide;
    void _notes;
    void _motion;
    return {
      ...doc,
      templates: {
        ...doc.templates,
        [id]: validate ? templatePageSchema.parse(visual) : visual,
      },
    };
  }
  const parsed = validate ? slideSchema.parse(slide) : slide;
  return { ...doc, slides: { ...doc.slides, [id]: parsed } };
}
function requireElementTargets(slide: Slide, ids: readonly string[]): void {
  const missing = ids.find((id) => !findElement(slide, id));
  if (missing) throw new Error(`Unknown Element: ${missing}`);
}
function changeElement(
  slide: Slide,
  id: string,
  value: unknown,
  key: "frame" | "appearance" | "geometry" | "content" | "container",
  validate = true,
): Slide {
  const current = findElement(slide, id);
  if (!current) throw new Error(`Unknown Element: ${id}`);
  const next =
    key === "container"
      ? {
          ...current,
          ...(value as { container: boolean; clipChildren: boolean }),
        }
      : { ...current, [key]: value };
  return replaceElement(slide, id, validate ? elementSchema.parse(next) : next);
}

export function syncLayerRoots(
  slide: Slide,
  layers: readonly { id: string }[],
  restoreRoots?: Readonly<Record<string, LayerRoot>>,
): Slide {
  const previous = new Map(slide.nodes.map((root) => [root.id, root]));
  const nodes = layers.map(
    ({ id }) =>
      previous.get(id) ??
      restoreRoots?.[id] ?? {
        type: "layer" as const,
        id,
        children: [],
      },
  );
  const motion = filterMotion(
    slide.motion,
    new Set(walkElements(nodes.flatMap((r) => r.children)).map((e) => e.id)),
  );
  return slideSchema.parse({ ...slide, nodes, ...(motion ? { motion } : {}) });
}

export function applyDocumentOperationToSlide(
  input: Slide,
  operation: DocumentOperation,
  validate = true,
): Slide {
  if (!("slideId" in operation) || operation.slideId !== input.id)
    throw new Error("Operation targets another slide");
  let slide = input;
  switch (operation.type) {
    case "slide.effects.set": {
      slide = structuredClone(slide);
      if (
        operation.resources !== undefined &&
        !operation.changes &&
        operation.motion === undefined
      )
        for (const stage of slide.motion?.stages ?? [])
          for (const track of stage.tracks) {
            if (!track.property.startsWith("effects.")) continue;
            const element = walkElements(
              slide.nodes.flatMap((r) => r.children),
            ).find((e) => e.id === track.elementId)!;
            if (
              !numericEffectParameter(
                element,
                track.property,
                operation.resources ?? {},
              )
            )
              throw new Error(
                "Cannot remove or rename an animated parameter; remove its animation explicitly first",
              );
          }
      if (operation.resources !== undefined) {
        if (operation.resources) slide.effectResources = operation.resources;
        else delete slide.effectResources;
      }
      for (const change of operation.changes ?? []) {
        const element = walkElements(
          slide.nodes.flatMap((r) => r.children),
        ).find((e) => e.id === change.elementId);
        if (!element) throw new Error("Unknown effect Element");
        if (change.value) element.effects = change.value;
        else delete element.effects;
      }
      if (operation.motion !== undefined) {
        if (operation.motion) slide.motion = operation.motion;
        else delete slide.motion;
      } else {
        const motion = filterEffectMotion(
          slide.motion,
          walkElements(slide.nodes.flatMap((r) => r.children)),
          slide.effectResources ?? {},
        );
        if (motion) slide.motion = motion;
      }
      break;
    }
    case "slide.motion.set":
      slide = { ...slide };
      if (operation.motion) slide.motion = operation.motion;
      else delete slide.motion;
      break;
    case "slide.notes.set":
      slide = { ...slide, notes: operation.notes };
      break;
    case "slide.background.set":
      slide = { ...slide, background: operation.background };
      break;
    case "elements.insert":
      if (!getChildren(slide, operation.parentId))
        throw new Error("Unknown or non-container parent");
      for (let i = 0; i < operation.elements.length; i++)
        slide = insertElement(
          slide,
          operation.parentId,
          operation.elements[i],
          operation.index === undefined ? undefined : operation.index + i,
        );
      break;
    case "elements.remove":
      slide = removeElements(slide, operation.elementIds);
      break;
    case "elements.reorder":
      slide = reorderElement(slide, operation.elementId, operation.index);
      break;
    case "elements.reparent":
      slide = reparentElements(
        slide,
        operation.elementIds,
        operation.parentId,
        operation.index,
      );
      break;
    case "elements.replace":
      slide = replaceElements(slide, operation.elements);
      break;
    case "elements.frame":
      slide = frameElements(slide, operation.elementIds, operation.frameId);
      break;
    case "elements.unframe":
      slide = unframeElement(slide, operation.frameId);
      break;
    case "elements.frame.set":
    case "elements.appearance.set":
    case "elements.geometry.set":
    case "elements.content.set":
    case "elements.container.set": {
      const key =
        operation.type === "elements.frame.set"
          ? "frame"
          : operation.type === "elements.appearance.set"
            ? "appearance"
            : operation.type === "elements.geometry.set"
              ? "geometry"
              : operation.type === "elements.content.set"
                ? "content"
                : "container";
      requireElementTargets(
        slide,
        operation.changes.map(({ elementId }) => elementId),
      );
      for (const change of operation.changes)
        slide = changeElement(
          slide,
          change.elementId,
          change.value,
          key,
          validate,
        );
      break;
    }
    default:
      throw new Error("Operation cannot be applied to a single slide");
  }
  return validate ? slideSchema.parse(slide) : slide;
}

/** Apply one validated operation atomically; neither input nor nested values are mutated. */
function applyParsedOperation(
  input: PresentationDocument,
  op: DocumentOperation,
  validatePage = true,
): PresentationDocument {
  let result: PresentationDocument = input;
  switch (op.type) {
    case "text-style.set":
      validateTextStyleLayouts(input, op);
      result = {
        ...input,
        deck: deckSchema.parse(editTextStyleDeck(input.deck, op)),
        slides: Object.fromEntries(
          Object.entries(input.slides).map(([id, page]) => [
            id,
            editTextStylePage(page, input.deck, op),
          ]),
        ),
        templates: Object.fromEntries(
          Object.entries(input.templates).map(([id, page]) => [
            id,
            editTextStylePage(page, input.deck, op),
          ]),
        ),
      };
      break;
    case "template.create": {
      if (input.templates[op.template.id] || input.slides[op.template.id])
        throw new Error("Duplicate page ID");
      result = {
        ...input,
        templates: { ...input.templates, [op.template.id]: op.template },
        deck: {
          ...input.deck,
          templateIds: insertAfter(
            input.deck.templateIds,
            op.template.id,
            op.afterId === undefined
              ? input.deck.templateIds.at(-1)!
              : op.afterId,
            (id) => id,
          ),
          templateMeta: {
            ...input.deck.templateMeta,
            [op.template.id]: { label: op.label },
          },
        },
      };
      break;
    }
    case "template.delete": {
      if (!input.templates[op.templateId]) throw new Error("Unknown template");
      if (op.templateId === input.deck.defaultTemplateId)
        throw new Error("Cannot delete Template A");
      if (
        Object.values(input.deck.slideMeta).some(
          (meta) => meta.templateId === op.templateId,
        )
      )
        throw new Error("Template is in use");
      const templates = { ...input.templates },
        templateMeta = { ...input.deck.templateMeta };
      delete templates[op.templateId];
      delete templateMeta[op.templateId];
      result = {
        ...input,
        templates,
        deck: {
          ...input.deck,
          templateMeta,
          templateIds: input.deck.templateIds.filter(
            (id) => id !== op.templateId,
          ),
        },
      };
      break;
    }
    case "slide.template.set":
      if (
        !input.slides[op.slideId] ||
        (op.templateId !== null && !input.templates[op.templateId])
      )
        throw new Error("Unknown slide or template");
      result = {
        ...input,
        deck: {
          ...input.deck,
          slideMeta: {
            ...input.deck.slideMeta,
            [op.slideId]: {
              ...input.deck.slideMeta[op.slideId],
              templateId: op.templateId,
            },
          },
        },
      };
      break;
    case "slide.independent": {
      const current = input.slides[op.slideId];
      if (!current || op.slide.id !== op.slideId)
        throw new Error("Unknown slide");
      // The client supplies fresh IDs so optimistic projection and durable replay agree.
      // Verify the submitted flattening against the canonical composition.
      const inheritedCount = input.deck.slideMeta[op.slideId].templateId
        ? walkElements(
            input.templates[
              input.deck.slideMeta[op.slideId].templateId!
            ].nodes.flatMap((r) => r.children),
          ).length
        : 0;
      const localIds = new Set(
        walkElements(current.nodes.flatMap((r) => r.children)).map((e) => e.id),
      );
      const templateId = input.deck.slideMeta[op.slideId].templateId;
      const inheritedIds = new Set(
        templateId
          ? walkElements(
              input.templates[templateId].nodes.flatMap((r) => r.children),
            ).map((e) => e.id)
          : [],
      );
      const cloneIds = walkElements(op.slide.nodes.flatMap((r) => r.children))
        .filter((e) => !localIds.has(e.id))
        .map((e) => e.id);
      if (cloneIds.some((id) => inheritedIds.has(id)))
        throw new Error("Inherited clones require fresh Element IDs");
      if (cloneIds.length !== inheritedCount)
        throw new Error("Invalid independent content");
      const generated = [...cloneIds];
      const expected = makeIndependentSlide(
        input.deck,
        current,
        input.templates,
        () => generated.shift()!,
      );
      if (JSON.stringify(expected) !== JSON.stringify(op.slide))
        throw new Error(
          "Independent content must preserve resolved appearance",
        );
      result = {
        ...input,
        slides: { ...input.slides, [op.slideId]: op.slide },
        deck: {
          ...input.deck,
          slideMeta: {
            ...input.deck.slideMeta,
            [op.slideId]: {
              ...input.deck.slideMeta[op.slideId],
              templateId: null,
            },
          },
        },
      };
      break;
    }
    case "slide.visual.restore":
      if (!input.slides[op.slideId] || op.slide.id !== op.slideId)
        throw new Error("Unknown slide");
      result = {
        ...input,
        slides: { ...input.slides, [op.slideId]: op.slide },
        deck: {
          ...input.deck,
          slideMeta: {
            ...input.deck.slideMeta,
            [op.slideId]: {
              ...input.deck.slideMeta[op.slideId],
              templateId: op.templateId,
            },
          },
        },
      };
      break;
    case "deck.properties.set":
      result = {
        ...input,
        deck: deckSchema.parse({ ...input.deck, ...op.changes }),
      };
      break;
    case "deck.guides.set":
      result = {
        ...input,
        deck: deckSchema.parse({
          ...input.deck,
          guideSets: op.guideSets,
          defaultGuideSetId: op.defaultGuideSetId,
        }),
      };
      break;
    case "deck.layers.set": {
      const deck = deckSchema.parse({
        ...input.deck,
        layers: op.layers,
      });
      const slides = { ...input.slides };
      for (const slideId of deck.slideIds)
        slides[slideId] = syncLayerRoots(
          requireSlide(input, slideId),
          deck.layers,
          op.restoreRoots?.[slideId],
        );
      const templates = { ...input.templates };
      for (const templateId of deck.templateIds) {
        const { notes: _notes, ...page } = syncLayerRoots(
          requireSlide(input, templateId),
          deck.layers,
          op.restoreRoots?.[templateId],
        );
        void _notes;
        templates[templateId] = templatePageSchema.parse(page);
      }
      result = { ...input, deck, slides, templates };
      break;
    }
    case "slide.create":
    case "slide.duplicate": {
      if (input.slides[op.slide.id]) throw new Error("Duplicate slide");
      if (op.type === "slide.duplicate" && !input.slides[op.sourceSlideId])
        throw new Error("Unknown source slide");
      const slideIds = insertAfter(
        input.deck.slideIds,
        op.slide.id,
        op.afterId,
        (id) => id,
      );
      result = {
        ...input,
        deck: deckSchema.parse({
          ...input.deck,
          slideIds,
          slideMeta: { ...input.deck.slideMeta, [op.slide.id]: op.meta },
        }),
        slides: { ...input.slides, [op.slide.id]: op.slide },
      };
      break;
    }
    case "slide.delete": {
      if (!input.slides[op.slideId]) throw new Error("Unknown slide");
      requireSlide(input, op.slideId);
      if (input.deck.slideIds.length <= 1)
        throw new Error("Cannot remove final slide");
      const slides = { ...input.slides };
      delete slides[op.slideId];
      const slideMeta = { ...input.deck.slideMeta };
      delete slideMeta[op.slideId];
      result = {
        ...input,
        slides,
        deck: deckSchema.parse({
          ...input.deck,
          slideIds: input.deck.slideIds.filter((id) => id !== op.slideId),
          slideMeta,
        }),
      };
      break;
    }
    case "slide.reorder": {
      if (!input.slides[op.slideId]) throw new Error("Unknown slide");
      requireSlide(input, op.slideId);
      if (op.slideId === op.afterId) throw new Error("Invalid slide anchor");
      result = {
        ...input,
        deck: deckSchema.parse({
          ...input.deck,
          slideIds: insertAfter(
            input.deck.slideIds.filter((id) => id !== op.slideId),
            op.slideId,
            op.afterId,
            (id) => id,
          ),
        }),
      };
      break;
    }
    case "slide.meta.set":
      if (!input.slides[op.slideId]) throw new Error("Unknown slide");
      requireSlide(input, op.slideId);
      result = {
        ...input,
        deck: deckSchema.parse({
          ...input.deck,
          slideMeta: { ...input.deck.slideMeta, [op.slideId]: op.meta },
        }),
      };
      break;
    case "slide.effects.set":
    case "slide.motion.set":
    case "slide.notes.set":
    case "slide.background.set":
    case "elements.insert":
    case "elements.remove":
    case "elements.reorder":
    case "elements.reparent":
    case "elements.replace":
    case "elements.frame":
    case "elements.unframe":
    case "elements.frame.set":
    case "elements.appearance.set":
    case "elements.geometry.set":
    case "elements.content.set":
    case "elements.container.set": {
      if (
        input.templates[op.slideId] &&
        (op.type === "slide.motion.set" ||
          op.type === "slide.notes.set" ||
          (op.type === "slide.effects.set" && op.motion))
      )
        throw new Error("Templates cannot own notes or Motion");
      if (
        op.type === "slide.background.set" &&
        input.deck.slideMeta[op.slideId]?.templateId
      )
        throw new Error("Background is inherited from template");
      const slide = requireSlide(input, op.slideId);
      result = withSlide(
        input,
        op.slideId,
        applyDocumentOperationToSlide(slide, op, validatePage),
        false,
      );
      break;
    }
  }
  return result;
}

/** Observers inspect the same evolving state as canonical semantic application.
 * They may reject, but the candidate is published only after final validation. */
export interface OperationEvaluation {
  before?(document: PresentationDocument, operation: DocumentOperation): void;
  after?(
    before: PresentationDocument,
    operation: DocumentOperation,
    after: PresentationDocument,
  ): void;
}

export function applyDocumentOperation(
  input: PresentationDocument,
  operation: DocumentOperation,
): PresentationDocument {
  return applyDocumentOperations(input, [operation]);
}

export function applyDocumentOperations(
  input: PresentationDocument,
  operations: readonly DocumentOperation[],
  evaluation?: OperationEvaluation,
): PresentationDocument {
  const parsed = z
    .array(documentOperationSchema)
    .min(1)
    .max(256)
    .parse(operations);
  return applyValidatedDocumentOperations(input, parsed, evaluation);
}

/** Typed operations already validated at authority/replay boundaries. */
export function applyValidatedDocumentOperations(
  input: PresentationDocument,
  operations: readonly DocumentOperation[],
  evaluation?: OperationEvaluation,
  replay = false,
): PresentationDocument {
  let candidate = input;
  const pages = new Set<string>();
  let broad = false;
  const local = new Set([
    "slide.effects.set",
    "slide.motion.set",
    "slide.notes.set",
    "slide.background.set",
    "elements.insert",
    "elements.remove",
    "elements.reorder",
    "elements.reparent",
    "elements.replace",
    "elements.frame",
    "elements.unframe",
    "elements.frame.set",
    "elements.appearance.set",
    "elements.geometry.set",
    "elements.content.set",
    "elements.container.set",
  ]);
  for (const operation of operations) {
    if (local.has(operation.type) && "slideId" in operation)
      pages.add(operation.slideId);
    else broad = true;
    evaluation?.before?.(candidate, operation);
    const next = applyParsedOperation(candidate, operation, !replay);
    evaluation?.after?.(candidate, operation, next);
    candidate = next;
  }
  if (broad) return presentationDocumentSchema.parse(candidate);
  if (replay) {
    candidate = {
      ...candidate,
      slides: { ...candidate.slides },
      templates: { ...candidate.templates },
    };
    for (const id of pages) {
      if (candidate.templates[id])
        candidate.templates[id] = templatePageSchema.parse(
          candidate.templates[id],
        );
      else candidate.slides[id] = slideSchema.parse(candidate.slides[id]);
    }
  }
  // Template changes must check the resolved identities/resources of dependents.
  for (const id of [...pages])
    if (candidate.templates[id])
      for (const [slideId, meta] of Object.entries(candidate.deck.slideMeta))
        if (meta.templateId === id) pages.add(slideId);
  const issues: z.ZodIssue[] = [];
  validatePresentationReferences(
    candidate,
    {
      addIssue: (issue) => {
        issues.push({ ...issue, path: issue.path ?? [] } as z.ZodIssue);
      },
      path: [],
    },
    [...pages],
  );
  if (issues.length) throw new z.ZodError(issues);
  return candidate;
}
