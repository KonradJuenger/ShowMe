import { readdir, readFile, lstat, rm } from "node:fs/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import path from "node:path";
import { z } from "zod/v4";
import { agentFailure, type AgentBridgeRequest } from "../src/core/agentRead";
import {
  BRIDGE_JSON_LIMIT,
  BRIDGE_PREVIEW_LIMIT,
  BRIDGE_REQUEST_LIMIT,
  type BridgeDescriptor,
} from "../electron/agentBridge";

const descriptorSchema = z
  .object({
    version: z.literal(1),
    instanceId: z.uuid(),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "EPERM"
    );
  }
}

const bridgeAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 8,
  maxFreeSockets: 4,
});

export async function bridgeRead(
  descriptor: BridgeDescriptor,
  value: AgentBridgeRequest,
  signal?: AbortSignal,
): Promise<any> {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > BRIDGE_REQUEST_LIMIT)
    return agentFailure("PAYLOAD_TOO_LARGE", "Use a smaller request.");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: descriptor.port,
        path: "/v1/read",
        method: "POST",
        agent: bridgeAgent,
        signal,
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (
            size >
            (value.command === "preview"
              ? BRIDGE_PREVIEW_LIMIT
              : BRIDGE_JSON_LIMIT)
          )
            request.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            if (
              !response.statusCode ||
              response.statusCode < 200 ||
              (response.statusCode >= 300 && response.statusCode < 400) ||
              response.headers["x-showme-instance"] !== descriptor.instanceId ||
              response.headers["x-showme-bridge"] !== "1"
            )
              throw new Error("Unavailable instance");
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (
              response.statusCode !== 200 &&
              (result?.ok !== false || typeof result.error?.code !== "string")
            )
              throw new Error("Invalid error response");
            resolve(result);
          } catch {
            reject(new Error("Unavailable instance"));
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("Read timeout")),
      value.command === "deliver" || value.command === "workspace"
        ? 121000
        : value.command === "preview"
          ? 61000
          : value.command === "apply"
            ? 31000
            : 16000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end(body);
  });
}

/** Cache only a verified live descriptor. Every request still carries the current
 * bearer token and verifies the instance headers, so bridge revocation remains authoritative. */
export class ShowMeClient {
  private cachedDescriptor: BridgeDescriptor | null = null;

  private uncertainOutcome() {
    return agentFailure(
      "OUTCOME_UNKNOWN",
      "The native operation may have completed. Read context and check the native library or destination before deliberately requesting new work; do not blindly retry.",
    );
  }

  private accessChanged(value: any) {
    return (
      value?.ok === false &&
      (value.error?.code === "MCP_ACCESS_CHANGED" ||
        value.error?.code === "UNAUTHORIZED")
    );
  }

  constructor(
    private readonly userData: string,
    private readonly instanceId?: string,
  ) {}

  private async discover(
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; descriptor: BridgeDescriptor; context: unknown }
    | { ok: false; failure: ReturnType<typeof agentFailure> }
  > {
    const directory = path.join(this.userData, "mcp", "instances");
    try {
      const files = (await readdir(directory)).filter((file) =>
        /^[a-f0-9-]{36}\.json$/.test(file),
      );
      const available: Array<{
        descriptor: BridgeDescriptor;
        context: unknown;
      }> = [];
      // Parallel probes are bounded by the descriptor count and only happen
      // during initial discovery or after a cached connection fails.
      await Promise.all(
        files.map(async (file) => {
          if (this.instanceId && file !== `${this.instanceId}.json`) return;
          try {
            const filename = path.join(directory, file),
              stat = await lstat(filename);
            if (
              !stat.isFile() ||
              stat.size > 4096 ||
              (process.platform !== "win32" &&
                ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
            )
              return;
            let raw: unknown;
            try {
              raw = JSON.parse(await readFile(filename, "utf8"));
            } catch {
              await rm(filename, { force: true });
              return;
            }
            const parsed = descriptorSchema.safeParse(raw);
            if (!parsed.success || file !== `${parsed.data.instanceId}.json`) {
              await rm(filename, { force: true });
              return;
            }
            if (!processIsAlive(parsed.data.pid)) {
              await rm(filename, { force: true });
              return;
            }
            const timeout = AbortSignal.timeout(1500);
            const context = await bridgeRead(
              parsed.data,
              { command: "context", params: {} },
              signal ? AbortSignal.any([signal, timeout]) : timeout,
            );
            if (context?.ok === true)
              available.push({ descriptor: parsed.data, context });
          } catch {
            /* Unauthorized or temporarily unavailable descriptors remain untouched. */
          }
        }),
      );
      if (available.length > 1)
        return {
          ok: false,
          failure: agentFailure(
            "AMBIGUOUS_INSTANCE",
            "Multiple ShowMe instances are available. Configure --instance with the intended instance ID from Settings.",
          ),
        };
      if (!available.length)
        return {
          ok: false,
          failure: agentFailure(
            "APP_UNAVAILABLE",
            "Open ShowMe, enable MCP in Settings and check the configured user-data directory.",
          ),
        };
      return { ok: true, ...available[0] };
    } catch {
      return {
        ok: false,
        failure: agentFailure(
          "APP_UNAVAILABLE",
          "ShowMe is unavailable or MCP access changed. Read context and retry.",
        ),
      };
    }
  }

  private async readDiscovered(
    value: AgentBridgeRequest,
    signal?: AbortSignal,
  ) {
    const discovered = await this.discover(signal);
    if (!discovered.ok) return discovered.failure;
    this.cachedDescriptor = discovered.descriptor;
    if (value.command === "context") return discovered.context;
    try {
      const result = await bridgeRead(discovered.descriptor, value, signal);
      if (this.accessChanged(result)) {
        this.cachedDescriptor = null;
        if (value.command === "workspace" || value.command === "deliver")
          return result;
        return null;
      }
      return result;
    } catch {
      this.cachedDescriptor = null;
      if (value.command === "workspace" || value.command === "deliver")
        return this.uncertainOutcome();
      return null;
    }
  }

  async read(value: AgentBridgeRequest, signal?: AbortSignal) {
    if (this.cachedDescriptor) {
      try {
        const result = await bridgeRead(this.cachedDescriptor, value, signal);
        if (!this.accessChanged(result)) return result;
        this.cachedDescriptor = null;
        if (value.command === "workspace" || value.command === "deliver")
          return result;
      } catch {
        this.cachedDescriptor = null;
        if (value.command === "workspace" || value.command === "deliver")
          return this.uncertainOutcome();
      }
    }

    const first = await this.readDiscovered(value, signal);
    if (first !== null) return first;

    // A descriptor can become stale between discovery and the actual request.
    // Rediscover exactly once. Never loop indefinitely on a broken instance.
    const retry = await this.readDiscovered(value, signal);
    return (
      retry ??
      agentFailure(
        "APP_UNAVAILABLE",
        "ShowMe is unavailable or MCP access changed. Read context and retry.",
      )
    );
  }
}
