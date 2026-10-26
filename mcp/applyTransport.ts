import { z } from "zod/v4";
import { agentApplyRequestSchema } from "../src/core/agentMutation";

/** Only tool metadata is projected. Canonical admission remains validateApplyInput. */
export function advertisedApplySchema() {
  const schema = z.toJSONSchema(agentApplyRequestSchema);
  const forms = schema.anyOf as Array<Record<string, any>>;
  const operation = {
    type: "object",
    properties: { type: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["type"],
    additionalProperties: true,
    description:
      "Semantic operation. Discover exact fields with showme.authoring kind=operations before using unfamiliar types. Full canonical validation runs before execution.",
  };
  // Fail loudly if the canonical envelope changes instead of publishing stale metadata.
  if (
    forms?.length !== 2 ||
    !forms[0].properties?.operations?.items ||
    !forms[1].properties?.pages?.items?.properties?.operations?.items
  )
    throw new Error(
      "Update the advertised apply projection for the canonical request forms.",
    );
  forms[0].properties.operations.items = operation;
  forms[1].properties.pages.items.properties.operations.items = operation;
  return schema;
}

/** Native receipts/replay storage stay complete; only empty MCP collections are omitted. */
export function compactApplyReceipt(value: Record<string, unknown>) {
  if (value.ok !== true) return value;
  const compact = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(record).filter(
        ([key, entry]) =>
          !(Array.isArray(entry) && entry.length === 0) &&
          !(
            key === "idMap" &&
            entry &&
            typeof entry === "object" &&
            Object.keys(entry).length === 0
          ),
      ),
    );
  return compact({
    ...value,
    ...(Array.isArray(value.pageResults)
      ? { pageResults: value.pageResults.map((page) => compact(page)) }
      : {}),
  });
}
