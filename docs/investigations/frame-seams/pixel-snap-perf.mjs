import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { snapRect } from "./pixel-snap-math.mjs";
import { performance } from "node:perf_hooks";
import os from "node:os";
const out = "test-results-pixel-snap";
await mkdir(out, { recursive: true });
const quantile = (a, p) =>
  [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * p)];
const math = [];
for (const count of [100, 1000, 10000]) {
  const rects = Array.from({ length: count }, (_, i) => ({
    x: (i % 100) * 17.3,
    y: Math.floor(i / 100) * 11.7,
    width: 17.3,
    height: 11.7,
  }));
  const view = {
    originX: 10.375,
    originY: 16.25,
    scaleX: 0.67,
    scaleY: 0.67,
    dpr: 1.25,
  };
  let checksum = 0;
  for (let warm = 0; warm < 30; warm++)
    for (const r of rects) checksum += snapRect(r, view).width;
  const samples = [];
  for (let b = 0; b < 100; b++) {
    const start = performance.now();
    for (let repeat = 0; repeat < 10; repeat++)
      for (const r of rects)
        checksum += snapRect(r, { ...view, originX: 10.375 + b * 0.037 }).width;
    samples.push((performance.now() - start) / 10);
  }
  math.push({
    count,
    medianMs: quantile(samples, 0.5),
    p95Ms: quantile(samples, 0.95),
    checksum,
  });
}
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 1.25,
});
await page.goto("http://127.0.0.1:5187");
await page.evaluate(async () => {
  const { snapRect } =
    await import("/docs/investigations/frame-seams/pixel-snap-math.mjs");
  document.body.replaceChildren();
  document.body.style.cssText = "margin:0;background:white";
  window.benchmark = async (count, mode, scenario) => {
    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;left:16.375px;top:16.25px;width:1800px;height:1200px;transform:scale(.67);transform-origin:top left";
    const cols = Math.ceil(Math.sqrt(count * 1.5)),
      rows = Math.ceil(count / cols),
      w = 1500 / cols,
      h = 1000 / rows;
    const rects = Array.from({ length: count }, (_, i) => ({
      x: (i % cols) * w,
      y: Math.floor(i / cols) * h,
      width: w,
      height: h,
    }));
    const elements = rects.map((r) => {
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;background:#336699;opacity:.5;left:" +
        r.x +
        "px;top:" +
        r.y +
        "px;width:" +
        r.width +
        "px;height:" +
        r.height +
        "px";
      host.append(el);
      return el;
    });
    document.body.replaceChildren(host);
    host.getBoundingClientRect();
    if (mode === "device") {
      const k = 0.67 * devicePixelRatio;
      Object.assign(host.style, {
        left: "0px",
        top: "0px",
        width: 1800 * k + "px",
        height: 1200 * k + "px",
      });
      const ox = Math.round(16.375 * devicePixelRatio),
        oy = Math.round(16.25 * devicePixelRatio);
      host.style.transform =
        "matrix(" +
        1 / devicePixelRatio +
        ",0,0," +
        1 / devicePixelRatio +
        "," +
        ox / devicePixelRatio +
        "," +
        oy / devicePixelRatio +
        ")";
      rects.forEach((r, i) => {
        const l = Math.round((16.375 + r.x * 0.67) * devicePixelRatio),
          t = Math.round((16.25 + r.y * 0.67) * devicePixelRatio),
          rr = Math.round((16.375 + (r.x + r.width) * 0.67) * devicePixelRatio),
          b = Math.round((16.25 + (r.y + r.height) * 0.67) * devicePixelRatio);
        Object.assign(elements[i].style, {
          left: l - ox + "px",
          top: t - oy + "px",
          width: rr - l + "px",
          height: b - t + "px",
        });
      });
    }
    const task = [],
      layout = [],
      frames = [];
    let previous = 0;
    for (let iteration = 0; iteration < 110; iteration++) {
      const now = await new Promise((r) => requestAnimationFrame(r));
      if (iteration >= 20) frames.push(now - previous);
      previous = now;
      const pan = (iteration % 30) * 0.137;
      const start = performance.now();
      if (scenario === "pan" && mode !== "device")
        host.style.left = 16.375 + pan + "px";
      const view = {
        originX: 16.375 + (scenario === "pan" ? pan : 0),
        originY: 16.25,
        scaleX: 0.67,
        scaleY: 0.67,
        dpr: devicePixelRatio,
      };
      if (mode === "device")
        host.style.transform =
          "matrix(" +
          1 / devicePixelRatio +
          ",0,0," +
          1 / devicePixelRatio +
          "," +
          Math.round(view.originX * devicePixelRatio) / devicePixelRatio +
          "," +
          Math.round(view.originY * devicePixelRatio) / devicePixelRatio +
          ")";
      const indices =
        scenario === "pan"
          ? mode === "snap" || mode === "device"
            ? rects.keys()
            : []
          : [iteration % count];
      for (const i of indices) {
        const input =
          scenario === "edit" ? { ...rects[i], x: rects[i].x + pan } : rects[i];
        const r = mode === "snap" ? snapRect(input, view) : input;
        if (mode !== "device")
          Object.assign(elements[i].style, {
            left: r.x + "px",
            top: r.y + "px",
            width: r.width + "px",
            height: r.height + "px",
          });
        if (mode === "device") {
          const ox = Math.round(view.originX * devicePixelRatio),
            oy = Math.round(view.originY * devicePixelRatio);
          const l = Math.round(
              (view.originX + input.x * 0.67) * devicePixelRatio,
            ),
            t = Math.round((view.originY + input.y * 0.67) * devicePixelRatio),
            rr = Math.round(
              (view.originX + (input.x + input.width) * 0.67) *
                devicePixelRatio,
            ),
            b = Math.round(
              (view.originY + (input.y + input.height) * 0.67) *
                devicePixelRatio,
            );
          Object.assign(elements[i].style, {
            left: l - ox + "px",
            top: t - oy + "px",
            width: rr - l + "px",
            height: b - t + "px",
          });
        }
      }
      const written = performance.now();
      host.getBoundingClientRect();
      elements.at(-1).getBoundingClientRect();
      const laidOut = performance.now();
      if (iteration >= 20) {
        task.push(written - start);
        layout.push(laidOut - written);
      }
    }
    const q = (a, p) =>
      a.slice().sort((a, b) => a - b)[Math.floor((a.length - 1) * p)];
    return {
      count,
      mode,
      scenario,
      jsMedianMs: q(task, 0.5),
      jsP95Ms: q(task, 0.95),
      layoutMedianMs: q(layout, 0.5),
      layoutP95Ms: q(layout, 0.95),
      frameMedianMs: q(frames, 0.5),
      frameP95Ms: q(frames, 0.95),
      framesOver25Ms: frames.filter((v) => v > 25).length,
      samples: frames.length,
    };
  };
});
const dom = [];
try {
  // Alternate order across repetitions to reduce warm-cache/order bias.
  for (let repeat = 0; repeat < 3; repeat++)
    for (const count of [100, 1000, 5000])
      for (const scenario of ["pan", "edit"])
        for (const mode of repeat % 2
          ? ["device", "snap", "baseline"]
          : ["baseline", "snap", "device"]) {
          const result = await page.evaluate(
            ({ count, scenario, mode }) =>
              window.benchmark(count, mode, scenario),
            { count, scenario, mode },
          );
          dom.push({ repeat, ...result });
          console.log(JSON.stringify({ repeat, ...result }));
        }
} finally {
  await browser.close();
}
const metadata = {
  browserVersion: browser.version(),
  node: process.version,
  cpu: os.cpus()[0].model,
  logicalCpus: os.cpus().length,
  dpr: 1.25,
  headless: true,
  productionRenderer: false,
};
await writeFile(
  `${out}/performance.json`,
  JSON.stringify({ metadata, math, dom }, null, 2),
);
console.log(JSON.stringify({ metadata, math }, null, 2));
