import { validateApplyInput } from "../../../mcp/inputValidation";
import {
  advertisedApplySchema,
  compactApplyReceipt,
} from "../../../mcp/applyTransport";
import { expect, it } from "vitest";
import { z } from "zod/v4";
import { blankEffect } from "../../../src/core/effectAuthoring";
import discoveryBaseline from "../../../docs/mcp/discovery-size-baseline-2026-10-18.json";
import { agentPreviewRequestSchema } from "../../../src/core/agentPreview";
import { agentWorkspaceRequestSchema } from "../../../src/core/agentWorkspace";
import { agentDeliveryRequestSchema } from "../../../src/core/agentDelivery";
import { AgentEditingService } from "../../../electron/agentEditing";
import {
  agentApplyRequestSchema,
  agentSingleApplyRequestSchema,
  assembleAgentMutation,
} from "../../../src/core/agentMutation";
import { newPresentationDocument } from "../../../src/core/document";
import { DocumentRuntime } from "../../../src/core/documentRuntime";
import {
  createBasicShape,
  createEmptyFrame,
} from "../../../src/core/elementFactory";
import { createTextElement } from "../../../src/core/text";
import { findElement } from "../../../src/core/scene";
import { getWorldMatrix } from "../../../src/core/scene";
import {
  localMatrix,
  multiply,
  resolveMediaFrame,
} from "../../../src/core/element";
import { editorOperations } from "../../../src/core/editorChange";
import {
  setElementAppearances,
  setSlideNotes,
} from "../../../src/core/editorCommands";
import type { EffectDefinition } from "../../../src/core/effects";
import type { EffectValidationResult } from "../../../src/core/effectValidation";
import {
  agentOperationContracts,
  agentOperationFamilies,
  agentOperationSchema,
} from "../../../src/core/agentOperationContracts";
import {
  agentAuthoringRequestSchema,
  buildAgentAuthoringGuide,
} from "../../../src/core/agentAuthoring";

it("canonical discovery exports every operation and validated examples in bounded families", () => {
  const all = agentOperationContracts();
  const variants = agentOperationSchema.options.map(
    (variant) => variant.shape.type.value,
  );
  expect(all.operations.map((item) => item.operation)).toEqual(variants);
  const discovered: string[] = [];
  for (const family of agentOperationFamilies) {
    const contract = agentOperationContracts(family, undefined, {
      detail: "full",
    });
    for (const item of contract.operations) {
      expect(item).toHaveProperty("schema.required");
      expect(item).toHaveProperty("example");
      if ("example" in item)
        expect(agentOperationSchema.safeParse(item.example).success).toBe(true);
      discovered.push(item.operation);
    }
    expect(agentOperationContracts(family).schemaDigest).toBe(
      contract.schemaDigest,
    );
  }
  expect(discovered.sort()).toEqual([...variants].sort());
  expect(
    buildAgentAuthoringGuide("workspace", { detail: "compact" }),
  ).toHaveProperty("schema.anyOf");
  const compact = buildAgentAuthoringGuide("background-shader", {
    detail: "compact",
  });
  expect(compact).not.toHaveProperty("authoringPrompt");
  expect(compact).toHaveProperty("runtime.slideContext");
  expect(
    buildAgentAuthoringGuide("background-shader", { detail: "full" }),
  ).toHaveProperty("examples.slideChange");
  expect(
    buildAgentAuthoringGuide("preview", { detail: "compact" }),
  ).toMatchObject({
    kind: "preview",
    schema: {
      required: expect.arrayContaining(["width", "height", "revision"]),
    },
  });
  expect(
    buildAgentAuthoringGuide("delivery", { detail: "compact" }),
  ).toMatchObject({
    kind: "delivery",
    schema: {
      required: expect.arrayContaining(["action", "expectedRevision"]),
    },
  });
});

it("batched compact discovery preserves exact admission schemas and relevant semantic rules without repeating the protocol", () => {
  const names = [
    "presence.add",
    "element.insert_text",
    "slide.create",
    "presence.add",
  ];
  const batch = agentOperationContracts(undefined, undefined, {
    operations: names,
  });
  expect(batch.operations.map((item) => item.operation)).toEqual(
    agentOperationSchema.options
      .map((variant) => variant.shape.type.value)
      .filter((name) => names.includes(name)),
  );
  expect(batch).not.toHaveProperty("request");
  expect(batch).not.toHaveProperty("limits");
  expect(batch).not.toHaveProperty("result");
  expect(batch.operations.every((item) => !("example" in item))).toBe(true);
  for (const item of batch.operations) {
    const variant = agentOperationSchema.options.find(
      (v) => v.shape.type.value === item.operation,
    )!;
    expect(item).toHaveProperty("schema", z.toJSONSchema(variant));
  }
  const rules = "rules" in batch ? batch.rules : [];
  expect(rules.join(" ")).toContain("parent-local");
  expect(rules.join(" ")).toContain("slide-end stop requires Exit None");
  expect(new Set(rules).size).toBe(rules.length);
  expect(
    agentOperationContracts(undefined, undefined, {
      operations: [...names].reverse(),
      detail: "full",
    }).schemaDigest,
  ).toBe(batch.schemaDigest);
  expect(agentOperationContracts(undefined, "presence.add")).toEqual(
    agentOperationContracts(undefined, undefined, {
      operations: ["presence.add"],
    }),
  );
  const protocol = buildAgentAuthoringGuide("protocol");
  expect(protocol).toHaveProperty(
    "request.required",
    expect.arrayContaining(["epoch", "expectedRevision", "mutationId"]),
  );
  expect(protocol).toHaveProperty("limits.nativeOperations", 256);
  expect(
    agentOperationContracts().operations.every((item) => !("schema" in item)),
  ).toBe(true);
});

it("glass-deck discovery stays within four calls and forty percent of its measured baseline payload", () => {
  const guides = [
    buildAgentAuthoringGuide("protocol"),
    buildAgentAuthoringGuide("operations", {
      operations: discoveryBaseline.operations,
    }),
    buildAgentAuthoringGuide("background-shader"),
    buildAgentAuthoringGuide("css-effect"),
  ];
  const bytes = guides.reduce(
    (total, data) =>
      total +
      new TextEncoder().encode(JSON.stringify({ ok: true, data })).length,
    0,
  );
  expect(guides).toHaveLength(4);
  expect(bytes).toBeLessThan(discoveryBaseline.structuredBytes * 0.4);
});

it("advertised apply metadata opens only operation bodies while canonical admission retains every constraint", () => {
  const canonical = z.toJSONSchema(agentApplyRequestSchema);
  const advertised = advertisedApplySchema();
  const forms = advertised.anyOf as Array<any>;
  expect(
    new TextEncoder().encode(JSON.stringify(advertised)).length,
  ).toBeLessThanOrEqual(6144);
  const bodies = [
    forms[0].properties.operations,
    forms[1].properties.pages.items.properties.operations,
  ];
  for (const body of bodies) {
    expect(body.items).toMatchObject({
      type: "object",
      required: ["type"],
      additionalProperties: true,
    });
    body.items = { placeholder: true };
  }
  const original = canonical.anyOf as Array<any>;
  original[0].properties.operations.items = { placeholder: true };
  original[1].properties.pages.items.properties.operations.items = {
    placeholder: true,
  };
  expect(advertised).toEqual(canonical);
  const f = fixture();
  const valid = f.request([
    {
      type: "element.insert_text",
      parentId: f.slide.nodes[0].id,
      frame: { x: 0, y: 0, width: 400, height: 80 },
      text: "Preserve nested fields",
      typography: { fontSize: 32 },
    },
  ]);
  expect(validateApplyInput(valid).success).toBe(true);
  for (const input of [
    {
      ...valid,
      operations: [
        { ...(valid.operations[0] as Record<string, unknown>), unknown: true },
      ],
    },
    { ...valid, operations: [{ type: "no.such_operation" }] },
    {
      ...valid,
      operations: [
        {
          ...(valid.operations[0] as Record<string, unknown>),
          frame: { x: 0, y: 0, width: -1, height: 80 },
        },
      ],
    },
    { ...valid, slideId: undefined },
    { ...valid, unknown: true },
    {
      ...valid,
      pages: [{ slideId: f.slide.id, operations: valid.operations }],
    },
    {
      ...valid,
      operations: undefined,
      pages: [{ pageId: f.slide.id, operations: valid.operations }],
    },
    {
      ...valid,
      operations: Array(129).fill({ type: "deck.rename", name: "Too many" }),
    },
  ])
    expect(validateApplyInput(input).success).toBe(false);
});

it("sparse MCP receipts preserve native replay concurrency identities and meaningful nested empty resource users", async () => {
  const f = fixture();
  const input = f.request(
    [{ type: "deck.rename", name: "Compact receipt" }],
    "compact-replay",
  );
  const accepted = await f.service.apply(input);
  const projected = compactApplyReceipt(accepted);
  expect(projected).toMatchObject({
    ok: true,
    documentId: f.model.documentId,
    epoch: "epoch",
    revision: 1,
    changed: true,
    replayed: false,
  });
  expect(projected).not.toHaveProperty("createdIds");
  expect(accepted.createdIds).toEqual([]);
  expect(JSON.stringify(projected).length).toBeLessThan(
    JSON.stringify(accepted).length,
  );
  await f.service.apply(
    f.request([{ type: "deck.rename", name: "Later edit" }]),
  );
  const replay = compactApplyReceipt(await f.service.apply(input));
  expect(replay).toMatchObject({
    revision: 1,
    replayed: true,
    currentObservation: { revision: 2, epoch: "epoch" },
  });
  const resource = {
    pageId: f.slide.id,
    resourceId: "removed",
    kind: "removed",
    elementIds: [],
  };
  const rich = compactApplyReceipt({
    ...accepted,
    createdIds: ["title"],
    idMap: { old: "title" },
    resourceChanges: [resource],
    warnings: [{ code: "NOTE", message: "Keep me" }],
    pageResults: [
      { slideId: f.slide.id, createdIds: ["title"], createdStageIds: [] },
    ],
  });
  expect(rich).toMatchObject({
    createdIds: ["title"],
    idMap: { old: "title" },
    resourceChanges: [resource],
    warnings: [{ code: "NOTE" }],
    pageResults: [{ createdIds: ["title"] }],
  });
  expect((rich.pageResults as any[])[0]).not.toHaveProperty("createdStageIds");
  const noop = await f.service.apply(
    f.request([{ type: "deck.rename", name: "Later edit" }]),
  );
  expect(compactApplyReceipt(noop)).toMatchObject({
    changed: false,
    transactionId: null,
  });
});

it("native assembly overflow reports measured costs and accepts independent smaller transactions without partial changes", async () => {
  const f = fixture();
  const operations = Array.from({ length: 100 }, (_, i) => ({
    type: "element.insert_text" as const,
    id: `cost-${i}`,
    parentId: f.slide.nodes[0].id,
    text: `Text ${i}`,
    frame: { x: 10, y: 10, width: 200, height: 60 },
  }));
  const result = await f.service.apply(f.request(operations));
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "PAYLOAD_TOO_LARGE",
      details: {
        budget: "nativeOperations",
        limit: 256,
        nativeOperations: expect.any(Number),
        count: "lower-bound",
        semanticOperations: 100,
      },
    },
  });
  expect(result.error.details.nativeOperations).toBeGreaterThan(256);
  expect(f.runtime.currentRevision(f.model.documentId)).toBe(0);
  expect(findElement((await f.projection()).slide, "cost-0")).toBeNull();
  for (let i = 0; i < 100; i += 25)
    expect(
      await f.service.apply(f.request(operations.slice(i, i + 25))),
    ).toMatchObject({ ok: true });
  expect(findElement((await f.projection()).slide, "cost-99")).not.toBeNull();
});

