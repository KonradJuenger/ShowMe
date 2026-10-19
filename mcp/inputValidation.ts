import { z } from "zod/v4";
import {
  agentApplyRequestSchema,
  agentPagesApplyRequestSchema,
  agentSingleApplyRequestSchema,
} from "../src/core/agentMutation";

/** Diagnostics select canonical operation schemas; admission still validates the complete request. */
export function validateApplyInput(input: unknown) {
  const parsed = agentApplyRequestSchema.safeParse(input);
  if (parsed.success) return parsed;
  let issues: Array<{ path: PropertyKey[]; code: string; message: string }> =
    parsed.error.issues;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    const form = (
      "pages" in value
        ? agentPagesApplyRequestSchema
        : agentSingleApplyRequestSchema
    ).safeParse(input);
    if (!form.success) issues = form.error.issues;
    const groups = Array.isArray(value.pages) ? value.pages : [value];
    outer: for (const [pageIndex, group] of groups.entries()) {
      if (
        !group ||
        typeof group !== "object" ||
        !Array.isArray(group.operations)
      )
        continue;
      for (const [stepIndex, op] of group.operations.entries()) {
        const variant =
          agentSingleApplyRequestSchema.shape.operations.element.options.find(
            (v) => v.shape.type.value === op?.type,
          );
        const result = variant?.safeParse(op);
        if (!result?.success) {
          const prefix = Array.isArray(value.pages)
            ? ["pages", pageIndex, "operations", stepIndex]
            : ["operations", stepIndex];
          issues = result
            ? result.error.issues.map((i) => ({
                ...i,
                path: [...prefix, ...i.path],
              }))
            : [
                {
                  code: "custom",
                  path: [...prefix, "type"],
                  message:
                    "Unknown operation. Discover kind=operations before retrying.",
                },
              ];
          break outer;
        }
      }
    }
  }
  return {
    success: false as const,
    error: {
      ok: false as const,
      error: {
        code: "INVALID_REQUEST",
        message:
          "Invalid semantic request. Inspect the indicated fields and canonical operation contract.",
        recoverable: true,
        details: {
          issues: issues.slice(0, 8).map((i) => ({
            path: i.path.map(String).join(".").slice(0, 300),
            code: i.code,
            message:
              i.code === "invalid_union"
                ? "Request must contain exactly one valid operations or pages form."
                : i.message.slice(0, 200),
          })),
        },
      },
    },
  };
}

/** The callback owns canonical admission and structured errors. Optional metadata projections never validate or transform input. */
export function callbackAdmissionSchema<T extends z.ZodType>(
  value: T,
  json = z.toJSONSchema(value),
) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "showme",
      jsonSchema: { input: () => json, output: () => json },
      validate: (input: unknown) => ({ value: input as z.infer<T> }),
    },
  };
}
