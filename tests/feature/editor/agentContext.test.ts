import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentContextService } from "../../../electron/agentContext";
import { AgentTextMeasurementService } from "../../../electron/agentTextMeasurement";
import { readSettings, writeSettings } from "../../../electron/settings";
import { newPresentationDocument } from "../../../src/core/document";
import type { DocumentProjection } from "../../../src/core/documentProjection";
import type {
  AgentEditorSnapshot,
  AgentPresentationContext,
} from "../../../src/core/agentContext";
import {
  createBasicShape,
  createEmptyFrame,
} from "../../../src/core/elementFactory";

function fixture() {
  const document = newPresentationDocument("Context");
  const slide = document.slides[document.deck.slideIds[0]];
  const group = createEmptyFrame("group");
  group.children = [createBasicShape("child", "rectangle")];
  slide.nodes[0].children = [group];
  slide.notes = "PRIVATE_NOTES";
  slide.motion = {
    stages: [
      { id: "entry", tracks: [] },
      { id: "click", tracks: [] },
    ],
  };
  const projection: DocumentProjection = {
    documentId: document.documentId,
    epoch: "epoch",
    revision: 3,
    savedRevision: 1,
    deck: document.deck,
    slide,
    templates: document.templates,
  };
  let active: string | null = document.documentId;
  let presentation: AgentPresentationContext | null = null;
  const service = new AgentContextService({
    activeDocumentId: () => active,
    projection: async (_id, pageId) => {
      if (pageId && pageId !== projection.slide.id)
        throw new Error("Unknown page");
      return projection;
    },
    presentation: () => presentation,
  });
  const snapshot: AgentEditorSnapshot = {
    documentId: document.documentId,
    documentEpoch: "epoch",
    observedRevision: 3,
    page: { kind: "slide", id: slide.id },
    selectionScopeId: "group",
    selectionIds: ["child"],
    mode: "edit",
    timeline: null,
  };
  let sequence = 0;
  let token = "";
  const attach = () => {
    const reply = service.update({
      type: "attach",
      documentId: snapshot.documentId,
      documentEpoch: snapshot.documentEpoch,
    });
    token = reply.token!;
    sequence = 0;
    return token;
  };
  const publish = () =>
    service.update({ type: "publish", token, sequence: ++sequence, snapshot });
  const enable = () => {
    service.setEnabled(true);
    attach();
    publish();
  };
  return {
    service,
    snapshot,
    projection,
    document,
    attach,
    publish,
    enable,
    setActive: (value: string | null) => {
      active = value;
    },
    setPresentation: (value: AgentPresentationContext | null) => {
      presentation = value;
    },
  };
}

it("defaults disabled and clears all published context immediately when disabled", async () => {
  const f = fixture();
  expect(await f.service.read()).toMatchObject({
    enabled: false,
    availability: "disabled",
    document: null,
    editor: null,
    presentation: null,
  });
  expect(
    f.service.update({
      type: "attach",
      documentId: f.snapshot.documentId,
      documentEpoch: "epoch",
    }).accepted,
  ).toBe(false);
  f.enable();
  expect((await f.service.read()).availability).toBe("ready");
  f.service.setEnabled(false);
  const off = await f.service.read();
  expect(off).toMatchObject({
    enabled: false,
    availability: "disabled",
    document: null,
    editor: null,
  });
  expect(await f.service.read()).toEqual(off);
  f.service.setEnabled(true);
  expect((await f.service.read()).editor).toBeNull();
});

