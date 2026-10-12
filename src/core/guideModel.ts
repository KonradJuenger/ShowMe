import { z } from "zod";
import { idSchema } from "./ids";

export const manualGuideSchema = z.object({
  id: idSchema,
  axis: z.enum(["horizontal", "vertical"]),
  position: z.number().finite(),
});

const marginSchema = z.number().finite().nonnegative().max(100000);
export const guideMarginsSchema = z.object({
  top: marginSchema,
  right: marginSchema,
  bottom: marginSchema,
  left: marginSchema,
});

export const guideGridSchema = z.object({
  count: z.number().int().min(1).max(200),
  gutter: z.number().finite().nonnegative().max(100000),
});

export const guideSetSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  margins: guideMarginsSchema.nullable(),
  columns: guideGridSchema.nullable(),
  rows: guideGridSchema.nullable(),
  manualGuides: z.array(manualGuideSchema).max(10000),
});

export type ManualGuide = z.infer<typeof manualGuideSchema>;
export type GuideMargins = z.infer<typeof guideMarginsSchema>;
export type GuideGrid = z.infer<typeof guideGridSchema>;
export type GuideSet = z.infer<typeof guideSetSchema>;
