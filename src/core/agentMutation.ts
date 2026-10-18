import { z } from "zod/v4";
import { createBasicShape } from "./elementFactory";
import {
  insertElements,
  removeElements,
  replaceElement,
  setElementAppearances,
  setElementFramesPreservingContent,
  translateElements,
  type EditorSnapshot,
} from "./editorCommands";
import { editorOperations } from "./editorChange";
import { getChildren, getOwningLayer, locateElement } from "./scene";
import { getWorldMatrix } from "./scene";
import { transformPoint, type Element } from "./element";
import { IDENTITY } from "./element";
import {
  insertText,
  updateText,
  type TextMeasurement,
  type TextContent,
} from "./text";
import { resolveTextTypography } from "./textTypography";
import type { DocumentProjection } from "./documentProjection";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const number = z.number().finite();
const point = z.object({ x: number, y: number }).strict();
const frame = point
  .extend({
    width: number.positive().max(100000),
    height: number.positive().max(100000),
  })
  .strict();
const color = z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/);
const appearance = z
  .object({
    fill: color.nullable().optional(),
    strokeColor: color.optional(),
    strokeWidth: number.nonnegative().optional(),
    opacity: number.min(0).max(1).optional(),
    radius: number.nonnegative().optional(),
  })
  .strict();
const ids = z.array(id).min(1).max(128);
export const agentApplyRequestSchema = z
  .object({
    documentId: id,
    epoch: id,
    expectedRevision: z.number().int().nonnegative(),
    mutationId: id,
    slideId: id,
    operations: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("text.set"),
              elementId: id,
              text: z.string().max(100000),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.move"),
              elementIds: ids,
              scopeId: id,
              dx: number,
              dy: number,
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.frame.set"),
              elementId: id,
              frame,
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.appearance.patch"),
              elementIds: ids,
              patch: appearance,
            })
            .strict(),
          z
            .object({
              type: z.literal("element.insert_text"),
              parentId: id,
              center: point,
              text: z.string().max(100000),
              name: z.string().max(200).optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("element.insert_shape"),
              parentId: id,
              shape: z.enum(["rectangle", "ellipse"]),
              frame,
              appearance: appearance.optional(),
              name: z.string().max(200).optional(),
            })
            .strict(),
          z
            .object({ type: z.literal("elements.remove"), elementIds: ids })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type AgentApplyRequest = z.infer<typeof agentApplyRequestSchema>;
