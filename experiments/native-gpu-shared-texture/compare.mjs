import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const numberOption = (name, fallback) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};
const width = Math.round(numberOption("--width", 1596));
const height = Math.round(numberOption("--height", 998));
const dpr = numberOption("--dpr", 1.6042);
const durationMs = numberOption("--duration", 20000);
const output = path.resolve(option("--output", ".benchmark-data/shared-texture/comparison.json"));
const evidenceDir = option("--evidence-dir", "");
const electronBin = path.resolve("node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const legacyOutput = path.resolve(".benchmark-data/shared-texture/legacy-scene-texture.json");
const sharedOutput = path.resolve(".benchmark-data/shared-texture/webgpu.json");

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
const common = [`--width=${width}`, `--height=${height}`, `--dpr=${dpr}`, `--duration=${durationMs}`];
const legacyArgs = ["experiments/native-gpu-shared-texture/legacy-scene-texture.mjs", ...common, `--output=${legacyOutput}`];
if (evidenceDir) legacyArgs.push(`--evidence=${path.resolve(evidenceDir, "legacy-scene-texture.png")}`);
run(process.execPath, legacyArgs);
const sharedArgs = ["experiments/native-gpu-shared-texture/main.cjs", "--benchmark", "--backend=webgpu", "--fps=60", ...common, `--output=${sharedOutput}`];
if (evidenceDir) sharedArgs.push(`--evidence=${path.resolve(evidenceDir, "shared-texture-webgpu.png")}`);
run(electronBin, sharedArgs);

const legacy = JSON.parse(await readFile(legacyOutput, "utf8"));
const shared = JSON.parse(await readFile(sharedOutput, "utf8"));
const close = (left, right, tolerance) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
const checks = {
  requestedLogicalSizeMatches: legacy.configuration.width === width && legacy.configuration.height === height && shared.configuration.width === width && shared.configuration.height === height,
  requestedDprMatchesConfiguration: close(legacy.configuration.dpr, dpr, .0001) && close(shared.configuration.dpr, dpr, .0001),
  legacyViewportMatchesRequested: legacy.viewport?.width === width && legacy.viewport?.height === height && close(legacy.viewport?.dpr, dpr, .01),
  durationMatches: legacy.configuration.durationMs === durationMs && shared.configuration.durationMs === durationMs,
  sameFinalShader: legacy.claims?.finalShaderMatchesSharedTextureHarness === true,
  noLegacyRendererErrors: Array.isArray(legacy.errors) && legacy.errors.length === 0,
  boundedSharedLifetime: (shared.transport?.queue?.maxRetained ?? Infinity) <= (shared.configuration.maxActive + 1) && shared.transport?.queue?.retained === 0,
};
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  comparisonKind: "controlled-approximate-scene",
  controlledVariables: ["logical width", "logical height", "DPR", "duration", "final shader", "hardware Electron process"],
  sceneEquivalence: "Both workloads are generated-GPU background -> native text/CSS -> cheap full-frame shader. They are intentionally approximate rather than pixel-identical so the legacy side can use the real ShowMe SlideRenderer/SceneTexture implementation without integrating the experimental transport into production.",
  checks,
  legacySceneTexture: legacy,
  sharedTextureWebGpu: shared,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, checks }, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
