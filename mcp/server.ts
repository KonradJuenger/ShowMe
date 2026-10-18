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
      state: z.literal("base"),
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
  read: (request: AgentBridgeRequest, signal?: AbortSignal) => Promise<any>,
) {
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
    "showme.context",
    {
      description:
        "Read the running ShowMe editor context first for current/selected intent. Returns document epoch/revision, active slide or template, selection, UI epoch and observed timeline state. Does not flush drafts or sample playback.",
      inputSchema: schema(z.object({}).strict()),
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
        "Learn ShowMe's live authoring contract without repository access. Use layout, text, frame, media, shader, CSS Effect, text Effect or Motion context. Creative-code contexts may be scoped to an exact document/slide/element/Effect.",
      inputSchema: schema(agentAuthoringRequestSchema),
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
      inputSchema: schema(agentInspectRequestSchema),
      outputSchema: schema(envelopeSchema),
      annotations,
    },
    async (params, ctx) =>
      json(await read({ command: "inspect", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.apply",
    {
      description:
        "Apply an atomic semantic batch to the active locally owned presentation. Requires Allow agent editing and an exact inspected revision. Supports slide construction, text/shape/frame insertion, managed media insertion by assetId, parent-local geometry, appearance, z-order, hierarchy, duplication, grouping, alignment/distribution, Text Styles, media frame/crop/playback controls, templates, deck CSS, Effects, Motion and Presence. Effect code is production-validated. Reuse an identical mutationId after a lost response. Raw document operations remain unavailable.",
      inputSchema: schema(agentApplyRequestSchema),
      outputSchema: schema(
        z.union([
          z
            .object({
              ok: z.literal(true),
              documentId: z.string(),
              epoch: z.string(),
              slideId: z.string(),
              mutationId: z.string(),
              previousRevision: z.number(),
              revision: z.number(),
              transactionId: z.string().nullable(),
              changed: z.boolean(),
              replayed: z.boolean(),
              createdIds: z.array(z.string()),
              changedIds: z.array(z.string()),
              removedIds: z.array(z.string()),
              createdSlideIds: z.array(z.string()),
              updatedSlideIds: z.array(z.string()),
              createdEffectInstanceIds: z.array(z.string()),
              updatedEffectInstanceIds: z.array(z.string()),
              idMap: z.record(z.string(), z.string()),
              createdTextStyleIds: z.array(z.string()),
              createdLayerIds: z.array(z.string()),
              deckChanged: z.boolean(),
              changes: z.array(
                z
                  .object({
                    kind: z.enum(["created", "changed", "removed"]),
                    elementIds: z.array(z.string()),
                  })
                  .strict(),
              ),
              warnings: z.array(
                z.object({ code: z.string(), message: z.string() }).strict(),
              ),
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
    async (params, ctx) =>
      json(await read({ command: "apply", params }, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "showme.preview",
    {
      description:
        "Render an explicit presentation slide at an exact epoch/revision to a production PNG (1–2048 output pixels per axis). Base state only, static video; time-based Effects use production clocks. No editor overlays or deterministic click/time sampling. Returns image plus IDs/dimensions/warnings.",
      inputSchema: schema(agentPreviewInputSchema),
      outputSchema: schema(previewMetadataSchema),
      annotations,
    },
    async (params, ctx) => {
      const value = await read(
        { command: "preview", params },
        ctx.mcpReq.signal,
      );
      if (!value.ok) return json(value);
      const { pngDataUrl, ...metadata } = value;
      if (
        typeof pngDataUrl !== "string" ||
        !pngDataUrl.startsWith("data:image/png;base64,")
      )
        throw new Error("Invalid production preview");
      return {
        ...json(metadata),
        content: [
          { type: "image", mimeType: "image/png", data: pngDataUrl.slice(22) },
          { type: "text", text: JSON.stringify(metadata) },
        ],
      };
    },
  );
  return server;
}
