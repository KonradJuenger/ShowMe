import { DOCUMENT_VERSION } from "./document";
import type { EditorSnapshot } from "./editorCommands";
import { appendEditorOperations } from "./editorChange";
import { applyDocumentOperationsToProjection } from "./documentProjection";
import type { DocumentOperation } from "./documentOperations";
import { makeIndependentSlide, nextTemplateLabel } from "./templates";
import { uid } from "./ids";

function change(
  snapshot: EditorSnapshot,
  operation: DocumentOperation,
): EditorSnapshot {
  const next = applyDocumentOperationsToProjection(snapshot, [operation]);
  if (!next) throw new Error("Cannot delete the active template");
  return appendEditorOperations(snapshot, next, [operation]);
}

export function createTemplate(
  snapshot: EditorSnapshot,
  id: string = uid(),
): EditorSnapshot {
  return change(snapshot, {
    type: "template.create",
    label: nextTemplateLabel(snapshot.deck),
    template: {
      version: DOCUMENT_VERSION,
      id,
      background: "#ffffff",
      nodes: snapshot.deck.layers.map(({ id }) => ({
        type: "layer",
        id,
        children: [],
      })),
    },
  });
}

export function deleteTemplate(
  snapshot: EditorSnapshot,
  templateId: string,
): EditorSnapshot {
  if (templateId === snapshot.deck.defaultTemplateId)
    throw new Error("Cannot delete Template A");
  if (
    Object.values(snapshot.deck.slideMeta).some(
      (meta) => meta.templateId === templateId,
    )
  )
    throw new Error("Template is in use");
  return change(snapshot, { type: "template.delete", templateId });
}

export function applyTemplate(
  snapshot: EditorSnapshot,
  templateId: string,
): EditorSnapshot {
  return change(snapshot, {
    type: "slide.template.set",
    slideId: snapshot.slide.id,
    templateId,
  });
}

export function makeIndependent(snapshot: EditorSnapshot): EditorSnapshot {
  if (!snapshot.deck.slideMeta[snapshot.slide.id]?.templateId) return snapshot;
  return change(snapshot, {
    type: "slide.independent",
    slideId: snapshot.slide.id,
    slide: makeIndependentSlide(
      snapshot.deck,
      snapshot.slide,
      snapshot.templates ?? {},
    ),
  });
}

/** Detach dependent slides while preserving their local content. */
export function deleteTemplateElements(
  snapshot: EditorSnapshot,
  templateId: string,
): EditorSnapshot {
  if (templateId === snapshot.deck.defaultTemplateId)
    throw new Error("Cannot delete Template A");
  const operations: DocumentOperation[] = Object.entries(
    snapshot.deck.slideMeta,
  )
    .filter(([, meta]) => meta.templateId === templateId)
    .map(([slideId]) => ({
      type: "slide.template.set",
      slideId,
      templateId: null,
    }));
  operations.push({ type: "template.delete", templateId });
  const next = applyDocumentOperationsToProjection(snapshot, operations);
  if (!next) throw new Error("Cannot delete the active template");
  return appendEditorOperations(snapshot, next, operations);
}
