import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Compact, reviewable data accompanies the report; raw events/traces stay in
// ignored test-results-effects-stress. Pass the final sweep and repeated run.
const inputs = process.argv.slice(2);
if (!inputs.length)
  throw new Error("Pass one or more stress report JSON paths");
const reports = await Promise.all(
  inputs.map(async (file) => ({
    file,
    data: JSON.parse(await readFile(file, "utf8")),
  })),
);
const first = reports[0].data;
if (
  reports.some(
    ({ data }) =>
      data.sourceDigest !== first.sourceDigest ||
      data.fixtureVersion !== first.fixtureVersion,
  )
)
  throw new Error("Do not combine different source files or fixture versions");
const rows = reports.flatMap(({ file, data }) =>
  data.cases.map((record) => {
    const summary = record.summary;
    const metrics = Object.fromEntries(
      (record.performanceAfter?.metrics ?? []).map((item) => [
        item.name,
        item.value,
      ]),
    );
    const previous = Object.fromEntries(
      (record.performanceBefore?.metrics ?? []).map((item) => [
        item.name,
        item.value,
      ]),
    );
    const privateMiB = (processes) =>
      (processes ?? []).reduce(
        (sum, item) => sum + (item.memory?.privateBytes ?? 0) / 1024,
        0,
      );
    return {
      report: path.basename(file),
      trial: record.trial ?? 1,
      durationMs: data.durationMs,
      ...record.scenario,
      status: record.status,
      error: record.error ?? null,
      coldMs: record.cold?.coldMs ?? null,
      rafFps: summary?.rafFps ?? null,
      outputFps: summary?.terminalMinFps ?? null,
      rafP95Ms: summary?.rafP95Ms ?? null,
      inputP95Ms: summary?.inputP95Ms ?? null,
      canvasMiB: summary?.canvasMiB ?? null,
      mirrorCanvasMiB: summary?.mirrorCanvasMiB ?? null,
      outputTextureMiB: summary?.outputTextureMiB ?? null,
      sourceCapturesPerSecond: summary
        ? (summary.dom.captures * 1000) / summary.elapsedMs
        : null,
      uploadMiBPerSecond: summary
        ? ((summary.runtime.uploadBytes / 1048576) * 1000) / summary.elapsedMs
        : null,
      gpuSamples: summary?.runtime.gpuSamples ?? null,
      textJobsPerSecond: summary
        ? (summary.runtime.textJobs * 1000) / summary.elapsedMs
        : null,
      textResultsPerSecond: summary
        ? (summary.runtime.textResults * 1000) / summary.elapsedMs
        : null,
      styleMs: summary?.dom.styleMs ?? null,
      drawSubmitMs: summary?.runtime.drawMs ?? null,
      videoFrames: summary?.videoFrames ?? null,
      videoDrops: summary?.videoDrops ?? null,
      longTaskMs: summary?.longTaskMs ?? null,
      jsHeapMiB: metrics.JSHeapUsedSize
        ? metrics.JSHeapUsedSize / 1048576
        : null,
      taskMs:
        metrics.TaskDuration !== undefined
          ? (metrics.TaskDuration - previous.TaskDuration) * 1000
          : null,
      processPrivateMiBBefore: record.processesBefore
        ? privateMiB(record.processesBefore)
        : null,
      processPrivateMiBAfter: record.processesAfter
        ? privateMiB(record.processesAfter)
        : null,
      settledErrors: record.settled?.errors ?? null,
      unchanged: record.settled?.unchanged ?? null,
      traceCosts: record.traceThreadCosts ?? null,
    };
  }),
);
const groups = [...new Set(rows.map((row) => row.id))].map((id) => {
  const candidates = rows.filter((row) => row.id === id);
  const bestDuration = Math.max(...candidates.map((row) => row.durationMs));
  const trials = candidates.filter((row) => row.durationMs === bestDuration);
  const values = trials
    .filter((row) => row.status === "ok")
    .map((row) => row.outputFps)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  return {
    id,
    trials: trials.length,
    successful: trials.filter((row) => row.status === "ok").length,
    outputMedianFps: values.length
      ? values[Math.floor(values.length / 2)]
      : null,
    outputMinFps: values.length ? values[0] : null,
    outputMaxFps: values.length ? values.at(-1) : null,
  };
});
const destination = path.resolve("docs/benchmarks/mixed-effects-2026-10-12");
await mkdir(destination, { recursive: true });
await writeFile(
  path.join(destination, "results.json"),
  JSON.stringify(
    {
      sourceDigest: first.sourceDigest,
      fixtureVersion: first.fixtureVersion,
      machine: first.machine,
      renderer: first.renderer,
      electron: first.electron,
      inputs: reports.map(({ file }) => path.basename(file)),
      units: {
        canvasMiB:
          "Logical RGBA8 canvas bitmaps, including every DOM mirror; excludes GL input textures, drawing buffers, driver copies, decoded media and managed image caches",
        outputTextureMiB:
          "Additional logical RGBA8 FBO output textures in GPU prototype; not VRAM residency",
        processPrivateMiB:
          "Electron process private bytes sampled before/after, not GPU VRAM or peak memory",
        outputFps:
          "Minimum publication rate among terminal shaders, not unique source/video frames",
        sourceCapturesPerSecond:
          "Total captures across all stages, not per-source freshness",
        taskMs:
          "CDP renderer task duration delta; trace times are inclusive and may overlap",
      },
      groups,
      rows,
    },
    null,
    2,
  ) + "\n",
);
const columns = [
  "id",
  "report",
  "trial",
  "durationMs",
  "status",
  "rafFps",
  "outputFps",
  "inputP95Ms",
  "canvasMiB",
  "mirrorCanvasMiB",
  "outputTextureMiB",
  "sourceCapturesPerSecond",
  "uploadMiBPerSecond",
  "videoFrames",
  "videoDrops",
  "processPrivateMiBAfter",
  "error",
];
const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
await writeFile(
  path.join(destination, "results.csv"),
  columns.join(",") +
    "\n" +
    rows
      .map((row) => columns.map((column) => quote(row[column])).join(","))
      .join("\n") +
    "\n",
);
console.log(
  JSON.stringify({
    destination,
    rows: rows.length,
    scenarios: groups.length,
    statuses: rows.reduce((counts, row) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      return counts;
    }, {}),
  }),
);
