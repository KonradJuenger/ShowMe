import { recordAcceptedImpact } from "./documentImpact";
import { textStyleInverse } from "./textStyles";
import { editablePage } from "./templates";
import { z } from "zod";
import { idSchema } from "./ids";
import type { PresentationDocument, Slide } from "./document";
import type { EditorSnapshot } from "./editorCommands";
import { applyDocumentOperationsToProjection } from "./documentProjection";
import {
  applyDocumentOperations,
  applyValidatedDocumentOperations,
  documentOperationSchema,
  type DocumentOperation,
} from "./documentOperations";
import {
  acceptedTransactionSchema,
  documentTransactionSchema,
  transactionFingerprint,
  type AcceptedTransaction,
  type DocumentTransaction,
} from "./documentTransactions";
import type { Element } from "./element";
import {
  containsElement,
  findElement,
  flattenSubtree,
  getChildren,
  locateElement,
} from "./scene";

export const editScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("element"),
      slideId: idSchema,
      elementId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("structure"),
      slideId: idSchema,
      parentId: idSchema,
    })
    .strict(),
  z.object({ kind: z.literal("slide"), slideId: idSchema }).strict(),
  z.object({ kind: z.literal("notes"), slideId: idSchema }).strict(),
  z.object({ kind: z.literal("slide-structure") }).strict(),
  z.object({ kind: z.literal("deck") }).strict(),
  z.object({ kind: z.literal("layers") }).strict(),
  z.object({ kind: z.literal("guides") }).strict(),
]);
export type EditScope = z.infer<typeof editScopeSchema>;

export interface LeaseGrant {
  token: string;
  actorId: string;
  scope: EditScope;
  generation: number;
  expiresAt: number;
}

export interface LeaseDenied {
  denied: true;
  scope: EditScope;
  ownerActorId: string;
}

export interface AuthoritySnapshot {
  document: PresentationDocument;
  epoch: string;
  revision: number;
  savedRevision: number;
}

interface AcceptedRecord {
  actorId: string;
  fingerprint: string;
  accepted: AcceptedTransaction;
}

interface HistoryEntry {
  actorId: string;
  transactionIds: string[];
  historyGroupId?: string;
  operations: DocumentOperation[];
  inverseOperations: DocumentOperation[];
  undoGuards: Map<string, string>;
  redoGuards?: Map<string, string>;
  undone: boolean;
}

export interface DocumentAuthorityOptions {
  epoch?: string;
  revision?: number;
  savedRevision?: number;
  leaseMs?: number;
  now?: () => number;
  idFactory?: () => string;
  durableCommit?: (
    accepted: AcceptedTransaction,
    nextDocument: PresentationDocument,
  ) => Promise<void>;
  onAccepted?: (
    accepted: AcceptedTransaction,
    document: PresentationDocument,
  ) => void;
}

const RECENT_TRANSACTIONS = 4096;
/** Host policy evaluated inside the commit queue; never persisted or sent over IPC. */
export type CommitAdmission = (state: {
  documentId: string;
  epoch: string;
  revision: number;
}) => void;
const HISTORY_LIMIT = 500;
const defaultIdFactory = () => crypto.randomUUID();

function requiredSlide(document: PresentationDocument, slideId: string): Slide {
  const slide = editablePage(document, slideId);
  if (!slide) throw new Error("Unknown slide");
  return slide;
}

function structuralScope(slideId: string, parentId: string): EditScope {
  return { kind: "structure", slideId, parentId };
}

function elementScope(slideId: string, elementId: string): EditScope {
  return { kind: "element", slideId, elementId };
}

function scopeKey(scope: EditScope) {
  switch (scope.kind) {
    case "element":
      return `element:${scope.slideId}:${scope.elementId}`;
    case "structure":
      return `structure:${scope.slideId}:${scope.parentId}`;
    case "slide":
    case "notes":
      return `${scope.kind}:${scope.slideId}`;
    default:
      return scope.kind;
  }
}

function isLayerRoot(slide: Slide, id: string) {
  return slide.nodes.some((root) => root.id === id);
}

function elementsRelated(
  document: PresentationDocument,
  slideId: string,
  a: string,
  b: string,
) {
  if (a === b) return true;
  const slide = editablePage(document, slideId);
  if (!slide) return false;
  return containsElement(slide, a, b) || containsElement(slide, b, a);
}

function scopesConflict(
  document: PresentationDocument,
  a: EditScope,
  b: EditScope,
) {
  if (a.kind === "slide-structure" || b.kind === "slide-structure")
    return a.kind === "slide-structure" && b.kind === "slide-structure";
  if (a.kind === "layers" || b.kind === "layers") return true;
  if (a.kind === "guides" || b.kind === "guides")
    return a.kind === "guides" && b.kind === "guides";
  if (a.kind === "deck" || b.kind === "deck")
    return a.kind === "deck" && b.kind === "deck";
  if ("slideId" in a && "slideId" in b && a.slideId !== b.slideId) return false;
  if (a.kind === "slide" || b.kind === "slide") return true;
  if (a.kind === "notes" || b.kind === "notes")
    return a.kind === "notes" && b.kind === "notes";

  if (!("slideId" in a) || !("slideId" in b)) return false;
  const slideId = a.slideId;
  const slide = editablePage(document, slideId);
  if (!slide) return false;

  if (a.kind === "element" && b.kind === "element")
    return elementsRelated(document, slideId, a.elementId, b.elementId);

  if (a.kind === "structure" && b.kind === "structure") {
    if (a.parentId === b.parentId) return true;
    if (isLayerRoot(slide, a.parentId) || isLayerRoot(slide, b.parentId))
      return false;
    return elementsRelated(document, slideId, a.parentId, b.parentId);
  }

  const element = a.kind === "element" ? a : b;
  const structure = a.kind === "structure" ? a : b;
  if (element.kind !== "element" || structure.kind !== "structure")
    return false;
  if (isLayerRoot(slide, structure.parentId)) return false;
  return elementsRelated(
    document,
    slideId,
    element.elementId,
    structure.parentId,
  );
}

function scopeCoveredBy(
  document: PresentationDocument,
  owner: EditScope,
  target: EditScope,
) {
  if (scopeKey(owner) === scopeKey(target)) return true;
  if (owner.kind !== "element") return false;
  if (!("slideId" in target) || target.slideId !== owner.slideId) return false;
  const slide = editablePage(document, owner.slideId);
  if (!slide) return false;
  if (target.kind === "element")
    return containsElement(slide, owner.elementId, target.elementId);
  if (target.kind === "structure" && !isLayerRoot(slide, target.parentId))
    return (
      owner.elementId === target.parentId ||
      containsElement(slide, owner.elementId, target.parentId)
    );
  return false;
}