it("combined page overflow reports complete native counts and preserves atomicity before a deliberate split", async () => {
  const g = fixture();
  const pages = ["cost-page-a", "cost-page-b"].map((slideId, index) => ({
    slideId,
    operations: [
      {
        type: "slide.create",
        id: slideId,
        afterId: index ? "cost-page-a" : g.slide.id,
        name: slideId,
      },
      { type: "layer.create", id: slideId + "-layer" },
      ...Array.from({ length: 50 }, (_, i) => ({
        type: "element.insert_text",
        id: slideId + "-text-" + i,
        parentId: slideId + "-layer",
        text: "Text",
        frame: { x: 0, y: 0, width: 200, height: 60 },
      })),
    ],
  }));
  const pageRequest = () => {
    const request: Record<string, unknown> = g.request([]);
    delete request.operations;
    return request;
  };
  const combined = await g.service.apply({ ...pageRequest(), pages });
  expect(combined).toMatchObject({
    ok: false,
    error: {
      code: "PAYLOAD_TOO_LARGE",
      details: {
        budget: "nativeOperations",
        scope: "transaction",
        count: "complete",
        semanticOperations: 104,
        processedSemanticOperations: 104,
      },
    },
  });
  expect(g.runtime.currentRevision(g.model.documentId)).toBe(0);
  for (const page of pages)
    expect(
      await g.service.apply({ ...pageRequest(), pages: [page] }),
    ).toMatchObject({ ok: true });
});

it("discovery selectors reject ambiguous unknown oversized and domain-mismatched requests", () => {
  for (const input of [
    { kind: "operations", operations: [] },
    { kind: "operations", operations: Array(33).fill("slide.create") },
    { kind: "operations", operations: ["no.such_operation"] },
    {
      kind: "operations",
      operations: ["slide.create"],
      operation: "slide.create",
    },
    { kind: "operations", family: "slide", operation: "slide.create" },
    { kind: "deck", operations: ["presence.add"] },
    { kind: "deck", family: "presence" },
    { kind: "css-effect", operations: ["effect.apply_code"] },
    { kind: "protocol", family: "slide" },
  ])
    expect(agentAuthoringRequestSchema.safeParse(input).success).toBe(false);
  expect(
    agentAuthoringRequestSchema.safeParse({
      kind: "operations",
      operations: ["slide.create", "presence.add"],
    }).success,
  ).toBe(true);
  expect(
    agentAuthoringRequestSchema.safeParse({
      kind: "operations",
      operation: "slide.create",
    }).success,
  ).toBe(true);
});

it("compact domain guides retain runtime facts and scoped source once while full detail adds valid examples", () => {
  const shader = buildAgentAuthoringGuide("background-shader", {
    detail: "compact",
  });
  expect(shader).toHaveProperty(
    "runtime.environment",
    expect.stringContaining("No input texture"),
  );
  expect(shader).toHaveProperty(
    "runtime.timing.progress",
    expect.stringContaining("Stop None supplies p=1"),
  );
  expect(shader).not.toHaveProperty("authoringPrompt");
  const css = buildAgentAuthoringGuide("css-effect");
  expect(css).toHaveProperty(
    "runtime.environment",
    expect.stringContaining("nested @supports"),
  );
  expect(css).toHaveProperty(
    "runtime.environment",
    expect.stringContaining("paused and sampled"),
  );
  const definition = {
    ...blankEffect("shader"),
    source: "unique-private-source",
  };
  const scoped = buildAgentAuthoringGuide("content-shader", {
    definition,
    elementId: "element",
    effectInstanceId: "effect",
    detail: "full",
  });
  expect(scoped).toHaveProperty("operationTemplate.source", definition.source);
  expect(scoped).toHaveProperty(
    "operationTemplate.existingInstanceId",
    "effect",
  );
  expect(JSON.stringify(scoped).split(definition.source)).toHaveLength(2);
  expect(JSON.stringify(shader)).not.toContain(definition.source);
  const full = buildAgentAuthoringGuide("preview", { detail: "full" });
  expect(
    agentPreviewRequestSchema.safeParse(
      "example" in full ? full.example : undefined,
    ).success,
  ).toBe(true);
  const workspace = buildAgentAuthoringGuide("workspace", { detail: "full" });
  expect(
    agentWorkspaceRequestSchema.safeParse(
      "example" in workspace ? workspace.example : undefined,
    ).success,
  ).toBe(true);
  const delivery = buildAgentAuthoringGuide("delivery", { detail: "full" });
  expect(
    agentDeliveryRequestSchema.safeParse(
      "example" in delivery ? delivery.example : undefined,
    ).success,
  ).toBe(true);
  expect(full).toHaveProperty("example.sample.incoming.captureTimeMs", 3350);
  expect(buildAgentAuthoringGuide("preview")).not.toHaveProperty("example");
  expect(buildAgentAuthoringGuide("layout")).not.toHaveProperty(
    "componentWorkflow",
  );
  expect(buildAgentAuthoringGuide("layout", { detail: "full" })).toHaveProperty(
    "componentWorkflow",
  );
});

it("replay preserves the historical receipt and separately observes subsequent accepted revisions", async () => {
  const f = fixture();
  const input = f.request(
    [{ type: "deck.rename", name: "First" }],
    "historical",
  );
  const accepted = await f.service.apply(input);
  expect(accepted).toMatchObject({
    ok: true,
    requestSlideId: f.slide.id,
    revision: 1,
  });
  await f.service.apply({
    ...f.request([{ type: "deck.rename", name: "Later" }], "later"),
    expectedRevision: 1,
  });
  expect(await f.service.apply(input)).toEqual({
    ...accepted,
    replayed: true,
    currentObservation: { epoch: "epoch", revision: 2 },
  });
  expect((await f.projection()).deck.name).toBe("Later");
  expect(
    await f.service.apply({ ...input, mutationId: "stale" }),
  ).toMatchObject({ error: { code: "REVISION_CONFLICT", actualRevision: 2 } });
});

it("native timeline IDs support automatic stagger revision removal and actor history without rebuilding blocks", async () => {
  const f = fixture(),
    parentId = f.slide.nodes[0].id;
  const authored = await f.service.apply(
    f.request(
      [
        {
          type: "element.insert_frame",
          id: "column-a",
          parentId,
          frame: { x: 0, y: 0, width: 200, height: 400 },
        },
        {
          type: "element.insert_frame",
          id: "column-b",
          parentId,
          frame: { x: 220, y: 0, width: 200, height: 400 },
        },
        {
          type: "element.insert_frame",
          id: "column-c",
          parentId,
          frame: { x: 440, y: 0, width: 200, height: 400 },
        },
        {
          type: "element.insert_text",
          id: "column-copy",
          parentId: "column-b",
          frame: { x: 20, y: 30, width: 160, height: 80 },
          text: "Parent-local",
        },
        {
          type: "presence.add",
          elementIds: ["column-a"],
          startOffsetMs: 0,
          transition: "move",
          durationMs: 400,
        },
        {
          type: "presence.add",
          elementIds: ["column-b"],
          startOffsetMs: 150,
          transition: "move",
          durationMs: 400,
        },
        {
          type: "presence.add",
          elementIds: ["column-c"],
          startOffsetMs: 300,
          transition: "move",
          durationMs: 400,
        },
        {
          type: "motion.animate",
          elementId: "column-a",
          property: "transform.scaleX",
          from: 0.5,
          to: 1,
          durationMs: 600,
          delayMs: 80,
        },
        { type: "timeline.stage.create", id: "click-stage" },
      ],
      "stagger",
    ),
  );
  expect(authored).toMatchObject({
    ok: true,
    createdStageIds: [expect.any(String), "click-stage"],
    createdBlockIds: expect.any(Array),
    createdTrackIds: [expect.any(String)],
    createdKeyframeIds: [expect.any(String), expect.any(String)],
  });
  const before = await f.projection(),
    motion = before.slide.motion!;
  const middle = motion.stages[0].blocks!.find(
    (block) => block.binding?.elementId === "column-b",
  )!;
  const numeric = motion.stages[0].blocks!.find(
    (block) => block.members.length,
  )!;
  const revise = await f.service.apply({
    ...f.request(
      [
        {
          type: "presence.update",
          blockId: middle.id,
          startOffsetMs: 225,
          end: { mode: "click", stageId: "click-stage" },
        },
        {
          type: "motion.block.update",
          blockId: numeric.id,
          delayMs: 120,
          durationMs: 700,
        },
      ],
      "revise-stagger",
    ),
    expectedRevision: 1,
  });
  expect(revise).toMatchObject({
    ok: true,
    createdBlockIds: [],
    createdTrackIds: [],
    createdKeyframeIds: [],
  });
  const revised = await f.projection();
  expect(
    revised.slide.motion!.stages[0].blocks!.find(({ id }) => id === middle.id)!
      .presenceSchedule,
  ).toMatchObject({
    startOffsetMs: 225,
    end: { mode: "click", stageId: "click-stage" },
  });
  expect(findElement(revised.slide, "column-copy")!.frame).toMatchObject({
    x: 20,
    y: 30,
  });
  const noop = await f.service.apply({
    ...f.request(
      [{ type: "presence.update", blockId: middle.id, startOffsetMs: 225 }],
      "noop-stagger",
    ),
    expectedRevision: 2,
  });
  expect(noop).toMatchObject({
    ok: true,
    changed: false,
    revision: 2,
    transactionId: null,
  });
  expect(
    await f.service.apply({
      ...f.request(
        [{ type: "presence.remove", blockId: middle.id }],
        "remove-stagger",
      ),
      expectedRevision: 2,
    }),
  ).toMatchObject({ ok: true, revision: 3 });
  expect(
    (await f.projection()).slide.motion!.stages[0].blocks!.map(({ id }) => id),
  ).not.toContain(middle.id);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).slide.motion).toEqual(revised.slide.motion);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: true }),
  ).toMatchObject({ ok: true });
  const accepted = await f.projection();
  expect(
    await f.service.apply({
      ...f.request(
        [
          { type: "deck.rename", name: "Must not commit" },
          { type: "presence.update", blockId: middle.id, startOffsetMs: 1 },
        ],
        "deleted-block",
      ),
      expectedRevision: accepted.revision,
    }),
  ).toMatchObject({ error: { code: "UNKNOWN_BLOCK" }, stepIndex: 1 });
  expect(await f.projection()).toEqual(accepted);
});

