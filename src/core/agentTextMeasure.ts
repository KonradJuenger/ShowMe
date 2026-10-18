import { z } from "zod/v4";
import { textTypographySchema } from "./textTypography";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export const agentTextMeasureItemSchema = z
  .object({
    text: z.string().max(100000),
    width: z.number().finite().positive().max(100000),
    typography: textTypographySchema.partial().optional(),
  })
  .strict();

export const agentMeasureTextRequestSchema = z
  .object({
    documentId: id,
    epoch: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
    items: z.array(agentTextMeasureItemSchema).min(1).max(64),
  })
  .strict();

export type AgentTextMeasureItem = z.infer<typeof agentTextMeasureItemSchema>;
export type AgentMeasureTextRequest = z.infer<
  typeof agentMeasureTextRequestSchema
>;