type ScopeSource = PresentationDocument | EditorSnapshot;

function scopeSourceSlide(source: ScopeSource, slideId: string): Slide {
  if ("slides" in source) return requiredSlide(source, slideId);
  if (source.slide.id !== slideId) throw new Error("Slide is not projected");
  return source.slide;
}

function requiredScopes(
  document: ScopeSource,
  operation: DocumentOperation,
): EditScope[] {
  switch (operation.type) {
    case "template.create":
    case "template.delete":
      return [{ kind: "layers" }];
    case "slide.template.set":
    case "slide.independent":
    case "slide.visual.restore":
      return [{ kind: "slide", slideId: operation.slideId }];
    case "text-style.set":
      return [
        { kind: "deck" },
        ...Object.entries(operation.layouts ?? {}).flatMap(
          ([slideId, entries]) =>
            Object.keys(entries).map((elementId) =>
              elementScope(slideId, elementId),
            ),
        ),
      ];
    case "deck.properties.set":
      return [{ kind: "deck" }];
    case "deck.layers.set":
      return [{ kind: "layers" }];
    case "deck.guides.set":
      return [{ kind: "guides" }];
    case "slide.create":
    case "slide.duplicate":
    case "slide.delete":
    case "slide.reorder":
      return [{ kind: "slide-structure" }];
    case "slide.meta.set":
    case "slide.effects.set":
    case "slide.motion.set":
    case "slide.background.set":
      return [{ kind: "slide", slideId: operation.slideId }];
    case "slide.notes.set":
      return [{ kind: "notes", slideId: operation.slideId }];
    case "elements.insert":
      return [structuralScope(operation.slideId, operation.parentId)];
    case "elements.remove":
      return [
        ...(scopeSourceSlide(document, operation.slideId).motion
          ? [{ kind: "slide" as const, slideId: operation.slideId }]
          : []),
        ...operation.elementIds.map((elementId) =>
          elementScope(operation.slideId, elementId),
        ),
      ];
    case "elements.replace":
      return operation.elements.map(({ id }) =>
        elementScope(operation.slideId, id),
      );
    case "elements.reorder": {
      const location = locateElement(
        scopeSourceSlide(document, operation.slideId),
        operation.elementId,
      );
      if (!location) throw new Error(`Unknown Element: ${operation.elementId}`);
      return [
        elementScope(operation.slideId, operation.elementId),
        structuralScope(operation.slideId, location.parentId),
      ];
    }
    case "elements.reparent":
      return [
        ...operation.elementIds.map((elementId) =>
          elementScope(operation.slideId, elementId),
        ),
        structuralScope(operation.slideId, operation.parentId),
      ];
    case "elements.frame": {
      const slide = scopeSourceSlide(document, operation.slideId);
      const locations = operation.elementIds.map((id) =>
        locateElement(slide, id),
      );
      if (locations.some((location) => !location))
        throw new Error("Unknown Element in frame selection");
      const parentId = locations[0]!.parentId;
      if (locations.some((location) => location!.parentId !== parentId))
        throw new Error("Frame selection requires one source scope");
      return [
        ...operation.elementIds.map((elementId) =>
          elementScope(operation.slideId, elementId),
        ),
        structuralScope(operation.slideId, parentId),
      ];
    }
    case "elements.unframe": {
      const location = locateElement(
        scopeSourceSlide(document, operation.slideId),
        operation.frameId,
      );
      if (!location) throw new Error(`Unknown Element: ${operation.frameId}`);
      return [
        elementScope(operation.slideId, operation.frameId),
        structuralScope(operation.slideId, location.parentId),
      ];
    }
    case "elements.frame.set":
    case "elements.appearance.set":
    case "elements.geometry.set":
    case "elements.content.set":
    case "elements.container.set":
      return operation.changes.map(({ elementId }) =>
        elementScope(operation.slideId, elementId),
      );
  }
}

function guardValue(value: unknown) {
  return value === undefined ? "undefined" : `json:${JSON.stringify(value)}`;
}

function setGuard(guards: Map<string, string>, key: string, value: unknown) {
  guards.set(key, guardValue(value));
}

function elementPosition(
  document: PresentationDocument,
  slideId: string,
  elementId: string,
) {
  const slide = editablePage(document, slideId);
  if (!slide) return null;
  const location = locateElement(slide, elementId);
  return location
    ? { parentId: location.parentId, index: location.index }
    : null;
}

function slidePosition(document: PresentationDocument, slideId: string) {
  const index = document.deck.slideIds.indexOf(slideId);
  return index < 0
    ? null
    : { afterId: index > 0 ? document.deck.slideIds[index - 1] : null };
}

function structureState(
  document: PresentationDocument,
  slideId: string,
  parentId: string,
) {
  const slide = editablePage(document, slideId);
  const children = slide ? getChildren(slide, parentId) : null;
  return children?.map(({ id }) => id) ?? null;
}

function ownElementState(element: Element | null) {
  if (!element) return null;
  const { children: _children, ...state } = element;
  return state;
}

function setStructureGuard(
  guards: Map<string, string>,
  document: PresentationDocument,
  slideId: string,
  parentId: string,
) {
  setGuard(
    guards,
    `structure:${slideId}:${parentId}`,
    structureState(document, slideId, parentId),
  );
}

function setElementFrameGuard(
  guards: Map<string, string>,
  document: PresentationDocument,
  slideId: string,
  elementId: string,
) {
  setGuard(
    guards,
    `element-frame:${slideId}:${elementId}`,
    editablePage(document, slideId)
      ? findElement(requiredSlide(document, slideId), elementId)?.frame
      : undefined,
  );
}

