import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const allowed = new Set([
  "--output",
  "--runs",
  "--baseline",
  "--max-regression-percent",
  "--skip-mixed",
  "--measure-baseline",
]);
for (let i = 0; i < args.length; i++)
  if (args[i].startsWith("--") && !allowed.has(args[i]))
    throw new Error(`Unknown option ${args[i]}`);

const output = path.resolve(
  option("--output", "test-results-renderer-workloads"),
);
const runs = Number(option("--runs", "3"));
const baselinePath = option("--baseline", null);
const limit = Number(option("--max-regression-percent", "20"));
const skipMixed = args.includes("--skip-mixed");
const measureBaseline = args.includes("--measure-baseline");
const harnessDigest = createHash("sha256");
for (const file of [
  "tests/helpers/renderingWorkloadHarness.tsx",
  "tests/helpers/mixedEffectsHarness.tsx",
  "tests/helpers/audienceNavigationHarness.tsx",
  "tests/helpers/audienceStressScene.ts",
  "tests/feature/effects/rendering-workloads.spec.ts",
  "tests/feature/presenter/audience-navigation.spec.ts",
  "tests/fixtures/media/renderer-pattern.png",
  "tests/helpers/webglPixels.ts",
])
  harnessDigest.update(await readFile(file));
const harnessSha256 = harnessDigest.digest("hex");
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error("--runs must be between 1 and 20");
if (!Number.isFinite(limit) || limit < 0)
  throw new Error("Invalid regression percentage");
await mkdir(output, { recursive: true });

const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout?.trim();
const branch = spawnSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).stdout?.trim();
const dirty = !!spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).stdout?.trim();

const isolated = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.config.ts",
    "--repeat-each",
    String(runs),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SHOWME_TEST_FILES: JSON.stringify([
        "tests/feature/effects/rendering-workloads.spec.ts",
      ]),
      SHOWME_RENDERER_BENCHMARK: "1",
      SHOWME_RENDERER_BASELINE: measureBaseline ? "1" : "0",
      SHOWME_RENDERER_BENCHMARK_OUTPUT: output,
    },
  },
);
if (isolated.error) throw isolated.error;
if (isolated.status !== 0) process.exit(isolated.status ?? 1);

