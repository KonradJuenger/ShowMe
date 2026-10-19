import { expect, it } from "vitest";
import { AgentInspectionService } from "../../../electron/agentInspection";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement } from "../../../src/core/text";
import type { DocumentProjection } from "../../../src/core/documentProjection";
import type { AgentContext } from "../../../src/core/agentContext";
import type { AgentInspectRequest } from "../../../src/core/agentRead";

function fixture() {
  const model = newPresentationDocument("Inspection"),
    slide = model.slides[model.deck.slideIds[0]];
  const title = createTextElement("title", { x: 20, y: 30 });
  if (title.content?.type === "text") title.content.text = "Visible title";
  slide.nodes[0].children = [title];
  slide.notes = "PRIVATE_NOTES";
  const projection: DocumentProjection = {
    documentId: model.documentId,
    epoch: "epoch",
    revision: 4,
    savedRevision: 1,
    deck: model.deck,
    slide,
    templates: model.templates,
  };
  const context: AgentContext = {
    enabled: true,
    availability: "ready",
    uiEpoch: 8,
    document: null,
    presentation: null,
    editor: {
      documentId: model.documentId,
      documentEpoch: "epoch",
      observedRevision: 4,
      page: { kind: "slide", id: slide.id },
      selectionIds: ["title"],
      selectionScopeId: null,
      mode: "edit",
      timeline: null,
    },
  };
  let access: number | null = 1,
    active: string | null = model.documentId;
  let read = async (_pageId?: string) => projection;
  let readContext = async () => context;
  const service = new AgentInspectionService({
    access: () => access,
    activeDocumentId: () => active,
    context: () => readContext(),
    projection: (_id, pageId) => read(pageId),
    listAssets: async () => ({
      items: [
        {
          version: 1,
          id: "a".repeat(64),
          filename: "private-photo.png",
          mediaType: "image",
          type: "image",
          mime: "image/png",
          names: ["photo.png"],
          bytes: 12345,
          width: 1600,
          height: 900,
          createdAt: "2026-10-18T00:00:00.000Z",
        },
      ],
      total: 1,
      counts: { images: 1, videos: 0 },
    }),
  });
  const request: AgentInspectRequest = {
    documentId: model.documentId,
    epoch: "epoch",
    revision: 4,
    target: { type: "slide", slideId: slide.id },
  };
  return {
    service,
    projection,
    request,
    context,
    setAccess: (value: typeof access) => {
      access = value;
    },
    setActive: (value: typeof active) => {
      active = value;
    },
    read: (fn: typeof read) => {
      read = fn;
    },
    readContext: (fn: typeof readContext) => {
      readContext = fn;
    },
  };
}
it("validates strict bounded read scopes and gates access before projection work", async () => {
  const f = fixture();
  f.read(async () => {
    throw new Error("Must not read");
  });
  expect(
    await f.service.inspect({ ...f.request, path: "private.sme" }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.inspect({
      ...f.request,
      target: { type: "deck", includeHiddenContent: true },
    }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(
    await f.service.inspect({
      ...f.request,
      target: {
        type: "elements",
        slideId: f.projection.slide.id,
        elementIds: Array(129).fill("title"),
      },
    }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  f.setAccess(null);
  expect(await f.service.inspect(f.request)).toMatchObject({
    error: { code: "MCP_DISABLED" },
  });
  f.setAccess(2);
  f.setActive(null);
  expect(await f.service.inspect(f.request)).toMatchObject({
    error: { code: "DOCUMENT_NOT_ACTIVE" },
  });
});
it("returns detached sparse deck slide and exact element reads without notes or mutation", async () => {
  const f = fixture(),
    before = structuredClone(f.projection);
  const outline = await f.service.inspect(f.request);
  expect(outline).toMatchObject({
    ok: true,
    data: { elements: [{ id: "title", textPreview: "Visible title" }] },
  });
  expect(JSON.stringify(outline)).not.toContain("PRIVATE_NOTES");
  expect(
    await f.service.inspect({ ...f.request, target: { type: "deck" } }),
  ).toMatchObject({ ok: true, data: { deck: { slideCount: 1 } } });
  expect(
    await f.service.inspect({
      ...f.request,
      target: {
        type: "elements",
        slideId: f.projection.slide.id,
        elementIds: ["title"],
        includeWorldTransform: true,
      },
    }),
  ).toMatchObject({
    ok: true,
    data: {
      elements: [
        { id: "title", worldTransform: { matrix: expect.any(Array) } },
      ],
    },
  });
  expect(f.projection).toEqual(before);
});
it("lists bounded managed assets without paths bytes or private storage metadata", async () => {
  const f = fixture();
  const result = await f.service.inspect({
    ...f.request,
    target: { type: "assets", query: "photo", offset: 0, limit: 10 },
  });
  expect(result).toMatchObject({
    ok: true,
    data: {
      assets: {
        query: "photo",
        offset: 0,
        limit: 10,
        total: 1,
        counts: { images: 1, videos: 0 },
        items: [
          {
            assetId: "a".repeat(64),
            name: "photo.png",
            type: "image",
            mediaType: "image",
            width: 1600,
            height: 900,
          },
        ],
      },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/private-photo|bytes|mime|createdAt/i);
  expect(
    await f.service.inspect({
      ...f.request,
      target: { type: "assets", limit: 51 },
    }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
});

it("rejects stale epochs revisions and missing scope instead of retargeting", async () => {
  const f = fixture();
  expect(await f.service.inspect({ ...f.request, epoch: "old" })).toMatchObject(
    { error: { code: "EPOCH_CONFLICT" } },
  );
  expect(await f.service.inspect({ ...f.request, revision: 3 })).toMatchObject({
    error: { code: "REVISION_CONFLICT", actualRevision: 4 },
  });
  expect(
    await f.service.inspect({
      ...f.request,
      target: { type: "slide", slideId: "missing" },
    }),
  ).toMatchObject({ error: { code: "UNKNOWN_SLIDE" } });
  expect(
    await f.service.inspect({
      ...f.request,
      target: {
        type: "elements",
        slideId: f.projection.slide.id,
        elementIds: ["missing"],
      },
    }),
  ).toMatchObject({ error: { code: "UNKNOWN_ELEMENT" } });
});
it("resolves selection once and rejects UI epoch changes template selection and oversized selection", async () => {
  const f = fixture(),
    request = { ...f.request, target: { type: "selection", uiEpoch: 8 } };
  expect(await f.service.inspect(request)).toMatchObject({
    ok: true,
    data: { slideId: f.projection.slide.id, elements: [{ id: "title" }] },
  });
  f.context.editor!.selectionIds = [];
  expect(await f.service.inspect(request)).toMatchObject({
    ok: true,
    data: { elements: [] },
  });
  f.context.editor!.selectionIds = Array(129).fill("title");
  expect(await f.service.inspect(request)).toMatchObject({
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
  f.context.editor!.page.kind = "template";
  expect(await f.service.inspect(request)).toMatchObject({
    error: { code: "UNSUPPORTED_PAGE" },
  });
  f.context.editor!.page.kind = "slide";
  f.context.editor!.selectionIds = ["title"];
  let reads = 0;
  f.readContext(async () => ({ ...f.context, uiEpoch: ++reads === 1 ? 8 : 9 }));
  expect(await f.service.inspect(request)).toMatchObject({
    error: { code: "UI_CONTEXT_CONFLICT" },
  });
});
it("discards output on accepted revision document replacement and access races", async () => {
  const f = fixture();
  let reads = 0;
  f.read(async () => ({ ...f.projection, revision: ++reads === 1 ? 4 : 5 }));
  expect(await f.service.inspect(f.request)).toMatchObject({
    error: { code: "REVISION_CONFLICT" },
  });
  f.read(async () => {
    f.setAccess(3);
    return f.projection;
  });
  expect(await f.service.inspect(f.request)).toMatchObject({
    error: { code: "MCP_ACCESS_CHANGED" },
  });
  f.read(async () => {
    f.setActive(null);
    return f.projection;
  });
  expect(await f.service.inspect(f.request)).toMatchObject({
    error: { code: "DOCUMENT_NOT_ACTIVE" },
  });
});
it("uses a presentation slide for deck metadata while the head projection is a template", async () => {
  const f = fixture(),
    template = f.projection.templates![f.projection.deck.defaultTemplateId!];
  f.read(async (pageId) =>
    pageId ? f.projection : { ...f.projection, slide: { ...template, notes: "" } },
  );
  expect(
    await f.service.inspect({ ...f.request, target: { type: "deck" } }),
  ).toMatchObject({ ok: true, data: { deck: { slideCount: 1 } } });
});