export class AgentMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stepIndex?: number,
    readonly actualRevision?: number,
  ) {
    super(message);
  }
}
export type AgentTextMeasure = (
  element: Element & { content: TextContent },
) => Promise<TextMeasurement | null>;
function forest(snapshot: EditorSnapshot) {
  const entries = new Map<string, Element>();
  const visit = (element: Element) => {
    entries.set(element.id, element);
    element.children.forEach(visit);
  };
  snapshot.slide.nodes.forEach((root) => root.children.forEach(visit));
  return entries;
}
export function mutationChanges(before: EditorSnapshot, after: EditorSnapshot) {
  const a = forest(before),
    b = forest(after);
  const createdIds = [...b.keys()].filter((id) => !a.has(id));
  const removedIds = [...a.keys()].filter((id) => !b.has(id));
  const changedIds = [...b.keys()].filter(
    (id) =>
      a.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)),
  );
  return { createdIds, removedIds, changedIds };
}
/** Detached staging only. Persistent state belongs exclusively to EditorSession/authority. */
export async function assembleAgentMutation(
  projection: DocumentProjection,
  request: AgentApplyRequest,
  measure: AgentTextMeasure,
  newId = () => crypto.randomUUID(),
) {
  if (
    !projection.deck.slideIds.includes(request.slideId) ||
    projection.slide.id !== request.slideId
  )
    throw new AgentMutationError(
      "UNKNOWN_SLIDE",
      "Edit an explicit presentation slide.",
    );
  let next: EditorSnapshot = projection;
  const targets = new Set(
    request.operations.flatMap((op) =>
      "elementIds" in op
        ? op.elementIds
        : "elementId" in op
          ? [op.elementId]
          : [],
    ),
  );
  if (targets.size > 128)
    throw new AgentMutationError(
      "PAYLOAD_TOO_LARGE",
      "Target at most 128 existing elements per request.",
    );
  const initialIds = new Set(forest(projection).keys());
  const requireEditable = (elementId: string) => {
    const location = locateElement(next.slide, elementId);
    if (!initialIds.has(elementId) || !location)
      throw new AgentMutationError(
        "UNKNOWN_ELEMENT",
        "Inspect the slide-owned element IDs again.",
      );
    const layer = next.deck.layers.find(
      (layer) => layer.id === location.layerId,
    );
    if (!layer || layer.locked || layer.hidden)
      throw new AgentMutationError(
        "TARGET_NOT_EDITABLE",
        "The element's layer must be visible and unlocked.",
      );
    return location.element;
  };
  const requireParent = (parentId: string) => {
    if (!getChildren(next.slide, parentId))
      throw new AgentMutationError(
        "INVALID_SCOPE",
        "Use an explicit editable layer or container.",
      );
    if (!next.slide.nodes.some((root) => root.id === parentId))
      requireEditable(parentId);
    const layerId = getOwningLayer(next.slide, parentId)?.id;
    const layer = next.deck.layers.find((layer) => layer.id === layerId);
    if (!layer || layer.locked || layer.hidden)
      throw new AgentMutationError(
        "TARGET_NOT_EDITABLE",
        "The parent layer must be visible and unlocked.",
      );
  };
  const setText = async (elementId: string, text: string) => {
    next = updateText(next, elementId, { text, placeholder: false });
    const element = locateElement(next.slide, elementId)!.element;
    if (element.content?.type !== "text")
      throw new AgentMutationError(
        "UNSUPPORTED_OPERATION",
        "Text replacement requires a text element.",
      );
    if (element.content.autoSize === "none") return;
    const measured = await measure({
      ...element,
      content: {
        ...element.content,
        format: {
          kind: "local",
          typography: resolveTextTypography(next.deck, element.content),
        },
      },
    });
    if (
      !measured ||
      !Number.isFinite(measured.width) ||
      !Number.isFinite(measured.height) ||
      measured.width < 0 ||
      measured.height < 0
    )
      throw new AgentMutationError(
        "MEASUREMENT_UNAVAILABLE",
        "Production text measurement is unavailable. Retry when the editor is ready.",
      );
    next = updateText(
      next,
      elementId,
      { text, placeholder: false },
      () => measured,
    );
  };
  for (let stepIndex = 0; stepIndex < request.operations.length; stepIndex++) {
    const op = request.operations[stepIndex];
    try {
      if ("elementIds" in op) op.elementIds.forEach(requireEditable);
      if ("elementId" in op) requireEditable(op.elementId);
      if (op.type === "text.set") {
        if (requireEditable(op.elementId).content?.type !== "text")
          throw new AgentMutationError(
            "UNSUPPORTED_OPERATION",
            "Text replacement requires a text element.",
          );
        await setText(op.elementId, op.text);
      } else if (op.type === "elements.move") {
        requireParent(op.scopeId);
        next = translateElements(next, op.elementIds, op.dx, op.dy, op.scopeId);
      } else if (op.type === "elements.frame.set") {
        const element = requireEditable(op.elementId);
        next = setElementFramesPreservingContent(next, [
          { elementId: op.elementId, value: { ...element.frame, ...op.frame } },
        ]);
      } else if (op.type === "elements.appearance.patch") {
        if (!Object.keys(op.patch).length)
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "Supply a nonempty appearance patch.",
          );
        next = setElementAppearances(
          next,
          [...new Set(op.elementIds)].map((elementId) => ({
            elementId,
            value: { ...requireEditable(elementId).appearance, ...op.patch },
          })),
        );
      } else if (op.type === "elements.remove")
        next = removeElements(next, op.elementIds);
      else {
        requireParent(op.parentId);
        const elementId = newId();
        if (forest(next).has(elementId))
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "An inserted identity conflicted. Retry with a new mutation ID.",
          );
        if (op.type === "element.insert_text") {
          const matrix = next.slide.nodes.some(
            (root) => root.id === op.parentId,
          )
            ? IDENTITY
            : getWorldMatrix(next.slide, op.parentId);
          const inserted = insertText(
            next,
            op.parentId,
            transformPoint(matrix, op.center),
            elementId,
          );
          if (inserted.scopeId !== op.parentId)
            throw new AgentMutationError(
              "INVALID_SCOPE",
              "The insertion parent is not editable.",
            );
          next = inserted.snapshot;
          if (op.name !== undefined) {
            const element = locateElement(next.slide, elementId)!.element;
            const named = { ...element, name: op.name };
            next = replaceElement(next, elementId, named);
          }
          await setText(elementId, op.text);
        } else {
          const element = createBasicShape(elementId, op.shape, op.frame);
          element.frame = { ...element.frame, ...op.frame };
          element.appearance = { ...element.appearance, ...op.appearance };
          if (op.name !== undefined) element.name = op.name;
          next = insertElements(next, [element], op.parentId);
        }
      }
      if (editorOperations(next).length > 256)
        throw new AgentMutationError(
          "PAYLOAD_TOO_LARGE",
          "Use fewer editing steps.",
        );
    } catch (error) {
      if (error instanceof AgentMutationError)
        throw new AgentMutationError(
          error.code,
          error.message,
          stepIndex,
          error.actualRevision,
        );
      throw new AgentMutationError(
        "INVALID_SCOPE",
        "The native command rejected this target or coordinate scope.",
        stepIndex,
      );
    }
  }
  const changes = mutationChanges(projection, next);
  if (
    new Set([
      ...changes.createdIds,
      ...changes.changedIds,
      ...changes.removedIds,
    ]).size > 128
  )
    throw new AgentMutationError(
      "PAYLOAD_TOO_LARGE",
      "Edit at most 128 affected elements, including descendants.",
    );
  return { snapshot: next, ...changes };
}
