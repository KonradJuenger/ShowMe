import { z } from "zod/v4";
import { EFFECT_API_VERSION, type EffectDefinition } from "./effects";
import {
  blankEffect,
  effectRuntimeContract,
  changeEffectAffects,
  effectAffects,
} from "./effectAuthoring";
import { motionProperties } from "./motionModel";
import {
  agentOperationContracts,
  agentOperationFamilies,
  agentContractDigest,
  agentProtocolGuide,
} from "./agentOperationContracts";
import { agentPreviewRequestSchema } from "./agentPreview";
import { agentWorkspaceRequestSchema } from "./agentWorkspace";
import { agentDeliveryRequestSchema } from "./agentDelivery";

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
  "operations",
  "protocol",
  "deck",
  "timeline",
  "preview",
  "delivery",
  "workspace",
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
    detail: z.enum(["compact", "full"]).optional(),
    family: z.enum(agentOperationFamilies).optional(),
    operation: z.string().min(1).max(100).optional(),
    operations: z.array(z.string().min(1).max(100)).min(1).max(32).optional(),
    documentId: id.optional(),
    epoch: z.string().min(1).max(100).optional(),
    revision: z.number().int().nonnegative().optional(),
    slideId: id.optional(),
    elementId: id.optional(),
    effectInstanceId: id.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const selectors = [value.family, value.operation, value.operations].filter(
      (v) => v !== undefined,
    );
    if (selectors.length > 1)
      ctx.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Use exactly one selector: family, operation, or operations.",
      });
    if (
      selectors.length &&
      value.kind !== "operations" &&
      value.kind !== "deck" &&
      value.kind !== "timeline"
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Operation selectors require kind=operations, deck or timeline.",
      });
    const family =
      value.family ??
      (value.kind === "deck"
        ? "deck"
        : value.kind === "timeline"
          ? "timeline"
          : undefined);
    for (const [index, name] of (
      value.operations ?? (value.operation ? [value.operation] : [])
    ).entries()) {
      if (!agentOperationContracts(family, name).operations.length)
        ctx.addIssue({
          code: "custom",
          path: value.operations ? ["operations", index] : ["operation"],
          message:
            "Unknown operation or mismatched family; read the operations catalog.",
        });
    }
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
    if (value.effectInstanceId && !isAgentEffectAuthoringKind(value.kind))
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
  detail: "compact" | "full" = "compact",
) {
  const serviceSchema =
    kind === "preview"
      ? z.toJSONSchema(agentPreviewRequestSchema)
      : kind === "delivery"
        ? z.toJSONSchema(agentDeliveryRequestSchema)
        : undefined;
  if (kind === "workspace")
    return {
      kind,
      contractVersion: 2,
      schema: z.toJSONSchema(agentWorkspaceRequestSchema),
      ...(detail === "full"
        ? {
            example: {
              action: "create",
              documentId: "<currentDocumentId>",
              epoch: "<currentEpoch>",
              expectedRevision: 0,
              name: "New presentation",
            },
          }
        : {}),
      rules: [
        "Save before switching or closing. Exact current identity/revision is required.",
        "create/open/close use native lifecycle services; import-assets returns managed asset IDs. Supplied paths stay within the user-selected root (realpath checked); omit paths for native pickers.",
        "close ends the editor window; start a new app session to reopen. Create/open return complete native identity and initial page IDs. Replace the COMPLETE identity after open; poll context until availability=ready and editor.documentId matches the receipt. Drafts, active leases and focused editing block switches. Imports report non-atomic per-item prepared/pending/failed recovery receipts using production raster/SVG/video decoding.",
      ],
    };
  if (kind === "preview" || kind === "delivery")
    return {
      kind,
      contractVersion: 2,
      schema: serviceSchema!,
      schemaDigest: agentContractDigest(JSON.stringify(serviceSchema)),
      ...(detail === "full"
        ? {
            example:
              kind === "preview"
                ? {
                    documentId: "<documentId>",
                    epoch: "<epoch>",
                    revision: 0,
                    slideId: "<incomingSlideId>",
                    width: 960,
                    height: 540,
                    sample: {
                      mode: "transition",
                      elapsedMs: 350,
                      previousSlideId: "<outgoingSlideId>",
                      outgoing: {
                        presentationOriginMs: 0,
                        activationMs: 0,
                        captureTimeMs: 3350,
                        clickTimesMs: [],
                      },
                      incoming: {
                        presentationOriginMs: 0,
                        activationMs: 3000,
                        captureTimeMs: 3350,
                        clickTimesMs: [],
                        previousSlideId: "<outgoingSlideId>",
                      },
                    },
                  }
                : {
                    documentId: "<documentId>",
                    epoch: "<epoch>",
                    expectedRevision: 0,
                    action: "package",
                    packageOptions: {
                      mediaLocked: false,
                      speakerNotes: "include",
                    },
                  },
          }
        : {}),
      rules:
        kind === "preview"
          ? [
              "Omitted sample renders authored base state, explicitly unsampled.",
              "Timeline captures derive paused clocks from actual reached activation/click times. Use explicit previousSlideId for backward or jump navigation.",
              "Finite-complete requires a reference captureTimeMs at or after known finite deadlines; it never invents future clicks or slide-end events. Unbounded effects use that reference time.",
              "Transition mode requires distinct previous/current slides and their explicit incoming/outgoing traces, shared presentation origin and capture time. Incoming activation plus elapsedMs equals captureTimeMs.",
              "Use samples for 1-6 frames, at most 5 megapixels total. Static video posters. Sampling does not establish playback smoothness.",
            ]
          : [
              "Only accepted state is delivered; human editor drafts are not flushed.",
              "Exact epoch and expectedRevision are checked inside the native persistence lock after any picker.",
              "Save uses its associated destination or the native picker for an untitled document. Save-as/package use native dialogs or the host-authorized SHOWME_DOCUMENT_DIR policy.",
              "For unattended package export, provide packageOptions {mediaLocked:boolean, speakerNotes:include/remove}. Native destination/overwrite policy still applies. Font warnings are returned; human callers without options keep native questions. Native SME and SMP preserve animation. This tool does not expose static PDF/PPTX export or arbitrary filesystem paths.",
            ],
    };
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
        "When several elements form one visual component, put them in one Frame/group and animate the parent instead of animating every child independently.",
      ],
      ...(detail === "full"
        ? {
            componentWorkflow: {
              summary:
                "Build composite visuals as structural Frames/groups so layout and lifecycle animation preserve visual hierarchy.",
              steps: [
                "Create a Frame/group with an explicit stable ID.",
                "Insert children with that ID as parentId.",
                "Author child x/y/width/height in parent-local coordinates.",
                "Style child elements normally.",
                "Use Presence on the parent when the whole component should enter or exit as one visual object.",
              ],
              example: {
                parent: {
                  type: "element.insert_frame",
                  id: "card",
                  parentId: "<layerId>",
                  frame: { x: 120, y: 180, width: 520, height: 320 },
                },
                child: {
                  type: "element.insert_text",
                  id: "card-title",
                  parentId: "card",
                  frame: { x: 32, y: 28, width: 456, height: 60 },
                  text: "Card title",
                },
                lifecycle: {
                  type: "presence.add",
                  stageIndex: 1,
                  elementIds: ["card"],
                  transition: "move",
                  direction: "Up",
                  distance: 50,
                  durationMs: 400,
                  easing: "Ease Out",
                },
              },
            },
          }
        : {}),
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
        "Use showme.measure_text before construction when wrapping or measured paragraph height materially affects layout; do not guess those dimensions.",
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
        "text.style.update",
        "text.style.rename",
        "text.style.delete",
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
        "frame.free",
        "frame.content_transform.set",
        "media.transform.patch",
        "video.playback.patch",
        "frame.content_center",
        "frame.content_reset",
      ],
    };
  if (kind === "media")
    return {
      kind,
      boundary:
        "MCP never accepts arbitrary filesystem paths, raw bytes or forged assets. element.insert_media accepts only an existing ShowMe-managed assetId resolved by the document asset authority.",
      supported:
        "Managed image/SVG/video assets can be inserted by assetId. Existing media can be inspected, resized, fit/filled, centered, reset and have its content transform edited.",
      inspect:
        "Use showme.inspect target=assets to discover ShowMe-managed asset IDs. Element detail returns assetId, media type, lockAspect, semantic transform and resolved content frame.",
      operations: [
        "element.insert_media",
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
      "Use Presence for entering/exiting visibility and entrance/exit movement.",
      "Use Motion for properties that animate while the element is present.",
      "Do not combine a Move Motion preset with a move Presence transition merely to create an entrance.",
      "Motion and Presence use the same named easing vocabulary: Linear, Ease In, Ease Out, Ease In Out and Hold.",
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
    detail?: "compact" | "full";
    family?: string;
    operation?: string;
    operations?: string[];
  } = {},
) {
  if (kind === "protocol") return { kind, ...agentProtocolGuide() };
  const family =
    options.family ??
    (kind === "deck" ? "deck" : kind === "timeline" ? "timeline" : undefined);
  if (kind === "operations" || kind === "deck" || kind === "timeline")
    return {
      kind,
      ...agentOperationContracts(family, options.operation, options),
    };
  if (!isAgentEffectAuthoringKind(kind))
    return normalAuthoringGuide(kind, options.detail);

  const definition = options.definition ?? starter(kind);
  return {
    kind,
    contractVersion: 2,
    effectApiVersion: EFFECT_API_VERSION,
    editing: !!options.definition,
    contract: {
      effectKind: definition.kind,
      affects: effectAffects(definition),
      timeControl: definition.timeControl,
      speed: definition.speed ?? 1,
      parameters: definition.parameters,
    },
    runtime: effectRuntimeContract(definition),
    ...(options.detail === "full"
      ? { examples: effectGuideExamples(kind) }
      : {}),
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

function effectGuideExamples(kind: AgentEffectAuthoringKind) {
  if (kind.endsWith("shader"))
    return {
      continuous:
        "Use sin(u_t * 2.0) for oscillation; u_p is only a finite interval's completion.",
      slideChange:
        "Blend u_previousSlideSeed toward u_slideSeed with smoothstep(0.0, 1.2, u_slideTime); first entry uses the current seed for both.",
      parameter: "uniform float strength; // @param 12 [0, 60]",
    };
  return {
    glass:
      ":scope { background: rgba(255,255,255,.3); backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,.7); border-radius: 24px; }",
    time: "Use calc(var(--t) * 1deg) for continuous time; finite @keyframes are paused and sampled from --p. Stop None supplies p=1, not a repeating animation clock.",
  };
}
