import { z } from "zod/v4";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const number = z.number().finite();
const agentTextTypographyPatchSchema = z
  .object({
    fontFamily: z.string().trim().min(1).max(200).optional(),
    fontSize: number.positive().max(512).optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    lineHeight: number.min(0.5).max(5).optional(),
    letterSpacing: number.min(-100).max(500).optional(),
  })
  .strict();

export const agentTextMeasureItemSchema = z
  .object({
    text: z.string().max(100000),
    width: number.positive().max(100000),
    typography: agentTextTypographyPatchSchema.optional(),
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