it("distinguishes meaningful UI changes from duplicate samples and accepted revisions", async () => {
  const f = fixture();
  f.enable();
  const first = await f.service.read();
  f.publish();
  expect((await f.service.read()).uiEpoch).toBe(first.uiEpoch);
  f.projection.revision++;
  f.snapshot.observedRevision++;
  f.publish();
  const revision = await f.service.read();
  expect(revision.document!.revision).toBe(4);
  expect(revision.uiEpoch).toBe(first.uiEpoch);
  f.snapshot.selectionIds = [];
  f.snapshot.selectionScopeId = f.projection.slide.nodes[0].id;
  f.snapshot.mode = "media-preview";
  f.publish();
  const changed = await f.service.read();
  expect(changed.uiEpoch).toBeGreaterThan(first.uiEpoch);
  expect(changed.editor).toMatchObject({
    selectionIds: [],
    mode: "media-preview",
  });
});

it("ignores passive playback time while recognizing stage selection seeks pause and before-entry state", async () => {
  const f = fixture();
  f.enable();
  f.snapshot.mode = "motion-preview";
  f.snapshot.timeline = {
    selectedStageIndex: 0,
    stageIndex: 0,
    stageId: "entry",
    stageTimeMs: 10,
    running: true,
    sampledAtMs: 1000,
    draft: false,
    playbackAnchor: { timeMs: 0, startedAtMs: 990 },
  };
  f.publish();
  const initial = await f.service.read();
  f.snapshot.timeline.stageTimeMs = 210;
  f.snapshot.timeline.sampledAtMs = 1200;
  f.publish();
  expect((await f.service.read()).uiEpoch).toBe(initial.uiEpoch);
  f.snapshot.timeline.selectedStageIndex = 1;
  f.publish();
  const selected = await f.service.read();
  expect(selected.uiEpoch).toBeGreaterThan(initial.uiEpoch);
  expect(selected.editor!.timeline).toMatchObject({
    selectedStageIndex: 1,
    stageIndex: 0,
  });
  f.snapshot.timeline.playbackAnchor = { timeMs: 200, startedAtMs: 1300 };
  f.publish();
  const seek = await f.service.read();
  expect(seek.uiEpoch).toBeGreaterThan(selected.uiEpoch);
  f.snapshot.timeline.running = false;
  f.snapshot.timeline.stageIndex = -1;
  f.snapshot.timeline.stageId = null;
  f.publish();
  const paused = await f.service.read();
  expect(paused.uiEpoch).toBeGreaterThan(seek.uiEpoch);
  expect(paused.editor!.timeline!.stageIndex).toBe(-1);
});

it("normalizes deleted selections and scopes against accepted state without retargeting or leaking drafts", async () => {
  const f = fixture();
  f.enable();
  f.snapshot.selectionIds = ["child", "child", "unacceptedDraft"];
  f.publish();
  const first = await f.service.read();
  expect(first.editor!.selectionIds).toEqual(["child"]);
  f.projection.slide.nodes[0].children = [];
  f.projection.revision++;
  const deleted = await f.service.read();
  expect(deleted.editor).toMatchObject({
    selectionIds: [],
    selectionScopeId: null,
  });
  expect(deleted.uiEpoch).toBeGreaterThan(first.uiEpoch);
  expect((await f.service.read()).uiEpoch).toBe(deleted.uiEpoch);
  f.projection.deck.slideIds = [];
  expect((await f.service.read()).editor).toBeNull();
});

it("identifies template editing and marks unaccepted timeline drafts explicitly", async () => {
  const f = fixture();
  f.enable();
  const templateId = f.projection.deck.templateIds[0];
  f.projection.slide = { ...f.projection.templates![templateId], notes: "" };
  f.snapshot.page = { kind: "template", id: templateId };
  f.snapshot.selectionIds = [];
  f.snapshot.selectionScopeId = f.projection.slide.nodes[0].id;
  f.snapshot.timeline = {
    selectedStageIndex: 2,
    stageIndex: 2,
    stageId: "draftStage",
    stageTimeMs: 0,
    running: false,
    sampledAtMs: 1,
    draft: true,
    playbackAnchor: null,
  };
  f.snapshot.mode = "motion-state-edit";
  f.publish();
  expect((await f.service.read()).editor).toMatchObject({
    page: { kind: "template", id: templateId },
    timeline: { draft: true, stageIndex: 2 },
  });
  f.snapshot.timeline.draft = false;
  f.publish();
  expect((await f.service.read()).editor!.timeline).toBeNull();
});

