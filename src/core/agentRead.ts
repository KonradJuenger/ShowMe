import { z } from "zod/v4";
import { agentApplyRequestSchema } from "./agentMutation";
import { agentAuthoringRequestSchema } from "./agentAuthoring";

export const SHOWME_MCP_SERVER_VERSION = "1.2.0" as const;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const scope = {
  documentId: id,
  epoch: z.string().min(1).max(100),
  revision: z.number().int().nonnegative(),
};
const hidden = { includeHiddenContent: z.boolean().optional() };
export const agentInspectRequestSchema = z
  .object({
    ...scope,
    target: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("deck"),
          includeStylesheet: z.boolean().optional(),
          includeTextStyles: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("slide"),
          slideId: id,
          ...hidden,
          includeNotes: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("elements"),
          slideId: id,
          elementIds: z.array(id).min(1).max(128),
          ...hidden,
          includeWorldTransform: z.boolean().optional(),
          includeEffectSource: z.boolean().optional(),
          includeMotion: z.boolean().optional(),
          includePresence: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("selection"),
          uiEpoch: z.number().int().nonnegative(),
          ...hidden,
          includeWorldTransform: z.boolean().optional(),
          includeEffectSource: z.boolean().optional(),
          includeMotion: z.boolean().optional(),
          includePresence: z.boolean().optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type AgentInspectRequest = z.infer<typeof agentInspectRequestSchema>;
export const agentPreviewInputSchema = z
  .object({
    ...scope,
    slideId: id,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  })
  .strict();
export const agentBridgeRequestSchema = z.discriminatedUnion("command", [
  z
    .object({ command: z.literal("apply"), params: agentApplyRequestSchema })
    .strict(),
  z
    .object({ command: z.literal("context"), params: z.object({}).strict() })
    .strict(),
  z
    .object({
      command: z.literal("authoring"),
      params: agentAuthoringRequestSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal("inspect"),
      params: agentInspectRequestSchema,
    })
    .strict(),
  z
    .object({ command: z.literal("preview"), params: agentPreviewInputSchema })
    .strict(),
]);
export type AgentBridgeRequest = z.infer<typeof agentBridgeRequestSchema>;
export function agentFailure(
  code: string,
  message: string,
  actualRevision?: number,
  details?: Record<string, unknown>,
) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      recoverable: code !== "INVALID_REQUEST",
      ...(actualRevision === undefined ? {} : { actualRevision }),
      ...(details === undefined ? {} : { details }),
    },
  };
}
export interface McpConnectionInfo {
  status: "disabled" | "ready" | "unavailable";
  configuration: string | null;
  instanceId: string | null;
}
