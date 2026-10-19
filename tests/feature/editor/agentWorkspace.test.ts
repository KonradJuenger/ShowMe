import { expect, it } from "vitest";
import { AgentWorkspaceService } from "../../../electron/agentWorkspace";
import { newPresentationDocument } from "../../../src/core/document";
import { DocumentRuntime } from "../../../src/core/documentRuntime";
import {
  importAgentMedia,
  type PreparedAgentMedia,
} from "../../../electron/agentMediaImport";
import { AgentMutationError } from "../../../src/core/agentMutation";
import type { Asset } from "../../../src/core/assets";

async function interruptedMedia(code: string) {
  const f = fixture();
  const before = await f.runtime.projection(f.model.documentId);
  let release!: (value: PreparedAgentMedia) => void, entered!: () => void;
  const delayed = new Promise<PreparedAgentMedia>(
    (resolve) => (release = resolve),
  );
  const decoding = new Promise<void>((resolve) => (entered = resolve));
  let admitted = true;
  const imported: string[] = [],
    updated: string[] = [];
  const result = importAgentMedia(
    ["first", "second", "third"],
    () => {
      if (!admitted) throw new AgentMutationError(code, "Admission ended.");
    },
    {
      authorize: async (file) => file,
      importFile: async (file) => {
        imported.push(file);
        return {
          version: 1,
          id: file,
          filename: file,
          mediaType: "image",
          type: "image",
          mime: "image/png",
          names: [file],
          bytes: 1,
          createdAt: "2026-10-18",
        };
      },
      prepare: async (asset) => {
        if (asset.id === "second") {
          entered();
          return delayed;
        }
        return { asset: { ...asset, width: 20, height: 20 }, preview: null };
      },
      updateAsset: async (asset) => {
        updated.push(asset.id);
      },
      storePreview: async () => {},
    },
  );
  await decoding;
  admitted = false;
  release({ asset: null, preview: null, failure: "pending" });
  expect(await result).toMatchObject({
    atomic: false,
    assets: [{ id: "first" }, { id: "second" }],
    items: [
      { index: 0, status: "imported", preparation: "prepared" },
      { index: 1, status: "imported", preparation: "pending", error: { code } },
      { index: 2, status: "not-attempted", preparation: "not-attempted" },
    ],
  });
  expect(imported).toEqual(["first", "second"]);
  expect(updated).toEqual(["first"]);
  expect(await f.runtime.projection(f.model.documentId)).toEqual(before);
  expect(f.runtime.metadata(f.model.documentId)).toMatchObject({
    revision: 0,
    savedRevision: 0,
  });
}

it("media cancellation during the second decoder retains both imported IDs and never starts the third", async () => {
  await interruptedMedia("REQUEST_CANCELLED");
});
it("media revocation during the second decoder retains completed receipts without document edits", async () => {
  await interruptedMedia("MCP_ACCESS_CHANGED");
});
it("renderer loss retains a pending media ID and a later native preparation can recover it", async () => {
  const asset: Asset = {
    version: 1,
    id: "a".repeat(64),
    filename: "image.png",
    mediaType: "image",
    type: "image",
    mime: "image/png",
    names: ["image"],
    bytes: 1,
    createdAt: "2026-10-18",
  };
  let lost = true,
    updates = 0;
  const dependencies = {
    authorize: async (file: string) => file,
    importFile: async () => asset,
    prepare: async () => {
      if (lost)
        throw new AgentMutationError(
          "MEDIA_PREPARATION_UNAVAILABLE",
          "Renderer lost.",
        );
      return { asset: { ...asset, width: 20, height: 20 }, preview: null };
    },
    updateAsset: async () => {
      updates++;
    },
    storePreview: async () => {},
  };
  expect(
    await importAgentMedia(["image.png"], () => {}, dependencies),
  ).toMatchObject({
    assets: [{ id: asset.id }],
    items: [
      {
        preparation: "pending",
        error: { code: "MEDIA_PREPARATION_UNAVAILABLE" },
      },
    ],
  });
  lost = false;
  expect(
    await importAgentMedia(["image.png"], () => {}, dependencies),
  ).toMatchObject({
    assets: [{ id: asset.id }],
    items: [{ preparation: "prepared" }],
  });
  expect(updates).toBe(1);
});
function fixture() {
  const model = newPresentationDocument("Workspace"),
    runtime = new DocumentRuntime(model, {
      actorId: "local",
      epoch: "workspace-epoch",
      durableCommit: async () => {},
    });
  let access: number | null = 1,
    calls = 0,
    gate: () => void = () => {};
  const service = new AgentWorkspaceService({
    access: () => access,
    activeDocumentId: () => model.documentId,
    runtime: () => runtime,
    eligibility: () => null,
    perform: async (_r, admit) => {
      await Promise.resolve();
      gate();
      admit();
      calls++;
      return { done: true };
    },
  });
  return {
    runtime,
    model,
    service,
    request: {
      action: "create",
      name: "Modern",
      documentId: model.documentId,
      epoch: "workspace-epoch",
      expectedRevision: 0,
    },
    revoke: () => {
      access = null;
    },
    gate: (f: () => void) => {
      gate = f;
    },
    calls: () => calls,
  };
}
it("native workspace admission rejects stale identity and dirty documents before lifecycle work", async () => {
  const f = fixture();
  expect(
    await f.service.run({ ...f.request, expectedRevision: 1 }),
  ).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  expect(await f.service.run({ ...f.request, epoch: "old" })).toMatchObject({
    error: { code: "EPOCH_CONFLICT" },
  });
  expect(f.calls()).toBe(0);
  expect(await f.service.run(f.request)).toMatchObject({ ok: true });
});
it("native workspace rechecks access and cancellation after a native picker wait", async () => {
  const f = fixture();
  f.gate(f.revoke);
  expect(await f.service.run(f.request)).toMatchObject({
    error: { code: "MCP_ACCESS_CHANGED" },
  });
  expect(f.calls()).toBe(0);
  const g = fixture(),
    controller = new AbortController();
  g.gate(() => controller.abort());
  expect(await g.service.run(g.request, controller.signal)).toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
  expect(g.calls()).toBe(0);
});