function operationGuards(
  document: PresentationDocument,
  operations: readonly DocumentOperation[],
) {
  const guards = new Map<string, string>();
  for (const raw of operations) {
    const operation = documentOperationSchema.parse(raw);
    if (operation.type === "deck.layers.set")
      for (const [id, slide] of Object.entries({
        ...document.slides,
        ...document.templates,
      }))
        setGuard(
          guards,
          `slide-motion:${id}`,
          ("motion" in slide ? slide.motion : null) ?? null,
        );
    if (
      (operation.type === "elements.remove" ||
        operation.type === "elements.replace" ||
        operation.type === "elements.unframe") &&
      editablePage(document, operation.slideId)?.motion
    )
      setGuard(
        guards,
        `slide-motion:${operation.slideId}`,
        requiredSlide(document, operation.slideId).motion,
      );
    switch (operation.type) {
      case "template.create":
      case "template.delete":
        setGuard(guards, "templates", document.templates);
        setGuard(guards, "template-meta", document.deck.templateMeta);
        setGuard(
          guards,
          "template-assignments",
          Object.fromEntries(
            Object.entries(document.deck.slideMeta).map(([id, meta]) => [
              id,
              meta.templateId,
            ]),
          ),
        );
        break;
      case "slide.template.set":
      case "slide.independent":
      case "slide.visual.restore":
        setGuard(
          guards,
          "template-ref:" + operation.slideId,
          document.deck.slideMeta[operation.slideId]?.templateId,
        );
        setGuard(
          guards,
          "slide-visual:" + operation.slideId,
          editablePage(document, operation.slideId),
        );
        break;
      case "text-style.set": {
        setGuard(
          guards,
          "text-style:" + operation.styleId,
          document.deck.textStyles.find((s) => s.id === operation.styleId) ??
            null,
        );
        const references: Record<string, unknown> = {};
        for (const page of [
          ...Object.values(document.slides),
          ...Object.values(document.templates),
        ]) {
          const refs = page.nodes.flatMap((r) => r.children);
          for (const e of refs.flatMap((e) => flattenSubtree(e)))
            if (
              e.content?.type === "text" &&
              (operation.restoreFormats?.[page.id]?.[e.id] ||
                (e.content.format.kind === "style" &&
                  e.content.format.styleId === operation.styleId))
            )
              references[page.id + ":" + e.id] = e.content.format;
          for (const id of Object.keys(operation.layouts?.[page.id] ?? {})) {
            const e = findElement({ ...page, notes: "" }, id);
            setGuard(
              guards,
              "text-style-layout:" + page.id + ":" + id,
              e ? { frame: e.frame, content: e.content } : null,
            );
          }
        }
        setGuard(
          guards,
          "text-style-references:" + operation.styleId,
          references,
        );
        break;
      }
      case "deck.properties.set":
        if (operation.changes.transitionDefaults !== undefined)
          setGuard(
            guards,
            "deck-transition-defaults",
            document.deck.transitionDefaults,
          );
        if (operation.changes.width !== undefined)
          setGuard(guards, "deck-width", document.deck.width);
        if (operation.changes.height !== undefined)
          setGuard(guards, "deck-height", document.deck.height);
        if (operation.changes.name !== undefined)
          setGuard(guards, "deck-name", document.deck.name);
        if (operation.changes.stylesheet !== undefined)
          setGuard(guards, "deck-stylesheet", document.deck.stylesheet ?? "");
        break;
      case "deck.layers.set": {
        setGuard(guards, "deck-layers", document.deck.layers);
        const nextIds = new Set(operation.layers.map(({ id }) => id));
        for (const layer of document.deck.layers) {
          if (nextIds.has(layer.id)) continue;
          for (const [slideId, slide] of Object.entries({
            ...document.slides,
            ...document.templates,
          }))
            setGuard(
              guards,
              `removed-layer:${slideId}:${layer.id}`,
              slide.nodes.find((root) => root.id === layer.id) ?? null,
            );
        }
        break;
      }
      case "deck.guides.set":
        setGuard(guards, "deck-guideSets", document.deck.guideSets);
        setGuard(
          guards,
          "deck-defaultGuideSetId",
          document.deck.defaultGuideSetId,
        );
        break;
      case "slide.create":
      case "slide.duplicate":
        setGuard(
          guards,
          `slide-exists:${operation.slide.id}`,
          editablePage(document, operation.slide.id) ?? null,
        );
        setGuard(guards, "slide-order", document.deck.slideIds);
        break;
      case "slide.delete":
        setGuard(
          guards,
          `slide-delete:${operation.slideId}`,
          editablePage(document, operation.slideId) ?? null,
        );
        setGuard(
          guards,
          `slide-delete-meta:${operation.slideId}`,
          document.deck.slideMeta[operation.slideId] ?? null,
        );
        setGuard(
          guards,
          `slide-delete-position:${operation.slideId}`,
          slidePosition(document, operation.slideId),
        );
        break;
      case "slide.reorder":
        setGuard(
          guards,
          `slide-position:${operation.slideId}`,
          slidePosition(document, operation.slideId),
        );
        break;
      case "slide.meta.set":
        setGuard(
          guards,
          `slide-meta:${operation.slideId}`,
          document.deck.slideMeta[operation.slideId] ?? null,
        );
        break;
      case "slide.effects.set":
        if (operation.resources !== undefined)
          setGuard(
            guards,
            `slide-effect-resources:${operation.slideId}`,
            editablePage(document, operation.slideId)?.effectResources ?? null,
          );
        setGuard(
          guards,
          `slide-motion:${operation.slideId}`,
          editablePage(document, operation.slideId)?.motion ?? null,
        );
        for (const change of operation.changes ?? [])
          setGuard(
            guards,
            `element-effects:${operation.slideId}:${change.elementId}`,
            findElement(
              requiredSlide(document, operation.slideId),
              change.elementId,
            )?.effects ?? null,
          );
        break;
      case "slide.motion.set":
        setGuard(
          guards,
          `slide-motion:${operation.slideId}`,
          editablePage(document, operation.slideId)?.motion ?? null,
        );
        break;
      case "slide.notes.set":
        setGuard(
          guards,
          `slide-notes:${operation.slideId}`,
          editablePage(document, operation.slideId)?.notes,
        );
        break;
      case "slide.background.set":
        setGuard(
          guards,
          `slide-background:${operation.slideId}`,
          editablePage(document, operation.slideId)?.background,
        );
        break;
      case "elements.insert": {
        setStructureGuard(
          guards,
          document,
          operation.slideId,
          operation.parentId,
        );
        const slide = editablePage(document, operation.slideId);
        for (const element of operation.elements)
          for (const inserted of flattenSubtree(element))
            setGuard(
              guards,
              `element-exists:${operation.slideId}:${inserted.id}`,
              slide ? findElement(slide, inserted.id) : null,
            );
        break;
      }
      case "elements.remove": {
        const slide = editablePage(document, operation.slideId);
        for (const elementId of operation.elementIds) {
          setGuard(
            guards,
            `element-remove:${operation.slideId}:${elementId}`,
            slide ? findElement(slide, elementId) : null,
          );
          setGuard(
            guards,
            `element-remove-position:${operation.slideId}:${elementId}`,
            elementPosition(document, operation.slideId, elementId),
          );
        }
        break;
      }
      case "elements.reorder": {
        const position = elementPosition(
          document,
          operation.slideId,
          operation.elementId,
        );
        setGuard(
          guards,
          `element-position:${operation.slideId}:${operation.elementId}`,
          position,
        );
        if (position)
          setStructureGuard(
            guards,
            document,
            operation.slideId,
            position.parentId,
          );
        break;
      }
      case "elements.reparent": {
        const parents = new Set<string>([operation.parentId]);
        for (const elementId of operation.elementIds) {
          const position = elementPosition(
            document,
            operation.slideId,
            elementId,
          );
          setGuard(
            guards,
            `element-position:${operation.slideId}:${elementId}`,
            position,
          );
          setElementFrameGuard(guards, document, operation.slideId, elementId);
          if (position) parents.add(position.parentId);
        }
        for (const parentId of parents)
          setStructureGuard(guards, document, operation.slideId, parentId);
        break;
      }
      case "elements.replace": {
        const slide = editablePage(document, operation.slideId);
        for (const { id } of operation.elements)
          setGuard(
            guards,
            `element-replace:${operation.slideId}:${id}`,
            slide ? findElement(slide, id) : null,
          );
        break;
      }
      case "elements.frame": {
        const slide = editablePage(document, operation.slideId);
        setGuard(
          guards,
          `frame-target:${operation.slideId}:${operation.frameId}`,
          slide ? findElement(slide, operation.frameId) : null,
        );
        const parentIds = new Set<string>();
        for (const elementId of operation.elementIds) {
          const position = elementPosition(
            document,
            operation.slideId,
            elementId,
          );
          setGuard(
            guards,
            `frame-member-position:${operation.slideId}:${elementId}`,
            position,
          );
          setElementFrameGuard(guards, document, operation.slideId, elementId);
          if (position) parentIds.add(position.parentId);
        }
        for (const parentId of parentIds)
          setStructureGuard(guards, document, operation.slideId, parentId);
        break;
      }
      case "elements.unframe": {
        const slide = editablePage(document, operation.slideId);
        const frame = slide ? findElement(slide, operation.frameId) : null;
        setGuard(
          guards,
          `unframe-own:${operation.slideId}:${operation.frameId}`,
          ownElementState(frame),
        );
        const position = elementPosition(
          document,
          operation.slideId,
          operation.frameId,
        );
        setGuard(
          guards,
          `unframe-position:${operation.slideId}:${operation.frameId}`,
          position,
        );
        setGuard(
          guards,
          `unframe-children:${operation.slideId}:${operation.frameId}`,
          frame?.children.map(({ id }) => id) ?? null,
        );
        for (const child of frame?.children ?? [])
          setGuard(
            guards,
            `unframe-child-frame:${operation.slideId}:${child.id}`,
            child.frame,
          );
        if (position)
          setStructureGuard(
            guards,
            document,
            operation.slideId,
            position.parentId,
          );
        break;
      }
      case "elements.frame.set":
      case "elements.appearance.set":
      case "elements.geometry.set":
      case "elements.content.set":
      case "elements.container.set": {
        const slide = editablePage(document, operation.slideId);
        for (const { elementId } of operation.changes) {
          const element = slide ? findElement(slide, elementId) : null;
          const value =
            operation.type === "elements.frame.set"
              ? element?.frame
              : operation.type === "elements.appearance.set"
                ? element?.appearance
                : operation.type === "elements.geometry.set"
                  ? element?.geometry
                  : operation.type === "elements.content.set"
                    ? element?.content
                    : element
                      ? {
                          container: element.container,
                          clipChildren: element.clipChildren,
                        }
                      : undefined;
          setGuard(
            guards,
            `element-semantic:${operation.type}:${operation.slideId}:${elementId}`,
            value,
          );
        }
        break;
      }
    }
  }
  return guards;
}

