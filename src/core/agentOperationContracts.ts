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

/** The apply envelope is learned once; selected operation contracts stay self-contained. */
export function agentProtocolGuide() {
  return {
    contractVersion: 2,
    limits: {
      standard: { operations: 128, pages: 8, affectedElements: 128 },
      expanded: { operations: 256, pages: 32, affectedElements: 512 },
      nativeOperations: 256,
      rendererValidations: 32,
      bridgeBytes: 262144,
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
      singlePage:
        "operations:[...] targets the inspected slideId. Mutually exclusive with pages.",
      pageBatch:
        "pages:[{slideId,operations:[...]}] stages all groups in one transaction. A new group's first operation is slide.create with explicit id=slideId. Existing groups use inspected page IDs. Later groups see earlier staged changes. Template creation uses single-page form.",
      budget:
        "standard is default; set budget=expanded explicitly. Both keep the native operation, validation and transport limits. Semantic operations can expand to multiple native operations; split oversized intents into coherent transactions.",
    },
    rules: [
      "Read context first, then inspect the accepted document at that exact epoch/revision. Only a locally owned active document with Allow agent editing can be changed; existing drafts/leases remain protected.",
      "One atomic transaction/revision and actor history per batch. Validation failure accepts no partial changes. Use the current exact revision and refresh context on conflict; never infer a document identity after open.",
      "Reuse mutationId only for an identical request after a lost response. Replay returns the historical receipt, not necessarily the latest revision.",
      "Inherited template visuals belong to their template. Use inspected editable parents and parent-local geometry. Human navigation and selection remain unchanged.",
    ],
    result: {
      authoredPages:
        "Authored IDs with explicit kind=slide/template; use createdSlideIds/createdTemplateIds for newly created pages.",
      idMap: "Native duplication maps source IDs to new IDs.",
      resourceChanges:
        "Changed resource IDs, owning pages and users, including shared-source updates.",
      revision:
        "Historical accepted revision, including replay. currentObservation separately reports current epoch/revision; refresh context when absent before the next write.",
    },
  };
}

const operationRules: Array<{
  families?: string[];
  operations?: string[];
  text: string;
}> = [
  {
    families: ["element", "elements", "frame", "media", "layer"],
    text: "Use inspected editable Layer/container IDs. Frames and child geometry are parent-local. Group composite visuals and animate the parent. Hidden/locked layers are not editable.",
  },
  {
    families: ["slide", "template"],
    text: "Inherited template content/background is template-owned: edit the template or use slide.make_independent. Templates accept visuals/resources, not slide timelines. Inspect deck.templates then the template page.",
  },
  {
    operations: ["slide.create", "template.create"],
    text: "Creation must be the first operation for a new page. A new page batch group's explicit ID must match its slideId; later groups see earlier staged changes.",
  },
  {
    operations: ["slide.duplicate"],
    text: "textReplacements keys are source-owned text IDs from inspect slide.recipe.slots; inherited text is excluded. Native duplication preserves templates, styles, motion and notes, returning idMap. Replace notes explicitly with slide.update.",
  },
  {
    families: ["effect", "background"],
    text: "Effect resources belong to a page; cross-slide sharing uses template elements. Capture/attach reuse a page resource, update changes all its users, prune removes only unused resources. Inspect includeEffectResources for source. Preserve animated parameter keys.",
  },
  {
    families: ["motion", "presence", "timeline", "effect", "background"],
    text: "stageIndex 0 is slide entry. Prefer returned stable stageId/blockId after reorder. Entry stage cannot be removed/reordered. Remove nonempty stages with explicit mergePrevious or remove blocks first. Native property conflicts/overlapping intervals reject the batch.",
  },
  {
    families: ["presence"],
    text: "Presence controls enter/exit lifecycle. A slide-end stop requires Exit None; click stops must reference a later stage. Apply Presence to a parent Frame to stagger whole components.",
  },
  {
    families: ["effect", "background"],
    text: "Effects control visual treatment, not element lifecycle. Non-click Effect offsets must be zero; delayed Effects use click start at entry stage. Discover the shader/CSS/text-effect guide for runtime code constraints.",
  },
];

/** Schemas come from the admission validator, never a second validator. */
export function agentOperationContracts(
  family?: string,
  operation?: string,
  options: { operations?: string[]; detail?: "compact" | "full" } = {},
) {
  const names = options.operations ? new Set(options.operations) : undefined;
  const selected = contracts.filter(
    (item) =>
      (!family || item.family === family) &&
      (!operation || item.operation === operation) &&
      (!names || names.has(item.operation)),
  );
  const filtered = !!(family || operation || names);
  const schemas = selected.map(({ operation, schema }) => ({
    operation,
    schema,
  }));
  return {
    contractVersion: 2,
    schemaDigest: agentContractDigest(JSON.stringify(schemas)),
    ...(filtered
      ? {
          rules: operationRules
            .filter((rule) =>
              selected.some(
                (item) =>
                  rule.families?.includes(item.family) ||
                  rule.operations?.includes(item.operation),
              ),
            )
            .map((rule) => rule.text),
        }
      : {
          discovery:
            "Read kind=protocol for the apply envelope. Request operations:[names] (1-32), operation:name, or family:name for exact schemas; compact is default, full adds examples. Creative code uses its own compact shader/CSS/text-effect guide.",
        }),
    operations: filtered
      ? selected.map(({ operation, family, schema, example }) => ({
          operation,
          family,
          schema,
          ...(options.detail === "full" ? { example } : {}),
        }))
      : contracts.map(({ operation, family }) => ({ operation, family })),
  };
}
