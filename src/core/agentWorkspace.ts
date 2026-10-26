import { z } from "zod/v4";
const identity = {
  documentId: z.string().min(1).max(100),
  epoch: z.string().min(1).max(100),
  expectedRevision: z.number().int().nonnegative(),
};
export const agentWorkspaceRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(1).max(200),
      ...identity,
    })
    .strict(),
  z
    .object({
      action: z.literal("open"),
      path: z.string().min(1).max(4096).optional(),
      ...identity,
    })
    .strict(),
  z.object({ action: z.literal("close"), ...identity }).strict(),
  z
    .object({
      action: z.literal("import-assets"),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
      ...identity,
    })
    .strict(),
]);
export type AgentWorkspaceRequest = z.infer<typeof agentWorkspaceRequestSchema>;