function sameGuards(a: Map<string, string>, b: Map<string, string>) {
  return (
    a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
  );
}

function frameChanges(
  locations: Array<NonNullable<ReturnType<typeof locateElement>>>,
) {
  return locations.map(({ element }) => ({
    elementId: element.id,
    value: element.frame,
  }));
}

function operationInverse(
  document: PresentationDocument,
  operation: DocumentOperation,
): DocumentOperation | DocumentOperation[] {
  switch (operation.type) {
    case "template.create":
      return { type: "template.delete", templateId: operation.template.id };
    case "template.delete":
      return {
        type: "template.create",
        template: document.templates[operation.templateId],
        label: document.deck.templateMeta[operation.templateId].label,
        afterId:
          document.deck.templateIds[
            document.deck.templateIds.indexOf(operation.templateId) - 1
          ] ?? null,
      };
    case "slide.template.set":
    case "slide.independent":
    case "slide.visual.restore":
      return {
        type: "slide.visual.restore",
        slideId: operation.slideId,
        slide: requiredSlide(document, operation.slideId),
        templateId: document.deck.slideMeta[operation.slideId].templateId,
      };
    case "text-style.set":
      return {
        type: "text-style.set",
        ...textStyleInverse(document, operation),
      };
    case "deck.properties.set":
      return {
        type: "deck.properties.set",
        changes: {
          ...(operation.changes.transitionDefaults !== undefined
            ? { transitionDefaults: document.deck.transitionDefaults }
            : {}),
          ...(operation.changes.width !== undefined
            ? { width: document.deck.width }
            : {}),
          ...(operation.changes.height !== undefined
            ? { height: document.deck.height }
            : {}),
          ...(operation.changes.name !== undefined
            ? { name: document.deck.name }
            : {}),
          ...(operation.changes.stylesheet !== undefined
            ? { stylesheet: document.deck.stylesheet ?? "" }
            : {}),
        },
      };
    case "deck.layers.set": {
      const nextIds = new Set(operation.layers.map(({ id }) => id));
      const removedIds = new Set(
        document.deck.layers
          .map(({ id }) => id)
          .filter((id) => !nextIds.has(id)),
      );
      const restoreRoots: Record<
        string,
        Record<string, Slide["nodes"][number]>
      > = {};
      if (removedIds.size) {
        for (const [slideId, slide] of Object.entries({
          ...document.slides,
          ...document.templates,
        })) {
          const roots = Object.fromEntries(
            slide.nodes
              .filter((root) => removedIds.has(root.id))
              .map((root) => [root.id, root]),
          );
          if (Object.keys(roots).length) restoreRoots[slideId] = roots;
        }
      }
      return {
        type: "deck.layers.set",
        layers: document.deck.layers,
        ...(Object.keys(restoreRoots).length ? { restoreRoots } : {}),
      };
    }
    case "deck.guides.set":
      return {
        type: "deck.guides.set",
        guideSets: document.deck.guideSets,
        defaultGuideSetId: document.deck.defaultGuideSetId,
      };
    case "slide.create":
    case "slide.duplicate":
      return { type: "slide.delete", slideId: operation.slide.id };
    case "slide.delete": {
      const index = document.deck.slideIds.indexOf(operation.slideId);
      if (index < 0) throw new Error("Unknown slide");
      return {
        type: "slide.create",
        slide: requiredSlide(document, operation.slideId),
        meta: document.deck.slideMeta[operation.slideId],
        afterId: index > 0 ? document.deck.slideIds[index - 1] : null,
      };
    }
    case "slide.reorder": {
      const index = document.deck.slideIds.indexOf(operation.slideId);
      if (index < 0) throw new Error("Unknown slide");
      return {
        type: "slide.reorder",
        slideId: operation.slideId,
        afterId: index > 0 ? document.deck.slideIds[index - 1] : null,
      };
    }
    case "slide.meta.set":
      return {
        type: "slide.meta.set",
        slideId: operation.slideId,
        meta: document.deck.slideMeta[operation.slideId],
      };
    case "slide.effects.set": {
      const slide = requiredSlide(document, operation.slideId);
      return {
        type: "slide.effects.set",
        slideId: slide.id,
        ...(operation.resources !== undefined
          ? { resources: slide.effectResources ?? null }
          : {}),
        ...(operation.changes
          ? {
              changes: operation.changes.map((c) => ({
                elementId: c.elementId,
                value: findElement(slide, c.elementId)?.effects ?? null,
              })),
            }
          : {}),
        motion: slide.motion ?? null,
      };
    }
    case "slide.motion.set":
      return {
        type: "slide.motion.set",
        slideId: operation.slideId,
        motion: requiredSlide(document, operation.slideId).motion ?? null,
      };
    case "slide.notes.set":
      return {
        type: "slide.notes.set",
        slideId: operation.slideId,
        notes: requiredSlide(document, operation.slideId).notes,
      };
    case "slide.background.set":
      return {
        type: "slide.background.set",
        slideId: operation.slideId,
        background: requiredSlide(document, operation.slideId).background,
      };
    case "elements.insert":
      return {
        type: "elements.remove",
        slideId: operation.slideId,
        elementIds: operation.elements.map(({ id }) => id),
      };
    case "elements.remove": {
      const slide = requiredSlide(document, operation.slideId);
      const locations = operation.elementIds.map((id) =>
        locateElement(slide, id),
      );
      if (locations.some((location) => !location))
        throw new Error("Unknown Element in removal");
      const ordered = (
        locations as Array<NonNullable<(typeof locations)[number]>>
      ).sort((a, b) =>
        a.parentId === b.parentId
          ? a.index - b.index
          : a.parentId.localeCompare(b.parentId),
      );
      return ordered.map(({ parentId, index, element }) => ({
        type: "elements.insert" as const,
        slideId: operation.slideId,
        parentId,
        index,
        elements: [element],
      }));
    }
    case "elements.reorder": {
      const location = locateElement(
        requiredSlide(document, operation.slideId),
        operation.elementId,
      );
      if (!location) throw new Error(`Unknown Element: ${operation.elementId}`);
      return {
        type: "elements.reorder",
        slideId: operation.slideId,
        elementId: operation.elementId,
        index: location.index,
      };
    }
    case "elements.reparent": {
      const slide = requiredSlide(document, operation.slideId);
      const locations = operation.elementIds.map((id) =>
        locateElement(slide, id),
      );
      if (locations.some((location) => !location))
        throw new Error("Unknown Element in reparent");
      const ordered = (
        locations as Array<NonNullable<(typeof locations)[number]>>
      ).sort((a, b) => a.index - b.index);
      const parentId = ordered[0].parentId;
      if (ordered.some((location) => location.parentId !== parentId))
        throw new Error("Reparent selection requires one source scope");
      return [
        {
          type: "elements.reparent",
          slideId: operation.slideId,
          elementIds: ordered.map(({ element }) => element.id),
          parentId,
          index: ordered[0].index,
        },
        ...[...ordered]
          .sort((a, b) => b.index - a.index)
          .map(({ element, index }): DocumentOperation => ({
            type: "elements.reorder",
            slideId: operation.slideId,
            elementId: element.id,
            index,
          })),
        {
          type: "elements.frame.set",
          slideId: operation.slideId,
          changes: frameChanges(ordered),
        },
      ];
    }
    case "elements.replace": {
      const slide = requiredSlide(document, operation.slideId);
      return {
        type: "elements.replace",
        slideId: operation.slideId,
        elements: operation.elements.map(({ id }) => {
          const element = findElement(slide, id);
          if (!element) throw new Error(`Unknown Element: ${id}`);
          return element;
        }),
      };
    }
    case "elements.frame": {
      const slide = requiredSlide(document, operation.slideId);
      const locations = operation.elementIds.map((id) =>
        locateElement(slide, id),
      );
      if (locations.some((location) => !location))
        throw new Error("Unknown Element in frame selection");
      const ordered = (
        locations as Array<NonNullable<(typeof locations)[number]>>
      ).sort((a, b) => a.index - b.index);
      const parentId = ordered[0].parentId;
      if (ordered.some((location) => location.parentId !== parentId))
        throw new Error("Frame selection requires one source scope");
      return [
        {
          type: "elements.unframe",
          slideId: operation.slideId,
          frameId: operation.frameId,
        },
        {
          type: "elements.reparent",
          slideId: operation.slideId,
          elementIds: ordered.map(({ element }) => element.id),
          parentId,
          index: ordered[0].index,
        },
        ...[...ordered]
          .sort((a, b) => b.index - a.index)
          .map(({ element, index }): DocumentOperation => ({
            type: "elements.reorder",
            slideId: operation.slideId,
            elementId: element.id,
            index,
          })),
        {
          type: "elements.frame.set",
          slideId: operation.slideId,
          changes: frameChanges(ordered),
        },
      ];
    }
    case "elements.unframe": {
      const slide = requiredSlide(document, operation.slideId);
      const location = locateElement(slide, operation.frameId);
      if (!location) throw new Error(`Unknown Element: ${operation.frameId}`);
      const frame = location.element;
      if (!frame.children.length)
        return {
          type: "elements.insert",
          slideId: operation.slideId,
          parentId: location.parentId,
          index: location.index,
          elements: [frame],
        };
      return [
        {
          type: "elements.frame",
          slideId: operation.slideId,
          elementIds: frame.children.map(({ id }) => id),
          frameId: frame.id,
        },
        {
          type: "elements.frame.set",
          slideId: operation.slideId,
          changes: [
            { elementId: frame.id, value: frame.frame },
            ...frame.children.map((child) => ({
              elementId: child.id,
              value: child.frame,
            })),
          ],
        },
        {
          type: "elements.appearance.set",
          slideId: operation.slideId,
          changes: [{ elementId: frame.id, value: frame.appearance }],
        },
        {
          type: "elements.geometry.set",
          slideId: operation.slideId,
          changes: [{ elementId: frame.id, value: frame.geometry }],
        },
        {
          type: "elements.content.set",
          slideId: operation.slideId,
          changes: [{ elementId: frame.id, value: frame.content }],
        },
        {
          type: "elements.container.set",
          slideId: operation.slideId,
          changes: [
            {
              elementId: frame.id,
              value: {
                container: frame.container,
                clipChildren: frame.clipChildren,
              },
            },
          ],
        },
      ];
    }
    case "elements.frame.set":
    case "elements.appearance.set":
    case "elements.geometry.set":
    case "elements.content.set":
    case "elements.container.set": {
      const slide = requiredSlide(document, operation.slideId);
      const changes = operation.changes.map(({ elementId }) => {
        const element = findElement(slide, elementId);
        if (!element) throw new Error(`Unknown Element: ${elementId}`);
        const value =
          operation.type === "elements.frame.set"
            ? element.frame
            : operation.type === "elements.appearance.set"
              ? element.appearance
              : operation.type === "elements.geometry.set"
                ? element.geometry
                : operation.type === "elements.content.set"
                  ? element.content
                  : {
                      container: element.container,
                      clipChildren: element.clipChildren,
                    };
        return { elementId, value };
      });
      return { ...operation, changes } as DocumentOperation;
    }
  }
}

