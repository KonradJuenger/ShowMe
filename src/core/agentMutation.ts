import { z } from "zod/v4";
import { createBasicShape, createEmptyFrame } from "./elementFactory";
import type { Asset } from "./assets";
import {
  insertElements,
  removeElements,
  replaceElement,
  setElementAppearances,
  setElementFramesPreservingContent,
  translateElements,
  createSlide,
  duplicateSlideWithResult,
  deleteSlide,
  setSlideBackground,
  setSlideNotes,
  updateSlideMeta,
  setDeckProperties,
  reorderSlides,
  reorderElements,
  reparentElements,
  frameElements,
  unframeElement,
  duplicateElementsWithResult,
  setElementEffectDefinition,
  setElementEffectParameterValue,
  setSlideEffects,
  setSlideMotion,
  type EditorSnapshot,
} from "./editorCommands";
import { editorOperations, setEditorOperations } from "./editorChange";
import { getChildren, getOwningLayer, locateElement } from "./scene";
import { getWorldMatrix } from "./scene";
import {
  transformPoint,
  isNeutralFrame,
  resolveMediaFrame,
  walkElements,
  type Element,
  type MediaContent,
} from "./element";
import { IDENTITY } from "./element";
import {
  insertText,
  updateText,
  type TextMeasurement,
  type TextContent,
  type TextPatch,
} from "./text";
import { resolveTextTypography, textStyleNameKey } from "./textTypography";
import type { DocumentProjection } from "./documentProjection";
import { applyTemplate, makeIndependent } from "./templateCommands";
import { alignSelection, distributeSelection } from "./arrangeCommands";
import { setSelectionProperty } from "./elementProperties";
import {
  addLayer,
  changeLayer,
  deleteLayer,
  reorderLayers,
} from "./layerActions";
import {
  centerMedia,
  convertMediaRule,
  createMediaElement,
  isMediaContent,
  mediaIntrinsic,
  resetMedia,
  setMediaContent,
  updateMediaFromResolved,
} from "./media";
import {
  createTextStyleFromElement,
  setTextStyle,
  updateTextStyleFromElement,
} from "./textStyleCommands";
import {
  addMotionPreset,
  addParameterAnimation,
  motionEaseFromName,
} from "./motion";
import { addPresence } from "./presence";
import {
  motionProperties,
  type MotionProperty,
} from "./motionModel";
import {
  EFFECT_STRING_LIMIT,
  effectDefinitionSchema,
  numericEffectParameter,
  reconcileShaderSource,
  type EffectDefinition,
} from "./effects";
import {
  blankEffect,
  changeEffectAffects,
  type EffectAffects,
} from "./effectAuthoring";
import type { EffectDefinitionValidator } from "./effectValidation";
import { uid } from "./ids";
import {
  slideTransitionSchema,
  transitionDefaultsSchema,
} from "./slideTransitions";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const number = z.number().finite();
const point = z.object({ x: number, y: number }).strict();
const frame = point
  .extend({
    width: number.positive().max(100000),
    height: number.positive().max(100000),
    rotation: number.min(-360000).max(360000).optional(),
    scaleX: number.positive().max(10000).optional(),
    scaleY: number.positive().max(10000).optional(),
    originX: number.min(0).max(1).optional(),
    originY: number.min(0).max(1).optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
  })
  .strict();
const optionalId = id.optional();
const assetId = z.string().regex(/^[a-f0-9]{64}$/);
const childIndex = z.number().int().min(0).max(100000);
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
const typography = z
  .object({
    fontFamily: z.string().trim().min(1).max(200).optional(),
    fontSize: number.positive().max(512).optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    lineHeight: number.min(0.5).max(5).optional(),
    letterSpacing: number.min(-100).max(500).optional(),
  })
  .strict();
const autoSize = z.enum(["none", "height", "both"]);
const background = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const layerPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    color: background.optional(),
  })
  .strict();
const cssClass = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
  .max(100);
const cssClasses = z
  .array(cssClass)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate CSS class",
  );
const stageIndex = z.number().int().nonnegative().max(10000);
const effectParameterKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine(
    (key) =>
      !key.startsWith("u_") &&
      !["resolution", "size"].includes(key) &&
      key !== "stepIndex",
    "Reserved runtime input name",
  );
const effectParameterBase = {
  key: effectParameterKey,
  label: z.string().min(1).max(100),
};
const agentEffectParameterSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...effectParameterBase,
        type: z.literal("number"),
        default: z.number().finite(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict(),
    z
      .object({
        ...effectParameterBase,
        type: z.literal("boolean"),
        default: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...effectParameterBase,
        type: z.literal("string"),
        default: z.string().max(EFFECT_STRING_LIMIT),
      })
      .strict(),
  ])
  .refine(
    (parameter) =>
      parameter.type !== "number" ||
      parameter.min === undefined ||
      parameter.max === undefined ||
      parameter.min <= parameter.max,
    "Invalid parameter range",
  );
