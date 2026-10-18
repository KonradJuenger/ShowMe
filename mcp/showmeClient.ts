import { readdir, readFile, lstat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
        agent: false,
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
      value.command === "preview" || value.command === "apply" ? 31000 : 16000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end(body);
  });
}

/** Discovery is per call: no token/session cache can outlive a preference transition. */
export class ShowMeClient {
  constructor(
    private readonly userData: string,
    private readonly instanceId?: string,
  ) {}
  async read(value: AgentBridgeRequest, signal?: AbortSignal) {
    const directory = path.join(this.userData, "mcp", "instances");
    try {
      const files = (await readdir(directory)).filter((file) =>
        /^[a-f0-9-]{36}\.json$/.test(file),
      );
      if (files.length > 128)
        return agentFailure(
          "APP_UNAVAILABLE",
          "Too many connection descriptors. Restart ShowMe and review its connection directory.",
        );
      const available: Array<{
        descriptor: BridgeDescriptor;
        context: unknown;
      }> = [];
      // Parallel probes have bounded count, short discovery deadline and no native captures.
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
            const parsed = descriptorSchema.safeParse(
              JSON.parse(await readFile(filename, "utf8")),
            );
            if (!parsed.success || file !== `${parsed.data.instanceId}.json`)
              return;
            const timeout = AbortSignal.timeout(1500);
            const context = await bridgeRead(
              parsed.data,
              { command: "context", params: {} },
              signal ? AbortSignal.any([signal, timeout]) : timeout,
            );
            if (context?.ok === true)
              available.push({ descriptor: parsed.data, context });
          } catch {
            /* Stale, unauthorized and incomplete descriptors are unavailable. */
          }
        }),
      );
      if (available.length > 1)
        return agentFailure(
          "AMBIGUOUS_INSTANCE",
          "Multiple ShowMe instances are available. Configure --instance with the intended instance ID from Settings.",
        );
      if (!available.length)
        return agentFailure(
          "APP_UNAVAILABLE",
          "Open ShowMe, enable MCP in Settings and check the configured user-data directory.",
        );
      return value.command === "context"
        ? available[0].context
        : await bridgeRead(available[0].descriptor, value, signal);
    } catch {
      return agentFailure(
        "APP_UNAVAILABLE",
        "ShowMe is unavailable or MCP access changed. Read context and retry.",
      );
    }
  }
}