function prependInverse(
  inverses: DocumentOperation[],
  before: PresentationDocument,
  operation: DocumentOperation,
  after: PresentationDocument,
  inverse: DocumentOperation | DocumentOperation[],
) {
  const restoreMotion: DocumentOperation[] = [];
  if (
    operation.type !== "slide.motion.set" &&
    operation.type !== "slide.effects.set"
  ) {
    // Page operations cannot change unrelated Motion. Deck operations retain broad fallback.
    const ids =
      "slideId" in operation ? [operation.slideId] : Object.keys(before.slides);
    for (const id of ids) {
      const slide = before.slides[id];
      if (
        slide &&
        after.slides[id] &&
        JSON.stringify(slide.motion) !== JSON.stringify(after.slides[id].motion)
      )
        restoreMotion.push({
          type: "slide.motion.set",
          slideId: id,
          motion: slide.motion ?? null,
        });
    }
  }
  inverses.unshift(
    ...(Array.isArray(inverse) ? inverse : [inverse]),
    ...restoreMotion,
  );
}

export function inverseOperations(
  document: PresentationDocument,
  operations: readonly DocumentOperation[],
) {
  const inverses: DocumentOperation[] = [];
  let inverse: DocumentOperation | DocumentOperation[];
  applyDocumentOperations(document, operations, {
    before: (before, operation) => {
      inverse = operationInverse(before, operation);
    },
    after: (before, operation, after) =>
      prependInverse(inverses, before, operation, after, inverse),
  });
  return inverses;
}

