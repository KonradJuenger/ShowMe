import { idSchema } from "./ids";
import { z } from "zod";
import { slideTransitionSchema } from "./slideTransitions";

export const slideMetaSchema = z.object({
  name: z.string().max(200),
  section: z.string().max(200),
  hidden: z.boolean(),
  templateId: idSchema.nullable(),
  transition: slideTransitionSchema.optional(),
});

export type SlideMeta = z.infer<typeof slideMetaSchema>;
