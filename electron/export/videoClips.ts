import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { hashFile } from "../storage/io";
import type { HtmlAssetSource } from "./html";

/** One export owns these derived files; originals never enter this directory. */
export class TemporaryVideoClips {
  private directory: string | undefined;
  private readonly clips = new Map<string, HtmlAssetSource & { id: string }>();

  async prepare(
    assetId: string,
    source: HtmlAssetSource,
    start: number,
    end: number | null,
  ): Promise<HtmlAssetSource & { id: string }> {
    if (start === 0 && end === null) return { ...source, id: assetId };
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      (end !== null && !Number.isFinite(end))
    )
      throw new Error("Invalid video trim range for HTML export");
    const key = JSON.stringify([assetId, start, end]);
    const existing = this.clips.get(key);
    if (existing) return existing;
    if (!ffmpegPath)
      throw new Error("Video trimming is unavailable on this platform");
    // Executables cannot run inside Electron's asar archive.
    const executable = ffmpegPath.replace(/\.asar([\\/])/, ".asar.unpacked$1");
    this.directory ??= await fs.mkdtemp(
      path.join(os.tmpdir(), "showme-html-video-"),
    );
    const file = path.join(this.directory, `clip-${this.clips.size}.mp4`);
    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(start),
      "-i",
      source.file,
    ];
    if (end !== null) args.push("-t", String(Math.max(0.05, end - start)));
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-sn",
      "-dn",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-abort_on",
      "empty_output",
      file,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-8192);
      });
      child.once("error", (error) =>
        reject(new Error(`Could not start video trimming: ${error.message}`)),
      );
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Could not trim video for HTML export (${signal ?? code}): ${diagnostic.trim()}`,
            ),
          );
      });
    });
    const result = { id: await hashFile(file), file, mime: "video/mp4" };
    this.clips.set(key, result);
    return result;
  }

  async dispose() {
    if (this.directory) {
      // This is exactly the private directory returned by mkdtemp above.
      await fs.rm(this.directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
      this.directory = undefined;
    }
    this.clips.clear();
  }
}
