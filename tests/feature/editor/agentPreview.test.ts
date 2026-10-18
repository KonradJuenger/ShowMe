import { expect, it } from "vitest";
import { AgentPreviewService } from "../../../electron/agentPreview";
import type {
  AgentPreviewRequest,
  AgentPreviewResult,
  SlidePreviewCapture,
} from "../../../src/core/agentPreview";
import { newPresentationDocument } from "../../../src/core/document";
import type { DocumentProjection } from "../../../src/core/documentProjection";

it("preview cancellation rejects before reads and propagates disconnect and opt-out aborts to native work", async () => {
  const model = newPresentationDocument("Cancellation"),
    slideId = model.deck.slideIds[0];
  const request = {
    documentId: model.documentId,
    epoch: "epoch",
    revision: 0,
    slideId,
    width: 320,
    height: 180,
  };
  let captures = 0;
  let entered!: () => void;
  let ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const service = new AgentPreviewService({
    access: () => 1,
    activeDocumentId: () => model.documentId,
    projection: async () => ({
      documentId: model.documentId,
      epoch: "epoch",
      revision: 0,
      savedRevision: 0,
      deck: model.deck,
      slide: model.slides[slideId],
      templates: model.templates,
    }),
    capture: async (_p, _w, _h, signal) => {
      captures++;
      entered();
      return new Promise((resolve) =>
        signal!.addEventListener("abort", () => resolve(null), { once: true }),
      );
    },
  });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(code(await service.preview(request, cancelled.signal))).toBe(
    "REQUEST_CANCELLED",
  );
  expect(captures).toBe(0);
  const caller = new AbortController();
  const pending = service.preview(request, caller.signal);
  await ready;
  caller.abort();
  expect(code(await pending)).toBe("REQUEST_CANCELLED");
  ready = new Promise((resolve) => {
    entered = resolve;
  });
  const disabled = service.preview(request);
  await ready;
  service.cancelAll();
  expect(code(await disabled)).toBe("REQUEST_CANCELLED");
  expect(captures).toBe(2);
});

function fixture() {
  const model = newPresentationDocument("Preview");
  const projection: DocumentProjection = {
    documentId: model.documentId,
    epoch: "epoch",
    revision: 4,
    savedRevision: 1,
    deck: model.deck,
    slide: model.slides[model.deck.slideIds[0]],
    templates: model.templates,
  };
  const request: AgentPreviewRequest = {
    documentId: model.documentId,
    epoch: "epoch",
    revision: 4,
    slideId: projection.slide.id,
    width: 321,
    height: 181,
  };
  let access: number | null = 1,
    active: string | null = model.documentId;
  let captures = 0,
    projections = 0;
  const pixels: SlidePreviewCapture = {
    width: 321,
    height: 181,
    pngDataUrl: "data:image/png;base64,production-capture",
    warnings: [],
  };
  let capture: (
    projection: DocumentProjection,
  ) => Promise<SlidePreviewCapture | null> = async () => pixels;
  let read: (slideId?: string) => Promise<DocumentProjection> = async () =>
    projection;
  const service = new AgentPreviewService({
    access: () => access,
    activeDocumentId: () => active,
    projection: async (_id, slideId) => {
      projections++;
      return read(slideId);
    },
    capture: async (value, width, height) => {
      captures++;
      expect([width, height]).toEqual([request.width, request.height]);
      return capture(value);
    },
  });
  return {
    service,
    projection,
    request,
    pixels,
    access: (value: number | null) => {
      access = value;
    },
    active: (value: string | null) => {
      active = value;
    },
    capture: (fn: typeof capture) => {
      capture = fn;
    },
    read: (fn: typeof read) => {
      read = fn;
    },
    counts: () => ({ captures, projections }),
  };
}
function code(result: AgentPreviewResult) {
  if (result.ok) throw new Error("Expected preview rejection");
  expect(result).not.toHaveProperty("pngDataUrl");
  return result.error.code;
}

it("rejects malformed sizes paths source bodies and unsupported timeline inputs before work", async () => {
  const f = fixture();
  expect(code(await f.service.preview({ ...f.request, width: 2049 }))).toBe(
    "INVALID_REQUEST",
  );
  expect(code(await f.service.preview({ ...f.request, width: 0 }))).toBe(
    "INVALID_REQUEST",
  );
  expect(code(await f.service.preview({ ...f.request, height: 10.5 }))).toBe(
    "INVALID_REQUEST",
  );
  expect(
    code(await f.service.preview({ ...f.request, documentId: "../file" })),
  ).toBe("INVALID_REQUEST");
  expect(
    code(await f.service.preview({ ...f.request, projection: f.projection })),
  ).toBe("INVALID_REQUEST");
  expect(code(await f.service.preview({ ...f.request, stageIndex: 1 }))).toBe(
    "INVALID_REQUEST",
  );
  expect(f.counts()).toEqual({ captures: 0, projections: 0 });
});

