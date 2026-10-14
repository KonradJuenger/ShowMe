import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".agenttmp", { recursive: true });
await build({ entryPoints: ["scripts/image-cache-benchmark.ts"], bundle: true,
  platform: "node", format: "cjs", packages: "external", outfile: ".agenttmp/image-cache-benchmark.cjs" });
const result = spawnSync(process.execPath, [".agenttmp/image-cache-benchmark.cjs", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
