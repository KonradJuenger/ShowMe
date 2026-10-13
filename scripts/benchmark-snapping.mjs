import { build } from "esbuild";
import { performance } from "node:perf_hooks";

const bundled = await build({
  stdin: {
    contents:
      'export * from "./src/core/dragSnapping.ts"; export * from "./src/core/snapping.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { createDragSnapAxis, defaultDragSnapSettings, resolveSnapAxis } =
  await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );

// Isolate solver costs: legacy scene target rebuilding is deliberately excluded.
// Timings are observations, never CI pass/fail thresholds.
const results = [];
for (const count of [100, 1000, 10000]) {
  const targets = { objects: Array.from({ length: count }, (_, i) => i * 30) };
  for (const mode of ["classic", "magnetic", "intent"]) {
    const prepareStart = performance.now();
    const axis = createDragSnapAxis(47, targets, 1, {
      ...defaultDragSnapSettings,
      mode,
    });
    const prepareMs = performance.now() - prepareStart;
    const query =
      mode === "classic"
        ? (position) => resolveSnapAxis(position, 47, targets, 8).value
        : (position) => axis.resolve(position, 200).value;
    let checksum = 0;
    for (let i = 0; i < 1000; i++) query(((i * 13.37) % (count * 30)) + 0.25);
    axis.reset();
    const timings = [];
    for (let batch = 0; batch < 100; batch++) {
      const start = performance.now();
      for (let i = 0; i < 100; i++)
        checksum += query((((batch * 100 + i) * 13.37) % (count * 30)) + 0.25);
      timings.push(((performance.now() - start) * 1000) / 100);
    }
    timings.sort((a, b) => a - b);
    results.push({
      targets: count,
      mode,
      prepareMs: mode === "classic" ? "—" : prepareMs.toFixed(3),
      queryMedianMicroseconds: timings[50].toFixed(3),
      queryP95Microseconds: timings[95].toFixed(3),
      checksum: Math.round(checksum),
    });
  }
}
console.table(results);