export function scopesForOperations(
  document: PresentationDocument | EditorSnapshot,
  operations: readonly DocumentOperation[],
) {
  let cursor: ScopeSource = document;
  const result: EditScope[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < operations.length; index++) {
    const operation = documentOperationSchema.parse(operations[index]);
    for (const scope of requiredScopes(cursor, operation)) {
      const key = scopeKey(scope);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(scope);
      }
    }
    if (index === operations.length - 1) break;
    if ("slides" in cursor) {
      cursor = applyDocumentOperations(cursor, [operation]);
    } else {
      const projected = applyDocumentOperationsToProjection(cursor, [
        operation,
      ]);
      if (!projected) {
        if (index !== operations.length - 1)
          throw new Error(
            "Cannot derive later edit scopes after deleting the projected slide",
          );
        break;
      }
      cursor =
        operation.type === "slide.create" ||
        operation.type === "slide.duplicate"
          ? { ...projected, slide: structuredClone(operation.slide) }
          : projected;
    }
  }
  return result;
}

export class DocumentAuthority {
  private current: PresentationDocument;
  private sequence: number;
  private saved: number;
  readonly epoch: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly durableCommit?: DocumentAuthorityOptions["durableCommit"];
  private readonly onAccepted?: DocumentAuthorityOptions["onAccepted"];
  private leases = new Map<string, LeaseGrant>();
  private leaseGenerations = new Map<string, number>();
  private accepted = new Map<string, AcceptedRecord>();
  private history: HistoryEntry[] = [];
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(
    document: PresentationDocument,
    options: DocumentAuthorityOptions = {},
  ) {
    this.current = document;
    this.sequence = options.revision ?? 0;
    this.saved = options.savedRevision ?? this.sequence;
    this.epoch = options.epoch ?? defaultIdFactory();
    this.leaseMs = options.leaseMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.durableCommit = options.durableCommit;
    this.onAccepted = options.onAccepted;
  }

  snapshot(): AuthoritySnapshot {
    return {
      document: this.current,
      epoch: this.epoch,
      revision: this.sequence,
      savedRevision: this.saved,
    };
  }

  get document() {
    return this.current;
  }

  get revision() {
    return this.sequence;
  }

  get savedRevision() {
    return this.saved;
  }

  get dirty() {
    return this.sequence !== this.saved;
  }

  get leaseState() {
    this.expireLeases();
    return [...this.leases.values()];
  }

  owns(actorId: string, scopes: EditScope[]) {
    this.expireLeases();
    return scopes.every((scope) =>
      [...this.leases.values()].some(
        (lease) =>
          lease.actorId === actorId &&
          scopeCoveredBy(this.current, lease.scope, scope),
      ),
    );
  }

