/** CPU-worker policy (browser); native Sharp admission separately respects libuv. */
export function imageWorkerConcurrency(logicalThreads: number | undefined): number {
  if (!logicalThreads || !Number.isFinite(logicalThreads) || logicalThreads < 1) return 2;
  const threads = Math.floor(logicalThreads);
  return Math.max(1, threads - Math.max(2, Math.ceil(threads / 4)));
}

/** One admission limit for background preparation and visible image requests. */
export class ImageWorkQueue {
  private active = 0;
  private bytes = 0;
  private waiting: Array<{
    bytes: number;
    start: () => void;
    priority: number;
    key?: string;
  }> = [];

  constructor(private readonly concurrency = 2) {}

  async run<T>(
    bytes: number,
    operation: () => Promise<T>,
    demand: { priority: number; key?: string } = { priority: 0 },
  ): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push({ bytes, start: resolve, ...demand });
      this.pump();
    });
    try {
      return await operation();
    } finally {
      this.active--;
      this.bytes -= bytes;
      this.pump();
    }
  }

  setPriorities(priorities: ReadonlyMap<string, number>) {
    for (const job of this.waiting) {
      const priority =
        job.key === undefined ? undefined : priorities.get(job.key);
      if (priority !== undefined) job.priority = priority;
    }
    this.pump();
  }

  private pump() {
    this.waiting.sort((a, b) => b.priority - a.priority);
    while (this.active < this.concurrency && this.waiting.length) {
      const priority = this.waiting[0].priority;
      const index = this.waiting.findIndex(
        (job) =>
          job.priority === priority &&
          (this.active === 0 || this.bytes + job.bytes <= 512 * 1024 * 1024),
      );
      if (index < 0) return;
      const [job] = this.waiting.splice(index, 1);
      this.active++;
      this.bytes += job.bytes;
      job.start();
    }
  }
}
