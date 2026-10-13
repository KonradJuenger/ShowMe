import { build } from "esbuild";
import { performance } from "node:perf_hooks";

const bundled = await build({
  stdin: {
    contents: 'export * from "./src/core/dragSnapping.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { createDragSnapAxis, defaultDragSnapSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

// Isolate solver costs: legacy scene target rebuilding is deliberately excluded.
// Timings are observations, never CI pass/fail thresholds.
const results = [];
for (const count of [100, 1000, 10000]) {
  for (const scenario of ["spread", "stacked"]) {
    const targets = {
      objects: Array.from({ length: count }, (_, i) =>
        scenario === "spread" ? i * 30 : 1000,
      ),
    };
    const features = targets.objects.map((position, index) => ({
      position,
      source: "objects",
      kind:
        scenario === "stacked"
          ? "start"
          : ["start", "center", "end"][index % 3],
      span:
        scenario === "spread"
          ? { start: 0, end: 100 }
          : { start: index * 100, end: index * 100 + 30 },
    }));
    {
      const prepareStart = performance.now();
      const axis = createDragSnapAxis(47, features, 1, defaultDragSnapSettings);
      const prepareMs = performance.now() - prepareStart;
      const query = (position, index) =>
        axis.resolve(position, 200, {
          start: scenario === "spread" ? 0 : ((index * 17) % count) * 100,
          end: scenario === "spread" ? 100 : ((index * 17) % count) * 100 + 30,
          pixelsPerUnit: 1,
        }).value;
      const positionAt = (index) =>
        scenario === "spread"
          ? ((index * 13.37) % (count * 30)) + 0.25
          : 1000.25;
      let checksum = 0;
      for (let i = 0; i < 1000; i++) query(positionAt(i), i);
      axis.reset();
      const timings = [];
      for (let batch = 0; batch < 100; batch++) {
        const start = performance.now();
        for (let i = 0; i < 100; i++)
          checksum += query(positionAt(batch * 100 + i), batch * 100 + i);
        timings.push(((performance.now() - start) * 1000) / 100);
      }
      timings.sort((a, b) => a - b);
      results.push({
        targets: count,
        scenario,
        prepareMs: prepareMs.toFixed(3),
        queryMedianMicroseconds: timings[50].toFixed(3),
        queryP95Microseconds: timings[95].toFixed(3),
        checksum: Math.round(checksum),
      });
    }
  }
}
console.table(results);