it("page groups stage shared deck changes and seven new slides into one replayable atomic transaction", async () => {
  const f = fixture();
  const { operations: _operations, ...identity } = f.request([]);
  const pages = Array.from({ length: 7 }, (_, index) => ({
    slideId: `page-${index}`,
    operations: [
      {
        type: "slide.create",
        id: `page-${index}`,
        name: `Page ${index}`,
        afterId: index ? `page-${index - 1}` : f.slide.id,
      },
      ...(index === 0
        ? [
            { type: "deck.rename", name: "Atomic deck" },
            { type: "layer.create", id: "shared-layer" },
          ]
        : []),
      {
        type: "element.insert_text",
        id: `copy-${index}`,
        parentId: "shared-layer",
        frame: { x: 20, y: 30, width: 300, height: 100 },
        text: "Shared staged layer",
      },
    ],
  }));
  const request = { ...identity, pages };
  const before = await f.projection();
  const failedPages = structuredClone(pages);
  failedPages[6].operations.push({
    type: "text.set",
    elementId: "missing",
    text: "Late failure",
  } as never);
  expect(
    await f.service.apply({
      ...request,
      mutationId: "late-page",
      pages: failedPages,
    }),
  ).toMatchObject({
    error: { code: "UNKNOWN_ELEMENT", details: { pageIndex: 6 } },
  });
  expect(await f.projection()).toEqual(before);
  expect(f.counts().writes).toBe(0);
  const result = await f.service.apply(request);
  expect(result).toMatchObject({
    ok: true,
    revision: 1,
    requestSlideId: f.slide.id,
    createdSlideIds: pages.map(({ slideId }) => slideId),
    authoredSlideIds: pages.map(({ slideId }) => slideId),
    pageResults: expect.any(Array),
  });
  expect(f.counts().writes).toBe(1);
  for (const page of pages) {
    const projection = await f.runtime.projection(
      f.model.documentId,
      page.slideId,
    );
    expect(projection.deck.name).toBe("Atomic deck");
    expect(
      projection.slide.nodes.find(({ id }) => id === "shared-layer")!.children,
    ).toHaveLength(1);
  }
  expect((await f.projection()).slide).toEqual({
    ...before.slide,
    nodes: [
      ...before.slide.nodes,
      { type: "layer", id: "shared-layer", children: [] },
    ],
  });
  expect(await f.service.apply(request)).toEqual({
    ...result,
    replayed: true,
    currentObservation: { epoch: "epoch", revision: 1 },
  });
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toEqual(before.deck.slideIds);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: true }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toHaveLength(8);
});

it("new-slide timeline receipts compare IDs with the authored page and deletion creates no replacement IDs", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request(
        [{ type: "timeline.stage.create", id: "shared-local-stage" }],
        "source-stages",
      ),
    ),
  ).toMatchObject({ ok: true });
  const created = await f.service.apply({
    ...f.request(
      [
        {
          type: "slide.create",
          id: "timeline-page",
          afterId: f.slide.id,
          name: "Timeline",
        },
        { type: "timeline.stage.create", id: "shared-local-stage" },
      ],
      "new-stages",
    ),
    expectedRevision: 1,
  });
  expect(created).toMatchObject({
    ok: true,
    createdStageIds: [expect.any(String), "shared-local-stage"],
  });
  const removed = await f.service.apply({
    ...f.request([{ type: "slide.delete" }], "remove-timeline-page"),
    slideId: "timeline-page",
    expectedRevision: 2,
  });
  expect(removed).toMatchObject({
    ok: true,
    createdStageIds: [],
    createdBlockIds: [],
    createdTrackIds: [],
    createdKeyframeIds: [],
  });
});

it("multi-page structural animation uses native full-document scopes and respects a lease on a later page", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request(
        [
          {
            type: "slide.create",
            id: "existing-page",
            afterId: f.slide.id,
            name: "Existing",
          },
        ],
        "existing-page",
      ),
    ),
  ).toMatchObject({ ok: true });
  const { operations: _operations, ...identity } = f.request([]);
  const request = {
    ...identity,
    expectedRevision: 1,
    mutationId: "animate-existing",
    pages: [
      {
        slideId: f.slide.id,
        operations: [
          { type: "presence.add", elementIds: ["title"], transition: "fade" },
        ],
      },
      {
        slideId: "existing-page",
        operations: [
          {
            type: "background.shader.create",
            name: "Native background",
            source:
              "#version 300 es\nprecision highp float;\nin vec2 v_uv; out vec4 outColor;\nvoid main(){ outColor=vec4(1.0); }",
          },
        ],
      },
    ],
  };
  const before = f.runtime.fullSnapshot(f.model.documentId);
  const lease = f.runtime.acquireForActor(f.model.documentId, "local", [
    { kind: "slide", slideId: "existing-page" },
  ]);
  expect(lease.denied).toBe(false);
  expect(
    await f.service.apply({ ...request, mutationId: "leased-later-page" }),
  ).toMatchObject({ error: { code: "LEASE_DENIED" } });
  expect(f.runtime.fullSnapshot(f.model.documentId)).toEqual(before);
  f.runtime.releaseForActor(f.model.documentId, "local");
  expect(await f.service.apply(request)).toMatchObject({
    ok: true,
    revision: 2,
    createdIds: [expect.any(String)],
    createdBlockIds: [expect.any(String)],
  });
  expect(f.counts().writes).toBe(2);
  expect((await f.projection()).slide.motion!.stages[0].blocks).toHaveLength(1);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect(f.runtime.fullSnapshot(f.model.documentId).document).toEqual(
    before.document,
  );
});

it("effect schedule editing retains native identity and validates later-click stops and slide-end exits atomically", async () => {
  const f = fixture();
  const applied = await f.service.apply(
    f.request(
      [
        {
          type: "effect.apply_code",
          elementId: "title",
          name: "Continuous",
          effectType: "css",
          affects: "element",
          source: ":scope { opacity: 0.9; }",
        },
        { type: "timeline.stage.create", id: "stop-click" },
      ],
      "scheduled-effect",
    ),
  );
  expect(applied.ok).toBe(true);
  const effectInstanceId = applied.createdEffectInstanceIds[0];
  const scheduled = await f.service.apply({
    ...f.request(
      [
        {
          type: "effect.schedule.set",
          elementId: "title",
          effectInstanceId,
          start: "click",
          startOffsetMs: 150,
          stop: { mode: "click", stageId: "stop-click" },
          progressEasing: "Ease Out",
        },
      ],
      "effect-delay",
    ),
    expectedRevision: 1,
  });
  expect(scheduled).toMatchObject({
    ok: true,
    createdBlockIds: [expect.any(String)],
  });
  const blockId = scheduled.createdBlockIds[0];
  const revised = await f.service.apply({
    ...f.request(
      [{ type: "effect.schedule.update", blockId, startOffsetMs: 225 }],
      "effect-revise",
    ),
    expectedRevision: 2,
  });
  expect(revised).toMatchObject({ ok: true, createdBlockIds: [] });
  const before = await f.projection();
  expect(
    before.slide.motion!.stages[0].blocks!.find(({ id }) => id === blockId)!
      .effectSchedule,
  ).toMatchObject({
    startOffsetMs: 225,
    stop: { mode: "click", stageId: "stop-click" },
  });
  expect(
    await f.service.apply({
      ...f.request(
        [
          { type: "deck.rename", name: "No partial write" },
          {
            type: "presence.add",
            elementIds: ["shape"],
            end: { mode: "slide-end" },
            exitTransition: { kind: "fade" },
          },
        ],
        "bad-exit",
      ),
      expectedRevision: 3,
    }),
  ).toMatchObject({ ok: false, stepIndex: 1 });
  expect(await f.projection()).toEqual(before);
});

it("page staging discards every page on cancellation access revocation or runtime replacement", async () => {
  for (const reason of ["cancel", "access", "runtime"] as const) {
    const f = fixture(),
      held = deferred(),
      entered = deferred(),
      controller = new AbortController();
    f.measure(async () => {
      entered.resolve();
      await held.promise;
      return { width: 100, height: 30 };
    });
    const { operations: _operations, ...identity } = f.request([]);
    const pending = f.service.apply(
      {
        ...identity,
        pages: [
          {
            slideId: "first-page",
            operations: [
              {
                type: "slide.create",
                id: "first-page",
                afterId: f.slide.id,
                name: "First",
              },
              { type: "deck.rename", name: "Staged only" },
            ],
          },
          {
            slideId: "last-page",
            operations: [
              {
                type: "slide.create",
                id: "last-page",
                afterId: "first-page",
                name: "Last",
              },
              {
                type: "element.insert_text",
                parentId: f.slide.nodes[0].id,
                frame: { x: 0, y: 0, width: 100, height: 40 },
                text: "Held",
                autoSize: "height",
              },
            ],
          },
        ],
      },
      controller.signal,
    );
    await entered.promise;
    if (reason === "cancel") controller.abort();
    else if (reason === "access") f.access(2);
    else
      f.current(
        new DocumentRuntime(f.model, {
          actorId: "local",
          epoch: "replacement",
          durableCommit: async () => {},
        }),
      );
    held.resolve();
    expect(await pending).toMatchObject({
      error: {
        code:
          reason === "cancel"
            ? "REQUEST_CANCELLED"
            : reason === "access"
              ? "MCP_ACCESS_CHANGED"
              : "EPOCH_CONFLICT",
      },
    });
    expect(f.counts().writes).toBe(0);
    expect((await f.projection()).deck.slideIds).toEqual([f.slide.id]);
    expect((await f.projection()).deck.name).toBe("Agent editing");
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function fixture(
  options: { maxIdentities?: number; maxReceiptBytes?: number } = {},
  styleTitle = false,
) {
  const model = newPresentationDocument("Agent editing"),
    slide = model.slides[model.deck.slideIds[0]];
  const title = createTextElement("title");
  if (title.content?.type === "text") {
    title.content.text = "Original";
    title.content.placeholder = false;
    title.content.autoSize = "none";
    if (styleTitle)
      title.content.format = {
        kind: "style",
        styleId: model.deck.textStyles[0].id,
        overrides: {},
      };
  }
  const group = createEmptyFrame("group");
  group.children = [createBasicShape("child", "ellipse")];
  slide.nodes[0].children = [
    title,
    createBasicShape("shape", "rectangle"),
    group,
  ];
  let writes = 0,
    notifications = 0,
    access: number | null = 1,
    active: string | null = model.documentId,
    reason: string | null = null;
  let writer = async () => {};
  const runtime = new DocumentRuntime(model, {
    actorId: "local",
    epoch: "epoch",
    durableCommit: async () => {
      await writer();
      writes++;
    },
  });
  let current = runtime;
  let measure = async (
    element: Parameters<
      ConstructorParameters<typeof AgentEditingService>[0]["measure"]
    >[1],
  ) => ({ width: element.content.text.length * 10, height: 30 });
  let validateEffect = async (
    _documentId: string,
    definition: EffectDefinition,
    _sampleText?: string,
  ): Promise<EffectValidationResult | null> => ({
    ok: true,
    kind: definition.kind,
    definition,
    diagnostics: [],
  });
  const service = new AgentEditingService({
    ...options,
    access: () => access,
    eligibility: () => reason,
    activeDocumentId: () => active,
    runtime: () => current,
    measure: (_id, element) => measure(element),
    validateEffect: (documentId, definition, sampleText) =>
      validateEffect(documentId, definition, sampleText),
    asset: async (_documentId, id) => ({
      version: 1,
      id,
      filename: "managed.png",
      mediaType: "image",
      type: "image",
      mime: "image/png",
      names: ["managed.png"],
      bytes: 1024,
      width: 1200,
      height: 800,
      createdAt: "2026-10-18T00:00:00.000Z",
    }),
    changed: () => {
      notifications++;
    },
  });
  const request = (
    operations: unknown[],
    mutationId: string = crypto.randomUUID(),
  ) => ({
    documentId: model.documentId,
    epoch: "epoch",
    expectedRevision: runtime.currentRevision(model.documentId),
    slideId: slide.id,
    mutationId,
    operations,
  });
  const projection = () => runtime.projection(model.documentId, slide.id);
  return {
    service,
    runtime,
    model,
    slide,
    request,
    projection,
    counts: () => ({ writes, notifications }),
    writer: (fn: typeof writer) => {
      writer = fn;
    },
    access: (value: number | null) => {
      access = value;
    },
    active: (value: string | null) => {
      active = value;
    },
    reason: (value: string | null) => {
      reason = value;
    },
    current: (value: DocumentRuntime) => {
      current = value;
    },
    measure: (fn: typeof measure) => {
      measure = fn;
    },
    validateEffect: (fn: typeof validateEffect) => {
      validateEffect = fn;
    },
  };
}
it("agent slide creation returns stable IDs preserves the projected slide and is replayable and undoable", async () => {
  const f = fixture();
  const before = await f.projection();
  const request = f.request([
    {
      type: "slide.create",
      afterId: f.slide.id,
      name: "Second slide",
      background: "#123456",
    },
  ]);
  const result = await f.service.apply(request);
  expect(result).toMatchObject({
    ok: true,
    changed: true,
    createdSlideIds: [expect.any(String)],
    createdIds: [],
  });
  const id = result.createdSlideIds[0];
  const p = await f.runtime.projection(f.model.documentId, id);
  expect(p.slide).toMatchObject({ id, background: "#123456", notes: "" });
  expect(p.slide.nodes.every((root) => root.children.length === 0)).toBe(true);
  expect(p.deck.slideIds).toEqual([f.slide.id, id]);
  expect(p.deck.slideMeta[id]).toMatchObject({
    name: "Second slide",
    templateId: null,
  });
  expect((await f.projection()).slide).toEqual(before.slide);
  expect(await f.service.apply(request)).toEqual({
    ...result,
    replayed: true,
    currentObservation: {
      epoch: "epoch",
      revision: f.runtime.metadata(f.model.documentId).revision,
    },
  });
  expect(f.counts().writes).toBe(1);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toEqual([f.slide.id]);
  expect(await f.service.apply(request)).toEqual({
    ...result,
    replayed: true,
    currentObservation: {
      epoch: "epoch",
      revision: f.runtime.metadata(f.model.documentId).revision,
    },
  });
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: true }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toEqual([f.slide.id, id]);
});

it("slide creation can author a complete new slide atomically and invalid anchors do not mutate", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([{ type: "slide.create", afterId: "missing", name: "Bad" }]),
    ),
  ).toMatchObject({ error: { code: "UNKNOWN_SLIDE" } });
  expect(f.counts().writes).toBe(0);

  const root = f.slide.nodes[0].id;
  const request = f.request([
    {
      type: "slide.create",
      id: "agent-slide",
      afterId: f.slide.id,
      name: "Agent title slide",
      background: "#000000",
    },
    {
      type: "element.insert_shape",
      id: "background",
      parentId: root,
      shape: "rectangle",
      frame: { x: 0, y: 0, width: 1920, height: 1080 },
      appearance: { fill: "#000000", strokeWidth: 0 },
    },
    {
      type: "element.insert_text",
      id: "headline",
      parentId: root,
      frame: { x: 140, y: 210, width: 1400, height: 180 },
      text: "A complete slide",
      typography: {
        fontFamily: "Arial",
        fontSize: 96,
        color: "#ffffff",
        align: "left",
      },
      autoSize: "none",
    },
    {
      type: "element.insert_shape",
      id: "rule",
      parentId: root,
      shape: "rectangle",
      frame: { x: 140, y: 430, width: 720, height: 4 },
      appearance: { fill: "#ffffff", strokeWidth: 0 },
    },
    {
      type: "elements.reorder",
      parentId: root,
      elementIds: ["background"],
      mode: "back",
    },
  ]);
  const result = await f.service.apply(request);
  expect(result).toMatchObject({
    ok: true,
    createdSlideIds: ["agent-slide"],
    createdIds: expect.arrayContaining(["background", "headline", "rule"]),
  });
  const authored = await f.runtime.projection(
    f.model.documentId,
    "agent-slide",
  );
  expect(authored.slide.background).toBe("#000000");
  expect(findElement(authored.slide, "headline")).toMatchObject({
    frame: { x: 140, y: 210, width: 1400, height: 180 },
    content: {
      type: "text",
      text: "A complete slide",
      format: { typography: { fontSize: 96, color: "#ffffff" } },
    },
  });
  expect(authored.slide.nodes[0].children[0].id).toBe("background");
  expect(f.counts().writes).toBe(1);
  expect(
    await f.service.apply({ ...request, mutationId: "different" }),
  ).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
});

