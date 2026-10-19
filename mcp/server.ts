import { callbackAdmissionSchema, validateApplyInput } from "./inputValidation";
import { advertisedApplySchema, compactApplyReceipt } from "./applyTransport";
import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { agentApplyRequestSchema } from "../src/core/agentMutation";
import {
  agentInspectRequestSchema,
  agentPreviewInputSchema,
  SHOWME_MCP_SERVER_VERSION,
  type AgentBridgeRequest,
} from "../src/core/agentRead";
import { agentAuthoringRequestSchema } from "../src/core/agentAuthoring";
import { agentMeasureTextRequestSchema } from "../src/core/agentTextMeasure";
import { agentWorkspaceRequestSchema } from "../src/core/agentWorkspace";
import { agentDeliveryRequestSchema } from "../src/core/agentDelivery";

const schema = <T extends z.ZodType>(value: T) =>
  fromJsonSchema<z.infer<T>>(z.toJSONSchema(value) as JsonSchemaType);
const errorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
    actualRevision: z.number().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const envelopeSchema = z.union([
  z
    .object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) })
    .strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
const previewMetadataSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      documentId: z.string(),
      epoch: z.string(),
      revision: z.number(),
      slideId: z.string(),
      mimeType: z.literal("image/png"),
      state: z.enum(["base", "sampled"]),
      sample: z.record(z.string(), z.unknown()).optional(),
      frames: z.array(z.record(z.string(), z.unknown())).max(6).optional(),
      width: z.number(),
      height: z.number(),
      warnings: z.array(
        z
          .object({
            code: z.enum(["MISSING_MEDIA", "EFFECT_FALLBACK"]),
            message: z.string(),
            elementIds: z.array(z.string()),
            effectInstanceIds: z.array(z.string()).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
export function createShowMeServer(
  bridgeRead: (
    request: AgentBridgeRequest,
    signal?: AbortSignal,
  ) => Promise<any>,
) {
  const requestSchemas = {
    context: z.object({}).strict(),
    authoring: agentAuthoringRequestSchema,
    inspect: agentInspectRequestSchema,
    preview: agentPreviewInputSchema,
    measure_text: agentMeasureTextRequestSchema,
    workspace: agentWorkspaceRequestSchema,
    deliver: agentDeliveryRequestSchema,
    apply: agentApplyRequestSchema,
  };
  const read = async (
    request: { command: AgentBridgeRequest["command"]; params: unknown },
    signal?: AbortSignal,
  ) => {
    const parsed = requestSchemas[request.command].safeParse(request.params);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            "Invalid request. Use the canonical tool contract and indicated fields.",
          recoverable: true,
          details: {
            issues: parsed.error.issues.slice(0, 8).map((issue) => ({
              path: issue.path.map(String).join(".").slice(0, 300),
              code: issue.code,
              message:
                issue.code === "invalid_union"
                  ? "Use one valid canonical request form."
                  : issue.message.slice(0, 200),
            })),
          },
        },
      };
    return bridgeRead(
      { ...request, params: parsed.data } as AgentBridgeRequest,
      signal,
    );
  };
  const server = new McpServer({
    name: "showme",
    version: SHOWME_MCP_SERVER_VERSION,
  });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const json = (value: any): CallToolResult => ({
    isError: value.ok === false,
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
  server.registerTool(
    "showme.workspace",
    {
      description:
        "Create/open/close a native presentation, or import managed assets. Use exact current document identity and expectedRevision. Save before switching/closing; drafts are never discarded. File paths must lie inside the user-selected ShowMe root; omit paths for native pickers. Read context after lifecycle operations. Import returns managed asset IDs for semantic media insertion.",
      inputSchema: callbackAdmissionSchema(agentWorkspaceRequestSchema),
      outputSchema: schema(envelopeSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) =>
      json(await read({ command: "workspace", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.context",
    {
      description:
        "Read the running ShowMe editor context first for current/selected intent. Returns document epoch/revision, active slide or template, selection, UI epoch and observed timeline state. Does not flush drafts or sample playback.",
      inputSchema: callbackAdmissionSchema(z.object({}).strict()),
      outputSchema: schema(envelopeSchema),
      annotations,
    },
    async (_args, ctx) =>
      json(await read({ command: "context", params: {} }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.authoring",
    {
      description:
        "Discover ShowMe contracts without repository access. Read kind=protocol once for apply rules. kind=operations returns a catalog; select operations:[names] (1-32), operation:name or family:name for exact schemas. Compact is default and includes relevant rules; full adds examples. Shader/CSS/text-effect kinds provide executable-code guidance. Creative-code contexts may be scoped to an exact document/slide/element/Effect.",
      inputSchema: callbackAdmissionSchema(agentAuthoringRequestSchema),
      outputSchema: schema(envelopeSchema),
      annotations,
    },
    async (params, ctx) =>
      json(await read({ command: "authoring", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.inspect",
    {
      description:
        "Inspect accepted authoring state at an exact epoch/revision. Default output stays sparse; inspect the managed asset library by bounded query, or request Text Styles, deck stylesheet, Effect source, semantic Motion/Presence summaries or world transforms when needed. Element details expose parent-local frame, hierarchy, appearance, text/media state and CSS/Effect metadata. Hidden text is withheld by default.",
      inputSchema: callbackAdmissionSchema(agentInspectRequestSchema),
      outputSchema: schema(envelopeSchema),
      annotations,
    },
    async (params, ctx) =>
      json(await read({ command: "inspect", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.measure_text",
    {
      description:
        "Measure 1-64 text runs at an exact document epoch/revision using ShowMe's production fonts and DOM text layout. Use this before construction when wrapping or measured paragraph height affects layout. This tool does not mutate the document.",
      inputSchema: callbackAdmissionSchema(agentMeasureTextRequestSchema),
      outputSchema: schema(
        z.union([
          z
            .object({
              ok: z.literal(true),
              documentId: z.string(),
              epoch: z.string(),
              revision: z.number(),
              measurements: z.array(
                z
                  .object({
                    width: z.number(),
                    height: z.number(),
                    contentExtent: z
                      .object({ width: z.number(), height: z.number() })
                      .strict()
                      .optional(),
                    overflow: z
                      .object({
                        horizontal: z.boolean(),
                        vertical: z.boolean(),
                      })
                      .strict()
                      .optional(),
                    font: z
                      .object({
                        requested: z.string(),
                        availability: z.enum([
                          "available",
                          "unavailable",
                          "unknown",
                        ]),
                        source: z.enum([
                          "managed",
                          "platform",
                          "generic",
                          "unknown",
                        ]),
                        fallback: z.enum(["possible", "unknown"]),
                        resolvedFamily: z.null(),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict(),
              ),
            })
            .strict(),
          z.object({ ok: z.literal(false), error: errorSchema }).strict(),
        ]),
      ),
      annotations,
    },
    async (params, ctx) =>
      json(await read({ command: "measure_text", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.apply",
    {
      description:
        "Apply an atomic semantic batch to the active locally owned presentation. Requires Allow agent editing and an exact inspected revision. Supports slide construction, text/shape/frame insertion, managed media insertion by assetId, parent-local geometry, appearance, z-order, hierarchy, duplication, grouping, alignment/distribution, Text Styles, media frame/crop/playback controls, templates, deck CSS, Effects, Motion and Presence. Effect code is production-validated. Reuse an identical mutationId after a lost response. Operation objects are intentionally open in tool metadata; discover exact operation contracts with showme.authoring. Full canonical validation runs before execution. Empty receipt collections/maps are omitted and mean empty. Raw document operations remain unavailable.",
      inputSchema: callbackAdmissionSchema(
        agentApplyRequestSchema,
        advertisedApplySchema(),
      ),
      outputSchema: schema(
        z.union([
          z
            .object({
              ok: z.literal(true),
              documentId: z.string(),
              epoch: z.string(),
              slideId: z.string(),
              requestSlideId: z.string(),
              authoredSlideIds: z.array(z.string()).optional(),
              authoredPages: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      kind: z.enum(["slide", "template"]),
                    })
                    .strict(),
                )
                .optional(),
              resourceChanges: z
                .array(
                  z
                    .object({
                      pageId: z.string(),
                      resourceId: z.string(),
                      kind: z.enum(["created", "changed", "removed"]),
                      elementIds: z.array(z.string()),
                    })
                    .strict(),
                )
                .optional(),
              pageResults: z
                .array(z.record(z.string(), z.unknown()))
                .max(32)
                .optional(),
              currentObservation: z
                .object({ epoch: z.string(), revision: z.number() })
                .strict()
                .optional(),
              mutationId: z.string(),
              previousRevision: z.number(),
              revision: z.number(),
              transactionId: z.string().nullable(),
              changed: z.boolean(),
              replayed: z.boolean(),
              createdIds: z.array(z.string()).optional(),
              changedIds: z.array(z.string()).optional(),
              removedIds: z.array(z.string()).optional(),
              createdSlideIds: z.array(z.string()).optional(),
              createdTemplateIds: z.array(z.string()).optional(),
              updatedSlideIds: z.array(z.string()).optional(),
              createdStageIds: z.array(z.string()).optional(),
              createdBlockIds: z.array(z.string()).optional(),
              createdTrackIds: z.array(z.string()).optional(),
              createdKeyframeIds: z.array(z.string()).optional(),
              createdEffectInstanceIds: z.array(z.string()).optional(),
              updatedEffectInstanceIds: z.array(z.string()).optional(),
              idMap: z.record(z.string(), z.string()).optional(),
              createdTextStyleIds: z.array(z.string()).optional(),
              createdLayerIds: z.array(z.string()).optional(),
              deckChanged: z.boolean(),
              changes: z
                .array(
                  z
                    .object({
                      kind: z.enum(["created", "changed", "removed"]),
                      elementIds: z.array(z.string()),
                    })
                    .strict(),
                )
                .optional(),
              warnings: z
                .array(
                  z.object({ code: z.string(), message: z.string() }).strict(),
                )
                .optional(),
            })
            .strict(),
          z
            .object({
              ok: z.literal(false),
              error: errorSchema,
              stepIndex: z.number().optional(),
            })
            .strict(),
        ]),
      ),
      annotations: {
        ...annotations,
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async (params, ctx) => {
      const parsed = validateApplyInput(params);
      return parsed.success
        ? json(
            compactApplyReceipt(
              await read(
                { command: "apply", params: parsed.data },
                ctx.mcpReq.signal,
              ),
            ),
          )
        : json(parsed.error);
    },
  );
  server.registerTool(
    "showme.deliver",
    {
      description:
        "Save accepted document state to its associated native destination, native Save As picker, or export a portable .smp package. Exact epoch/revision required; never flushes another actor's drafts. Uses native path/overwrite policy; no arbitrary filesystem access. Native .sme/.smp preserve animation. Cancellation is reported separately from a written artifact.",
      inputSchema: callbackAdmissionSchema(agentDeliveryRequestSchema),
      outputSchema: schema(envelopeSchema),
      annotations: {
        ...annotations,
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    async (params, ctx) =>
      json(await read({ command: "deliver", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.preview",
    {
      description:
        "Render an exact-revision production PNG. Omit sample for authored base state; use an event trace for frozen timeline/finite-complete sampling or explicit incoming/outgoing traces for transitions. Static video posters; sampling establishes visual/timing correctness, not audience smoothness. Returns resolved clocks and warnings.",
      inputSchema: callbackAdmissionSchema(agentPreviewInputSchema),
      outputSchema: schema(previewMetadataSchema),
      annotations,
    },
    async (params, ctx) => {
      const value = await read(
        { command: "preview", params },
        ctx.mcpReq.signal,
      );
      if (!value.ok) return json(value);
      const { pngDataUrl, frames, ...rest } = value;
      const metadata = {
        ...rest,
        ...(frames
          ? {
              frames: frames.map(
                ({
                  pngDataUrl: _png,
                  ...frame
                }: {
                  pngDataUrl: string;
                  [key: string]: unknown;
                }) => frame,
              ),
            }
          : {}),
      };
      if (
        !frames &&
        (typeof pngDataUrl !== "string" ||
          !pngDataUrl.startsWith("data:image/png;base64,"))
      )
        throw new Error("Invalid production preview");
      return {
        ...json(metadata),
        content: [
          ...(frames ?? [{ pngDataUrl }]).map(
            (frame: { pngDataUrl: string }) => ({
              type: "image" as const,
              mimeType: "image/png",
              data: frame.pngDataUrl.slice(22),
            }),
          ),
          { type: "text", text: JSON.stringify(metadata) },
        ],
      };
    },
  );
  return server;
}
