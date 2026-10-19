import path from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ShowMeClient } from "./showmeClient";
import { createShowMeServer } from "./server";

try {
  const { values } = parseArgs({
    options: { "user-data": { type: "string" }, instance: { type: "string" } },
    strict: true,
  });
  if (
    !values["user-data"] ||
    !path.isAbsolute(values["user-data"]) ||
    (values.instance && !/^[a-f0-9-]{36}$/.test(values.instance))
  )
    throw new Error("Invalid configuration");
  const client = new ShowMeClient(values["user-data"], values.instance);
  const handle = serveStdio(() =>
    createShowMeServer((value, signal) => client.read(value, signal)),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void handle.close();
    });
} catch {
  console.error(
    "ShowMe MCP requires --user-data with an absolute application-data directory, and an optional --instance UUID.",
  );
  process.exitCode = 1;
}
