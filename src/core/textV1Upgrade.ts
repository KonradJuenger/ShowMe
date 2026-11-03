import { textRuns } from "./textRuns";

/** Only used at explicitly versioned v1 persistence/transfer boundaries.
 * The caller validates the entire converted payload with its strict current schema.
 * All unchanged fields survive so unknown fields are still rejected there.
 */
export function upgradeV1TextPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(upgradeV1TextPayload);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const converted = Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      upgradeV1TextPayload(item),
    ]),
  );
  if (object.type === "text" && "format" in object && "autoSize" in object) {
    if (
      typeof object.text !== "string" ||
      object.text.length > 100000 ||
      "runs" in object
    )
      throw new Error("Invalid version 1 text content");
    delete converted.text;
    converted.runs = textRuns(object.text);
  }
  if (
    ("nodes" in object && "background" in object) ||
    ("textStyles" in object && "slideIds" in object) ||
    object.kind === "showme-presentation"
  ) {
    if (object.version !== 1)
      throw new Error("Invalid version 1 document component");
    converted.version = 2;
  }
  return converted;
}
