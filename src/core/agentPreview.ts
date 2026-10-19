import { z } from "zod/v4";
import { agentPreviewSampleSchema } from "./agentPreviewSample";
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

/** Output pixels; use the same bounds as the existing native capture service. */
export const agentPreviewRequestSchema = z
  .object({
    documentId: idSchema,
    epoch: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
    slideId: idSchema,
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    sample: agentPreviewSampleSchema.optional(),
    samples: z.array(agentPreviewSampleSchema).min(1).max(6).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sample && value.samples)
      context.addIssue({
        code: "custom",
        message: "Use sample or samples, not both.",
      });
    if (
      value.samples &&
      value.width * value.height * value.samples.length > 5242880
    )
      context.addIssue({
        code: "custom",
        message: "Samples exceed the total 5-megapixel capture budget.",
      });
  });
export type AgentPreviewRequest = z.infer<typeof agentPreviewRequestSchema>;

export interface AgentPreviewWarning {
  code: "MISSING_MEDIA" | "EFFECT_FALLBACK";
  message: string;
  elementIds: string[];
  effectInstanceIds?: string[];
}

/** Internal native result, shared with the existing thumbnail capture path. */
export interface SlidePreviewCapture {
  pngDataUrl: string;
  width: number;
  height: number;
  warnings: AgentPreviewWarning[];
}

export type AgentPreviewErrorCode =
  | "INVALID_REQUEST"
  | "MCP_DISABLED"
  | "MCP_ACCESS_CHANGED"
  | "DOCUMENT_NOT_ACTIVE"
  | "DOCUMENT_UNAVAILABLE"
  | "EPOCH_CONFLICT"
  | "REVISION_CONFLICT"
  | "UNKNOWN_SLIDE"
  | "PREVIEW_FAILED"
  | "REQUEST_CANCELLED";

export type AgentPreviewResult =
  | (SlidePreviewCapture & {
      ok: true;
      documentId: string;
      epoch: string;
      revision: number;
      slideId: string;
      mimeType: "image/png";
      state: "base" | "sampled";
      sample?: Record<string, unknown>;
      frames?: Array<SlidePreviewCapture & { sample: Record<string, unknown> }>;
    })
  | {
      ok: false;
      error: {
        code: AgentPreviewErrorCode;
        message: string;
        recoverable: boolean;
        actualRevision?: number;
      };
    };
