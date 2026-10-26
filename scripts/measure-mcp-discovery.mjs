import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
  await readFile(
    path.join(root, "docs/mcp/discovery-size-baseline-2026-10-18.json"),
    "utf8",
  ),
);
const bundle = await build({
  stdin: {
    contents: `export {buildAgentAuthoringGuide as guide} from './src/core/agentAuthoring'; export {agentApplyRequestSchema} from './src/core/agentMutation'; export {z} from 'zod/v4'; export {advertisedApplySchema} from './mcp/applyTransport';`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { guide, agentApplyRequestSchema, z, advertisedApplySchema } =
  module.exports;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const requests = [
  { kind: "protocol" },
  { kind: "operations", operations: baseline.operations },
  { kind: "background-shader" },
  { kind: "css-effect" },
];
const calls = requests.map(({ kind, ...options }) => {
  const result = { ok: true, data: guide(kind, options) };
  return {
    request: { kind, ...options },
    structuredBytes: bytes(result),
    wireBytes: bytes({
      isError: false,
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    }),
  };
});
const structuredBytes = calls.reduce((n, call) => n + call.structuredBytes, 0);
const wireBytes = calls.reduce((n, call) => n + call.wireBytes, 0);
const result = {
  method: baseline.method,
  measurement:
    "Offline canonical guide generation. New default compact protocol, selected operations, shader and CSS guides. Caller emits one representation. Actual host model-context normalization is unmeasured.",
  baseline: {
    authoringCalls: baseline.authoringCalls,
    structuredBytes: baseline.structuredBytes,
    wireBytes: baseline.wireBytes,
  },
  canonicalApplySchemaBytes: bytes(z.toJSONSchema(agentApplyRequestSchema)),
  advertisedApplySchemaBytes: bytes(advertisedApplySchema()),
  advertisedApplyReductionPercent: Number(
    (
      100 *
      (1 -
        bytes(advertisedApplySchema()) /
          bytes(z.toJSONSchema(agentApplyRequestSchema)))
    ).toFixed(2),
  ),
  authoringCalls: calls.length,
  structuredBytes,
  wireBytes,
  structuredReductionPercent: Number(
    (100 * (1 - structuredBytes / baseline.structuredBytes)).toFixed(2),
  ),
  wireReductionPercent: Number(
    (100 * (1 - wireBytes / baseline.wireBytes)).toFixed(2),
  ),
  calls,
};
if (process.argv[2])
  await writeFile(
    path.resolve(process.argv[2]),
    JSON.stringify(result, null, 2) + "\n",
  );
console.log(JSON.stringify(result, null, 2));
