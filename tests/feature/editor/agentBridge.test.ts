import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentBridge,
  BRIDGE_JSON_LIMIT,
  BRIDGE_REQUEST_LIMIT,
  type BridgeDescriptor,
} from "../../../electron/agentBridge";
import { ShowMeClient, bridgeRead } from "../../../mcp/showmeClient";
import { AgentEditingService } from "../../../electron/agentEditing";
import { DocumentRuntime } from "../../../src/core/documentRuntime";
import { newPresentationDocument } from "../../../src/core/document";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("a lost HTTP response during durability replays the accepted mutation without duplicating inserts", async () => {
  const model = newPresentationDocument("Lost response");
  let release!: () => void,
    entered!: () => void,
    writes = 0;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    durable = new Promise<void>((r) => {
      entered = r;
    });
  const runtime = new DocumentRuntime(model, {
    actorId: "local",
    epoch: "epoch",
    durableCommit: async () => {
      entered();
      await held;
      writes++;
    },
  });
  const service = new AgentEditingService({
    access: () => 1,
    eligibility: () => null,
    activeDocumentId: () => model.documentId,
    runtime: () => runtime,
    measure: async () => null,
    changed: () => {},
  });
  const f = await fixture(async (request, signal) =>
    request.command === "apply"
      ? service.apply(request.params, signal)
      : { ok: true, data: {} },
  );
  const command = {
    command: "apply" as const,
    params: {
      documentId: model.documentId,
      epoch: "epoch",
      expectedRevision: 0,
      mutationId: "lost-response",
      slideId: model.deck.slideIds[0],
      operations: [
        {
          type: "element.insert_shape" as const,
          parentId: model.slides[model.deck.slideIds[0]].nodes[0].id,
          shape: "rectangle" as const,
          frame: { x: 0, y: 0, width: 30, height: 30 },
        },
      ],
    },
  };
  const controller = new AbortController();
  const pending = bridgeRead(f.descriptor, command, controller.signal).catch(
    () => null,
  );
  await durable;
  controller.abort();
  expect(await pending).toBeNull();
  release();
  const replay = await bridgeRead(f.descriptor, command);
  expect(replay).toMatchObject({
    ok: true,
    replayed: true,
    revision: 1,
    createdIds: [expect.any(String)],
  });
  expect(writes).toBe(1);
  expect(
    (await runtime.projection(model.documentId)).slide.nodes[0].children,
  ).toHaveLength(1);
});

