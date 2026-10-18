import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentBridgeRequestSchema,
  agentFailure,
  type AgentBridgeRequest,
} from "../src/core/agentRead";

export const BRIDGE_REQUEST_LIMIT = 64 * 1024;
export const BRIDGE_JSON_LIMIT = 2 * 1024 * 1024;
export const BRIDGE_PREVIEW_LIMIT = 32 * 1024 * 1024;
export interface BridgeDescriptor {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
}
/** Private read-only RPC. Neither the token nor this object is exposed to renderers. */
export class AgentBridge {
  private server: Server | null = null;
  private descriptor: string | null = null;
  private generation = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private ready = false;
  private identity: string | null = null;
  private work = 0;
  constructor(
    private readonly userData: string,
    private readonly dispatch: (
      request: AgentBridgeRequest,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  get status() {
    return this.ready ? ("ready" as const) : ("unavailable" as const);
  }
  get instanceId() {
    return this.ready ? this.identity : null;
  }
  setEnabled(enabled: boolean): Promise<void> {
    const generation = ++this.generation;
    this.ready = false;
    // Revoke before awaiting filesystem work or any queued startup.
    this.server?.closeAllConnections();
    this.lifecycle = this.lifecycle
      .catch(() => {})
      .then(async () => {
        await this.stop();
        if (enabled && generation === this.generation)
          await this.start(generation);
      })
      .catch(() => {
        this.ready = false;
      });
    return this.lifecycle;
  }
  private async stop() {
    const server = this.server,
      descriptor = this.descriptor;
    this.server = null;
    this.descriptor = null;
    this.identity = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (descriptor) await rm(descriptor, { force: true });
  }
  private async start(generation: number) {
    const token = randomBytes(32).toString("hex"),
      instanceId = randomUUID();
    const server = createServer(async (request, response) => {
      const fail = (code: string, message: string, status = 400) => {
        if (response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-ShowMe-Instance": instanceId,
          "X-ShowMe-Bridge": "1",
        });
        response.end(JSON.stringify(agentFailure(code, message)));
      };
      const expected = Buffer.from(`Bearer ${token}`),
        supplied = Buffer.from(request.headers.authorization ?? "");
      const port = (server.address() as { port: number } | null)?.port;
      if (generation !== this.generation || !this.ready)
        return fail("MCP_ACCESS_CHANGED", "Read context again.", 403);
      if (
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== `127.0.0.1:${port}` ||
        request.headers.origin !== undefined ||
        Object.keys(request.headers).some((k) => k.startsWith("sec-fetch-")) ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return fail("UNAUTHORIZED", "Local connection is not authorized.", 403);
      if (
        request.method !== "POST" ||
        request.url !== "/v1/read" ||
        request.headers["content-type"] !== "application/json"
      )
        return fail("INVALID_REQUEST", "Use the private read endpoint.");
      if (this.work >= 8)
        return fail("BUSY", "Too many pending reads. Retry later.", 429);
      this.work++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        request.setTimeout(15000, () => request.destroy());
        for await (const chunk of request) {
          size += chunk.length;
          if (size > BRIDGE_REQUEST_LIMIT) {
            fail("PAYLOAD_TOO_LARGE", "Use a smaller request.", 413);
            request.resume();
            return;
          }
          chunks.push(chunk);
        }
        const parsed = agentBridgeRequestSchema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        if (!parsed.success)
          return fail(
            "INVALID_REQUEST",
            "Use a supported read command and valid parameters.",
          );
        if (generation !== this.generation)
          return fail("MCP_ACCESS_CHANGED", "Read context again.", 403);
        const command = parsed.data.command;
        timer = setTimeout(
          () => response.destroy(),
          command === "preview" || command === "apply" ? 30000 : 15000,
        );
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        const result = await this.dispatch(parsed.data, abort.signal);
        if (generation !== this.generation || !this.ready)
          return fail("MCP_ACCESS_CHANGED", "Read context again.", 403);
        if (response.destroyed) return;
        const json = JSON.stringify(result);
        if (
          Buffer.byteLength(json) >
          (command === "preview" ? BRIDGE_PREVIEW_LIMIT : BRIDGE_JSON_LIMIT)
        )
          return fail(
            "PAYLOAD_TOO_LARGE",
            "Inspect a narrower scope or request a smaller preview.",
            413,
          );
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-ShowMe-Instance": instanceId,
          "X-ShowMe-Bridge": "1",
        });
        response.end(json);
      } catch {
        fail(
          "INVALID_REQUEST",
          "The read request failed. Read context and retry.",
        );
      } finally {
        if (timer) clearTimeout(timer);
        this.work--;
      }
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.maxHeadersCount = 32;
    server.maxConnections = 32;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      if (generation !== this.generation) {
        await this.stop();
        return;
      }
      const directory = path.join(this.userData, "mcp", "instances");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(directory, 0o700);
      if (process.platform === "win32") {
        const run = promisify(execFile);
        const { stdout } = await run(
          "whoami.exe",
          ["/user", "/fo", "csv", "/nh"],
          { windowsHide: true },
        );
        const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
        if (!sid) throw new Error("User identity unavailable");
        await run(
          "icacls.exe",
          [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
          { windowsHide: true },
        );
      }
      const filename = path.join(directory, `${instanceId}.json`),
        temporary = filename + ".tmp";
      this.descriptor = filename;
      const descriptor: BridgeDescriptor = {
        version: 1,
        instanceId,
        pid: process.pid,
        port: (server.address() as { port: number }).port,
        token,
      };
      try {
        await writeFile(temporary, JSON.stringify(descriptor), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true });
      }
      if (generation !== this.generation) {
        await this.stop();
        return;
      }
      this.ready = true;
      this.identity = instanceId;
    } catch {
      await this.stop();
    }
  }
}