  markSaved(revision: number) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > this.sequence
    )
      throw new Error("Invalid saved revision");
    this.saved = revision;
  }

  /** The .sme filename owns the displayed deck name at the storage boundary. */
  syncRuntimeDeckName(name: string) {
    this.current = { ...this.current, deck: { ...this.current.deck, name } };
  }

  expireLeases(now = this.now()) {
    for (const [token, lease] of this.leases)
      if (lease.expiresAt <= now) this.leases.delete(token);
  }

  acquire(actorId: string, rawScopes: EditScope[], now = this.now()) {
    idSchema.parse(actorId);
    const scopes = rawScopes.map((scope) => editScopeSchema.parse(scope));
    this.expireLeases(now);
    const unique = new Map(scopes.map((scope) => [scopeKey(scope), scope]));
    for (const scope of unique.values()) {
      for (const lease of this.leases.values()) {
        if (
          lease.actorId !== actorId &&
          scopesConflict(this.current, scope, lease.scope)
        )
          return {
            denied: true as const,
            scope,
            ownerActorId: lease.actorId,
          };
      }
    }
    const grants: LeaseGrant[] = [];
    for (const scope of unique.values()) {
      const key = scopeKey(scope);
      for (const [token, lease] of this.leases)
        if (lease.actorId === actorId && scopeKey(lease.scope) === key)
          this.leases.delete(token);
      const generation = (this.leaseGenerations.get(key) ?? 0) + 1;
      this.leaseGenerations.set(key, generation);
      const grant = {
        token: this.idFactory(),
        actorId,
        scope,
        generation,
        expiresAt: now + this.leaseMs,
      };
      this.leases.set(grant.token, grant);
      grants.push(grant);
    }
    return { denied: false as const, grants };
  }

  renew(actorId: string, tokens: string[], now = this.now()) {
    this.expireLeases(now);
    const grants: LeaseGrant[] = [];
    for (const token of tokens) {
      const lease = this.leases.get(token);
      if (!lease || lease.actorId !== actorId)
        throw new Error("Lease expired or does not belong to actor");
      const renewed = { ...lease, expiresAt: now + this.leaseMs };
      this.leases.set(token, renewed);
      grants.push(renewed);
    }
    return grants;
  }

  release(actorId: string, tokens?: string[]) {
    const selected = tokens ? new Set(tokens) : null;
    for (const [token, lease] of this.leases)
      if (lease.actorId === actorId && (!selected || selected.has(token)))
        this.leases.delete(token);
  }

  private evaluateTransaction(
    actorId: string,
    transaction: DocumentTransaction,
  ) {
    this.expireLeases();
    const grants = transaction.leaseTokens.map((token) => {
      const lease = this.leases.get(token);
      if (!lease || lease.actorId !== actorId)
        throw new Error("Required edit lease expired");
      return lease;
    });
    const inverses: DocumentOperation[] = [];
    let inverse: DocumentOperation | DocumentOperation[];
    const candidate = applyValidatedDocumentOperations(
      this.current,
      transaction.operations,
      {
        before: (cursor, operation) => {
          for (const scope of requiredScopes(cursor, operation)) {
            if (
              !grants.some(
                (grant) =>
                  grant.actorId === actorId &&
                  scopeCoveredBy(cursor, grant.scope, scope),
              )
            )
              throw new Error(`Missing lease for ${scopeKey(scope)}`);
          }
          inverse = operationInverse(cursor, operation);
        },
        after: (cursor, operation, next) => {
          prependInverse(inverses, cursor, operation, next, inverse);
          if (operation.type === "text-style.set") {
            for (const page of [
              ...Object.values(cursor.slides),
              ...Object.values(cursor.templates),
            ]) {
              const after = editablePage(next, page.id)!;
              for (const e of page.nodes
                .flatMap((r) => r.children)
                .flatMap((e) => flattenSubtree(e))) {
                if (e.content?.type !== "text") continue;
                const changed = findElement(after, e.id);
                if (
                  changed?.content?.type !== "text" ||
                  JSON.stringify(changed.content.format) ===
                    JSON.stringify(e.content.format)
                )
                  continue;
                for (const lease of this.leases.values())
                  if (
                    lease.actorId !== actorId &&
                    scopesConflict(
                      cursor,
                      lease.scope,
                      elementScope(page.id, e.id),
                    )
                  )
                    throw new Error(
                      "Text Style conversion has an active collaborator lease",
                    );
              }
            }
          }
        },
      },
    );
    for (const operation of transaction.operations)
      if (operation.type === "slide.delete") {
        for (const lease of this.leases.values())
          if (
            lease.actorId !== actorId &&
            "slideId" in lease.scope &&
            lease.scope.slideId === operation.slideId
          )
            throw new Error("Slide has an active collaborator lease");
      }
    return { candidate, inverse: inverses };
  }

  private documentAtRevision(revision: number) {
    const accepted = this.acceptedAfter(revision);
    if (accepted === null) return null;
    return applyValidatedDocumentOperations(
      this.current,
      accepted
        .slice()
        .reverse()
        .flatMap((item) => item.inverseOperations),
      undefined,
      true,
    );
  }

  private async commitInternal(
    actorId: string,
    raw: DocumentTransaction,
    recordHistory: boolean,
  ) {
    idSchema.parse(actorId);
    const transaction = documentTransactionSchema.parse(raw);
    if (transaction.documentId !== this.current.documentId)
      throw new Error("Transaction targets another document");
    if (transaction.epoch !== this.epoch)
      throw new Error("Transaction epoch is stale");
    if (transaction.baseRevision > this.sequence)
      throw new Error("Transaction base revision is from the future");

    const fingerprint = transactionFingerprint(transaction);
    const prior = this.accepted.get(transaction.transactionId);
    if (prior) {
      if (prior.actorId !== actorId || prior.fingerprint !== fingerprint)
        throw new Error(
          "Transaction ID reused with different actor or content",
        );
      return prior.accepted;
    }

    const parsedOperations = transaction.operations;
    if (transaction.baseRevision < this.sequence) {
      const baseDocument = this.documentAtRevision(transaction.baseRevision);
      if (!baseDocument)
        throw new Error(
          "Stale transaction cannot be validated because its base revision is no longer available",
        );
      if (
        !sameGuards(
          operationGuards(baseDocument, parsedOperations),
          operationGuards(this.current, parsedOperations),
        )
      )
        throw new Error(
          "Stale transaction conflicts with edits accepted after its base revision",
        );
    }

    const { candidate, inverse } = this.evaluateTransaction(
      actorId,
      transaction,
    );
    const accepted = acceptedTransactionSchema.parse({
      transactionId: transaction.transactionId,
      documentId: transaction.documentId,
      epoch: transaction.epoch,
      actorId,
      revision: this.sequence + 1,
      operations: parsedOperations,
      inverseOperations: inverse,
      ...(transaction.historyGroupId
        ? { historyGroupId: transaction.historyGroupId }
        : {}),
    });

    recordAcceptedImpact(accepted, this.current, candidate);
    await this.durableCommit?.(accepted, candidate);

    this.current = candidate;
    this.sequence = accepted.revision;
    this.accepted.set(transaction.transactionId, {
      actorId,
      fingerprint,
      accepted,
    });
    while (this.accepted.size > RECENT_TRANSACTIONS)
      this.accepted.delete(this.accepted.keys().next().value!);

    if (recordHistory) {
      this.history = this.history.filter(
        (entry) => entry.actorId !== actorId || !entry.undone,
      );
      const priorHistory = [...this.history]
        .reverse()
        .find((entry) => entry.actorId === actorId && !entry.undone);
      if (
        accepted.historyGroupId &&
        priorHistory &&
        priorHistory.historyGroupId === accepted.historyGroupId
      ) {
        priorHistory.transactionIds.push(accepted.transactionId);
        priorHistory.operations.push(...accepted.operations);
        priorHistory.inverseOperations.unshift(...accepted.inverseOperations);
        priorHistory.undoGuards = operationGuards(
          candidate,
          priorHistory.inverseOperations,
        );
      } else {
        this.history.push({
          actorId,
          transactionIds: [accepted.transactionId],
          historyGroupId: accepted.historyGroupId,
          operations: accepted.operations,
          inverseOperations: accepted.inverseOperations,
          undoGuards: operationGuards(candidate, accepted.inverseOperations),
          undone: false,
        });
        while (this.history.length > HISTORY_LIMIT) this.history.shift();
      }
    }

    try {
      this.onAccepted?.(accepted, candidate);
    } catch (error) {
      console.error("Accepted transaction notification failed", error);
    }
    return accepted;
  }

  private enqueueCommit<T>(task: () => Promise<T>): Promise<T> {
    const run = this.commitQueue.then(task);
    this.commitQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private closing = false;

  /** Revoke admissions synchronously, then drain admitted durability/accepted publication. */
  beginClose(): Promise<void> {
    this.closing = true;
    return this.enqueueCommit(async () => {});
  }

  cancelClose() {
    this.closing = false;
  }

  private requireOpen() {
    if (this.closing) throw new Error("Document is closing");
  }

  commit(actorId: string, raw: DocumentTransaction, admit?: CommitAdmission) {
    return this.enqueueCommit(() => {
      this.requireOpen();
      admit?.({
        documentId: this.current.documentId,
        epoch: this.epoch,
        revision: this.sequence,
      });
      return this.commitInternal(actorId, raw, true);
    });
  }

  runExclusive<T>(task: (snapshot: AuthoritySnapshot) => Promise<T>) {
    return this.enqueueCommit(() => task(this.snapshot()));
  }

  private historyTarget(actorId: string, redo: boolean) {
    if (redo)
      return this.history.find(
        (entry) => entry.actorId === actorId && entry.undone,
      );
    return [...this.history]
      .reverse()
      .find((entry) => entry.actorId === actorId && !entry.undone);
  }

  canUndo(actorId: string) {
    return !!this.historyTarget(actorId, false);
  }

  canRedo(actorId: string) {
    return !!this.historyTarget(actorId, true);
  }

  undo(actorId: string, leaseTokens: string[] = [], admit?: CommitAdmission) {
    return this.enqueueCommit(async () => {
      this.requireOpen();
      admit?.({
        documentId: this.current.documentId,
        epoch: this.epoch,
        revision: this.sequence,
      });
      const entry = this.historyTarget(actorId, false);
      if (!entry) throw new Error("Nothing to undo");
      if (
        !sameGuards(
          entry.undoGuards,
          operationGuards(this.current, entry.inverseOperations),
        )
      )
        throw new Error(
          "Undo is no longer safe because later edits changed the affected state",
        );
      let tokens = leaseTokens;
      let acquired: string[] = [];
      if (!tokens.length) {
        const result = this.acquire(
          actorId,
          scopesForOperations(this.current, entry.inverseOperations),
        );
        if (result.denied)
          throw new Error("Undo conflicts with an active edit lease");
        acquired = result.grants.map((grant) => grant.token);
        tokens = acquired;
      }
      try {
        const accepted = await this.commitInternal(
          actorId,
          {
            transactionId: this.idFactory(),
            documentId: this.current.documentId,
            epoch: this.epoch,
            baseRevision: this.sequence,
            leaseTokens: tokens,
            operations: entry.inverseOperations,
          },
          false,
        );
        entry.redoGuards = operationGuards(this.current, entry.operations);
        entry.undone = true;
        return accepted;
      } finally {
        if (acquired.length) this.release(actorId, acquired);
      }
    });
  }

  redo(actorId: string, leaseTokens: string[] = [], admit?: CommitAdmission) {
    return this.enqueueCommit(async () => {
      this.requireOpen();
      admit?.({
        documentId: this.current.documentId,
        epoch: this.epoch,
        revision: this.sequence,
      });
      const entry = this.historyTarget(actorId, true);
      if (!entry) throw new Error("Nothing to redo");
      if (
        !entry.redoGuards ||
        !sameGuards(
          entry.redoGuards,
          operationGuards(this.current, entry.operations),
        )
      )
        throw new Error(
          "Redo is no longer safe because later edits changed the affected state",
        );
      let tokens = leaseTokens;
      let acquired: string[] = [];
      if (!tokens.length) {
        const result = this.acquire(
          actorId,
          scopesForOperations(this.current, entry.operations),
        );
        if (result.denied)
          throw new Error("Redo conflicts with an active edit lease");
        acquired = result.grants.map((grant) => grant.token);
        tokens = acquired;
      }
      try {
        const accepted = await this.commitInternal(
          actorId,
          {
            transactionId: this.idFactory(),
            documentId: this.current.documentId,
            epoch: this.epoch,
            baseRevision: this.sequence,
            leaseTokens: tokens,
            operations: entry.operations,
          },
          false,
        );
        entry.undoGuards = operationGuards(
          this.current,
          entry.inverseOperations,
        );
        entry.redoGuards = undefined;
        entry.undone = false;
        return accepted;
      } finally {
        if (acquired.length) this.release(actorId, acquired);
      }
    });
  }

  acceptedAfter(revision: number) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision > this.sequence
    )
      throw new Error("Invalid revision");
    if (revision === this.sequence) return [];
    const items = [...this.accepted.values()]
      .map((entry) => entry.accepted)
      .filter((entry) => entry.revision > revision)
      .sort((a, b) => a.revision - b.revision);
    if (
      items.length &&
      items[0].revision === revision + 1 &&
      items.at(-1)?.revision === this.sequence
    )
      return items;
    return null;
  }
}
