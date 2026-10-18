import { z } from "zod/v4";
import { agentSingleApplyRequestSchema } from "./agentMutation";

export const agentOperationFamilies = [
  "slide",
  "template",
  "deck",
  "layer",
  "element",
  "elements",
  "text",
  "frame",
  "background",
  "effect",
  "motion",
  "presence",
  "timeline",
  "media",
  "video",
] as const;
export const agentOperationSchema =
  agentSingleApplyRequestSchema.shape.operations.element;

export function agentContractDigest(text: string) {
  let hash = 2166136261;
  for (const char of text)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const contracts = agentOperationSchema.options.map((variant) => {
  const schema = z.toJSONSchema(variant);
  const type = variant.shape.type.value;
  const example = schemaExample(schema) as Record<string, unknown>;
  if ("property" in example) example.property = "transform.x";
  if (type === "effect.apply_code" || type === "background.shader.create")
    example.source =
      "#version 300 es\nprecision highp float;\nin vec2 v_uv; out vec4 outColor;\nvoid main() { outColor = vec4(1.0, 0.2, 0.0, 1.0); }";
  return {
    operation: type,
    family: type.split(".")[0],
    description: `Native semantic ${type.replaceAll(".", " ").replaceAll("_", " ")}; exact revision, ownership and lease rules apply.`,
    schema,
    example: variant.parse(example),
  };
});

function schemaExample(schema: Record<string, any>): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf)
    return schemaExample((schema.anyOf ?? schema.oneOf)[0]);
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? []).map((key: string) => [
        key,
        schemaExample(schema.properties[key]),
      ]),
    );
  if (schema.type === "array")
    return Array.from(
      {
        length:
          schema.minItems ??
          (Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0),
      },
      (_, index) => schemaExample(schema.prefixItems?.[index] ?? schema.items),
    );
  if (schema.type === "number" || schema.type === "integer")
    return (
      schema.minimum ??
      (schema.exclusiveMinimum === undefined ? 1 : schema.exclusiveMinimum + 1)
    );
  if (schema.type === "boolean") return true;
  if (schema.type === "null") return null;
  const candidates = ["example", "#FF4D16", "a".repeat(64)];
  return (
    candidates.find(
      (value) =>
        (!schema.pattern || new RegExp(schema.pattern).test(value)) &&
        value.length >= (schema.minLength ?? 0) &&
        value.length <= (schema.maxLength ?? Infinity),
    ) ?? "example"
  );
}

/** Schemas are exported from the actual admission validator, never a second validator. */
export function agentOperationContracts(family?: string, operation?: string) {
  const selected = contracts.filter(
    (item) =>
      (!family || item.family === family) &&
      (!operation || item.operation === operation),
  );
  return {
    contractVersion: 1,
    schemaDigest: agentContractDigest(JSON.stringify(selected)),
    limits: {
      operations: 128,
      expanded: {
        operations: 256,
        pageGroups: 32,
        affectedElements: 512,
        nativeOperations: 256,
      },
      affectedElements: 128,
      sourceBytesPerEffect: 100000,
    },
    request: {
      required: [
        "documentId",
        "epoch",
        "expectedRevision",
        "mutationId",
        "slideId",
      ],
      singlePage: {
        operations:
          "1-128 operations from these canonical contracts; mutually exclusive with pages.",
      },
      pageBatch: {
        pages:
          "1-8 groups of {slideId, operations}; at most 128 total operations and 128 affected elements. New groups begin with slide.create whose explicit id equals the group's slideId. Existing groups use inspected slide IDs. Single-page form handles deletion/duplication.",
        sharedState:
          "Later groups see earlier staged deck, layer and style changes. One transaction/revision and actor history for the whole batch.",
      },
      rendererValidationLimit: 32,
      budget:
        "standard (default): 8 pages/128 operations/128 affected elements; expanded (explicit): 32 pages/256 operations/512 affected elements. Both retain 256 native operations, 32 validations and 256KiB transport. Split larger intents into coherent transactions.",
      resources:
        "effect.resource.capture names an existing instance resource; attach reuses it on the same page; update changes source once for all its instances. Cross-slide sharing uses template elements. Instance parameters stay independent. inspect slide includeEffectResources:true exposes source. Capture removes the old definition only when orphaned; effect.resource.prune removes other unused definitions while native animated parameter checks remain authoritative. resourceChanges identifies changed resources and users.",
      bridgeBytes: 262144,
      revision:
        "Exact accepted revision; one atomic transaction. Reuse mutationId only for an identical request.",
    },
    targets: {
      parent:
        "Use an inspected editable Layer/container ID. Frames and child coordinates are parent-local.",
      ownership:
        "Inherited template content/background is template-owned. Target the template ID to edit it once for all dependent slides; use slide.make_independent for a detached copy. Templates accept visual content/resources, not slide timelines. Inspect deck.templates then inspect the template with target slide/elements.",
      creation:
        "slide.create or template.create must be first; subsequent operations author the new page. slide.duplicate plus textReplacements keyed by source element ID instantiates a reusable native slide recipe, preserving template/styles/motion and returning idMap. Inspect slide.recipe.slots for source-owned text IDs and names; inherited text is excluded. Duplication preserves notes unless slide.update explicitly replaces them. Human navigation and selection remain unchanged.",
      stage:
        "stageIndex identifies a native click stage under exact revision admission; stage 0 is slide entry.",
      timeline:
        "Prefer stable stageId/blockId after insertion or reorder; stageIndex is still supported. Entry stage cannot be removed/reordered. Remove nonempty stages with explicit mergePrevious or remove blocks first. Presence slide-end requires Exit None; click stops reference a later native stage. Non-click effect offsets must be zero; delayed effects use click start at the entry stage. Native property conflicts and overlapping intervals reject the whole transaction.",
    },
    result: {
      slideId: "Request context, also requestSlideId.",
      createdSlideIds: "Authoritative newly created pages.",
      authoredSlideIds:
        "Legacy page-ID list; use authoredPages for explicit page kind.",
      authoredPages: "Authored page IDs with kind=slide/template.",
      resourceChanges:
        "Created/changed/removed resource IDs, owning page and current element users.",
      revision: "Historical accepted transaction revision, including replay.",
      currentObservation:
        "Separately observed current epoch/revision. Refresh context if absent; the next write can still conflict.",
    },
    operations:
      family || operation
        ? selected
        : contracts.map(({ operation, family }) => ({ operation, family })),
  };
}
