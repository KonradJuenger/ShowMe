import { agentDeliveryRequestSchema } from "../../../src/core/agentDelivery";
import { expect, it } from "vitest";
import { AgentDeliveryService } from "../../../electron/agentDelivery";
import { DocumentRuntime } from "../../../src/core/documentRuntime";
import { newPresentationDocument } from "../../../src/core/document";
import { storedDocument } from "../../helpers/storage";
import { setSlideNotes } from "../../../src/core/editorCommands";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

function fixture() {
  const model = newPresentationDocument("Delivery");
  let current = new DocumentRuntime(model, {
    actorId: "local",
    epoch: "epoch",
    durableCommit: async () => {},
  });
  let access: number | null = 1,
    writes = 0;
  let deliver: ConstructorParameters<
    typeof AgentDeliveryService
  >[0]["deliver"] = async (_request, check) => {
    check();
    writes++;
    return {
      destination: "authorized.sme",
      format: "sme",
      overwrite: "native-policy",
    };
  };
  const service = new AgentDeliveryService({
    access: () => access,
    activeDocumentId: () => model.documentId,
    eligibility: () => null,
    runtime: () => current,
    deliver: (...args) => deliver(...args),
  });
  const request = {
    documentId: model.documentId,
    epoch: "epoch",
    expectedRevision: 0,
    action: "save",
  };
  return {
    service,
    request,
    current: (value: DocumentRuntime) => {
      current = value;
    },
    access: (value: number | null) => {
      access = value;
    },
    deliver: (value: typeof deliver) => {
      deliver = value;
    },
    writes: () => writes,
    model,
  };
}

it("delivery distinguishes native cancellation written revision and unsupported paths without creating history", async () => {
  const f = fixture();
  expect(await f.service.deliver(f.request)).toMatchObject({
    ok: true,
    data: {
      written: true,
      revision: 0,
      destination: "authorized.sme",
      draftPolicy: "accepted-only",
      preservesAnimation: true,
    },
  });
  f.deliver(async () => null);
  expect(
    await f.service.deliver({ ...f.request, action: "save-as" }),
  ).toMatchObject({ ok: true, data: { written: false, cancelled: true } });
  expect(
    await f.service.deliver({
      ...f.request,
      destination: "arbitrary-path.sme",
    }),
  ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  f.deliver(async () => {
    throw new Error("PRIVATE_DESTINATION");
  });
  expect(await f.service.deliver(f.request)).toMatchObject({
    error: { code: "DELIVERY_FAILED" },
  });
  expect(f.writes()).toBe(1);
});

it("delivery rechecks cancellation access and runtime identity after the native picker before admission", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.deliver(async (_request, check) => {
    controller.abort();
    check();
    return null;
  });
  expect(await f.service.deliver(f.request, controller.signal)).toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
  f.deliver(async (_request, check) => {
    f.access(2);
    check();
    return null;
  });
  expect(await f.service.deliver(f.request)).toMatchObject({
    error: { code: "MCP_ACCESS_CHANGED" },
  });
  f.deliver(async (_request, check) => {
    f.current(
      new DocumentRuntime(f.model, {
        actorId: "local",
        epoch: "epoch",
        durableCommit: async () => {},
      }),
    );
    check();
    return null;
  });
  expect(await f.service.deliver(f.request)).toMatchObject({
    error: { code: "EPOCH_CONFLICT" },
  });
  expect(f.writes()).toBe(0);
});

it("native save and package guards execute under the accepted snapshot lock and leave rejected artifacts untouched", async () => {
  const f = await storedDocument();
  const file = path.join(f.root, "Delivery.sme");
  await f.storage.saveDocument(f.id, file, (target) => {
    expect(target).toBe(file);
    expect(existsSync(target)).toBe(false);
  });
  const original = await readFile(file, "utf8");
  f.session.apply(
    setSlideNotes(f.session.snapshot!, "Later accepted revision"),
  );
  await f.session.flush();
  const reject = () => {
    throw new Error("Exact revision rejected");
  };
  await expect(f.storage.saveDocument(f.id, undefined, reject)).rejects.toThrow(
    "Exact revision rejected",
  );
  expect(await readFile(file, "utf8")).toBe(original);
  await expect(
    f.storage.packageDocument(
      f.id,
      path.join(f.root, "Rejected.smp"),
      false,
      false,
      reject,
    ),
  ).rejects.toThrow("Exact revision rejected");
  await expect(
    f.storage.savePackageAs(
      f.id,
      path.join(f.root, "RejectedSave.smp"),
      false,
      undefined,
      reject,
    ),
  ).rejects.toThrow("Exact revision rejected");
  let saved = -1;
  await f.storage.saveDocument(f.id, undefined, () => {
    saved = f.runtime.authority.revision;
  });
  expect(saved).toBe(1);
  expect(f.runtime.authority.savedRevision).toBe(1);
  const reopened = JSON.parse(await readFile(file, "utf8"));
  expect(reopened.slides[f.session.snapshot!.slide.id].notes).toBe(
    "Later accepted revision",
  );
  f.session.apply(
    setSlideNotes(f.session.snapshot!, "Edit after native snapshot"),
  );
  await f.session.flush();
  expect(f.runtime.authority.savedRevision).toBe(1);
  expect(f.runtime.authority.dirty).toBe(true);
});

it("unattended package options require explicit native lock and speaker-note policies", () => {
  const f = fixture();
  expect(
    agentDeliveryRequestSchema.safeParse({
      ...f.request,
      action: "package",
      packageOptions: { mediaLocked: false, speakerNotes: "remove" },
    }).success,
  ).toBe(true);
  expect(
    agentDeliveryRequestSchema.safeParse({
      ...f.request,
      packageOptions: { mediaLocked: false, speakerNotes: "remove" },
    }).success,
  ).toBe(false);
  expect(
    agentDeliveryRequestSchema.safeParse({
      ...f.request,
      action: "package",
      packageOptions: { speakerNotes: "include" },
    }).success,
  ).toBe(false);
});
