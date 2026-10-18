import { expect, it } from "vitest";
import { AgentEditingService } from "../../../electron/agentEditing";
import {
  agentApplyRequestSchema,
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
  const service = new AgentEditingService({
    ...options,
    access: () => access,
    eligibility: () => reason,
    activeDocumentId: () => active,
    runtime: () => current,
    measure: (_id, element) => measure(element),
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
  expect(await f.service.apply(request)).toEqual({ ...result, replayed: true });
  expect(f.counts().writes).toBe(1);
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: false }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toEqual([f.slide.id]);
  expect(await f.service.apply(request)).toEqual({ ...result, replayed: true });
  expect(
    await f.service.undo({ documentId: f.model.documentId, redo: true }),
  ).toMatchObject({ ok: true });
  expect((await f.projection()).deck.slideIds).toEqual([f.slide.id, id]);
});

it("slide anchors and isolated creation reject atomically and stale slide requests do not retarget", async () => {
  const f = fixture();
  expect(
    await f.service.apply(
      f.request([{ type: "slide.create", afterId: "missing", name: "Bad" }]),
    ),
  ).toMatchObject({ error: { code: "UNKNOWN_SLIDE" } });
  expect(
    await f.service.apply(
      f.request([
        { type: "slide.create", afterId: null, name: "Bad" },
        { type: "text.set", elementId: "title", text: "No" },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(f.counts().writes).toBe(0);
  const request = f.request([
    { type: "slide.create", afterId: null, name: "First" },
  ]);
  const result = await f.service.apply(request);
  expect((await f.projection()).deck.slideIds[0]).toBe(
    result.createdSlideIds[0],
  );
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
        center: { x: 500, y: 300 },
        text: "Design",
        typography: { fontSize: 120, color: "#007F73", bold: true },
        autoSize: "both",
      },
    ]),
  );
  expect(inserted.ok).toBe(true);
  const id = inserted.createdIds[0];
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
  ).toMatchObject({ error: { code: "TARGET_NOT_EDITABLE" } });
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
        center: { x: 150, y: 100 },
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
  expect(await second).toEqual({ ...accepted, replayed: true });
  f.access(null);
  f.access(2);
  expect(await f.service.apply(input)).toEqual({ ...accepted, replayed: true });
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
        center: { x: 0, y: 0 },
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
          center: { x: 0, y: 0 },
          text: "Bad",
        },
      ]),
    ),
  ).toMatchObject({ error: { code: "INVALID_SCOPE" } });
  const p = await f.projection();
  p.deck.layers[0].locked = true;
  const request = agentApplyRequestSchema.parse(
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
    agentApplyRequestSchema.parse(
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
        center: { x: 0, y: 0 },
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
        center: { x: 0, y: 0 },
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