const agentEffectParameterValueSchema = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(EFFECT_STRING_LIMIT),
]);
const agentEffectTimeControlSchema = z
  .object({
    start: z.enum(["presentation", "slide", "click"]),
    stop: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }).strict(),
      z.object({ mode: z.literal("next-click") }).strict(),
      z.object({ mode: z.literal("slide-end") }).strict(),
      z
        .object({
          mode: z.literal("after"),
          durationMs: z.number().int().positive().max(86400000),
        })
        .strict(),
    ]),
  })
  .strict();
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
              type: z.literal("slide.create"),
              afterId: id.nullable(),
              name: z.string().trim().min(1).max(200),
              background: background.optional(),
              id: optionalId,
            })
            .strict(),
          z
            .object({
              type: z.literal("slide.duplicate"),
              afterId: id.nullable().optional(),
              name: z.string().trim().min(1).max(200).optional(),
              id: optionalId,
            })
            .strict(),
          z.object({ type: z.literal("slide.delete") }).strict(),
          z
            .object({
              type: z.literal("slide.move"),
              afterId: id.nullable(),
            })
            .strict(),
          z
            .object({
              type: z.literal("slide.update"),
              name: z.string().trim().min(1).max(200).optional(),
              background: background.optional(),
              hidden: z.boolean().optional(),
              notes: z.string().max(100000).optional(),
              transition: slideTransitionSchema.nullable().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("slide.template.apply"),
              templateId: id,
            })
            .strict(),
          z.object({ type: z.literal("slide.make_independent") }).strict(),
          z
            .object({
              type: z.literal("deck.rename"),
              name: z.string().trim().min(1).max(200),
            })
            .strict(),
          z
            .object({
              type: z.literal("deck.stylesheet.set"),
              source: z.string().max(100000),
            })
            .strict(),
          z
            .object({
              type: z.literal("deck.dimensions.set"),
              width: number.positive().max(100000),
              height: number.positive().max(100000),
            })
            .strict(),
          z
            .object({
              type: z.literal("deck.transition_defaults.set"),
              value: transitionDefaultsSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal("layer.create"),
              id: optionalId,
              patch: layerPatch.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("layer.update"),
              layerId: id,
              patch: layerPatch,
            })
            .strict(),
          z
            .object({
              type: z.literal("layer.delete"),
              layerId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("layer.reorder"),
              layerIds: z.array(id).min(1).max(128),
              index: childIndex,
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.apply"),
              elementIds: ids,
              styleId: id.nullable(),
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.clear_overrides"),
              elementIds: ids,
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.create"),
              elementId: id,
              name: z.string().trim().min(1).max(200),
              styleId: optionalId,
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.update"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.rename"),
              styleId: id,
              name: z.string().trim().min(1).max(200),
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style.delete"),
              styleId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("text.style"),
              elementId: id,
              typography: typography.optional(),
              autoSize: autoSize.optional(),
            })
            .strict(),
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
              type: z.literal("elements.css_classes.set"),
              elementIds: ids,
              classes: cssClasses,
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.reorder"),
              parentId: id,
              elementIds: ids,
              mode: z.enum(["front", "back", "forward", "backward"]),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.align"),
              scopeId: id,
              elementIds: ids,
              axis: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.distribute"),
              scopeId: id,
              elementIds: ids,
              axis: z.enum(["evenly", "horizontal", "vertical"]),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.duplicate"),
              elementIds: ids,
              offset: point.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.reparent"),
              elementIds: ids,
              parentId: id,
              index: childIndex.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.group"),
              elementIds: ids.min(2),
              id: optionalId,
              name: z.string().max(200).optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("elements.ungroup"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.fit"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.fill"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.free"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.content_center"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.content_reset"),
              elementId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("frame.content_transform.set"),
              elementId: id,
              frame,
            })
            .strict(),
          z
            .object({
              type: z.literal("media.transform.patch"),
              elementId: id,
              patch: z
                .object({
                  rotation: number.min(-360000).max(360000).optional(),
                  flipX: z.boolean().optional(),
                  flipY: z.boolean().optional(),
                  zoom: number.positive().max(100).optional(),
                  anchorX: number.min(0).max(1).optional(),
                  anchorY: number.min(0).max(1).optional(),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              type: z.literal("video.playback.patch"),
              elementId: id,
              patch: z
                .object({
                  volume: number.min(0).max(1).optional(),
                  mute: z.boolean().optional(),
                  loop: z.boolean().optional(),
                  autoplay: z.boolean().optional(),
                  startTime: number.min(0).max(86400).optional(),
                  endTime: number.min(0).max(86400).nullable().optional(),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              type: z.literal("effect.apply_code"),
              elementId: id,
              name: z.string().trim().min(1).max(100),
              effectType: z.enum(["shader", "css", "text-js"]),
              affects: z.enum([
                "pixels",
                "backdrop",
                "generated",
                "element",
                "text",
              ]),
              source: z.string().min(1).max(100000),
              styleSource: z.string().max(100000).optional(),
              speed: z.number().finite().nonnegative().max(100).optional(),
              timeControl: agentEffectTimeControlSchema.optional(),
              parameters: z.array(agentEffectParameterSchema).max(32).optional(),
              existingInstanceId: id.optional(),
              stageIndex: stageIndex.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("effect.parameter.set"),
              elementId: id,
              effectInstanceId: id,
              key: z.string().min(1).max(64),
              value: agentEffectParameterValueSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal("effect.enabled.set"),
              elementId: id,
              effectInstanceId: id,
              enabled: z.boolean(),
            })
            .strict(),
          z
            .object({
              type: z.literal("effect.remove"),
              elementId: id,
              effectInstanceId: id,
            })
            .strict(),
          z
            .object({
              type: z.literal("background.shader.create"),
              name: z.string().trim().min(1).max(100),
              source: z.string().min(1).max(100000),
              speed: z.number().finite().nonnegative().max(100).optional(),
              timeControl: agentEffectTimeControlSchema.optional(),
              parameters: z.array(agentEffectParameterSchema).max(32).optional(),
              stageIndex: stageIndex.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("motion.add_preset"),
              stageIndex,
              elementIds: ids,
              preset: z.enum(["Move", "Scale", "Rotate", "Fade", "Pulse"]),
            })
            .strict(),
          z
            .object({
              type: z.literal("motion.animate"),
              stageIndex,
              elementId: id,
              property: z.string().min(1).max(200),
              from: number,
              to: number,
              durationMs: z.number().int().min(1).max(86400000),
              ease: z
                .enum(["Linear", "Ease In", "Ease Out", "Ease In Out", "Hold"])
                .optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("presence.add"),
              stageIndex,
              elementIds: ids,
            })
            .strict(),
          z
            .object({
              type: z.literal("element.insert_text"),
              parentId: id,
              frame,
              text: z.string().max(100000),
              name: z.string().max(200).optional(),
              typography: typography.optional(),
              autoSize: autoSize.optional(),
              id: optionalId,
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
              id: optionalId,
            })
            .strict(),
          z
            .object({
              type: z.literal("element.insert_frame"),
              parentId: id,
              frame,
              appearance: appearance.optional(),
              name: z.string().max(200).optional(),
              id: optionalId,
            })
            .strict(),
          z
            .object({
              type: z.literal("element.insert_media"),
              parentId: id,
              assetId,
              frame,
              name: z.string().max(200).optional(),
              id: optionalId,
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
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export type AgentTextMeasure = (
  element: Element & { content: TextContent },
) => Promise<TextMeasurement | null>;
export type AgentEffectValidate = EffectDefinitionValidator;
export type AgentAssetResolve = (
  assetId: string,
) => Promise<Asset> | Asset;
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
  validateEffect?: AgentEffectValidate,
  resolveAsset?: AgentAssetResolve,
  replacementSlide?: import("./document").Slide,
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
  const createdEffectInstanceIds: string[] = [];
  const updatedEffectInstanceIds: string[] = [];
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
  const templateElementIds = new Set(
    Object.values(projection.templates ?? {}).flatMap((template) =>
      walkElements(template.nodes.flatMap((root) => root.children)).map(
        ({ id }) => id,
      ),
    ),
  );
  const createdThisBatch = new Set<string>();
  const idMap: Record<string, string> = {};
  const createdTextStyleIds: string[] = [];
  const createdLayerIds: string[] = [];
  const requireEditable = (elementId: string) => {
    const location = locateElement(next.slide, elementId);
    if (!location) {
      const templateId = next.deck.slideMeta[next.slide.id]?.templateId;
      const template = templateId ? next.templates?.[templateId] : undefined;
      const templateOwns = template
        ? walkElements(template.nodes.flatMap((root) => root.children)).some(
            ({ id }) => id === elementId,
          )
        : false;
      if (templateOwns)
        throw new AgentMutationError(
          "TEMPLATE_OWNED",
          "The target belongs to the applied Template.",
          undefined,
          undefined,
          { suggestedOperation: "slide.make_independent" },
        );
      throw new AgentMutationError(
        "UNKNOWN_ELEMENT",
        "Inspect the slide-owned element IDs again.",
      );
    }
    if (
      !initialIds.has(elementId) &&
      !createdThisBatch.has(elementId) &&
      !templateElementIds.has(elementId)
    )
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
  const setText = async (elementId: string, patch: TextPatch) => {
    next = updateText(next, elementId, patch);
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
    next = updateText(next, elementId, {}, () => measured);
  };
  type ApplyEffectCode = Extract<
    AgentApplyRequest["operations"][number],
    { type: "effect.apply_code" }
  >;
  const effectDefinition = (
    op: Omit<ApplyEffectCode, "type" | "elementId">,
    existing?: EffectDefinition,
  ): EffectDefinition => {
    const shader = op.effectType === "shader";
    if (
      (shader && !["pixels", "backdrop", "generated"].includes(op.affects)) ||
      (op.effectType === "css" && op.affects !== "element") ||
      (op.effectType === "text-js" && op.affects !== "text")
    )
      throw new AgentMutationError(
        "INVALID_REQUEST",
        "Match shader with pixels/backdrop/generated, CSS with element, and text-js with text.",
      );
    if (op.effectType !== "text-js" && op.styleSource !== undefined)
      throw new AgentMutationError(
        "INVALID_REQUEST",
        "styleSource is only available for text-js Effects.",
      );
    const compatibleExisting =
      existing &&
      ((op.effectType === "shader" &&
        existing.kind === "fragment-glsl") ||
        (op.effectType === "css" && existing.kind === "css") ||
        (op.effectType === "text-js" && existing.kind === "text-js"))
        ? existing
        : undefined;
    let definition: EffectDefinition =
      compatibleExisting ??
      (op.effectType === "shader"
        ? changeEffectAffects(
            blankEffect("shader"),
            op.affects as EffectAffects,
            true,
          )
        : changeEffectAffects(
            blankEffect("css-js"),
            op.effectType === "text-js" ? "text" : "element",
            true,
          ));
    if (definition.kind === "fragment-glsl")
      definition = changeEffectAffects(
        definition,
        op.affects as EffectAffects,
        false,
      );
    definition = {
      ...definition,
      name: op.name,
      speed: op.speed ?? definition.speed,
      timeControl: op.timeControl ?? definition.timeControl,
      parameters: op.parameters ?? definition.parameters,
    };
    if (definition.kind === "fragment-glsl")
      definition = reconcileShaderSource(definition, op.source);
    else if (definition.kind === "text-js")
      definition = {
        ...definition,
        source: op.source,
        styleSource: op.styleSource ?? definition.styleSource,
      };
    else definition = { ...definition, source: op.source };
    const parsed = effectDefinitionSchema.safeParse(definition);
    if (!parsed.success)
      throw new AgentMutationError(
        "INVALID_REQUEST",
        parsed.error.issues.map(({ message }) => message).join("; "),
      );
    return parsed.data;
  };
  const validateDefinition = async (
    definition: EffectDefinition,
    sampleText?: string,
  ) => {
    if (!validateEffect)
      throw new AgentMutationError(
        "EFFECT_VALIDATION_UNAVAILABLE",
        "Production Effect validation is unavailable. Retry when the renderer is ready.",
      );
    const result = await validateEffect(definition, sampleText);
    if (!result)
      throw new AgentMutationError(
        "EFFECT_VALIDATION_UNAVAILABLE",
        "Production Effect validation is unavailable. Retry when the renderer is ready.",
      );
    if (!result.ok)
      throw new AgentMutationError(
        "EFFECT_VALIDATION_ERROR",
        result.diagnostics.map(({ message }) => message).join("; "),
        undefined,
        undefined,
        { kind: result.kind, diagnostics: result.diagnostics },
      );
    return result.definition;
  };
  const requireEffect = (elementId: string, instanceId: string) => {
    const element = requireEditable(elementId);
    const instance = element.effects?.find(({ id }) => id === instanceId);
    const definition =
      instance && next.slide.effectResources?.[instance.resourceId];
    if (!instance || !definition)
      throw new AgentMutationError(
        "UNKNOWN_EFFECT",
        "Inspect the element and use an existing Effect instance ID.",
      );
    return { element, instance, definition };
  };
  const ensureStages = (index: number) => {
    const motion = structuredClone(next.slide.motion ?? { stages: [] });
    while (motion.stages.length <= index)
      motion.stages.push({ id: uid(), tracks: [], blocks: [] });
    return motion;
  };
  for (let stepIndex = 0; stepIndex < request.operations.length; stepIndex++) {
    const op = request.operations[stepIndex];
    try {
      if ("elementIds" in op) op.elementIds.forEach(requireEditable);
      if ("elementId" in op) requireEditable(op.elementId);
      if (op.type === "slide.create") {
        if (stepIndex !== 0)
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "slide.create must be the first operation so following operations target the created slide.",
          );
        if (op.afterId !== null && !next.deck.slideIds.includes(op.afterId))
          throw new AgentMutationError(
            "UNKNOWN_SLIDE",
            "Use an inspected slide anchor, or null to insert first.",
          );
        const slideId = op.id ?? newId();
        if (next.deck.slideIds.includes(slideId))
          throw new AgentMutationError("INVALID_REQUEST", "Slide ID already exists.");
        const createdSlide = {
          version: 1 as const,
          id: slideId,
          background: op.background ?? "#ffffff",
          notes: "",
          nodes: next.deck.layers.map((layer) => ({
            type: "layer" as const,
            id: layer.id,
            children: [],
          })),
        };
        const created = createSlide(
          next,
          createdSlide,
          { name: op.name, section: "", hidden: false, templateId: null },
          op.afterId,
        );
        next = setEditorOperations(
          { ...created, slide: createdSlide },
          editorOperations(created),
        );
      } else if (op.type === "slide.duplicate") {
        if (stepIndex !== 0)
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "slide.duplicate must be the first operation so following operations target the duplicate.",
          );
        const slideId = op.id ?? newId();
        const sourceMeta = next.deck.slideMeta[next.slide.id];
        const afterId = op.afterId === undefined ? next.slide.id : op.afterId;
        if (afterId !== null && !next.deck.slideIds.includes(afterId))
          throw new AgentMutationError("UNKNOWN_SLIDE", "Use an inspected slide anchor or null.");
        const duplicated = duplicateSlideWithResult(
          next,
          next.slide,
          slideId,
          { ...sourceMeta, name: op.name ?? sourceMeta.name },
          afterId,
          newId,
        );
        Object.assign(idMap, duplicated.idMap);
        for (const value of Object.values(duplicated.idMap))
          createdThisBatch.add(value);
        const operation = [...editorOperations(duplicated.snapshot)]
          .reverse()
          .find((value) => value.type === "slide.duplicate");
        const createdSlide =
          operation?.type === "slide.duplicate" ? operation.slide : undefined;
        if (!createdSlide)
          throw new AgentMutationError("COMMIT_FAILED", "The duplicated slide was not staged.");
        next = setEditorOperations(
          { ...duplicated.snapshot, slide: createdSlide },
          editorOperations(duplicated.snapshot),
        );
      } else if (op.type === "slide.delete") {
        if (request.operations.length !== 1 || !replacementSlide)
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "Delete a slide in its own request so ShowMe can select a surviving replacement.",
          );
        next = deleteSlide(next, next.slide.id, replacementSlide);
      } else if (op.type === "slide.move") {
        next = reorderSlides(next, next.slide.id, op.afterId);
      } else if (op.type === "slide.update") {
        if (
          op.name === undefined &&
          op.background === undefined &&
          op.hidden === undefined &&
          op.notes === undefined &&
          op.transition === undefined
        )
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "Supply a slide name, background, hidden state, notes, or transition.",
          );
        if (op.background) {
          if (next.deck.slideMeta[next.slide.id]?.templateId)
            throw new AgentMutationError(
              "TEMPLATE_OWNED",
              "The slide background is inherited from its template.",
              undefined,
              undefined,
              { suggestedOperation: "slide.make_independent" },
            );
          next = setSlideBackground(next, op.background);
        }
        if (op.name)
          next = updateSlideMeta(next, next.slide.id, { name: op.name });
        if (op.hidden !== undefined)
          next = updateSlideMeta(next, next.slide.id, { hidden: op.hidden });
        if (op.notes !== undefined)
          next = setSlideNotes(next, op.notes);
        if (op.transition !== undefined)
          next = updateSlideMeta(next, next.slide.id, {
            transition: op.transition ?? undefined,
          });
      } else if (op.type === "slide.template.apply") {
        next = applyTemplate(next, op.templateId);
      } else if (op.type === "slide.make_independent") {
        next = makeIndependent(next);
      } else if (op.type === "deck.rename") {
        next = setDeckProperties(next, { name: op.name });
      } else if (op.type === "deck.stylesheet.set") {
        next = setDeckProperties(next, { stylesheet: op.source });
      } else if (op.type === "deck.dimensions.set") {
        next = setDeckProperties(next, { width: op.width, height: op.height });
      } else if (op.type === "deck.transition_defaults.set") {
        next = setDeckProperties(next, { transitionDefaults: op.value });
      } else if (op.type === "layer.create") {
        const layerId = op.id ?? newId();
        if (next.deck.layers.some((layer) => layer.id === layerId))
          throw new AgentMutationError("INVALID_REQUEST", "Layer ID already exists.");
        next = addLayer(next, layerId).snapshot;
        if (op.patch && Object.keys(op.patch).length)
          next = changeLayer(next, layerId, op.patch);
        createdLayerIds.push(layerId);
      } else if (op.type === "layer.update") {
        if (!next.deck.layers.some((layer) => layer.id === op.layerId))
          throw new AgentMutationError("UNKNOWN_LAYER", "Inspect the slide and use an existing Layer ID.");
        if (!Object.keys(op.patch).length)
          throw new AgentMutationError("INVALID_REQUEST", "Supply a nonempty Layer patch.");
        next = changeLayer(next, op.layerId, op.patch);
      } else if (op.type === "layer.delete") {
        if (!next.deck.layers.some((layer) => layer.id === op.layerId))
          throw new AgentMutationError("UNKNOWN_LAYER", "Inspect the slide and use an existing Layer ID.");
        if (next.deck.layers.length <= 1)
          throw new AgentMutationError("UNSUPPORTED_OPERATION", "The final Layer cannot be deleted.");
        next = deleteLayer(next, op.layerId);
      } else if (op.type === "layer.reorder") {
        next = reorderLayers(next, op.layerIds, op.index);
      } else if (op.type === "text.style.apply") {
        if (op.styleId && !next.deck.textStyles.some((style) => style.id === op.styleId))
          throw new AgentMutationError("UNKNOWN_TEXT_STYLE", "Inspect the deck and use an existing Text Style ID.");
        for (const elementId of op.elementIds) {
          const element = requireEditable(elementId);
          if (element.content?.type !== "text")
            throw new AgentMutationError("UNSUPPORTED_OPERATION", "Text Style assignment requires text elements.");
          await setText(elementId, {
            format: op.styleId
              ? { kind: "style", styleId: op.styleId, overrides: {} }
              : { kind: "local", typography: resolveTextTypography(next.deck, element.content) },
          });
        }
      } else if (op.type === "text.style.clear_overrides") {
        for (const elementId of op.elementIds) {
          const element = requireEditable(elementId);
          if (element.content?.type !== "text")
            throw new AgentMutationError("UNSUPPORTED_OPERATION", "Text Style override reset requires text elements.");
          if (element.content.format.kind === "style")
            await setText(elementId, {
              format: { ...element.content.format, overrides: {} },
            });
        }
      } else if (op.type === "text.style.create") {
        const styleId = op.styleId ?? newId();
        next = createTextStyleFromElement(next, op.elementId, op.name, styleId);
        createdTextStyleIds.push(styleId);
      } else if (op.type === "text.style.update") {
        requireEditable(op.elementId);
        next = updateTextStyleFromElement(next, op.elementId);
      } else if (op.type === "text.style.rename") {
        const style = next.deck.textStyles.find((value) => value.id === op.styleId);
        if (!style)
          throw new AgentMutationError("UNKNOWN_TEXT_STYLE", "Inspect Text Styles and use an existing style ID.");
        if (style.defaultKind)
          throw new AgentMutationError("UNSUPPORTED_OPERATION", "Built-in Heading/Text styles cannot be renamed.");
        if (
          next.deck.textStyles.some(
            (value) =>
              value.id !== style.id &&
              textStyleNameKey(value.name) === textStyleNameKey(op.name),
          )
        )
          throw new AgentMutationError("INVALID_REQUEST", "A Text Style with that name already exists.");
        next = setTextStyle(next, {
          styleId: style.id,
          value: { ...style, name: op.name },
        });
      } else if (op.type === "text.style.delete") {
        const style = next.deck.textStyles.find((value) => value.id === op.styleId);
        if (!style)
          throw new AgentMutationError("UNKNOWN_TEXT_STYLE", "Inspect Text Styles and use an existing style ID.");
        if (style.defaultKind)
          throw new AgentMutationError("UNSUPPORTED_OPERATION", "Built-in Heading/Text styles cannot be deleted.");
        next = setTextStyle(next, { styleId: style.id, value: null });
      } else if (op.type === "text.style") {
        if (
          !Object.keys(op.typography ?? {}).length &&
          op.autoSize === undefined
        )
          throw new AgentMutationError(
            "INVALID_REQUEST",
            "Supply typography or autoSize.",
          );
        await setText(op.elementId, {
          ...op.typography,
          ...(op.autoSize === undefined ? {} : { autoSize: op.autoSize }),
        });
      } else if (op.type === "text.set") {
        if (requireEditable(op.elementId).content?.type !== "text")
          throw new AgentMutationError(
            "UNSUPPORTED_OPERATION",
            "Text replacement requires a text element.",
          );
        await setText(op.elementId, { text: op.text, placeholder: false });
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
      } else if (op.type === "elements.css_classes.set") {
        for (const elementId of [...new Set(op.elementIds)]) {
          const element = requireEditable(elementId);
          const replacement = { ...element };
          if (op.classes.length) replacement.cssClasses = [...op.classes];
          else delete replacement.cssClasses;
          next = replaceElement(next, elementId, replacement);
        }
      } else if (op.type === "elements.reorder") {
        requireParent(op.parentId);
        const direct = new Set(
          (getChildren(next.slide, op.parentId) ?? []).map(({ id }) => id),
        );
        const invalid = op.elementIds.filter((id) => !direct.has(id));
        if (invalid.length)
          throw new AgentMutationError(
            "INVALID_SCOPE",
            "Reorder targets must be direct siblings of the supplied parent.",
            undefined,
            undefined,
            { requiredParentId: op.parentId, elementIds: invalid },
          );
        next = reorderElements(next, op.parentId, op.elementIds, op.mode);
      } else if (op.type === "elements.align") {
        requireParent(op.scopeId);
        next = alignSelection(next, op.elementIds, op.scopeId, op.axis);
      } else if (op.type === "elements.distribute") {
        requireParent(op.scopeId);
        next = distributeSelection(next, op.elementIds, op.scopeId, op.axis);
      } else if (op.type === "elements.duplicate") {
        const duplicated = duplicateElementsWithResult(
          next,
          op.elementIds,
          newId,
          op.offset ?? { x: 20, y: 20 },
        );
        next = duplicated.snapshot;
        Object.assign(idMap, duplicated.idMap);
        for (const value of Object.values(duplicated.idMap))
          createdThisBatch.add(value);
      } else if (op.type === "elements.reparent") {
        requireParent(op.parentId);
        next = reparentElements(next, op.elementIds, op.parentId, op.index);
      } else if (op.type === "elements.group") {
        const groupId = op.id ?? newId();
        if (forest(next).has(groupId))
          throw new AgentMutationError("INVALID_REQUEST", "Group ID already exists.");
        next = frameElements(next, op.elementIds, groupId);
        createdThisBatch.add(groupId);
        if (op.name !== undefined) {
          const group = locateElement(next.slide, groupId)!.element;
          next = replaceElement(next, groupId, { ...group, name: op.name });
        }
      } else if (op.type === "elements.ungroup") {
        const group = requireEditable(op.elementId);
        if (!isNeutralFrame(group))
          throw new AgentMutationError(
            "UNSUPPORTED_OPERATION",
            "Only a neutral Group can be ungrouped without visual loss.",
          );
        next = unframeElement(next, op.elementId);
      } else if (
        op.type === "frame.fit" ||
        op.type === "frame.fill" ||
        op.type === "frame.free" ||
        op.type === "frame.content_center" ||
        op.type === "frame.content_reset" ||
        op.type === "frame.content_transform.set"
      ) {
        const element = requireEditable(op.elementId);
        if (!isMediaContent(element.content))
          throw new AgentMutationError("INVALID_MEDIA", "The target has no image, SVG, or video content.");
        const intrinsic = async () => {
          const stored = mediaIntrinsic(element.content);
          if (stored) return stored;
          if (!resolveAsset)
            throw new AgentMutationError(
              "INVALID_MEDIA",
              "The media source dimensions are unavailable.",
            );
          try {
            const asset = await resolveAsset(element.content.assetId);
            if (!asset.width || !asset.height) throw new Error("unprepared");
            return { width: asset.width, height: asset.height };
          } catch {
            throw new AgentMutationError(
              "INVALID_MEDIA",
              "The managed media source is unavailable.",
            );
          }
        };
        let content: MediaContent;
        if (op.type === "frame.fit")
          content = convertMediaRule(element, "fit", await intrinsic());
        else if (op.type === "frame.fill")
          content = convertMediaRule(element, "fill", await intrinsic());
        else if (op.type === "frame.free")
          content = convertMediaRule(element, "free", await intrinsic());
        else if (op.type === "frame.content_center")
          content = centerMedia(element, await intrinsic());
        else if (op.type === "frame.content_reset")
          content = resetMedia(element, await intrinsic());
        else
          content = updateMediaFromResolved(element, {
            ...resolveMediaFrame(element, await intrinsic())!,
            ...op.frame,
          }, await intrinsic());
        next = setMediaContent(next, op.elementId, content);
      } else if (op.type === "media.transform.patch") {
        requireEditable(op.elementId);
        if (!Object.keys(op.patch).length)
          throw new AgentMutationError("INVALID_REQUEST", "Supply a nonempty media transform patch.");
        if (op.patch.rotation !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.rotation",
            op.patch.rotation,
          );
        if (op.patch.flipX !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.flipX",
            op.patch.flipX,
          );
        if (op.patch.flipY !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.flipY",
            op.patch.flipY,
          );
        if (op.patch.zoom !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.zoom",
            op.patch.zoom,
          );
        if (op.patch.anchorX !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.anchorX",
            op.patch.anchorX,
          );
        if (op.patch.anchorY !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.media.anchorY",
            op.patch.anchorY,
          );
      } else if (op.type === "video.playback.patch") {
        const element = requireEditable(op.elementId);
        if (element.content?.type !== "video")
          throw new AgentMutationError("INVALID_MEDIA", "Video playback settings require a video element.");
        if (!Object.keys(op.patch).length)
          throw new AgentMutationError("INVALID_REQUEST", "Supply a nonempty video playback patch.");
        if (op.patch.volume !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.volume",
            op.patch.volume,
          );
        if (op.patch.mute !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.mute",
            op.patch.mute,
          );
        if (op.patch.loop !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.loop",
            op.patch.loop,
          );
        if (op.patch.autoplay !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.autoplay",
            op.patch.autoplay,
          );
        if (op.patch.startTime !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.startTime",
            op.patch.startTime,
          );
        if (op.patch.endTime !== undefined)
          next = setSelectionProperty(
            next,
            [op.elementId],
            "content.video.endTime",
            op.patch.endTime,
          );
      } else if (op.type === "effect.apply_code") {
        const target = requireEditable(op.elementId);
        const existing = op.existingInstanceId
          ? requireEffect(op.elementId, op.existingInstanceId)
          : undefined;
        const definition = await validateDefinition(
          effectDefinition(
            {
              name: op.name,
              effectType: op.effectType,
              affects: op.affects,
              source: op.source,
              ...(op.styleSource === undefined
                ? {}
                : { styleSource: op.styleSource }),
              ...(op.speed === undefined ? {} : { speed: op.speed }),
              ...(op.timeControl === undefined
                ? {}
                : { timeControl: op.timeControl }),
              ...(op.parameters === undefined
                ? {}
                : { parameters: op.parameters }),
              ...(op.existingInstanceId === undefined
                ? {}
                : { existingInstanceId: op.existingInstanceId }),
              ...(op.stageIndex === undefined
                ? {}
                : { stageIndex: op.stageIndex }),
            },
            existing?.definition,
          ),
          target.content?.type === "text" ? target.content.text : undefined,
        );
        const before = new Set((target.effects ?? []).map(({ id }) => id));
        next = setElementEffectDefinition(
          next,
          op.elementId,
          definition,
          op.existingInstanceId,
          op.stageIndex ?? 0,
        );
        if (op.existingInstanceId)
          updatedEffectInstanceIds.push(op.existingInstanceId);
        else {
          const created = locateElement(next.slide, op.elementId)!.element.effects?.find(
            ({ id }) => !before.has(id),
          );
          if (!created)
            throw new AgentMutationError(
              "COMMIT_FAILED",
              "The Effect instance was not created.",
            );
          createdEffectInstanceIds.push(created.id);
        }
      } else if (op.type === "effect.parameter.set") {
        requireEffect(op.elementId, op.effectInstanceId);
        next = setElementEffectParameterValue(
          next,
          op.elementId,
          op.effectInstanceId,
          op.key,
          op.value,
        );
        updatedEffectInstanceIds.push(op.effectInstanceId);
      } else if (op.type === "effect.enabled.set") {
        const { element } = requireEffect(op.elementId, op.effectInstanceId);
        next = setSlideEffects(next, {
          changes: [
            {
              elementId: op.elementId,
              value: element.effects!.map((effect) =>
                effect.id === op.effectInstanceId
                  ? { ...effect, enabled: op.enabled }
                  : effect,
              ),
            },
          ],
        });
        updatedEffectInstanceIds.push(op.effectInstanceId);
      } else if (op.type === "effect.remove") {
        const { element, instance } = requireEffect(
          op.elementId,
          op.effectInstanceId,
        );
        const remaining = element.effects!.filter(
          ({ id }) => id !== op.effectInstanceId,
        );
        const usedElsewhere = [...forest(next).values()].some(
          (candidate) =>
            candidate.id !== op.elementId &&
            candidate.effects?.some(
              ({ resourceId }) => resourceId === instance.resourceId,
            ),
        );
        const resources = { ...(next.slide.effectResources ?? {}) };
        if (
          !usedElsewhere &&
          !remaining.some(
            ({ resourceId }) => resourceId === instance.resourceId,
          )
        )
          delete resources[instance.resourceId];
        next = setSlideEffects(next, {
          resources: Object.keys(resources).length ? resources : null,
          changes: [
            {
              elementId: op.elementId,
              value: remaining.length ? remaining : null,
            },
          ],
        });
      } else if (op.type === "background.shader.create") {
        const layerIndex = next.deck.layers.findIndex(
          ({ hidden, locked }) => !hidden && !locked,
        );
        const parentId = next.slide.nodes[layerIndex]?.id;
        if (layerIndex < 0 || !parentId)
          throw new AgentMutationError(
            "TARGET_NOT_EDITABLE",
            "A visible unlocked layer is required for a background Element.",
          );
        const definition = await validateDefinition(
          effectDefinition({
            name: op.name,
            effectType: "shader",
            affects: "generated",
            source: op.source,
            ...(op.speed === undefined ? {} : { speed: op.speed }),
            ...(op.timeControl === undefined
              ? {}
              : { timeControl: op.timeControl }),
            ...(op.parameters === undefined
              ? {}
              : { parameters: op.parameters }),
            ...(op.stageIndex === undefined
              ? {}
              : { stageIndex: op.stageIndex }),
          }),
        );
        const elementId = newId();
        const element = createBasicShape(elementId, "rectangle", {
          x: next.deck.width / 2,
          y: next.deck.height / 2,
        });
        element.frame = {
          ...element.frame,
          x: 0,
          y: 0,
          width: next.deck.width,
          height: next.deck.height,
        };
        element.name = op.name;
        element.appearance = {
          ...element.appearance,
          fill: null,
          strokeWidth: 0,
        };
        next = insertElements(next, [element], parentId);
        next = setElementEffectDefinition(
          next,
          elementId,
          definition,
          undefined,
          op.stageIndex ?? 0,
        );
        next = reorderElements(next, parentId, [elementId], "back");
        const created = locateElement(next.slide, elementId)!.element.effects?.[0];
        if (created) createdEffectInstanceIds.push(created.id);
      } else if (op.type === "motion.add_preset") {
        next = setSlideMotion(
          next,
          addMotionPreset(
            ensureStages(op.stageIndex),
            op.stageIndex,
            op.elementIds,
            op.preset,
          ),
        );
      } else if (op.type === "motion.animate") {
        const element = requireEditable(op.elementId);
        if (
          !(motionProperties as readonly string[]).includes(op.property) &&
          !numericEffectParameter(
            element,
            op.property,
            next.slide.effectResources ?? {},
          )
        )
          throw new AgentMutationError(
            "UNSUPPORTED_MOTION_PROPERTY",
            "Use a native Motion property or a numeric Effect parameter returned by inspection.",
            undefined,
            undefined,
            { property: op.property },
          );
        const motion = addParameterAnimation(
          next.slide.motion,
          op.stageIndex,
          op.elementId,
          op.property as MotionProperty,
          op.property,
          op.from,
          op.to,
          op.durationMs,
          true,
        );
        if (op.ease) {
          const block = motion.stages[op.stageIndex].blocks?.at(-1);
          const member = block?.members[0];
          const track = motion.stages[op.stageIndex].tracks.find(
            ({ id }) => id === member?.trackId,
          );
          const from = track?.keyframes.find(
            ({ id }) => id === member?.fromKeyframeId,
          );
          if (from) from.easeToNext = motionEaseFromName(op.ease);
        }
        next = setSlideMotion(next, motion);
      } else if (op.type === "presence.add") {
        next = setSlideMotion(
          next,
          addPresence(ensureStages(op.stageIndex), op.stageIndex, op.elementIds),
        );
      } else if (op.type === "elements.remove")
        next = removeElements(next, op.elementIds);
      else {
        requireParent(op.parentId);
        const elementId = op.id ?? newId();
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
            transformPoint(matrix, {
              x: op.frame.x + op.frame.width / 2,
              y: op.frame.y + op.frame.height / 2,
            }),
            elementId,
          );
          if (inserted.scopeId !== op.parentId)
            throw new AgentMutationError(
              "INVALID_SCOPE",
              "The insertion parent is not editable.",
            );
          next = inserted.snapshot;
          const textElement = locateElement(next.slide, elementId)!.element;
          next = setElementFramesPreservingContent(next, [
            {
              elementId,
              value: { ...textElement.frame, ...op.frame },
            },
          ]);
          if (op.name !== undefined) {
            const element = locateElement(next.slide, elementId)!.element;
            const named = { ...element, name: op.name };
            next = replaceElement(next, elementId, named);
          }
          await setText(elementId, {
            text: op.text,
            placeholder: false,
            ...op.typography,
            autoSize: op.autoSize ?? "none",
          });
          createdThisBatch.add(elementId);
        } else if (op.type === "element.insert_media") {
          if (!resolveAsset)
            throw new AgentMutationError(
              "UNSUPPORTED_OPERATION",
              "Managed Library asset resolution is unavailable.",
            );
          let asset: Asset;
          try {
            asset = await resolveAsset(op.assetId);
          } catch {
            throw new AgentMutationError(
              "INVALID_MEDIA",
              "Use an existing ShowMe-managed asset ID.",
            );
          }
          if (asset.id !== op.assetId || !asset.width || !asset.height)
            throw new AgentMutationError(
              "INVALID_MEDIA",
              "The managed asset is missing prepared dimensions.",
            );
          const element = createMediaElement(elementId, asset, op.frame);
          element.frame = { ...element.frame, ...op.frame };
          if (op.name !== undefined) element.name = op.name;
          next = insertElements(next, [element], op.parentId);
          createdThisBatch.add(elementId);
        } else {
          const element =
            op.type === "element.insert_frame"
              ? createEmptyFrame(elementId, op.frame)
              : createBasicShape(elementId, op.shape, op.frame);
          element.frame = { ...element.frame, ...op.frame };
          element.appearance = { ...element.appearance, ...op.appearance };
          if (op.name !== undefined) element.name = op.name;
          next = insertElements(next, [element], op.parentId);
          createdThisBatch.add(elementId);
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
          error.details,
        );
      throw new AgentMutationError(
        "INVALID_SCOPE",
        "The native command rejected this target or coordinate scope.",
        stepIndex,
      );
    }
  }
  const changes =
    projection.slide.id === next.slide.id
      ? mutationChanges(projection, next)
      : projection.deck.slideIds.includes(next.slide.id)
        ? { createdIds: [], removedIds: [], changedIds: [] }
        : { createdIds: [...forest(next).keys()], removedIds: [], changedIds: [] };
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
  const createdSlideIds = next.deck.slideIds.filter(
    (id) => !projection.deck.slideIds.includes(id),
  );
  const updatedSlideIds =
    next.slide.id === projection.slide.id &&
    (next.slide !== projection.slide ||
      JSON.stringify(next.deck.slideMeta[projection.slide.id]) !==
        JSON.stringify(projection.deck.slideMeta[projection.slide.id]))
      ? [projection.slide.id]
      : [];
  return {
    snapshot: next,
    ...changes,
    createdSlideIds,
    updatedSlideIds,
    createdEffectInstanceIds: [...new Set(createdEffectInstanceIds)],
    updatedEffectInstanceIds: [...new Set(updatedEffectInstanceIds)],
    idMap,
    createdTextStyleIds: [...new Set(createdTextStyleIds)],
    createdLayerIds: [...new Set(createdLayerIds)],
    changed: editorOperations(next).length > 0,
  };
}
