/** One admission limit for background preparation and visible image requests. */
export class ImageWorkQueue {
  private active = 0;
  private bytes = 0;
  private waiting: Array<{ bytes: number; start: () => void }> = [];

  async run<T>(bytes: number, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.waiting.push({ bytes, start: resolve });
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

  private pump() {
    while (this.active < 2 && this.waiting.length) {
      const index = this.waiting.findIndex(
        (job) =>
          this.active === 0 || this.bytes + job.bytes <= 512 * 1024 * 1024,
      );
      if (index < 0) return;
      const [job] = this.waiting.splice(index, 1);
      this.active++;
      this.bytes += job.bytes;
      job.start();
    }
  }
}
