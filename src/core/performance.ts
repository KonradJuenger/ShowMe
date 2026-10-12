export interface PerformanceSample {
  name: string;
  durationMs: number;
  startTime: number;
}

export const performanceEnabled = () =>
  typeof process !== "undefined" && process.env.SHOWME_PERF === "1" ||
  typeof window !== "undefined" && window.location.search.includes("showmePerf=1");

const samples: PerformanceSample[] = [];
if (performanceEnabled())
  (globalThis as typeof globalThis & { __showmePerformance?: () => PerformanceSample[] })
    .__showmePerformance = () => [...samples];

export function measurePerformance<T>(name: string, operation: () => T): T {
  if (!performanceEnabled()) return operation();
  const start = performance.now();
  const finish = () => {
    recordPerformance(name, start, performance.now() - start);
  };
  try {
    const result = operation();
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

export function recordPerformance(name: string, startTime: number, durationMs: number) {
  if (!performanceEnabled()) return;
  samples.push({ name, durationMs, startTime });
  if (samples.length > 5000) samples.shift();
  performance.measure(`showme.${name}`, { start: startTime, duration: durationMs });
}

export function performanceSamples() {
  return [...samples];
}

export function clearPerformanceSamples() {
  samples.length = 0;
}
