import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Run serially, alternating clean main+common-harness and candidate checkouts.
const [baselineDirectory, outputDirectory, repeats = "3"] =
  process.argv.slice(2);
if (!baselineDirectory || !outputDirectory)
  throw new Error(
    "Usage: node scripts/benchmark-renderer-paired.mjs <baseline-checkout> <output> [runs]",
  );
const output = path.resolve(outputDirectory);
const runs = Number(repeats);
if (!Number.isInteger(runs) || runs < 3 || runs > 20)
  throw new Error("Paired runs must be between 3 and 20");
const candidateDirectory = process.cwd();
const samples = { baseline: [], candidate: [] };
for (const cwd of [baselineDirectory, candidateDirectory]) {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (status.status !== 0 || status.stdout.trim())
    throw new Error(`Checkout must be clean: ${cwd}`);
}
await mkdir(output, { recursive: true });
for (let index = 0; index < runs; index++) {
  for (const kind of ["baseline", "candidate"]) {
    const directory = path.join(output, `${index}-${kind}`);
    const run = spawnSync(
      process.execPath,
      [
        "scripts/benchmark-renderer-workloads.mjs",
        "--runs",
        "1",
        "--output",
        directory,
        ...(kind === "baseline" ? ["--measure-baseline"] : []),
      ],
      {
        cwd: kind === "baseline" ? baselineDirectory : candidateDirectory,
        env: { ...process.env, SHOWME_TEST_PORT: "5183" },
        stdio: "inherit",
      },
    );
    if (run.error) throw run.error;
    if (run.status !== 0) process.exit(run.status ?? 1);
    const report = JSON.parse(
      await readFile(path.join(directory, "report.json"), "utf8"),
    );
    const reference = samples.baseline[0];
    if (report.provenance.dirty) throw new Error("Dirty measurement");
    if (reference) {
      for (const key of [
        "harnessSha256",
        "platform",
        "arch",
        "cpu",
        "logicalCpus",
      ])
        if (reference.provenance[key] !== report.provenance[key])
          throw new Error(`Mismatched ${key}`);
      for (const name of ["native", "generated", "scene-texture"])
        if (
          JSON.stringify(reference.workloads[name].environment) !==
          JSON.stringify(report.workloads[name].environment)
        )
          throw new Error(`Mismatched ${name} environment`);
      if (
        JSON.stringify(reference.mixed.environment) !==
        JSON.stringify(report.mixed.environment)
      )
        throw new Error("Mismatched mixed environment");
    }
    samples[kind].push(report);
  }
}
const summarize = (values) => {
  if (values.some((value) => !Number.isFinite(value))) return null;
  values.sort((a, b) => a - b);
  return {
    median: values[Math.floor(values.length / 2)],
    range: { min: values[0], max: values.at(-1) },
  };
};
const aggregate = {};
for (const kind of ["baseline", "candidate"]) {
  const rows = samples[kind];
  const first = rows[0];
  aggregate[kind] = {
    provenance: {
      ...first.provenance,
      runs,
      order: "baseline then candidate, repeated serially",
    },
    workloads: Object.fromEntries(
      Object.entries(first.workloads).map(([name, workload]) => [
        name,
        {
          environment: workload.environment,
          metrics: Object.fromEntries(
            Object.keys(workload.metrics).map((metric) => [
              metric,
              summarize(
                rows.map((row) => row.workloads[name].metrics[metric]?.median),
              ),
            ]),
          ),
        },
      ]),
    ),
    mixed: {
      environment: first.mixed.environment,
      metrics: Object.fromEntries(
        Object.keys(first.mixed.metrics).map((metric) => [
          metric,
          summarize(rows.map((row) => row.mixed.metrics[metric])),
        ]),
      ),
    },
  };
}
await writeFile(
  path.join(output, "paired-report.json"),
  JSON.stringify(
    { schemaVersion: 1, createdAt: new Date().toISOString(), ...aggregate },
    null,
    2,
  ) + "\n",
);
console.log(`Paired results: ${path.join(output, "paired-report.json")}`);