it("rejects malformed data foreign scopes stale sequence numbers and obsolete view cleanup", async () => {
  const f = fixture();
  f.enable();
  const old = f.attach();
  f.publish();
  const current = f.attach();
  f.publish();
  expect(f.service.update({ type: "detach", token: old }).accepted).toBe(false);
  expect(
    f.service.update({
      type: "publish",
      token: current,
      sequence: 1,
      snapshot: f.snapshot,
    }).accepted,
  ).toBe(false);
  expect(
    f.service.update({
      type: "publish",
      token: current,
      sequence: 2,
      snapshot: { ...f.snapshot, documentId: "other" },
    }).accepted,
  ).toBe(false);
  expect(() =>
    f.service.update({
      type: "publish",
      token: current,
      sequence: 2,
      snapshot: { ...f.snapshot, arbitraryReactState: {} },
    }),
  ).toThrow();
  expect(() =>
    f.service.update({
      type: "attach",
      documentId: "../path",
      documentEpoch: "epoch",
    }),
  ).toThrow();
  expect((await f.service.read()).availability).toBe("ready");
  f.setActive(null);
  expect(f.publish().accepted).toBe(false);
  expect((await f.service.read()).editor).toBeNull();
});

it("keeps epochs monotonic across invalidation and rejects earlier document incarnations", async () => {
  const f = fixture();
  f.enable();
  const before = await f.service.read();
  f.projection.epoch = "reopened";
  const unavailable = await f.service.read();
  expect(unavailable).toMatchObject({
    availability: "unavailable",
    editor: null,
  });
  expect(f.publish().accepted).toBe(false);
  f.snapshot.documentEpoch = "reopened";
  f.attach();
  f.publish();
  const reopened = await f.service.read();
  expect(reopened.uiEpoch).toBeGreaterThan(before.uiEpoch);
  expect(reopened.editor!.documentEpoch).toBe("reopened");
  // A canceled close issues no invalidation and leaves the view intact.
  expect(await f.service.read()).toEqual(reopened);
});

