"use strict";

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

function intervalSummary(timestamps) {
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]);
  return {
    samples: intervals.length,
    p50Ms: percentile(intervals, 0.5),
    p95Ms: percentile(intervals, 0.95),
    maxMs: intervals.length ? Math.max(...intervals) : null,
    over33Ms: intervals.filter((value) => value > 33.34).length,
  };
}

function valueSummary(values) {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function rate(count, startedAt, endedAt) {
  const seconds = Math.max(0.001, (endedAt - startedAt) / 1000);
  return count / seconds;
}

module.exports = { intervalSummary, valueSummary, rate };
