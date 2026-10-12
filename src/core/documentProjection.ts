import { editTextStyleDeck, editTextStylePage } from "./textStyles";
import { templateEditorPage } from "./templates";
import type { EditorSnapshot } from "./editorCommands";
import { deckSchema, type Deck, type Slide } from "./document";
import {
  applyDocumentOperationToSlide,
  syncLayerRoots,
  documentOperationSchema,
  type DocumentOperation,
} from "./documentOperations";

export interface DocumentProjection extends EditorSnapshot {
  documentId: string;
  epoch: string;
  revision: number;
  savedRevision: number;
}

function insertAfterId(
  ids: readonly string[],
  id: string,
  afterId: string | null,
) {
  const index = afterId === null ? -1 : ids.indexOf(afterId);
  if (afterId !== null && index < 0)
    throw new Error("Unknown insertion anchor");
  return [...ids.slice(0, index + 1), id, ...ids.slice(index + 1)];
}

function requireProjectedSlide(deck: Deck, slideId: string) {
  if (!deck.slideIds.includes(slideId) && !deck.templateIds.includes(slideId))
    throw new Error("Unknown slide");
}

/**
 * Apply accepted document operations to the editor's small read projection. Metadata
 * on the input object is preserved; revision advancement belongs to the replica.
 * Returns null only when the active slide is deleted and a fresh projection is
 * required.
 */
export function applyDocumentOperationsToProjection<
  T extends {
    deck: Deck;
    slide: Slide;
    templates?: Record<string, import("./document").TemplatePage>;
  },
>(input: T, operations: readonly DocumentOperation[]): T | null {
  let deck = input.deck;
  let slide = input.slide;
  let templates = input.templates;

  for (const raw of operations) {
    const operation = documentOperationSchema.parse(raw);
    switch (operation.type) {
      case "text-style.set":
        slide = editTextStylePage(slide, deck, operation);
        if (templates)
          templates = Object.fromEntries(
            Object.entries(templates).map(([id, page]) => [
              id,
              editTextStylePage(page, deck, operation),
            ]),
          );
        deck = deckSchema.parse(editTextStyleDeck(deck, operation));
        break;
      case "template.create":
        templates = {
          ...templates,
          [operation.template.id]: operation.template,
        };
        deck = deckSchema.parse({
          ...deck,
          templateIds: insertAfterId(
            deck.templateIds,
            operation.template.id,
            operation.afterId === undefined
              ? deck.templateIds.at(-1)!
              : operation.afterId,
          ),
          templateMeta: {
            ...deck.templateMeta,
            [operation.template.id]: { label: operation.label },
          },
        });
        break;
      case "template.delete": {
        if (slide.id === operation.templateId) return null;
        templates = { ...templates };
        delete templates[operation.templateId];
        const templateMeta = { ...deck.templateMeta };
        delete templateMeta[operation.templateId];
        deck = deckSchema.parse({
          ...deck,
          templateIds: deck.templateIds.filter(
            (id) => id !== operation.templateId,
          ),
          templateMeta,
        });
        break;
      }
      case "slide.template.set":
      case "slide.independent":
      case "slide.visual.restore":
        deck = deckSchema.parse({
          ...deck,
          slideMeta: {
            ...deck.slideMeta,
            [operation.slideId]: {
              ...deck.slideMeta[operation.slideId],
              templateId:
                operation.type === "slide.independent"
                  ? null
                  : operation.templateId,
            },
          },
        });
        if (
          operation.type !== "slide.template.set" &&
          operation.slideId === slide.id
        )
          slide = operation.slide;
        break;
      case "deck.properties.set":
        deck = deckSchema.parse({ ...deck, ...operation.changes });
        break;
      case "deck.guides.set":
        deck = deckSchema.parse({
          ...deck,
          guideSets: operation.guideSets,
          defaultGuideSetId: operation.defaultGuideSetId,
        });
        break;
      case "deck.layers.set":
        if (templates)
          templates = Object.fromEntries(
            Object.entries(templates).map(([id, page]) => {
              const { notes: _notes, ...visual } = syncLayerRoots(
                templateEditorPage(page),
                operation.layers,
                operation.restoreRoots?.[id],
              );
              void _notes;
              return [id, visual];
            }),
          );
        deck = deckSchema.parse({ ...deck, layers: operation.layers });
        slide = syncLayerRoots(
          slide,
          deck.layers,
          operation.restoreRoots?.[slide.id],
        );
        break;
      case "slide.create":
      case "slide.duplicate": {
        if (deck.slideIds.includes(operation.slide.id))
          throw new Error("Duplicate slide");
        if (
          operation.type === "slide.duplicate" &&
          !deck.slideIds.includes(operation.sourceSlideId)
        )
          throw new Error("Unknown source slide");
        deck = deckSchema.parse({
          ...deck,
          slideIds: insertAfterId(
            deck.slideIds,
            operation.slide.id,
            operation.afterId,
          ),
          slideMeta: {
            ...deck.slideMeta,
            [operation.slide.id]: operation.meta,
          },
        });
        break;
      }
      case "slide.delete": {
        requireProjectedSlide(deck, operation.slideId);
        if (deck.slideIds.length <= 1)
          throw new Error("Cannot remove final slide");
        const slideMeta = { ...deck.slideMeta };
        delete slideMeta[operation.slideId];
        deck = deckSchema.parse({
          ...deck,
          slideIds: deck.slideIds.filter((id) => id !== operation.slideId),
          slideMeta,
        });
        if (operation.slideId === slide.id) return null;
        break;
      }
      case "slide.reorder":
        requireProjectedSlide(deck, operation.slideId);
        if (operation.slideId === operation.afterId)
          throw new Error("Invalid slide anchor");
        deck = deckSchema.parse({
          ...deck,
          slideIds: insertAfterId(
            deck.slideIds.filter((id) => id !== operation.slideId),
            operation.slideId,
            operation.afterId,
          ),
        });
        break;
      case "slide.meta.set":
        requireProjectedSlide(deck, operation.slideId);
        deck = deckSchema.parse({
          ...deck,
          slideMeta: {
            ...deck.slideMeta,
            [operation.slideId]: operation.meta,
          },
        });
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
      case "elements.container.set":
        requireProjectedSlide(deck, operation.slideId);
        if (templates?.[operation.slideId]) {
          const {
            notes: _notes,
            motion: _motion,
            ...visual
          } = applyDocumentOperationToSlide(
            templateEditorPage(templates[operation.slideId]),
            operation,
          );
          void _notes;
          void _motion;
          templates = { ...templates, [operation.slideId]: visual };
        }
        if (operation.slideId === slide.id)
          slide = applyDocumentOperationToSlide(slide, operation);
        break;
    }
  }

  return { ...input, deck, slide, ...(templates ? { templates } : {}) };
}
