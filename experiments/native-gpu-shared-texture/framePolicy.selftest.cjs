"use strict";

const assert = require("node:assert/strict");
const { BoundedLatestFrameQueue } = require("./framePolicy.cjs");

const released = [];
const completions = [];
const queue = new BoundedLatestFrameQueue({
  maxActive: 2,
  release: (frame, reason) => released.push([frame.id, reason]),
  consume: (frame, done) => {
    completions.push([frame.id, done]);
  },
});

for (let id = 1; id <= 6; id++) queue.offer({ id });
assert.deepEqual(completions.map(([id]) => id), [1, 2]);
assert.deepEqual(released, [[3, "stale"], [4, "stale"], [5, "stale"]]);
assert.equal(queue.snapshot().maxRetained, 3);
assert.equal(queue.snapshot().pending, 1);

completions[0][1]();
assert.deepEqual(completions.map(([id]) => id), [1, 2, 6]);
assert.equal(queue.snapshot().active, 2);
assert.equal(queue.snapshot().pending, 0);

queue.close();
queue.offer({ id: 7 });
assert.deepEqual(released.at(-1), [7, "closed"]);
completions[1][1]();
completions[2][1]();
assert.equal(queue.snapshot().active, 0);
assert.equal(queue.snapshot().retained, 0);
assert.equal(queue.snapshot().consumerErrors, 0);
console.log(JSON.stringify(queue.snapshot()));