it("gates disabled and inactive-document reads before acquiring projections or pixels", async () => {
  const f = fixture();
  f.access(null);
  expect(code(await f.service.preview(f.request))).toBe("MCP_DISABLED");
  f.access(1);
  f.active("another");
  expect(code(await f.service.preview(f.request))).toBe("DOCUMENT_NOT_ACTIVE");
  expect(f.counts()).toEqual({ captures: 0, projections: 0 });
});

it("returns exact accepted identity dimensions and production diagnostics without changing document state", async () => {
  const f = fixture();
  const before = structuredClone(f.projection);
  f.pixels.warnings = [
    { code: "MISSING_MEDIA", message: "Missing media", elementIds: ["image"] },
  ];
  expect(await f.service.preview(f.request)).toEqual({
    ok: true,
    ...f.request,
    state: "base",
    mimeType: "image/png",
    ...f.pixels,
  });
  expect(f.counts().captures).toBe(1);
  expect(f.projection).toEqual(before);
});

it("rejects missing slides and template pages rather than rendering another target", async () => {
  const f = fixture();
  expect(
    code(await f.service.preview({ ...f.request, slideId: "missing" })),
  ).toBe("UNKNOWN_SLIDE");
  expect(
    code(
      await f.service.preview({
        ...f.request,
        slideId: f.projection.deck.templateIds[0],
      }),
    ),
  ).toBe("UNKNOWN_SLIDE");
  expect(f.counts().captures).toBe(0);
});

it("rejects stale revision and document incarnation before capture", async () => {
  const f = fixture();
  const result = await f.service.preview({ ...f.request, revision: 3 });
  expect(code(result)).toBe("REVISION_CONFLICT");
  expect(result).toMatchObject({ error: { actualRevision: 4 } });
  expect(
    code(await f.service.preview({ ...f.request, epoch: "previous" })),
  ).toBe("EPOCH_CONFLICT");
  expect(f.counts().captures).toBe(0);
});

it("discards captured pixels when a document revision changes during rendering", async () => {
  const f = fixture();
  f.capture(async () => {
    f.projection.revision++;
    return f.pixels;
  });
  const result = await f.service.preview(f.request);
  expect(code(result)).toBe("REVISION_CONFLICT");
  expect(result).toMatchObject({
    error: { actualRevision: 5, recoverable: true },
  });
});

it("discards pixels after MCP disable or a disable-and-reenable transition", async () => {
  const off = fixture();
  off.capture(async () => {
    off.access(null);
    return off.pixels;
  });
  expect(code(await off.service.preview(off.request))).toBe("MCP_DISABLED");
  const toggled = fixture();
  toggled.capture(async () => {
    toggled.access(3);
    return toggled.pixels;
  });
  expect(code(await toggled.service.preview(toggled.request))).toBe(
    "MCP_ACCESS_CHANGED",
  );
});

it("discards output after close replacement or same-ID reopen", async () => {
  const closed = fixture();
  closed.capture(async () => {
    closed.active(null);
    return closed.pixels;
  });
  expect(code(await closed.service.preview(closed.request))).toBe(
    "DOCUMENT_NOT_ACTIVE",
  );
  const replaced = fixture();
  replaced.capture(async () => {
    replaced.projection.epoch = "reopened";
    return replaced.pixels;
  });
  expect(code(await replaced.service.preview(replaced.request))).toBe(
    "EPOCH_CONFLICT",
  );
});

it("returns structured failures for busy capture renderer rejection and unavailable documents", async () => {
  const f = fixture();
  f.capture(async () => null);
  expect(code(await f.service.preview(f.request))).toBe("PREVIEW_FAILED");
  f.capture(async () => {
    throw new Error("PRIVATE_PATH_AND_STACK");
  });
  const result = await f.service.preview(f.request);
  expect(code(result)).toBe("PREVIEW_FAILED");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PATH");
  f.read(async () => {
    throw new Error("Guest disconnected");
  });
  expect(code(await f.service.preview(f.request))).toBe("DOCUMENT_UNAVAILABLE");
});

it("renders only the explicitly requested slide while unrelated UI navigation is irrelevant", async () => {
  const f = fixture();
  const target = { ...structuredClone(f.projection.slide), id: "target" };
  f.projection.deck.slideIds.push(target.id);
  f.projection.deck.slideMeta[target.id] = {
    ...f.projection.deck.slideMeta[f.projection.slide.id],
    name: "Target",
  };
  f.request.slideId = target.id;
  f.read(async (id) =>
    id === target.id ? { ...f.projection, slide: target } : f.projection,
  );
  f.capture(async (projection) => {
    expect(projection.slide.id).toBe("target");
    return f.pixels;
  });
  expect(await f.service.preview(f.request)).toMatchObject({
    ok: true,
    slideId: "target",
  });
});