let mixed = null;
if (!skipMixed) {
  const mixedOutput = path.join(output, "mixed");
  const run = spawnSync(
    process.execPath,
    [
      "scripts/benchmark-audience.mjs",
      "--runs",
      String(runs),
      "--output",
      mixedOutput,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
  mixed = JSON.parse(
    await readFile(path.join(mixedOutput, "report.json"), "utf8"),
  );
}

if (
  spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout?.trim() !== revision
)
  throw new Error("HEAD changed during renderer benchmark");

const kinds = ["native", "generated", "scene-texture"];
const reports = Object.fromEntries(
  await Promise.all(
    kinds.map(async (kind) => [
      kind,
      await Promise.all(
        Array.from({ length: runs }, (_, index) =>
          readFile(path.join(output, `${kind}-run-${index}.json`), "utf8").then(
            JSON.parse,
          ),
        ),
      ),
    ]),
  ),
);
for (const kind of kinds) {
  const rows = reports[kind];
  if (
    rows.some(
      (row) =>
        row.schemaVersion !== rows[0].schemaVersion ||
        row.workload !== rows[0].workload ||
        JSON.stringify(row.environment) !== JSON.stringify(rows[0].environment),
    )
  )
    throw new Error(`Mismatched ${kind} workload environments`);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const range = (values) => ({
  min: Math.min(...values),
  max: Math.max(...values),
});
const select = {
  native: {
    frameP95Ms: (r) => r.frames.p95,
    taskCpuMs: (r) => r.metrics.TaskDuration,
    styleRecalculations: (r) => r.metrics.RecalcStyleCount,
    layoutCount: (r) => r.metrics.LayoutCount,
    computedStyleReads: (r) => r.result.discovered.styleReads,
    selectorQueries: (r) => r.result.discovered.queries,
    canvasAllocations: (r) => r.result.discovered.canvasAllocations,
    sceneCaptures: (r) => r.result.diagnostics.sceneCaptures,
    domClones: (r) => r.result.diagnostics.domClones,
  },
  generated: {
    frameP95Ms: (r) => r.frames.p95,
    taskCpuMs: (r) => r.metrics.TaskDuration,
    canvas2dCopies: (r) => r.result.discovered.canvas2dCopies,
    sceneCaptures: (r) => r.result.diagnostics.sceneCaptures,
    shaderCompilations: (r) => r.result.discovered.shaderCompilations,
    gpuTextureAllocations: (r) => r.result.discovered.gpuTextureAllocations,
    activeContexts: (r) => (r.baseline ? null : r.result.contextCount),
    maxActiveContexts: (r) => (r.baseline ? null : r.result.maxActiveContexts),
  },
  "scene-texture": {
    taskCpuMs: (r) => r.metrics.TaskDuration,
    firstCaptures: (r) => r.result.firstPreparation.sceneCaptures,
    firstStyleReads: (r) => r.result.firstPreparation.domStyleReads,
    firstPreparationMs: (r) =>
      r.baseline ? null : r.result.firstPreparation.scenePreparationMs,
    revisitCaptures: (r) => r.result.revisit.sceneCaptures,
    retainedReuses: (r) =>
      r.baseline ? null : r.result.revisit.sceneRetainedReuses,
    revisitReadyMs: (r) => r.result.revisitReadyMs,
  },
};

const workloads = Object.fromEntries(
  kinds.map((kind) => {
    const rows = reports[kind];
    const metrics = Object.fromEntries(
      Object.entries(select[kind]).map(([name, read]) => {
        const samples = rows.map(read);
        if (samples.some((value) => !Number.isFinite(value)))
          return [name, null];
        return [name, { median: median(samples), range: range(samples) }];
      }),
    );
    return [kind, { environment: rows[0].environment, metrics }];
  }),
);

const aggregate = {
  schemaVersion: 2,
  createdAt: new Date().toISOString(),
  provenance: {
    mode: "headless Chromium",
    note: "Keep this dataset separate from visible Electron/hardware-GPU measurements.",
    revision,
    measureBaseline,
    harnessSha256,
    branch,
    dirty,
    runs,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
  },
  workloads,
  mixed: mixed
    ? {
        environment: mixed.environment,
        metrics: mixed.metrics,
        metricRanges: mixed.metricRanges,
      }
    : null,
};
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify(aggregate, null, 2) + "\n",
);

console.log(JSON.stringify(aggregate, null, 2));

if (baselinePath) {
  const baseline = JSON.parse(
    await readFile(path.resolve(baselinePath), "utf8"),
  );
  if (dirty || baseline.provenance?.dirty)
    throw new Error("Paired renderer claims require clean commits.");
  if (
    baseline.schemaVersion !== aggregate.schemaVersion ||
    baseline.provenance?.harnessSha256 !== harnessSha256
  )
    throw new Error("Paired renderer harness/schema mismatch.");
  for (const key of ["platform", "arch", "cpu", "logicalCpus"])
    if (baseline.provenance?.[key] !== aggregate.provenance[key])
      throw new Error(`Paired renderer environment mismatch: ${key}`);
  if (baseline.provenance?.runs !== aggregate.provenance.runs)
    throw new Error("Paired renderer run counts must match.");
  for (const kind of kinds)
    if (
      JSON.stringify(baseline.workloads?.[kind]?.environment) !==
      JSON.stringify(aggregate.workloads[kind].environment)
    )
      throw new Error(`Paired renderer browser/viewport mismatch: ${kind}`);
  if (
    baseline.mixed &&
    aggregate.mixed &&
    JSON.stringify(baseline.mixed.environment) !==
      JSON.stringify(aggregate.mixed.environment)
  )
    throw new Error("Paired mixed workload environment mismatch.");
  const comparisons = [];
  for (const kind of kinds)
    for (const [metric, value] of Object.entries(workloads[kind].metrics)) {
      const previous = baseline.workloads?.[kind]?.metrics?.[metric]?.median;
      if (!Number.isFinite(previous) || !Number.isFinite(value?.median))
        continue;
      const changePercent = previous
        ? (100 * (value.median - previous)) / previous
        : null;
      comparisons.push({
        workload: kind,
        metric,
        baseline: previous,
        current: value.median,
        changePercent,
        result:
          previous === 0
            ? "no percentage baseline"
            : changePercent > limit
              ? "regressed"
              : changePercent < -limit
                ? "improved"
                : "within tolerance",
      });
    }
  await writeFile(
    path.join(output, "comparison.json"),
    JSON.stringify({ limitPercent: limit, comparisons }, null, 2) + "\n",
  );
}