it("keeps bounded admission occupied until revoked native work actually finishes", async () => {
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async () => {
    if (++calls === 8) entered();
    await held;
    return { ok: true, data: {} };
  });
  const pending = Array.from({ length: 8 }, () =>
    bridgeRead(f.descriptor, { command: "context", params: {} }).catch(
      () => null,
    ),
  );
  await admitted;
  expect((await raw(f.descriptor)).body.error.code).toBe("BUSY");
  await f.bridge.setEnabled(false);
  await f.bridge.setEnabled(true);
  const descriptor = JSON.parse(
    await readFile(
      path.join(f.folder, "mcp", "instances", `${f.bridge.instanceId}.json`),
      "utf8",
    ),
  ) as BridgeDescriptor;
  expect((await raw(descriptor)).body.error.code).toBe("BUSY");
  release();
  expect(await Promise.all(pending)).toEqual(Array(8).fill(null));
  await expect.poll(async () => (await raw(descriptor)).body.ok).toBe(true);
});
async function fixture(
  dispatch: ConstructorParameters<typeof AgentBridge>[1] = async () => ({
    ok: true,
    data: { document: null },
  }),
  directory?: string,
) {
  const folder =
    directory ?? (await mkdtemp(path.join(os.tmpdir(), "showme-bridge-")));
  if (!directory)
    cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const bridge = new AgentBridge(folder, dispatch);
  cleanup.push(() => bridge.setEnabled(false));
  await bridge.setEnabled(true);
  expect(bridge.status).toBe("ready");
  const file = path.join(
    folder,
    "mcp",
    "instances",
    `${bridge.instanceId}.json`,
  );
  const descriptor = JSON.parse(
    await readFile(file, "utf8"),
  ) as BridgeDescriptor;
  return { bridge, folder, descriptor, file };
}
async function raw(
  d: BridgeDescriptor,
  headers: Record<string, string> = {},
  body = '{"command":"context","params":{}}',
  method = "POST",
  route = "/v1/read",
) {
  return new Promise<{ status: number; body: any; headers: object }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: d.port,
          method,
          path: route,
          agent: false,
          headers: {
            authorization: `Bearer ${d.token}`,
            "content-type": "application/json",
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(text),
              headers: res.headers,
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
it("caches a verified bridge between calls and rediscovers after MCP restart", async () => {
  let contextCalls = 0;
  let inspectCalls = 0;
  const f = await fixture(async (request) => {
    if (request.command === "context") {
      contextCalls++;
      return { ok: true, data: { document: null } };
    }
    if (request.command === "inspect") {
      inspectCalls++;
      return { ok: true, data: { inspected: true } };
    }
    return { ok: true, data: {} };
  });
  const client = new ShowMeClient(f.folder);

  expect(await client.read({ command: "context", params: {} })).toMatchObject({
    ok: true,
  });
  expect(contextCalls).toBe(1);

  // Once verified, ordinary calls no longer depend on descriptor rescans or a
  // redundant context probe.
  await rm(f.file, { force: true });
  expect(
    await client.read({
      command: "inspect",
      params: {
        documentId: "doc",
        epoch: "epoch",
        revision: 0,
        target: { type: "deck" },
      },
    }),
  ).toMatchObject({ ok: true, data: { inspected: true } });
  expect(contextCalls).toBe(1);
  expect(inspectCalls).toBe(1);

  const oldInstance = f.bridge.instanceId;
  await f.bridge.setEnabled(false);
  await f.bridge.setEnabled(true);
  expect(f.bridge.instanceId).not.toBe(oldInstance);

  expect(
    await client.read({
      command: "inspect",
      params: {
        documentId: "doc",
        epoch: "epoch",
        revision: 0,
        target: { type: "deck" },
      },
    }),
  ).toMatchObject({ ok: true, data: { inspected: true } });
  expect(contextCalls).toBe(2);
  expect(inspectCalls).toBe(2);
});

it("publishes only a private authenticated loopback descriptor and cleans it up on disable", async () => {
  const f = await fixture();
  expect(f.descriptor).toMatchObject({
    version: 1,
    pid: process.pid,
    instanceId: f.bridge.instanceId,
  });
  expect(f.descriptor.token).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform === "win32") {
    const run = promisify(execFile);
    const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
    });
    const acl = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[System.IO.File]::GetAccessControl('${f.file.replaceAll("'", "''")}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`,
      ],
      { windowsHide: true },
    );
    const userSid = identity.stdout.match(/S-1-5-[0-9-]+/)![0];
    const allowed = new Set([
      userSid,
      "S-1-5-18", // LocalSystem
      "S-1-5-32-544", // Builtin Administrators
    ]);
    const principals = acl.stdout.trim().split(/\r?\n/);
    expect(principals).toContain(userSid);
    expect(principals.every((sid) => allowed.has(sid))).toBe(true);
  }
  expect(
    await bridgeRead(f.descriptor, { command: "context", params: {} }),
  ).toEqual({ ok: true, data: { document: null } });
  await f.bridge.setEnabled(false);
  expect(await readdir(path.dirname(f.file))).toEqual([]);
  expect(
    await new ShowMeClient(f.folder).read({ command: "context", params: {} }),
  ).toMatchObject({ error: { code: "APP_UNAVAILABLE" } });
}, 10000);
it("rejects unauthenticated DNS rebinding browser origins and fetch requests before dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { ok: true, data: {} };
  });
  expect(
    (await raw(f.descriptor, { authorization: "Bearer bad" })).status,
  ).toBe(403);
  expect((await raw(f.descriptor, { host: "evil.example" })).status).toBe(403);
  expect((await raw(f.descriptor, { origin: "null" })).status).toBe(403);
  expect(
    (await raw(f.descriptor, { "sec-fetch-site": "same-origin" })).status,
  ).toBe(403);
  const preflight = await raw(
    f.descriptor,
    { origin: "https://example.com" },
    "",
    "OPTIONS",
  );
  expect(preflight.status).toBe(403);
  expect(preflight.headers).not.toHaveProperty("access-control-allow-origin");
  expect(calls).toBe(0);
});
it("rejects unknown commands raw IPC malformed JSON routes and oversized payloads", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { ok: true, data: {} };
  });
  expect(
    (await raw(f.descriptor, {}, '{"command":"documentCommit","params":{}}'))
      .body.error.code,
  ).toBe("INVALID_REQUEST");
  expect(
    (
      await raw(
        f.descriptor,
        {},
        '{"command":"context","params":{},"source":"x"}',
      )
    ).status,
  ).toBe(400);
  expect((await raw(f.descriptor, {}, "{")).status).toBe(400);
  expect((await raw(f.descriptor, {}, "{}", "GET")).status).toBe(400);
  expect((await raw(f.descriptor, {}, "{}", "POST", "/elsewhere")).status).toBe(
    400,
  );
  expect(
    (await raw(f.descriptor, {}, "x".repeat(BRIDGE_REQUEST_LIMIT + 1))).body.error
      .code,
  ).toBe("PAYLOAD_TOO_LARGE");
  expect(calls).toBe(0);
});
it("bounds response size without truncating data and preserves safe service errors", async () => {
  const f = await fixture(async (value) =>
    value.command === "context"
      ? { ok: true, data: { text: "x".repeat(BRIDGE_JSON_LIMIT) } }
      : {
          ok: false,
          error: {
            code: "REVISION_CONFLICT",
            message: "Inspect again.",
            recoverable: true,
          },
        },
  );
  expect((await raw(f.descriptor)).body).toMatchObject({
    error: { code: "PAYLOAD_TOO_LARGE" },
  });
  expect(
    await bridgeRead(f.descriptor, {
      command: "inspect",
      params: {
        documentId: "doc",
        epoch: "epoch",
        revision: 1,
        target: { type: "deck" },
      },
    }),
  ).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
});
it("revokes pending output and old tokens across disable and rapid startup transitions", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture(async () => {
    entered();
    await held;
    return { ok: true, data: { private: "must not arrive" } };
  });
  const pending = bridgeRead(f.descriptor, {
    command: "context",
    params: {},
  }).catch(() => null);
  await enteredPromise;
  await f.bridge.setEnabled(false);
  release();
  expect(await pending).toBeNull();
  const on = f.bridge.setEnabled(true),
    off = f.bridge.setEnabled(false);
  await Promise.all([on, off]);
  expect(f.bridge.status).toBe("unavailable");
  expect(await readdir(path.dirname(f.file))).toEqual([]);
  await f.bridge.setEnabled(true);
  expect(f.bridge.instanceId).not.toBe(f.descriptor.instanceId);
  await expect(
    bridgeRead(f.descriptor, { command: "context", params: {} }),
  ).rejects.toThrow();
});
it("prunes accumulated dead descriptors before discovery becomes unusable", async () => {
  const f = await fixture();
  const directory = path.dirname(f.file);
  for (let index = 0; index < 140; index++) {
    const instanceId = crypto.randomUUID();
    await writeFile(
      path.join(directory, `${instanceId}.json`),
      JSON.stringify({
        version: 1,
        instanceId,
        pid: 2147483647,
        port: 1,
        token: "0".repeat(64),
      }),
      { mode: 0o600 },
    );
  }
  expect(
    await new ShowMeClient(f.folder).read({ command: "context", params: {} }),
  ).toMatchObject({ ok: true });
  expect((await readdir(directory)).length).toBe(1);
});

it("discovers only authenticated live instances and refuses ambiguity or explicit instance fallback", async () => {
  const f = await fixture(),
    second = await fixture(undefined, f.folder);
  const client = new ShowMeClient(f.folder);
  expect(await client.read({ command: "context", params: {} })).toMatchObject({
    error: { code: "AMBIGUOUS_INSTANCE" },
  });
  expect(
    await new ShowMeClient(f.folder, f.descriptor.instanceId).read({
      command: "context",
      params: {},
    }),
  ).toMatchObject({ ok: true });
  await f.bridge.setEnabled(false);
  expect(
    await new ShowMeClient(f.folder, f.descriptor.instanceId).read({
      command: "context",
      params: {},
    }),
  ).toMatchObject({ error: { code: "APP_UNAVAILABLE" } });
  await writeFile(f.file, JSON.stringify({ ...f.descriptor, version: 2 }), {
    mode: 0o600,
  });
  expect(await client.read({ command: "context", params: {} })).toMatchObject({
    ok: true,
  });
  await second.bridge.setEnabled(false);
  expect(await client.read({ command: "context", params: {} })).toMatchObject({
    error: { code: "APP_UNAVAILABLE" },
  });
});