it("agent typography uses native style overrides measurement fixed text frames and no-op history", async () => {
  const f = fixture({}, true);
  expect(
    await f.service.apply(
      f.request([
        {
          type: "text.style",
          elementId: "title",
          typography: { color: "#007F73", fontSize: 90 },
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  expect(
    findElement((await f.projection()).slide, "title")!.content,
  ).toMatchObject({
    format: {
      kind: "style",
      styleId: f.model.deck.textStyles[0].id,
      overrides: { color: "#007F73", fontSize: 90 },
    },
  });
  const inserted = await f.service.apply(
    f.request([
      {
        type: "element.insert_text",
        parentId: f.slide.nodes[0].id,
        frame: { x: 500, y: 300, width: 800, height: 180 },
        text: "Design",
        typography: { fontSize: 120, color: "#007F73", bold: true },
        autoSize: "both",
      },
    ]),
  );
  expect(inserted.ok).toBe(true);
  const id = inserted.createdIds[0];
  expect(findElement((await f.projection()).slide, id)?.frame).toMatchObject({
    x: 500,
    y: 300,
  });
  let measuredSize = 0;
  f.measure(async (element) => {
    measuredSize =
      element.content.format.kind === "local"
        ? element.content.format.typography.fontSize
        : 0;
    return { width: 600, height: 130 };
  });
  const styled = await f.service.apply(
    f.request([
      { type: "text.style", elementId: id, typography: { fontSize: 100 } },
    ]),
  );
  expect(styled.ok).toBe(true);
  expect(measuredSize).toBe(100);
  const p = await f.projection();
  expect(findElement(p.slide, id)).toMatchObject({
    frame: { width: 604, height: 134 },
    content: {
      format: { typography: { fontSize: 100, bold: true, color: "#007F73" } },
    },
  });
  const fixed = await f.service.apply(
    f.request([
      { type: "text.style", elementId: id, autoSize: "none" },
      {
        type: "elements.frame.set",
        elementId: id,
        frame: { x: 120, y: 200, width: 900, height: 300 },
      },
    ]),
  );
  expect(fixed.ok).toBe(true);
  const noop = await f.service.apply(
    f.request([
      { type: "text.style", elementId: id, typography: { fontSize: 100 } },
    ]),
  );
  expect(noop).toMatchObject({ ok: true, changed: false, transactionId: null });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "text.style",
          elementId: "shape",
          typography: { fontSize: 100 },
        },
      ]),
    ),
  ).toMatchObject({ ok: false });
  expect(
    await f.service.apply(
      f.request([{ type: "text.style", elementId: id, typography: {} }]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.apply(
      f.request([
        { type: "text.style", elementId: id, typography: { fontSize: 0 } },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
});

it("deck naming and independent slide styling commit without element changes and protect template backgrounds", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([{ type: "slide.update", background: "#123456" }]),
    ),
  ).toMatchObject({
    error: {
      code: "TEMPLATE_OWNED",
      details: { suggestedOperation: "slide.make_independent" },
    },
  });
  expect(
    await f.service.apply(
      f.request([
        { type: "slide.make_independent" },
        { type: "slide.update", background: "#123456" },
      ]),
    ),
  ).toMatchObject({ ok: true });
  expect(
    (await f.projection()).deck.slideMeta[f.slide.id].templateId,
  ).toBeNull();
  expect((await f.projection()).slide.background).toBe("#123456");
  const result = await f.service.apply(
    f.request([
      { type: "deck.rename", name: "A beautiful deck" },
      { type: "slide.update", name: "Cover" },
    ]),
  );
  expect(result).toMatchObject({
    ok: true,
    changed: true,
    createdIds: [],
    updatedSlideIds: [f.slide.id],
    deckChanged: true,
  });
  expect((await f.projection()).deck.name).toBe("A beautiful deck");
  expect(
    await f.service.apply(
      f.request([{ type: "deck.rename", name: "A beautiful deck" }]),
    ),
  ).toMatchObject({ ok: true, changed: false });
  const created = await f.service.apply(
    f.request([{ type: "slide.create", afterId: null, name: "Cover" }]),
  );
  const id = created.createdSlideIds[0];
  expect(
    await f.service.apply({
      ...f.request([
        { type: "slide.update", name: "New cover", background: "#007F73" },
      ]),
      slideId: id,
    }),
  ).toMatchObject({ ok: true, updatedSlideIds: [id] });
  expect(
    (await f.runtime.projection(f.model.documentId, id)).slide.background,
  ).toBe("#007F73");
});

it("slide notes transitions and deck transition defaults use canonical slide metadata", async () => {
  const f = fixture();
  const result = await f.service.apply(
    f.request([
      {
        type: "slide.update",
        notes: "Speaker note",
        transition: {
          kind: "fade",
          durationMs: 180,
          easing: "ease-out",
        },
      },
      {
        type: "deck.transition_defaults.set",
        value: {
          kind: "wipe",
          durationMs: 240,
          easing: "linear",
        },
      },
    ]),
  );
  expect(result).toMatchObject({ ok: true, updatedSlideIds: [f.slide.id] });
  const p = await f.projection();
  expect(p.slide.notes).toBe("Speaker note");
  expect(p.deck.slideMeta[f.slide.id].transition).toEqual({
    kind: "fade",
    durationMs: 180,
    easing: "ease-out",
  });
  expect(p.deck.transitionDefaults).toEqual({
    kind: "wipe",
    durationMs: 240,
    easing: "linear",
  });
});

it("creative semantic operations reuse deck CSS Effects z-order and native Motion", async () => {
  const f = fixture();
  const root = f.slide.nodes[0].id;
  const first = await f.service.apply(
    f.request([
      {
        type: "deck.stylesheet.set",
        source: ".glass-card { box-shadow: 0 8px 24px #0008; }",
      },
      {
        type: "elements.css_classes.set",
        elementIds: ["shape"],
        classes: ["glass-card"],
      },
      {
        type: "elements.reorder",
        parentId: root,
        elementIds: ["shape"],
        mode: "front",
      },
      {
        type: "effect.apply_code",
        elementId: "shape",
        name: "Soft blur",
        effectType: "css",
        affects: "element",
        source: ":scope { filter: blur(calc(var(--amount) * 1px)); }",
        parameters: [
          {
            type: "number",
            key: "amount",
            label: "Amount",
            default: 8,
            min: 0,
            max: 20,
          },
        ],
      },
    ]),
  );
  expect(first).toMatchObject({
    ok: true,
    createdEffectInstanceIds: [expect.any(String)],
  });
  const effectId = first.createdEffectInstanceIds[0];
  const second = await f.service.apply(
    f.request([
      {
        type: "effect.parameter.set",
        elementId: "shape",
        effectInstanceId: effectId,
        key: "amount",
        value: 6,
      },
      {
        type: "motion.animate",
        stageIndex: 0,
        elementId: "shape",
        property: `effects.${effectId}.parameters.amount`,
        from: 8,
        to: 1,
        durationMs: 400,
        ease: "Ease Out",
      },
    ]),
  );
  expect(second).toMatchObject({
    ok: true,
    updatedEffectInstanceIds: [effectId],
  });
  const p = await f.projection();
  expect(p.deck.stylesheet).toContain(".glass-card");
  expect(findElement(p.slide, "shape")?.cssClasses).toEqual(["glass-card"]);
  expect(p.slide.nodes[0].children.at(-1)?.id).toBe("shape");
  expect(findElement(p.slide, "shape")?.effects?.[0].parameters.amount).toBe(6);
  expect(
    p.slide.motion?.stages[0].tracks.some(
      (track) =>
        track.elementId === "shape" &&
        track.property === `effects.${effectId}.parameters.amount`,
    ),
  ).toBe(true);
});

it("Presence uses named easing and attaches lifecycle animation to the grouped parent", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([
        {
          type: "presence.add",
          stageIndex: 0,
          elementIds: ["group"],
          transition: "move",
          direction: "Up",
          distance: 50,
          durationMs: 400,
          easing: "Ease Out",
          exitTransition: {
            kind: "fade",
            durationMs: 250,
            easing: "Ease In",
          },
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  const p = await f.projection();
  const block = p.slide.motion?.stages[0].blocks?.find(
    (candidate) =>
      candidate.binding?.kind === "presence" &&
      candidate.binding.elementId === "group",
  );
  expect(block).toMatchObject({
    binding: { kind: "presence", elementId: "group" },
    members: [],
    presenceSchedule: {
      enterTransition: {
        kind: "move",
        direction: "Up",
        distance: 50,
        durationMs: 400,
        easing: [0, 0, 0.58, 1],
      },
      exitTransition: {
        kind: "fade",
        durationMs: 250,
        easing: [0.42, 0, 1, 1],
      },
    },
  });
  expect(
    p.slide.motion?.stages[0].tracks.some(
      (track) => track.elementId === "group",
    ),
  ).toBe(false);
});

it("large semantic batches commit once stay atomic and remain bounded", async () => {
  const f = fixture();
  const root = f.slide.nodes[0].id;
  const operations = Array.from({ length: 50 }, (_, index) => ({
    type: "element.insert_shape" as const,
    id: `bulk-${index}`,
    parentId: root,
    shape: "rectangle" as const,
    frame: { x: index * 2, y: index * 2, width: 20, height: 20 },
  }));
  const accepted = await f.service.apply(f.request(operations, "bulk-50"));
  expect(accepted).toMatchObject({
    ok: true,
    previousRevision: 0,
    revision: 1,
  });
  expect(accepted.createdIds).toHaveLength(50);
  expect(f.counts()).toEqual({ writes: 1, notifications: 1 });

  const rejected = fixture();
  const rejectedRoot = rejected.slide.nodes[0].id;
  const before = await rejected.projection();
  const lateFailure = [
    ...Array.from({ length: 49 }, (_, index) => ({
      type: "element.insert_shape" as const,
      id: `late-${index}`,
      parentId: rejectedRoot,
      shape: "rectangle" as const,
      frame: { x: index, y: index, width: 10, height: 10 },
    })),
    {
      type: "element.insert_shape" as const,
      id: "late-invalid",
      parentId: "missing-parent",
      shape: "rectangle" as const,
      frame: { x: 0, y: 0, width: 10, height: 10 },
    },
  ];
  expect(
    await rejected.service.apply(
      rejected.request(lateFailure, "bulk-late-failure"),
    ),
  ).toMatchObject({
    error: { code: "INVALID_SCOPE" },
    stepIndex: 49,
  });
  expect(await rejected.projection()).toEqual(before);
  expect(rejected.counts().writes).toBe(0);

  expect(
    agentApplyRequestSchema.safeParse(
      rejected.request(
        Array.from({ length: 129 }, (_, index) => ({
          type: "element.insert_shape",
          id: `too-many-${index}`,
          parentId: rejectedRoot,
          shape: "rectangle",
          frame: { x: 0, y: 0, width: 10, height: 10 },
        })),
        "too-many",
      ),
    ).success,
  ).toBe(false);
});

it("builds composite cards with local children and parent Presence in one atomic batch", async () => {
  const f = fixture();
  let measurementCalls = 0;
  f.measure(async (element) => {
    measurementCalls++;
    return { width: element.frame.width, height: 48 };
  });
  const root = f.slide.nodes[0].id;
  const operations: any[] = [
    {
      type: "element.insert_text",
      id: "dashboard-title",
      parentId: root,
      frame: { x: 120, y: 80, width: 1200, height: 100 },
      autoSize: "none",
      text: "Dashboard",
      typography: { fontSize: 72, bold: true },
    },
  ];
  for (const [index, id] of ["card-a", "card-b", "card-c"].entries()) {
    operations.push(
      {
        type: "element.insert_frame",
        id,
        parentId: root,
        frame: {
          x: 120 + index * 560,
          y: 240,
          width: 500,
          height: 360,
        },
        name: `Card ${index + 1}`,
      },
      {
        type: "element.insert_shape",
        id: `${id}-background`,
        parentId: id,
        shape: "rectangle",
        frame: { x: 0, y: 0, width: 500, height: 360 },
        appearance: { fill: "#f4f4f4", radius: 24 },
      },
      {
        type: "element.insert_text",
        id: `${id}-label`,
        parentId: id,
        frame: { x: 32, y: 28, width: 436, height: 48 },
        autoSize: "height",
        text: "Metric",
        typography: { fontSize: 24 },
      },
      {
        type: "element.insert_text",
        id: `${id}-metric`,
        parentId: id,
        frame: { x: 32, y: 100, width: 436, height: 90 },
        autoSize: "none",
        text: `${(index + 1) * 25}%`,
        typography: { fontSize: 64, bold: true },
      },
    );
  }
  operations.push({
    type: "presence.add",
    stageIndex: 0,
    elementIds: ["card-a", "card-b", "card-c"],
    transition: "move",
    direction: "Up",
    distance: 40,
    durationMs: 350,
    easing: "Ease Out",
  });

  const receipt = await f.service.apply(
    f.request(operations, "composite-cards"),
  );
  expect(receipt).toMatchObject({
    ok: true,
    previousRevision: 0,
    revision: 1,
  });
  expect(f.counts()).toEqual({ writes: 1, notifications: 1 });
  expect(measurementCalls).toBe(1);

  const p = await f.projection();
  for (const id of ["card-a", "card-b", "card-c"]) {
    const card = findElement(p.slide, id)!;
    expect(card).toMatchObject({
      container: true,
      frame: { width: 500, height: 360 },
    });
    expect(card.children.map((child) => child.id)).toEqual([
      `${id}-background`,
      `${id}-label`,
      `${id}-metric`,
    ]);
    expect(findElement(p.slide, `${id}-label`)!.frame).toMatchObject({
      x: 32,
      y: 28,
      width: 436,
    });
    expect(findElement(p.slide, `${id}-label`)!.frame.height).toBeGreaterThan(
      0,
    );
  }
  const presenceParents = (p.slide.motion?.stages[0].blocks ?? [])
    .flatMap((block) =>
      block.binding?.kind === "presence" ? [block.binding.elementId] : [],
    )
    .sort();
  expect(presenceParents).toEqual(["card-a", "card-b", "card-c"]);
  expect(
    (p.slide.motion?.stages[0].tracks ?? []).some(
      (track) =>
        track.elementId.includes("-label") ||
        track.elementId.includes("-metric") ||
        track.elementId.includes("-background"),
    ),
  ).toBe(false);
});

it("structural authoring reuses native group duplicate reparent align distribute and Text Styles", async () => {
  const f = fixture();
  const root = f.slide.nodes[0].id;
  const grouped = await f.service.apply(
    f.request([
      {
        type: "elements.group",
        elementIds: ["title", "shape"],
        id: "cluster",
        name: "Cluster",
      },
      {
        type: "elements.frame.set",
        elementId: "cluster",
        frame: {
          x: 160,
          y: 160,
          width: 640,
          height: 360,
          rotation: 12,
        },
      },
    ]),
  );
  expect(grouped).toMatchObject({
    ok: true,
    createdIds: ["cluster"],
  });
  expect(findElement((await f.projection()).slide, "cluster")).toMatchObject({
    name: "Cluster",
    container: true,
    clipChildren: false,
    frame: { rotation: 12 },
  });

  const duplicated = await f.service.apply(
    f.request([
      {
        type: "elements.duplicate",
        elementIds: ["cluster"],
        offset: { x: 40, y: 20 },
      },
    ]),
  );
  expect(duplicated).toMatchObject({
    ok: true,
    idMap: {
      cluster: expect.any(String),
      title: expect.any(String),
      shape: expect.any(String),
    },
  });
  const duplicateId = duplicated.idMap.cluster;
  expect(findElement((await f.projection()).slide, duplicateId)).toBeTruthy();

  expect(
    await f.service.apply(
      f.request([{ type: "elements.ungroup", elementId: "cluster" }]),
    ),
  ).toMatchObject({ ok: true, removedIds: ["cluster"] });

  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.align",
          scopeId: root,
          elementIds: ["title", "shape"],
          axis: "left",
        },
        {
          type: "elements.distribute",
          scopeId: root,
          elementIds: ["title", "shape", duplicateId],
          axis: "horizontal",
        },
        {
          type: "elements.reparent",
          elementIds: ["shape"],
          parentId: "group",
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  expect(findElement((await f.projection()).slide, "group")!.children).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "shape" })]),
  );

  const headingId = f.model.deck.textStyles[0].id;
  expect(
    await f.service.apply(
      f.request([
        {
          type: "text.style.apply",
          elementIds: ["title"],
          styleId: headingId,
        },
        {
          type: "text.style",
          elementId: "title",
          typography: { fontSize: 88 },
        },
        {
          type: "text.style.clear_overrides",
          elementIds: ["title"],
        },
        {
          type: "text.style.create",
          elementId: "title",
          name: "Agent Heading",
          styleId: "agent-heading",
        },
      ]),
    ),
  ).toMatchObject({
    ok: true,
    createdTextStyleIds: ["agent-heading"],
  });
  expect(
    (await f.projection()).deck.textStyles.some(
      (style) => style.id === "agent-heading" && style.name === "Agent Heading",
    ),
  ).toBe(true);
});

