import { snapRect } from "./pixel-snap-math.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const out = "test-results-pixel-snap";
await mkdir(out, { recursive: true });
let maxEdge = 0,
  maxSize = 0,
  maxJoin = 0;
const collapse = [];
for (const width of [0.25, 0.5, 1, 2, 5, 10, 120]) {
  let total = 0,
    zero = 0;
  for (const scale of [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2])
    for (const dpr of [1, 1.25, 1.5, 2])
      for (let p = 0; p < 100; p++) {
        const view = {
          originX: 0,
          originY: 0,
          scaleX: scale,
          scaleY: scale,
          dpr,
        };
        const r = { x: p / 100 / (scale * dpr), y: 0, width, height: 32 };
        const s = snapRect(r, view),
          next = snapRect({ ...r, x: r.x + width }, view),
          f = scale * dpr;
        maxEdge = Math.max(
          maxEdge,
          Math.abs((s.x - r.x) * f),
          Math.abs((s.x + s.width - r.x - r.width) * f),
        );
        maxSize = Math.max(maxSize, Math.abs((s.width - width) * f));
        maxJoin = Math.max(maxJoin, Math.abs(s.x + s.width - next.x) * f);
        total++;
        if (s.width === 0) zero++;
      }
  collapse.push({ width, total, collapsed: zero });
}
const summary = {
  cases: collapse.reduce((n, r) => n + r.total, 0),
  maxEdge,
  maxSize,
  maxJoin,
  collapse,
};
assert(maxEdge <= 0.5 + 1e-10);
assert(maxSize <= 1 + 1e-10);
assert(maxJoin < 1e-10);
await writeFile(`${out}/geometry.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
