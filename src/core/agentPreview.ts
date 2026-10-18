import { z } from "zod";
import { idSchema } from "./ids";

/** Output pixels; use the same bounds as the existing native capture service. */
export const agentPreviewRequestSchema = z
  .object({
    documentId: idSchema,
    epoch: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
    slideId: idSchema,
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
  })
  .strict();
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
  | "PREVIEW_FAILED";

export type AgentPreviewResult =
  | (SlidePreviewCapture & {
      ok: true;
      documentId: string;
      epoch: string;
      revision: number;
      slideId: string;
      mimeType: "image/png";
      state: "base";
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
