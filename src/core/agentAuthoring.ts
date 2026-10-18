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
export const agentAuthoringKinds = [
  "background-shader",
  "content-shader",
  "backdrop-shader",
  "css-effect",
  "text-effect",
  "motion",
] as const;
export type AgentAuthoringKind = (typeof agentAuthoringKinds)[number];

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
  });
export type AgentAuthoringRequest = z.infer<typeof agentAuthoringRequestSchema>;

export function effectAuthoringKind(
  definition: EffectDefinition,
): Exclude<AgentAuthoringKind, "motion"> {
  if (definition.kind === "css") return "css-effect";
  if (definition.kind === "text-js") return "text-effect";
  if (definition.input === "content") return "content-shader";
  if (definition.input === "backdrop") return "backdrop-shader";
  return "background-shader";
}

function starter(kind: Exclude<AgentAuthoringKind, "motion">) {
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

export function buildAgentAuthoringGuide(
  kind: AgentAuthoringKind,
  options: {
    definition?: EffectDefinition;
    previewElementName?: string;
    elementId?: string;
    effectInstanceId?: string;
  } = {},
) {
  if (kind === "motion")
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
