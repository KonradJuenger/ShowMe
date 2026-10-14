import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recordAudienceBenchmark,
  renderAudienceHistory,
} from "./audience-benchmark-history.mjs";

const compareOnly = process.argv.includes("--compare-only");
const historyOnly = process.argv.includes("--history-only");
const args = process.argv
  .slice(2)
  .filter((arg) => !["--compare-only", "--history-only"].includes(arg));
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
for (let i = 0; i < args.length; i += 2)
  if (
    ![
      "--output",
      "--baseline",
      "--runs",
      "--max-regression-percent",
      "--history",
    ].includes(args[i])
  )
    throw new Error(`Unknown option ${args[i]}`);
const runs = Number(option("--runs", "3"));
const historyDirectory = path.resolve(
  option("--history", ".benchmark-data/audience"),
);
if (historyOnly) {
  await renderAudienceHistory(historyDirectory);
  console.log(path.join(historyDirectory, "history.html"));
  process.exit(0);
}
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
  throw new Error("--runs must be between 1 and 20");
const output = path.resolve(option("--output", "test-results-audience-stress"));
const baselinePath = option("--baseline", null);
const limit = Number(option("--max-regression-percent", "20"));
if (!Number.isFinite(limit) || limit < 0)
  throw new Error("Invalid regression percentage");
const baseline = baselinePath
  ? JSON.parse(await readFile(path.resolve(baselinePath), "utf8"))
  : null;
await mkdir(output, { recursive: true });
if (compareOnly && !baseline)
  throw new Error("--compare-only requires --baseline");
const existingReport = compareOnly
  ? JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))
  : null;
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout?.trim();
const branch = spawnSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).stdout?.trim();
const dirty = !!spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).stdout?.trim();
if (!compareOnly) {
  const run = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "playwright.config.ts",
      "--grep",
      "audience stress benchmark",
      "--repeat-each",
      String(runs),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        SHOWME_TEST_FILES: JSON.stringify([
          "tests/feature/presenter/audience-navigation.spec.ts",
        ]),
        SHOWME_AUDIENCE_BENCHMARK_OUTPUT: output,
      },
    },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
const reports = compareOnly
  ? []
  : await Promise.all(
      Array.from({ length: runs }, (_, i) =>
        readFile(path.join(output, `run-${i}.json`), "utf8").then(JSON.parse),
      ),
    );
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summaries = reports.map((report) => report.summary);
if (
  !compareOnly &&
  spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout?.trim() !== revision
)
  throw new Error(
    "HEAD changed during the benchmark; do not associate this measurement with a commit",
  );
if (
  reports.some(
    (report) =>
      report.schemaVersion !== reports[0].schemaVersion ||
      JSON.stringify(report.workload) !== JSON.stringify(reports[0].workload) ||
      JSON.stringify(report.environment) !==
        JSON.stringify(reports[0].environment),
  )
)
  throw new Error("Repeated runs have mismatched environments or workloads");
const aggregate = existingReport ?? {
  schemaVersion: reports[0].schemaVersion,
  createdAt: new Date().toISOString(),
  revision,
  branch,
  dirty,
  runs,
  workload: reports[0].workload,
  environment: {
    ...reports[0].environment,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  metrics: {
    firstNavigationP95Ms: median(summaries.map((s) => s.firstNavigationMs.p95)),
    revisitNavigationP95Ms: median(
      summaries.map((s) => s.revisitNavigationMs.p95),
    ),
    frameIntervalP95Ms: median(summaries.map((s) => s.frameIntervalMs.p95)),
    taskCpuMs: median(summaries.map((s) => s.taskCpuMs)),
    longTaskTotalMs: median(summaries.map((s) => s.longTaskTotalMs)),
    heapBytes: median(summaries.map((s) => s.heapBytes)),
  },
};
if (!compareOnly) {
  const perRun = summaries.map((summary) => ({
    firstNavigationP95Ms: summary.firstNavigationMs.p95,
    revisitNavigationP95Ms: summary.revisitNavigationMs.p95,
    frameIntervalP95Ms: summary.frameIntervalMs.p95,
    taskCpuMs: summary.taskCpuMs,
    longTaskTotalMs: summary.longTaskTotalMs,
    heapBytes: summary.heapBytes,
  }));
  aggregate.metricRanges = Object.fromEntries(
    Object.keys(aggregate.metrics).map((key) => [
      key,
      {
        min: Math.min(...perRun.map((sample) => sample[key])),
        max: Math.max(...perRun.map((sample) => sample[key])),
      },
    ]),
  );
  const entry = await recordAudienceBenchmark(aggregate, historyDirectory);
  aggregate.machineId = entry.machineId;
  aggregate.group = entry.group;
  console.log("Commit history:", path.join(historyDirectory, "history.html"));
}
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify(aggregate, null, 2) + "\n",
);
console.table(aggregate.metrics);
if (baseline) {
  if (
    baseline.schemaVersion !== aggregate.schemaVersion ||
    baseline.machineId !== aggregate.machineId ||
    JSON.stringify(baseline.workload) !== JSON.stringify(aggregate.workload) ||
    JSON.stringify(baseline.environment) !==
      JSON.stringify(aggregate.environment) ||
    baseline.runs !== aggregate.runs
  )
    throw new Error(
      "Baseline workload, browser, viewport, machine and run count must match; capture a new baseline for a changed environment",
    );
  const comparison = Object.entries(aggregate.metrics).map(
    ([metric, value]) => {
      const previous = baseline.metrics[metric];
      if (
        !Number.isFinite(previous) ||
        previous < 0 ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new Error(`Invalid baseline metric ${metric}`);
      const changePercent = previous
        ? (100 * (value - previous)) / previous
        : null;
      return {
        metric,
        baseline: previous,
        current: value,
        changePercent,
        result:
          previous === 0
            ? "no percentage baseline"
            : changePercent > limit
              ? "regressed"
              : changePercent < -limit
                ? "improved"
                : "within tolerance",
      };
    },
  );
  await writeFile(
    path.join(output, "comparison.json"),
    JSON.stringify({ limitPercent: limit, comparison }, null, 2) + "\n",
  );
  console.table(comparison);
  if (comparison.some((row) => row.result === "regressed"))
    process.exitCode = 1;
}
