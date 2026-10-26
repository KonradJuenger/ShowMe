import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(
  process.argv[2] ?? ".benchmark-data/renderer/bounded-context-study.json",
);
const git = (...args) =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
if (git("status", "--porcelain"))
  throw new Error("Use a clean candidate checkout");
const revision = git("rev-parse", "HEAD");
const server = await createServer({
  server: { host: "127.0.0.1", port: 5185, strictPort: true },
});
await server.listen();
const rows = [];
try {
  for (let run = 0; run < 3; run++)
    for (const count of [16, 24, 32])
      for (const preserve of [false, true]) {
        const browser = await chromium.launch({
          args: ["--enable-blink-features=CanvasDrawElement"],
        });
        try {
          const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
          });
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Performance.enable");
          const metrics = {};
          await page.exposeFunction("measureStudy", async (phase) => {
            metrics[phase] = (await cdp.send("Performance.getMetrics")).metrics;
          });
          await page.goto(
            "http://127.0.0.1:5185/tests/helpers/effects-harness.html",
          );
          const result = await page.evaluate(
            async ({ count, preserve }) => {
              const { runShaderContextStudy } =
                await import("/tests/helpers/renderingWorkloadHarness.tsx");
              return runShaderContextStudy(count, preserve, (phase) =>
                window.measureStudy(phase),
              );
            },
            { count, preserve },
          );
          if (
            result.contextCount !== 1 ||
            result.chainCount !== count ||
            result.paintedOutputs !== count ||
            result.errors.length ||
            result.contextsAfterDispose !== 0 ||
            result.preserveDrawingBuffer !== preserve
          )
            throw new Error(
              `Capacity/preservation failed: ${JSON.stringify(result)}`,
            );
          const metric = (phase, name) =>
            metrics[phase].find((m) => m.name === name)?.value ?? 0;
          const row = {
            run,
            count,
            preserve,
            browser: browser.version(),
            ...result,
            taskCpuMs:
              1000 *
              (metric("end", "TaskDuration") - metric("start", "TaskDuration")),
          };
          rows.push(row);
          console.log(
            JSON.stringify({
              run,
              count,
              preserve,
              active: result.contextCount,
              painted: result.paintedOutputs,
              taskCpuMs: row.taskCpuMs,
            }),
          );
        } finally {
          await browser.close();
        }
      }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        revision,
        dirty: false,
        mode: "headless Chromium; serial alternating preserve false/true; three repetitions",
        rows,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await server.close();
}
