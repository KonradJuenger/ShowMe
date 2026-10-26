import { z } from "zod/v4";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const agentDeliveryRequestSchema = z
  .object({
    documentId: id,
    epoch: z.string().min(1).max(100),
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["save", "save-as", "package"]),
    packageOptions: z
      .object({
        mediaLocked: z.boolean(),
        speakerNotes: z.enum(["include", "remove"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.packageOptions && value.action !== "package")
      context.addIssue({
        code: "custom",
        path: ["packageOptions"],
        message: "Package options require action=package.",
      });
  });
export type AgentDeliveryRequest = z.infer<typeof agentDeliveryRequestSchema>;
