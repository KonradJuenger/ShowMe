import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// A concurrent instance may own any recovery journal in this profile. Leave
// startup recovery until all other instances have exited.
export class RunningInstances {
  private readonly directory: string;
  private readonly file: string;

  constructor(userData: string) {
    this.directory = path.join(userData, "running-instances");
    this.file = path.join(this.directory, `${process.pid}-${randomUUID()}.json`);
  }

  async register() {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
  }

  async hasOther() {
    for (const name of await fs.readdir(this.directory)) {
      const file = path.join(this.directory, name);
      if (!name.endsWith(".json") || file === this.file) continue;
      let pid: unknown;
      try {
        pid = JSON.parse(await fs.readFile(file, "utf8")).pid;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // An unreadable marker must not make live recovery appear abandoned.
        return true;
      }
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
      try {
        process.kill(pid as number, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        await fs.rm(file, { force: true });
      }
    }
    return false;
  }

  async dispose() {
    await fs.rm(this.file, { force: true });
  }
}