it("slide duplicate move hide and delete preserve native slide semantics and return identity maps", async () => {
  const f = fixture();
  const duplicated = await f.service.apply(
    f.request([
      {
        type: "slide.duplicate",
        id: "copy-slide",
        name: "Copy",
      },
    ]),
  );
  expect(duplicated).toMatchObject({
    ok: true,
    createdSlideIds: ["copy-slide"],
    idMap: {
      title: expect.any(String),
      shape: expect.any(String),
      group: expect.any(String),
      child: expect.any(String),
    },
  });
  const changed = await f.service.apply({
    ...f.request([
      { type: "slide.update", hidden: true, name: "Hidden copy" },
      { type: "slide.move", afterId: null },
    ]),
    slideId: "copy-slide",
  });
  expect(changed).toMatchObject({ ok: true });
  const copy = await f.runtime.projection(f.model.documentId, "copy-slide");
  expect(copy.deck.slideIds[0]).toBe("copy-slide");
  expect(copy.deck.slideMeta["copy-slide"]).toMatchObject({
    name: "Hidden copy",
    hidden: true,
  });

  expect(
    await f.service.apply({
      ...f.request([{ type: "slide.delete" }]),
      slideId: "copy-slide",
    }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).not.toContain("copy-slide");
});

it("layer authoring creates stable parents and respects visibility locking", async () => {
  const f = fixture();
  const created = await f.service.apply(
    f.request([
      {
        type: "layer.create",
        id: "agent-layer",
        patch: { name: "Agent Layer", color: "#123456" },
      },
      {
        type: "element.insert_shape",
        id: "layer-shape",
        parentId: "agent-layer",
        shape: "rectangle",
        frame: { x: 20, y: 30, width: 100, height: 80 },
      },
    ]),
  );
  expect(created).toMatchObject({
    ok: true,
    createdLayerIds: ["agent-layer"],
    createdIds: ["layer-shape"],
  });
  let p = await f.projection();
  expect(p.deck.layers.at(-1)).toMatchObject({
    id: "agent-layer",
    name: "Agent Layer",
    color: "#123456",
    hidden: false,
    locked: false,
  });
  expect(p.slide.nodes.at(-1)?.children[0]?.id).toBe("layer-shape");

  expect(
    await f.service.apply(
      f.request([
        {
          type: "layer.update",
          layerId: "agent-layer",
          patch: { hidden: true, locked: true },
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.move",
          elementIds: ["layer-shape"],
          scopeId: "agent-layer",
          dx: 10,
          dy: 0,
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "TARGET_NOT_EDITABLE" } });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "layer.update",
          layerId: "agent-layer",
          patch: { hidden: false, locked: false },
        },
        {
          type: "layer.reorder",
          layerIds: ["agent-layer"],
          index: 0,
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  p = await f.projection();
  expect(p.deck.layers[0].id).toBe("agent-layer");
});

it("managed media can be inserted by asset ID and exposes semantic fit fill center reset and content transforms", async () => {
  const f = fixture();
  const inserted = await f.service.apply(
    f.request([
      {
        type: "element.insert_media",
        id: "inserted-media",
        parentId: f.slide.nodes[0].id,
        assetId: "c".repeat(64),
        frame: { x: 200, y: 180, width: 720, height: 480 },
        name: "Managed image",
      },
    ]),
  );
  expect(inserted).toMatchObject({
    ok: true,
    createdIds: ["inserted-media"],
  });
  expect(
    findElement((await f.projection()).slide, "inserted-media"),
  ).toMatchObject({
    name: "Managed image",
    frame: { x: 200, y: 180, width: 720, height: 480 },
    content: {
      type: "image",
      assetId: "c".repeat(64),
      transform: {
        rule: "fill",
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      },
    },
  });

  const p = await f.projection();
  const media = createBasicShape("managed-media", "rectangle");
  media.frame = {
    ...media.frame,
    x: 100,
    y: 100,
    width: 600,
    height: 400,
  };
  media.content = {
    type: "image",
    assetId: "b".repeat(64),
    filename: "managed.png",
    mediaType: "image",
    opacity: 1,
    lockAspect: true,
    transform: {
      rule: "fill",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
      rotation: 0,
      flipX: false,
      flipY: false,
      anchorX: 0.5,
      anchorY: 0.5,
      zoom: 1,
    },
  };
  p.slide.nodes[0].children.push(media);
  const fit = await assembleAgentMutation(
    p,
    agentSingleApplyRequestSchema.parse(
      f.request([{ type: "frame.fit", elementId: "managed-media" }]),
    ),
    async () => null,
  );
  expect(
    findElement(fit.snapshot.slide, "managed-media")!.content,
  ).toMatchObject({
    transform: { rule: "fit", intrinsicWidth: 1200, intrinsicHeight: 800 },
  });
  const moved = await assembleAgentMutation(
    {
      ...p,
      deck: fit.snapshot.deck,
      slide: fit.snapshot.slide,
      templates: fit.snapshot.templates,
    },
    agentSingleApplyRequestSchema.parse(
      f.request([
        {
          type: "frame.content_transform.set",
          elementId: "managed-media",
          frame: {
            x: 20,
            y: 30,
            width: 560,
            height: 360,
            rotation: 8,
          },
        },
        { type: "frame.content_center", elementId: "managed-media" },
        { type: "frame.content_reset", elementId: "managed-media" },
        { type: "frame.fill", elementId: "managed-media" },
      ]),
    ),
    async () => null,
  );
  expect(
    findElement(moved.snapshot.slide, "managed-media")!.content,
  ).toMatchObject({
    transform: {
      rule: "fill",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zoom: 1,
    },
  });

  const free = structuredClone(p);
  const freeMedia = findElement(free.slide, "managed-media")!;
  if (!freeMedia.content || freeMedia.content.type === "text")
    throw new Error("Missing media fixture");
  freeMedia.content.transform = {
    rule: "free",
    local: {
      ...freeMedia.frame,
      x: 0,
      y: 0,
    },
  };
  await expect(
    assembleAgentMutation(
      free,
      agentSingleApplyRequestSchema.parse(
        f.request([{ type: "frame.fill", elementId: "managed-media" }]),
      ),
      async () => null,
    ),
  ).rejects.toMatchObject({ code: "INVALID_MEDIA" });
});

it("shader parameters reconcile from source and validation failure is atomic", async () => {
  const shader = `#version 300 es
precision highp float;
uniform float movement; // @param 0.6 [0, 1]
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = vec4(v_uv.x * movement, 0.1, 0.2, 1.0);
}`;
  const f = fixture();
  const accepted = await f.service.apply(
    f.request([
      {
        type: "background.shader.create",
        name: "Generated green",
        source: shader,
        timeControl: { start: "slide", stop: { mode: "none" } },
      },
    ]),
  );
  expect(accepted).toMatchObject({
    ok: true,
    createdIds: [expect.any(String)],
    createdEffectInstanceIds: [expect.any(String)],
  });
  const p = await f.projection();
  const created = findElement(p.slide, accepted.createdIds[0])!;
  const definition = p.slide.effectResources?.[created.effects![0].resourceId];
  expect(definition?.parameters).toMatchObject([
    { key: "movement", default: 0.6, min: 0, max: 1 },
  ]);

  const rejected = fixture();
  const before = await rejected.projection();
  rejected.validateEffect(async (_id, definition) => ({
    ok: false,
    kind: definition.kind,
    diagnostics: [
      { severity: "error", line: 7, message: "synthetic compile failure" },
    ],
  }));
  expect(
    await rejected.service.apply(
      rejected.request([
        {
          type: "background.shader.create",
          name: "Broken",
          source: shader,
        },
      ]),
    ),
  ).toMatchObject({
    error: {
      code: "EFFECT_VALIDATION_ERROR",
      details: {
        kind: "fragment-glsl",
        diagnostics: [{ line: 7, message: "synthetic compile failure" }],
      },
    },
  });
  expect(await rejected.projection()).toEqual(before);
  expect(rejected.counts().writes).toBe(0);
});

it("strict semantic requests reject raw document patches invalid numbers colors and implicit selection", async () => {
  const f = fixture();
  expect(
    agentApplyRequestSchema.safeParse(
      f.request([{ type: "text.set", elementId: "title", text: "New" }]),
    ).success,
  ).toBe(true);
  expect(
    await f.service.apply({ ...f.request([]), document: f.model }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.apply(
      f.request([
        { type: "elements.move", elementIds: ["title"], dx: 1, dy: 1 },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.frame.set",
          elementId: "shape",
          frame: { x: 0, y: 0, width: 0, height: Infinity },
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.appearance.patch",
          elementIds: ["shape"],
          patch: { fill: "url(private)" },
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(f.counts().writes).toBe(0);
});
it("all seven operations use one native transaction and return generated measured IDs and semantic changes", async () => {
  const f = fixture(),
    root = f.slide.nodes[0].id;
  const result = await f.service.apply(
    f.request([
      { type: "text.set", elementId: "title", text: "Changed" },
      {
        type: "elements.move",
        elementIds: ["shape"],
        scopeId: root,
        dx: 10,
        dy: 20,
      },
      {
        type: "elements.frame.set",
        elementId: "shape",
        frame: { x: 40, y: 50, width: 200, height: 80 },
      },
      {
        type: "elements.appearance.patch",
        elementIds: ["shape"],
        patch: { fill: "#ff0000", opacity: 0.5 },
      },
      {
        type: "element.insert_text",
        parentId: root,
        frame: { x: 150, y: 100, width: 800, height: 180 },
        autoSize: "both",
        text: "Label",
        name: "Agent label",
      },
      {
        type: "element.insert_shape",
        parentId: root,
        shape: "ellipse",
        frame: { x: 200, y: 100, width: 90, height: 70 },
      },
      { type: "elements.remove", elementIds: ["group"] },
    ]),
  );
  expect(result).toMatchObject({
    ok: true,
    changed: true,
    previousRevision: 0,
    revision: 1,
    removedIds: ["group", "child"],
    changedIds: ["title", "shape"],
    createdIds: [expect.any(String), expect.any(String)],
  });
  const p = await f.projection();
  expect(findElement(p.slide, "shape")).toMatchObject({
    frame: { x: 40, y: 50, width: 200, height: 80 },
    appearance: { fill: "#ff0000", opacity: 0.5 },
  });
  expect(findElement(p.slide, result.createdIds[0])).toMatchObject({
    name: "Agent label",
    content: { text: "Label" },
    frame: { height: expect.any(Number) },
  });
  expect(f.counts().writes).toBe(1);
  expect(
    f.runtime.historyStateForActor(f.model.documentId, "mcp-local").canUndo,
  ).toBe(true);
  expect(
    f.runtime.historyStateForActor(f.model.documentId, "local").canUndo,
  ).toBe(false);
  await f.runtime.undoForActor(f.model.documentId, "mcp-local");
});
it("a later invalid target or unsupported text operation commits none of a staged batch", async () => {
  const f = fixture(),
    before = await f.projection();
  const result = await f.service.apply(
    f.request([
      { type: "text.set", elementId: "title", text: "Must not persist" },
      { type: "elements.remove", elementIds: ["missing"] },
    ]),
  );
  expect(result).toMatchObject({
    error: { code: "UNKNOWN_ELEMENT" },
    stepIndex: 1,
  });
  expect(await f.projection()).toEqual(before);
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "shape", text: "Wrong" }]),
    ),
  ).toMatchObject({ error: { code: "UNSUPPORTED_OPERATION" } });
  expect(f.counts().writes).toBe(0);
});
it("no-op edits neither advance revision nor create an agent history unit", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Original" }]),
    ),
  ).toMatchObject({
    ok: true,
    changed: false,
    transactionId: null,
    revision: 0,
  });
  expect(f.service.history().canUndo).toBe(false);
  expect(f.counts().writes).toBe(0);
});
it("deduplicates concurrent and reconnected retries with canonical fingerprints and original insertion IDs", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  f.writer(async () => {
    entered.resolve();
    await held.promise;
  });
  const input = f.request(
    [
      {
        type: "element.insert_shape",
        parentId: f.slide.nodes[0].id,
        shape: "rectangle",
        frame: { x: 0, y: 0, width: 20, height: 20 },
      },
    ],
    "retry",
  );
  const first = f.service.apply(input);
  await entered.promise;
  const second = f.service.apply({
    ...input,
    operations: [
      {
        frame: { height: 20, width: 20, y: 0, x: 0 },
        type: "element.insert_shape",
        shape: "rectangle",
        parentId: f.slide.nodes[0].id,
      },
    ],
  });
  held.resolve();
  const accepted = await first;
  expect(await second).toEqual({
    ...accepted,
    replayed: true,
    currentObservation: {
      epoch: "epoch",
      revision: f.runtime.metadata(f.model.documentId).revision,
    },
  });
  f.access(null);
  f.access(2);
  expect(await f.service.apply(input)).toEqual({
    ...accepted,
    replayed: true,
    currentObservation: {
      epoch: "epoch",
      revision: f.runtime.metadata(f.model.documentId).revision,
    },
  });
  expect(
    await f.service.apply({ ...input, expectedRevision: 1 }),
  ).toMatchObject({ error: { code: "MUTATION_ID_REUSED" } });
  expect(f.counts().writes).toBe(1);
});
it("exact expected revision rejects disjoint edits queued ahead of agent admission", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  f.writer(async () => {
    entered.resolve();
    await held.promise;
  });
  const p = await f.projection();
  const lease = f.runtime.acquireForActor(f.model.documentId, "local", [
    { kind: "notes", slideId: p.slide.id },
  ]);
  if (lease.denied) throw new Error("Fixture lease denied");
  const human = f.runtime.commit(f.model.documentId, {
    transactionId: "human",
    documentId: f.model.documentId,
    epoch: "epoch",
    baseRevision: 0,
    leaseTokens: lease.grants.map((grant) => grant.token),
    operations: [...editorOperations(setSlideNotes(p, "Human notes"))],
  });
  await entered.promise;
  const queued = deferred();
  const commit = f.runtime.commitForActor.bind(f.runtime);
  f.runtime.commitForActor = (id, actor, transaction, admit) => {
    const result = commit(id, actor, transaction, admit);
    if (actor === "mcp-local") queued.resolve();
    return result;
  };
  const agent = f.service.apply(
    f.request([{ type: "text.set", elementId: "title", text: "Stale" }]),
  );
  await queued.promise;
  held.resolve();
  await human;
  expect(await agent).toMatchObject({
    error: { code: "REVISION_CONFLICT", actualRevision: 1 },
  });
  expect(
    findElement((await f.projection()).slide, "title")!.content,
  ).toMatchObject({ text: "Original" });
  expect(f.counts().writes).toBe(1);
});
it("human ancestor and LAN leases deny agent writes while unrelated leases do not get replaced", async () => {
  const f = fixture();
  const lease = f.runtime.acquireForActor(f.model.documentId, "local", [
    { kind: "element", slideId: f.slide.id, elementId: "group" },
  ]);
  if (lease.denied) throw new Error("Fixture lease denied");
  const peerLease = f.runtime.acquireForActor(f.model.documentId, "lan-peer", [
    { kind: "element", slideId: f.slide.id, elementId: "shape" },
  ]);
  if (peerLease.denied) throw new Error("Fixture peer lease denied");
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.appearance.patch",
          elementIds: ["shape"],
          patch: { fill: "#ff0000" },
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "LEASE_DENIED" } });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.appearance.patch",
          elementIds: ["child"],
          patch: { fill: "#ff0000" },
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "LEASE_DENIED" } });
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Allowed" }]),
    ),
  ).toMatchObject({ ok: true });
  expect(
    f.runtime
      .leaseState(f.model.documentId)
      .some((grant) => grant.token === lease.grants[0].token),
  ).toBe(true);
  expect(
    f.runtime
      .leaseState(f.model.documentId)
      .some((grant) => grant.actorId === "mcp-local"),
  ).toBe(false);
});
it("pre-admission measurement cancellation access changes guest and active-document checks reject without writes", async () => {
  const f = fixture(),
    held = deferred(),
    entered = deferred();
  f.measure(async () => {
    entered.resolve();
    await held.promise;
    return { width: 10, height: 20 };
  });
  const controller = new AbortController();
  const pending = f.service.apply(
    f.request([
      {
        type: "element.insert_text",
        parentId: f.slide.nodes[0].id,
        frame: { x: 0, y: 0, width: 800, height: 180 },
        autoSize: "both",
        text: "Held",
      },
    ]),
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  held.resolve();
  expect(await pending).toMatchObject({ error: { code: "REQUEST_CANCELLED" } });
  f.reason("GUEST_EDITING_UNSUPPORTED");
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Guest" }]),
    ),
  ).toMatchObject({ error: { code: "GUEST_EDITING_UNSUPPORTED" } });
  f.reason(null);
  f.active(null);
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Closed" }]),
    ),
  ).toMatchObject({ error: { code: "DOCUMENT_NOT_ACTIVE" } });
  expect(f.counts().writes).toBe(0);
});
it("revocation during durable writing preserves accepted outcome and retry identity", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  f.writer(async () => {
    entered.resolve();
    await held.promise;
  });
  const input = f.request(
    [{ type: "text.set", elementId: "title", text: "Durable" }],
    "durable",
  );
  const pending = f.service.apply(input);
  await entered.promise;
  f.access(null);
  held.resolve();
  expect(await pending).toMatchObject({ ok: true, revision: 1 });
  f.access(2);
  expect(await f.service.apply(input)).toMatchObject({
    ok: true,
    replayed: true,
    revision: 1,
  });
  expect(f.counts().writes).toBe(1);
});
it("durable failure leaves accepted state and agent history unchanged", async () => {
  const f = fixture(),
    before = await f.projection();
  f.writer(async () => {
    throw new Error("PRIVATE_WRITER_PATH");
  });
  const result = await f.service.apply(
    f.request([{ type: "text.set", elementId: "title", text: "Failure" }]),
  );
  expect(result).toMatchObject({ error: { code: "COMMIT_FAILED" } });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_WRITER_PATH");
  expect(await f.projection()).toEqual(before);
  expect(f.service.history().canUndo).toBe(false);
});
it("agent undo and redo preserve disjoint human history and replay never reapplies an undone edit", async () => {
  const f = fixture(),
    input = f.request(
      [{ type: "text.set", elementId: "title", text: "Agent" }],
      "undo-retry",
    );
  expect(await f.service.apply(input)).toMatchObject({ ok: true });
  const p = await f.projection(),
    shape = findElement(p.slide, "shape")!;
  const lease = f.runtime.acquireForActor(f.model.documentId, "local", [
    { kind: "element", slideId: f.slide.id, elementId: "shape" },
  ]);
  if (lease.denied) throw new Error("Fixture lease denied");
  await f.runtime.commit(f.model.documentId, {
    transactionId: "human-style",
    documentId: f.model.documentId,
    epoch: "epoch",
    baseRevision: 1,
    leaseTokens: lease.grants.map((grant) => grant.token),
    operations: [
      ...editorOperations(
        setElementAppearances(p, [
          {
            elementId: "shape",
            value: { ...shape.appearance, fill: "#ff0000" },
          },
        ]),
      ),
    ],
  });
  f.runtime.releaseForActor(f.model.documentId, "local");
  f.access(null);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect(
    findElement((await f.projection()).slide, "shape")!.appearance.fill,
  ).toBe("#ff0000");
  expect(
    findElement((await f.projection()).slide, "title")!.content,
  ).toMatchObject({ text: "Original" });
  f.access(3);
  expect(await f.service.apply(input)).toMatchObject({
    ok: true,
    replayed: true,
    revision: 1,
  });
  expect(
    findElement((await f.projection()).slide, "title")!.content,
  ).toMatchObject({ text: "Original" });
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: true }),
  ).toMatchObject({ ok: true });
});
it("live epoch replay capacity rejects new identities without eviction but permits accepted retries", async () => {
  const f = fixture({ maxIdentities: 1 });
  const input = f.request(
    [{ type: "text.set", elementId: "title", text: "One" }],
    "one",
  );
  expect(await f.service.apply(input)).toMatchObject({ ok: true });
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Two" }], "two"),
    ),
  ).toMatchObject({ error: { code: "MUTATION_CAPACITY_REACHED" } });
  expect(await f.service.apply(input)).toMatchObject({
    ok: true,
    replayed: true,
  });
});
it("locked layers inherited targets invalid scopes and ancestor-descendant transforms are rejected atomically", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([
        {
          type: "elements.move",
          elementIds: ["group", "child"],
          scopeId: f.slide.nodes[0].id,
          dx: 10,
          dy: 0,
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_SCOPE" } });
  expect(
    await f.service.apply(
      f.request([
        {
          type: "element.insert_text",
          parentId: "missing",
          frame: { x: 0, y: 0, width: 800, height: 180 },
          autoSize: "both",
          text: "Bad",
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_SCOPE" } });
  const p = await f.projection();
  p.deck.layers[0].locked = true;
  const request = agentSingleApplyRequestSchema.parse(
    f.request([{ type: "elements.remove", elementIds: ["title"] }]),
  );
  await expect(
    assembleAgentMutation(p, request, async () => null),
  ).rejects.toMatchObject({ code: "TARGET_NOT_EDITABLE" });
  expect(f.counts().writes).toBe(0);
});

it("frame sizing preserves Free media world placement under a rotated scaled parent and disables native text auto-size", async () => {
  const f = fixture(),
    p = await f.projection();
  const group = findElement(p.slide, "group")!;
  group.frame.rotation = 35;
  group.frame.scaleX = 1.6;
  group.frame.scaleY = 0.7;
  const media = createBasicShape("media", "rectangle");
  media.frame.rotation = 20;
  media.content = {
    type: "image",
    assetId: "a".repeat(64),
    filename: "private.png",
    mediaType: "image",
    opacity: 1,
    lockAspect: true,
    transform: {
      rule: "free",
      local: {
        ...media.frame,
        rotation: 0,
        x: -20,
        y: 10,
        width: 800,
        height: 400,
      },
    },
  };
  group.children = [media];
  const title = findElement(p.slide, "title")!;
  if (title.content?.type === "text") title.content.autoSize = "both";
  const world = multiply(
    getWorldMatrix(p.slide, "media"),
    localMatrix(resolveMediaFrame(media)!),
  );
  const result = await assembleAgentMutation(
    p,
    agentSingleApplyRequestSchema.parse(
      f.request([
        {
          type: "elements.frame.set",
          elementId: "media",
          frame: { x: 50, y: 20, width: 200, height: 100 },
        },
        {
          type: "elements.frame.set",
          elementId: "title",
          frame: { x: 70, y: 90, width: 300, height: 100 },
        },
      ]),
    ),
    async () => {
      throw new Error("Explicit resize must not request auto-size");
    },
  );
  const after = findElement(result.snapshot.slide, "media")!;
  expect(after.frame.rotation).toBe(20);
  const afterWorld = multiply(
    getWorldMatrix(result.snapshot.slide, "media"),
    localMatrix(resolveMediaFrame(after)!),
  );
  afterWorld.forEach((value, index) =>
    expect(value).toBeCloseTo(world[index], 6),
  );
  expect(findElement(result.snapshot.slide, "title")!.content).toMatchObject({
    autoSize: "none",
  });
});

it("known durable acceptance survives a post-commit history refresh failure", async () => {
  const f = fixture(),
    history = f.runtime.historyStateForActor.bind(f.runtime);
  f.runtime.historyStateForActor = (id, actor) => {
    if (f.runtime.currentRevision(id) > 0)
      throw new Error("PRIVATE_REFRESH_ERROR");
    return history(id, actor);
  };
  const input = f.request(
    [{ type: "text.set", elementId: "title", text: "Accepted" }],
    "refresh-failure",
  );
  expect(await f.service.apply(input)).toMatchObject({
    ok: true,
    revision: 1,
    warnings: [{ code: "REFRESH_FAILED" }],
  });
  expect(await f.service.apply(input)).toMatchObject({
    ok: true,
    replayed: true,
    revision: 1,
  });
  expect(f.counts().writes).toBe(1);
});

it("access generation changes while measuring invalidate staged work before admission", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  f.measure(async () => {
    entered.resolve();
    await held.promise;
    return { width: 100, height: 30 };
  });
  const pending = f.service.apply(
    f.request([
      {
        type: "element.insert_text",
        parentId: f.slide.nodes[0].id,
        frame: { x: 0, y: 0, width: 800, height: 180 },
        autoSize: "both",
        text: "Unaccepted",
      },
    ]),
  );
  await entered.promise;
  f.access(2);
  held.resolve();
  expect(await pending).toMatchObject({
    error: { code: "MCP_ACCESS_CHANGED" },
  });
  expect(f.counts().writes).toBe(0);
});

it("closing a runtime while measuring rejects staged writes and reopening requires a new epoch", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  f.measure(async () => {
    entered.resolve();
    await held.promise;
    return { width: 100, height: 30 };
  });
  const pending = f.service.apply(
    f.request([
      {
        type: "element.insert_text",
        parentId: f.slide.nodes[0].id,
        frame: { x: 0, y: 0, width: 800, height: 180 },
        autoSize: "both",
        text: "Closing",
      },
    ]),
  );
  await entered.promise;
  f.service.forget(f.model.documentId);
  held.resolve();
  expect(await pending).toMatchObject({ error: { code: "DOCUMENT_CLOSED" } });
  const reopened = new DocumentRuntime(f.model, {
    actorId: "local",
    epoch: "reopened",
    durableCommit: async () => {},
  });
  f.current(reopened);
  expect(
    await f.service.apply(
      f.request([{ type: "text.set", elementId: "title", text: "Old" }]),
    ),
  ).toMatchObject({ error: { code: "EPOCH_CONFLICT" } });
  expect(f.counts().writes).toBe(0);
});

it("MCP template authoring shares one native background and preserves ownership and undo", async () => {
  const f = fixture();
  const created = await f.service.apply(
    f.request([
      { type: "template.create", id: "shared-theme", background: "#101020" },
      {
        type: "element.insert_text",
        id: "theme-label",
        parentId: f.model.deck.layers[0].id,
        frame: { x: 30, y: 20, width: 400, height: 70 },
        text: "Shared label",
      },
    ]),
  );
  expect(created).toMatchObject({
    ok: true,
    createdTemplateIds: ["shared-theme"],
  });
  let p = await f.runtime.projection(f.model.documentId, "shared-theme");
  expect(p.slide.background).toBe("#101020");
  expect(findElement(p.slide, "theme-label")).toBeTruthy();
  expect(
    await f.service.apply({
      ...f.request([
        { type: "template.background.set", background: "#202040" },
      ]),
      slideId: "shared-theme",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.service.apply(
      f.request([{ type: "slide.template.apply", templateId: "shared-theme" }]),
    ),
  ).toMatchObject({ ok: true });
  expect(
    await f.service.apply(
      f.request([
        { type: "text.set", elementId: "theme-label", text: "Wrong owner" },
      ]),
    ),
  ).toMatchObject({ error: { code: "TEMPLATE_OWNED" } });
  expect(
    await f.service.apply(
      f.request([{ type: "template.delete", templateId: "shared-theme" }]),
    ),
  ).toMatchObject({ ok: false });
  p = await f.runtime.projection(f.model.documentId, "shared-theme");
  expect(p.slide.background).toBe("#202040");
  expect(
    await f.service.apply({
      ...f.request([{ type: "slide.update", notes: "invalid" }]),
      slideId: "shared-theme",
    }),
  ).toMatchObject({ error: { code: "INVALID_SCOPE" } });
});

it("MCP direct text styles and native slide recipes retain shared references and replace only declared slots", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([
        {
          type: "text.style.define",
          styleId: "design-title",
          name: "Design title",
          typography: { fontFamily: "Arial", fontSize: 96, color: "#AACCEE" },
        },
        {
          type: "text.style.apply",
          elementIds: ["title"],
          styleId: "design-title",
        },
      ]),
    ),
  ).toMatchObject({ ok: true, createdTextStyleIds: ["design-title"] });
  const result = await f.service.apply(
    f.request([
      {
        type: "slide.duplicate",
        id: "recipe-copy",
        name: "Recipe instance",
        textReplacements: { title: "New narrative" },
      },
    ]),
  );
  expect(result).toMatchObject({ ok: true, createdSlideIds: ["recipe-copy"] });
  const p = await f.runtime.projection(f.model.documentId, "recipe-copy");
  expect(findElement(p.slide, result.idMap.title)?.content).toMatchObject({
    text: "New narrative",
    format: { kind: "style", styleId: "design-title" },
  });
  expect(
    (await f.projection()).slide.nodes[0].children[0].content,
  ).toMatchObject({ text: "Original" });
  const revision = f.runtime.currentRevision(f.model.documentId);
  expect(
    await f.service.apply(
      f.request([
        {
          type: "slide.duplicate",
          id: "bad-recipe",
          textReplacements: { missing: "bad" },
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "UNKNOWN_ELEMENT" } });
  expect(f.runtime.currentRevision(f.model.documentId)).toBe(revision);
});

it("MCP named native effect resources share source with independent instances and validate updates atomically", async () => {
  const f = fixture();
  const applied = await f.service.apply(
    f.request([
      {
        type: "effect.apply_code",
        elementId: "shape",
        name: "Shared CSS",
        effectType: "css",
        affects: "element",
        source: ":scope {opacity:0.8}",
      },
    ]),
  );
  expect(applied).toMatchObject({ ok: true });
  const instanceId = applied.createdEffectInstanceIds[0];
  expect(
    await f.service.apply(
      f.request([
        {
          type: "effect.resource.capture",
          elementId: "shape",
          effectInstanceId: instanceId,
          resourceId: "shared-css",
        },
        {
          type: "effect.resource.attach",
          elementId: "title",
          resourceId: "shared-css",
        },
        {
          type: "effect.resource.update",
          resourceId: "shared-css",
          source: ":scope {opacity:0.6}",
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  const p = await f.projection();
  expect(findElement(p.slide, "shape")?.effects?.[0].resourceId).toBe(
    "shared-css",
  );
  expect(findElement(p.slide, "title")?.effects?.[0].resourceId).toBe(
    "shared-css",
  );
  expect(p.slide.effectResources?.["shared-css"].source).toBe(
    ":scope {opacity:0.6}",
  );
});

it("MCP expanded budget admits larger semantic intents without exceeding native transaction bounds", () => {
  const f = fixture();
  const operations = Array.from({ length: 129 }, () => ({
    type: "deck.rename",
    name: "Design",
  }));
  expect(agentApplyRequestSchema.safeParse(f.request(operations)).success).toBe(
    false,
  );
  expect(
    agentApplyRequestSchema.safeParse({
      ...f.request(operations),
      budget: "expanded",
    }).success,
  ).toBe(true);
  expect(
    agentApplyRequestSchema.safeParse({
      ...f.request([...operations, ...operations]),
      budget: "expanded",
    }).success,
  ).toBe(false);
});

it("SDK semantic diagnostics bound malformed known and unknown operation issues without echoing source", () => {
  const f = fixture();
  const known = validateApplyInput(
    f.request([
      { type: "deck.transition_defaults.set", kind: "fade", durationMs: 750 },
    ]),
  );
  expect(known).toMatchObject({
    success: false,
    error: {
      error: {
        code: "INVALID_REQUEST",
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "operations.0.value" }),
          ]),
        },
      },
    },
  });
  expect(JSON.stringify(known).length).toBeLessThan(2000);
  const missingRevision = {
    ...f.request([{ type: "deck.rename", name: "Safe" }]),
    expectedRevision: undefined,
  };
  expect(validateApplyInput(missingRevision)).toMatchObject({
    success: false,
    error: {
      error: {
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "expectedRevision" }),
          ]),
        },
      },
    },
  });
  expect(
    validateApplyInput(
      f.request([{ type: "unknown.operation", source: "private-source" }]),
    ),
  ).toMatchObject({
    success: false,
    error: { error: { details: { issues: [{ path: "operations.0.type" }] } } },
  });
  expect(
    JSON.stringify(
      validateApplyInput(
        f.request([{ type: "unknown.operation", source: "private-source" }]),
      ),
    ),
  ).not.toContain("private-source");
});
it("MCP style collisions return the native conflicting identity and keep the batch atomic", async () => {
  const f = fixture();
  const result = await f.service.apply(
    f.request([
      { type: "deck.rename", name: "Unaccepted" },
      {
        type: "text.style.define",
        styleId: "collision",
        name: "Heading",
        typography: { fontSize: 72 },
      },
    ]),
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      details: {
        conflictingStyle: { name: "Heading", id: expect.any(String) },
      },
    },
  });
  expect(f.runtime.currentRevision(f.model.documentId)).toBe(0);
  expect((await f.projection()).deck.name).not.toBe("Unaccepted");
});
it("MCP resource rename prunes only orphaned definitions and reports native users", async () => {
  const f = fixture();
  const applied = await f.service.apply(
    f.request([
      {
        type: "effect.apply_code",
        elementId: "shape",
        name: "Prune CSS",
        effectType: "css",
        affects: "element",
        source: ":scope {opacity: var(--amount)}",
        parameters: [
          {
            key: "amount",
            label: "Amount",
            type: "number",
            default: 0.8,
            min: 0,
            max: 1,
          },
        ],
      },
    ]),
  );
  const instanceId = applied.createdEffectInstanceIds[0];
  expect(
    await f.service.apply(
      f.request([
        {
          type: "motion.animate",
          stageIndex: 0,
          elementId: "shape",
          property: "effects." + instanceId + ".parameters.amount",
          from: 0.3,
          to: 0.8,
          durationMs: 600,
        },
      ]),
    ),
  ).toMatchObject({ ok: true });
  const before = await f.projection();
  const old = findElement(before.slide, "shape")!.effects![0].resourceId;
  const renamed = await f.service.apply(
    f.request([
      {
        type: "effect.resource.capture",
        elementId: "shape",
        effectInstanceId: instanceId,
        resourceId: "named-css",
      },
    ]),
  );
  expect(renamed).toMatchObject({
    ok: true,
    resourceChanges: expect.arrayContaining([
      {
        pageId: before.slide.id,
        resourceId: old,
        kind: "removed",
        elementIds: [],
      },
      {
        pageId: before.slide.id,
        resourceId: "named-css",
        kind: "created",
        elementIds: ["shape"],
      },
    ]),
  });
  expect((await f.projection()).slide.effectResources?.[old]).toBeUndefined();
  expect((await f.projection()).slide.motion).toEqual(before.slide.motion);
  const update = await f.service.apply(
    f.request([
      {
        type: "effect.resource.update",
        resourceId: "named-css",
        source: ":scope {opacity: calc(var(--amount) * 0.9)}",
      },
    ]),
  );
  expect(update).toMatchObject({
    ok: true,
    changedIds: [],
    resourceChanges: [
      {
        pageId: before.slide.id,
        resourceId: "named-css",
        kind: "changed",
        elementIds: ["shape"],
      },
    ],
  });
  const prune = await f.service.apply(
    f.request([{ type: "effect.resource.prune" }]),
  );
  expect(prune).toMatchObject({ ok: true, changed: false });
  expect(
    findElement((await f.projection()).slide, "shape")!.effects![0].id,
  ).toBe(instanceId);
});
