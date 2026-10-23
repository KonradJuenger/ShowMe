import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

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
const warmupMs = numberOption("--warmup", 1500);
const output = path.resolve(option("--output", ".benchmark-data/shared-texture/comparison.json"));
const evidenceDir = option("--evidence-dir", "");
const require = createRequire(import.meta.url);
const electronBin = require("electron");
const legacyOutput = path.resolve(".benchmark-data/shared-texture/legacy-scene-texture.json");
const sharedOutput = path.resolve(".benchmark-data/shared-texture/webgpu.json");

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
const common = [`--width=${width}`, `--height=${height}`, `--dpr=${dpr}`, `--duration=${durationMs}`, `--warmup=${warmupMs}`];
const legacyArgs = ["experiments/native-gpu-shared-texture/legacy-scene-texture.mjs", ...common, `--output=${legacyOutput}`];
if (evidenceDir) legacyArgs.push(`--evidence=${path.resolve(evidenceDir, "legacy-scene-texture.png")}`);
run(process.execPath, legacyArgs);
const sharedArgs = ["experiments/native-gpu-shared-texture/main.cjs", "--benchmark", "--backend=webgpu", "--fps=60", ...common, `--output=${sharedOutput}`];
if (evidenceDir) sharedArgs.push(`--evidence=${path.resolve(evidenceDir, "shared-texture-webgpu.png")}`);
run(electronBin, sharedArgs);

const legacy = JSON.parse(await readFile(legacyOutput, "utf8"));
const shared = JSON.parse(await readFile(sharedOutput, "utf8"));
const close = (left, right, tolerance) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
const expectedPhysical = { width: Math.round(width * dpr), height: Math.round(height * dpr) };
const sharedShapes = (shared.source?.textureShapes ?? []).map(({ shape }) => shape);
const expectedShape = `${expectedPhysical.width}x${expectedPhysical.height}`;
const checks = {
  requestedLogicalSizeMatches: legacy.configuration.width === width && legacy.configuration.height === height && shared.configuration.width === width && shared.configuration.height === height,
  requestedDprMatchesConfiguration: close(legacy.configuration.dpr, dpr, .0001) && close(shared.configuration.dpr, dpr, .0001),
  legacyViewportMatchesRequested: legacy.viewport?.width === width && legacy.viewport?.height === height && close(legacy.viewport?.dpr, dpr, .01),
  legacyPhysicalCanvasMatchesRequested: legacy.outputCanvas?.width === expectedPhysical.width && legacy.outputCanvas?.height === expectedPhysical.height,
  sharedPhysicalTextureMatchesRequested: sharedShapes.includes(expectedShape),
  durationMatches: legacy.configuration.durationMs === durationMs && shared.configuration.durationMs === durationMs,
  warmupMatches: legacy.configuration.warmupMs === warmupMs && shared.configuration.warmupMs === warmupMs,
  sharedMeasurementWindowMatches:
    shared.measurementWindow?.durationMs === durationMs &&
    shared.consumer?.measurementWindow?.startEpochMs === shared.measurementWindow?.startEpochMs &&
    shared.consumer?.measurementWindow?.endEpochMs === shared.measurementWindow?.endEpochMs,
  sameFinalShader: legacy.claims?.finalShaderMatchesSharedTextureHarness === true,
  noLegacyRendererErrors: Array.isArray(legacy.errors) && legacy.errors.length === 0,
  boundedSharedLifetime: (shared.transport?.queue?.maxRetained ?? Infinity) <= (shared.configuration.maxActive + 1) && shared.transport?.queue?.retained === 0,
};
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  comparisonKind: "cadence-reference-not-apples-to-apples",
  controlledVariables: ["logical width", "logical height", "DPR", "physical pixel dimensions", "duration", "warmup", "final shader", "Electron version and hardware"],
  expectedPhysical,
  sceneEquivalence: "Not equivalent. The shared-texture source intentionally includes additional animated native CSS and decoration. The legacy run is therefore a broad cadence reference for the current SceneTexture path, not an apples-to-apples CPU or transport speedup comparison.",
  claims: {
    cadenceReferenceUseful: true,
    cpuCostDirectlyComparable: false,
    transportSpeedupApplesToApples: false,
  },
  checks,
  legacySceneTexture: legacy,
  sharedTextureWebGpu: shared,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, checks }, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