it("does not mix an old UI view with a projection that resolves after replacement", async () => {
  const f = fixture();
  let release!: (value: DocumentProjection) => void;
  let delayed = true;
  const service = new AgentContextService({
    activeDocumentId: () => f.snapshot.documentId,
    projection: async () => {
      if (delayed) {
        delayed = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return f.projection;
    },
    presentation: () => null,
  });
  service.setEnabled(true);
  const first = service.update({
    type: "attach",
    documentId: f.snapshot.documentId,
    documentEpoch: "epoch",
  }).token!;
  service.update({
    type: "publish",
    token: first,
    sequence: 1,
    snapshot: f.snapshot,
  });
  const pending = service.read();
  service.invalidate();
  f.snapshot.selectionIds = [];
  const second = service.update({
    type: "attach",
    documentId: f.snapshot.documentId,
    documentEpoch: "epoch",
  }).token!;
  service.update({
    type: "publish",
    token: second,
    sequence: 1,
    snapshot: f.snapshot,
  });
  release(f.projection);
  expect((await pending).editor!.selectionIds).toEqual([]);
});

it("reports unavailable document projections instead of falling back to another owner", async () => {
  const f = fixture();
  const service = new AgentContextService({
    activeDocumentId: () => f.snapshot.documentId,
    projection: async () => {
      throw new Error("Disconnected guest");
    },
    presentation: () => null,
  });
  service.setEnabled(true);
  const token = service.update({
    type: "attach",
    documentId: f.snapshot.documentId,
    documentEpoch: "epoch",
  }).token!;
  service.update({ type: "publish", token, sequence: 1, snapshot: f.snapshot });
  expect(await service.read()).toMatchObject({
    availability: "unavailable",
    document: null,
    editor: null,
  });
  f.projection.templates = {};
  f.enable();
  expect(await f.service.read()).toMatchObject({
    availability: "unavailable",
    editor: null,
  });
});

it("keeps presenter context separate and returns detached data without presentation bodies", async () => {
  const f = fixture();
  f.enable();
  const before = await f.service.read();
  const presenter: AgentPresentationContext = {
    documentId: f.snapshot.documentId,
    slideId: "audienceSlide",
    slideIndex: 1,
    black: false,
    stageIndex: 0,
    stageTimeMs: 5,
    running: true,
    startedAtMs: 100,
    restartToken: null,
  };
  f.setPresentation(presenter);
  const presenting = await f.service.read();
  expect(presenting.uiEpoch).toBeGreaterThan(before.uiEpoch);
  expect(presenting.editor!.page.id).toBe(f.projection.slide.id);
  presenter.stageTimeMs = 200;
  expect((await f.service.read()).uiEpoch).toBe(presenting.uiEpoch);
  presenting.editor!.selectionIds.push("other");
  presenting.presentation!.black = true;
  expect((await f.service.read()).editor!.selectionIds).toEqual(["child"]);
  expect((await f.service.read()).presentation!.black).toBe(false);
  expect(JSON.stringify(await f.service.read())).not.toMatch(
    /PRIVATE_NOTES|nodes|effectResources/,
  );
});

it("persists the MCP preference in app settings while preserving unrelated settings", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-mcp-setting-"));
  try {
    expect((await readSettings(folder)).mcpEnabled).toBeUndefined();
    await writeSettings(folder, {
      mcpEnabled: true,
      imageCachingEnabled: false,
    });
    expect(await readSettings(folder)).toMatchObject({
      mcpEnabled: true,
      imageCachingEnabled: false,
    });
    const next = await readSettings(folder);
    await writeSettings(folder, { ...next, mcpEnabled: false });
    expect(await readSettings(folder)).toMatchObject({
      mcpEnabled: false,
      imageCachingEnabled: false,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("text measurement batches exact-scope reads and rejects stale or disabled access", async () => {
  let access: number | null = 1;
  let active: string | null = "document";
  const state = { documentId: "document", epoch: "epoch", revision: 3 };
  let calls = 0;
  const service = new AgentTextMeasurementService({
    access: () => access,
    activeDocumentId: () => active,
    state: async () => ({ ...state }),
    measure: async (_documentId, items) => {
      calls++;
      return items.map((item) => ({
        width: item.width,
        height: item.text.length * 2,
      }));
    },
  });
  const request = {
    documentId: "document",
    epoch: "epoch",
    revision: 3,
    items: [
      {
        text: "One",
        width: 320,
        typography: { fontFamily: "Arial", fontSize: 32 },
      },
      { text: "Second", width: 420 },
    ],
  };

  expect(await service.measure(request)).toEqual({
    ok: true,
    documentId: "document",
    epoch: "epoch",
    revision: 3,
    measurements: [
      { width: 320, height: 6 },
      { width: 420, height: 12 },
    ],
  });
  expect(calls).toBe(1);

  state.revision = 4;
  expect(await service.measure(request)).toMatchObject({
    error: { code: "REVISION_CONFLICT", actualRevision: 4 },
  });
  expect(calls).toBe(1);

  state.revision = 3;
  state.epoch = "replacement";
  expect(await service.measure(request)).toMatchObject({
    error: { code: "EPOCH_CONFLICT" },
  });
  expect(calls).toBe(1);

  state.epoch = "epoch";
  access = null;
  expect(await service.measure(request)).toMatchObject({
    error: { code: "MCP_DISABLED" },
  });
  expect(calls).toBe(1);

  access = 2;
  active = "other";
  expect(await service.measure(request)).toMatchObject({
    error: { code: "DOCUMENT_NOT_ACTIVE" },
  });
  expect(calls).toBe(1);
});

