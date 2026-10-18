import { z } from "zod/v4";
import { EFFECT_API_VERSION, type EffectDefinition } from "./effects";
import {
  blankEffect,
  buildEffectAuthoringPrompt,
  changeEffectAffects,
  effectAffects,
} from "./effectAuthoring";
import { motionProperties } from "./motionModel";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export const agentEffectAuthoringKinds = [
  "background-shader",
  "content-shader",
  "backdrop-shader",
  "css-effect",
  "text-effect",
] as const;
export type AgentEffectAuthoringKind =
  (typeof agentEffectAuthoringKinds)[number];

export const agentAuthoringKinds = [
  "layout",
  "text",
  "frame",
  "media",
  ...agentEffectAuthoringKinds,
  "motion",
] as const;
export type AgentAuthoringKind = (typeof agentAuthoringKinds)[number];

export function isAgentEffectAuthoringKind(
  kind: AgentAuthoringKind,
): kind is AgentEffectAuthoringKind {
  return (agentEffectAuthoringKinds as readonly string[]).includes(kind);
}

export const agentAuthoringRequestSchema = z
  .object({
    kind: z.enum(agentAuthoringKinds),
    documentId: id.optional(),
    epoch: z.string().min(1).max(100).optional(),
    revision: z.number().int().nonnegative().optional(),
    slideId: id.optional(),
    elementId: id.optional(),
    effectInstanceId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const scoped = value.documentId !== undefined;
    if (
      scoped &&
      (value.epoch === undefined ||
        value.revision === undefined ||
        value.slideId === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Scoped authoring requires documentId, epoch, revision and slideId.",
      });
    if (
      !scoped &&
      (value.epoch !== undefined ||
        value.revision !== undefined ||
        value.slideId !== undefined ||
        value.elementId !== undefined ||
        value.effectInstanceId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Document-scoped authoring requires documentId.",
      });
    if (value.effectInstanceId && !value.elementId)
      ctx.addIssue({
        code: "custom",
        message: "effectInstanceId requires elementId.",
      });
    if (
      value.effectInstanceId &&
      !isAgentEffectAuthoringKind(value.kind)
    )
      ctx.addIssue({
        code: "custom",
        message: "effectInstanceId requires an Effect authoring kind.",
      });
  });
export type AgentAuthoringRequest = z.infer<typeof agentAuthoringRequestSchema>;

export function effectAuthoringKind(
  definition: EffectDefinition,
): AgentEffectAuthoringKind {
  if (definition.kind === "css") return "css-effect";
  if (definition.kind === "text-js") return "text-effect";
  if (definition.input === "content") return "content-shader";
  if (definition.input === "backdrop") return "backdrop-shader";
  return "background-shader";
}

function starter(kind: AgentEffectAuthoringKind) {
  if (kind.endsWith("shader")) {
    const effect = blankEffect("shader");
    return changeEffectAffects(
      effect,
      kind === "content-shader"
        ? "pixels"
        : kind === "backdrop-shader"
          ? "backdrop"
          : "generated",
      true,
    );
  }
  const effect = blankEffect("css-js");
  return kind === "text-effect"
    ? changeEffectAffects(effect, "text", true)
    : changeEffectAffects(effect, "element", true);
}

function normalAuthoringGuide(
  kind: Exclude<AgentAuthoringKind, AgentEffectAuthoringKind>,
) {
  if (kind === "layout")
    return {
      kind,
      coordinateContract: {
        persistent: "Element frame x/y/width/height are parent-local.",
        world:
          "Request includeWorldTransform from showme.inspect for derived world-space reasoning; never persist world coordinates.",
        nested:
          "elements.move/align/distribute take an explicit scopeId. Reparenting preserves world appearance through ShowMe's native command.",
      },
      rules: [
        "Use stable IDs returned by create/duplicate/group operations.",
        "Layers and containers are valid parents. Hidden or locked layers are not editable until explicitly changed through Layer authoring.",
        "Use semantic structure operations rather than reconstructing nested objects.",
      ],
      operations: [
        "slide.create",
        "slide.duplicate",
        "slide.delete",
        "slide.move",
        "slide.update",
        "slide.template.apply",
        "slide.make_independent",
        "deck.dimensions.set",
        "layer.create",
        "layer.update",
        "layer.delete",
        "layer.reorder",
        "element.insert_text",
        "element.insert_shape",
        "element.insert_frame",
        "elements.move",
        "elements.frame.set",
        "elements.align",
        "elements.distribute",
        "elements.reorder",
        "elements.duplicate",
        "elements.group",
        "elements.ungroup",
        "elements.reparent",
        "elements.remove",
      ],
    };
  if (kind === "text")
    return {
      kind,
      rules: [
        "Text layout uses ShowMe's production text measurement.",
        "A fixed authored box uses autoSize=none; height/both use native measured auto-size.",
        "Applying a Text Style keeps local overrides as ShowMe style overrides.",
      ],
      typography: [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "bold",
        "italic",
        "color",
        "align",
        "verticalAlign",
        "lineHeight",
        "letterSpacing",
      ],
      autoSize: ["none", "height", "both"],
      operations: [
        "element.insert_text",
        "text.set",
        "text.style",
        "text.style.apply",
        "text.style.clear_overrides",
        "text.style.create",
      ],
      discovery:
        "Inspect the deck with includeTextStyles=true to get Text Style IDs and definitions.",
    };
  if (kind === "frame")
    return {
      kind,
      model: {
        frame:
          "The outer Element frame is parent-local and controls the viewport/container geometry.",
        content:
          "Image/SVG/video content has a separate media transform inside the frame. Resizing the outer frame preserves native crop semantics.",
        group:
          "elements.group creates ShowMe's neutral non-clipping structural Frame; element.insert_frame creates an empty clipping Frame.",
      },
      operations: [
        "element.insert_frame",
        "elements.frame.set",
        "elements.group",
        "elements.ungroup",
        "elements.reparent",
        "frame.fit",
        "frame.fill",
        "frame.content_transform.set",
        "frame.content_center",
        "frame.content_reset",
      ],
    };
  if (kind === "media")
    return {
      kind,
      boundary:
        "MCP never accepts arbitrary filesystem paths or forged assets. Media insertion requires a ShowMe-managed Library asset authority and is not exposed yet.",
      supported:
        "Existing image, SVG and video elements can be inspected, resized, fit/filled, centered, reset and have their content transform edited.",
      inspect:
        "Element detail returns assetId, media type, lockAspect and the canonical semantic transform.",
      operations: [
        "elements.frame.set",
        "frame.fit",
        "frame.fill",
        "frame.content_transform.set",
        "frame.content_center",
        "frame.content_reset",
      ],
    };
  return {
    kind,
    effectApiVersion: EFFECT_API_VERSION,
    properties: [...motionProperties],
    effectParameterAddress: "effects.<instanceId>.parameters.<key>",
    rules: [
      "Only numeric Effect parameters are Motion-addressable.",
      "Use Presence for lifecycle visibility instead of opacity hacks.",
      "Motion operates on ShowMe's existing Click Timeline stages.",
    ],
    operations: {
      preset: "motion.add_preset",
      numeric: "motion.animate",
      presence: "presence.add",
    },
  };
}

export function buildAgentAuthoringGuide(
  kind: AgentAuthoringKind,
  options: {
    definition?: EffectDefinition;
    previewElementName?: string;
    elementId?: string;
    effectInstanceId?: string;
  } = {},
) {
  if (!isAgentEffectAuthoringKind(kind))
    return normalAuthoringGuide(kind);

  const definition = options.definition ?? starter(kind);
  return {
    kind,
    effectApiVersion: EFFECT_API_VERSION,
    editing: !!options.definition,
    contract: {
      effectKind: definition.kind,
      affects: effectAffects(definition),
      timeControl: definition.timeControl,
      speed: definition.speed ?? 1,
      parameters: definition.parameters,
      source: definition.source,
      ...(definition.styleSource === undefined
        ? {}
        : { styleSource: definition.styleSource }),
    },
    authoringPrompt: buildEffectAuthoringPrompt(definition, {
      creating: !options.definition,
      previewElementName: options.previewElementName,
    }),
    operationTemplate:
      kind === "background-shader" && !options.effectInstanceId
        ? {
            type: "background.shader.create",
            name: definition.name,
            source: definition.source,
            speed: definition.speed ?? 1,
            timeControl: definition.timeControl,
          }
        : {
            type: "effect.apply_code",
            elementId: options.elementId ?? "<elementId>",
            name: definition.name,
            effectType:
              definition.kind === "fragment-glsl"
                ? "shader"
                : definition.kind === "text-js"
                  ? "text-js"
                  : "css",
            affects: effectAffects(definition),
            source: definition.source,
            ...(definition.styleSource === undefined
              ? {}
              : { styleSource: definition.styleSource }),
            speed: definition.speed ?? 1,
            timeControl: definition.timeControl,
            ...(options.effectInstanceId
              ? { existingInstanceId: options.effectInstanceId }
              : {}),
          },
  };
}
