import { it, expect, vi } from "vitest";
import { promises as fs, type Stats } from "node:fs";
import { constants as bufferLimits } from "node:buffer";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { TemporaryVideoClips } from "../../../electron/export/videoClips";
import { createHtmlExport } from "../../../electron/export/html";
import { htmlExportFixture } from "../../helpers/htmlExportFixture";
import type { HtmlExportPayload } from "../../../src/export/html/types";

const original = path.resolve("tests/fixtures/media/native-motion.webm");
const source = { file: original, mime: "video/webm" };

function duration(file: string) {
  const result = spawnSync(
    ffmpeg!,
    [
      "-v",
      "error",
      "-i",
      file,
      "-progress",
      "pipe:1",
      "-nostats",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  // The fixture is 30 fps. Include the last frame's duration rather than
  // measuring only its presentation timestamp.
  return Number([...result.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)![1]) / 30;
}

function firstFrame(file: string, start: number) {
  const result = spawnSync(ffmpeg!, [
    "-v",
    "error",
    "-ss",
    String(start),
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
}

function frameDifference(a: Buffer, b: Buffer) {
  expect(a.length).toBe(b.length);
  return a.reduce((total, byte, index) => total + Math.abs(byte - b[index]), 0);
}

it("keeps untrimmed sources intact without creating a clip", async () => {
  const clips = new TemporaryVideoClips();
  try {
    expect(await clips.prepare("source", source, 0, null)).toEqual({
      ...source,
      id: "source",
    });
  } finally {
    await clips.dispose();
  }
});

it("cuts exact ranges, reuses identical clips and removes all derived files", async () => {
  const before = await fs.readFile(original);
  const clips = new TemporaryVideoClips();
  let directory = "";
  try {
    const first = await clips.prepare("source", source, 0.2, 0.6);
    directory = path.dirname(first.file);
    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.mime).toBe("video/mp4");
    expect(duration(first.file)).toBeCloseTo(0.4, 2);
    const frame = firstFrame(first.file, 0);
    expect(frameDifference(frame, firstFrame(original, 0.2))).toBeLessThan(
      frameDifference(frame, firstFrame(original, 0)),
    );
    expect(await clips.prepare("source", source, 0.2, 0.6)).toBe(first);
    const next = await clips.prepare("source", source, 0.7, null);
    expect(next.id).not.toBe(first.id);
    expect(duration(next.file)).toBeCloseTo(0.3, 2);
    expect(await fs.readdir(directory)).toHaveLength(2);
  } finally {
    await clips.dispose();
  }
  await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(original)).toEqual(before);
});

it("cleans partial work after a failed video conversion", async () => {
  const clips = new TemporaryVideoClips();
  let directory = "";
  try {
    const good = await clips.prepare("source", source, 0.1, 0.4);
    directory = path.dirname(good.file);
    await expect(
      clips.prepare(
        "missing",
        { file: path.join(directory, "missing.webm"), mime: "video/webm" },
        0.1,
        0.4,
      ),
    ).rejects.toThrow("Could not trim video");
  } finally {
    await clips.dispose();
  }
  await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "showme-clip-test-"),
  );
  await fs.writeFile(path.join(directory, "runtime.js"), "void 0;");
  const image = path.join(directory, "image.svg");
  await fs.writeFile(
    image,
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"/>',
  );
  const document = htmlExportFixture();
  return {
    directory,
    image,
    document,
    input: {
      document,
      runtimeDirectory: directory,
      runtimeVersion: "test",
      managedFonts: async () => [],
      resolveAsset: async (id: string) =>
        id === "video" ? source : { file: image, mime: "image/svg+xml" },
    },
  };
}

it("embeds cropped bytes and rebases only the exported snapshot before deleting temporary clips", async () => {
  const setup = await fixture();
  const before = structuredClone(setup.document);
  const rm = vi.spyOn(fs, "rm");
  try {
    const { html } = await createHtmlExport(setup.input);
    const json = html.match(
      /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
    )![1];
    const payload = JSON.parse(json) as HtmlExportPayload;
    const video = payload.document.slides[1].nodes[0].children.find(
      (e) => e.content?.type === "video",
    )!.content!;
    expect(video).toMatchObject({
      type: "video",
      startTime: 0,
      loop: true,
      mute: true,
    });
    expect((video as { endTime: number }).endTime).toBeCloseTo(0.7, 8);
    expect(video).not.toMatchObject({ assetId: "video" });
    const asset = payload.assets.find(
      (a) => a.id === (video as { assetId: string }).assetId,
    )!;
    expect(asset.mime).toBe("video/mp4");
    const copy = path.join(setup.directory, "embedded.mp4");
    await fs.writeFile(copy, Buffer.from(asset.data, "base64"));
    expect(duration(copy)).toBeCloseTo(0.7, 2);
    expect(setup.document).toEqual(before);
    const cleaned = rm.mock.calls
      .map(([file]) => String(file))
      .filter((file) => path.basename(file).startsWith("showme-html-video-"));
    expect(cleaned).toHaveLength(1);
    await expect(fs.access(cleaned[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    rm.mockRestore();
    await fs.rm(setup.directory, { recursive: true, force: true });
  }
});

it("deletes temporary clips if assembling the export subsequently fails", async () => {
  const setup = await fixture();
  const rm = vi.spyOn(fs, "rm");
  try {
    await expect(
      createHtmlExport({
        ...setup.input,
        resolveAsset: async (id) =>
          id === "video"
            ? source
            : {
                file: path.join(setup.directory, "missing.svg"),
                mime: "image/svg+xml",
              },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const cleaned = rm.mock.calls
      .map(([file]) => String(file))
      .filter((file) => path.basename(file).startsWith("showme-html-video-"));
    expect(cleaned).toHaveLength(1);
    await expect(fs.access(cleaned[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    rm.mockRestore();
    await fs.rm(setup.directory, { recursive: true, force: true });
  }
});

it("rejects an oversized payload before loading the offending asset into memory", async () => {
  const setup = await fixture();
  setup.document.slides[1].nodes[0].children =
    setup.document.slides[1].nodes[0].children.filter(
      (e) => e.content?.type !== "video",
    );
  const stat = vi
    .spyOn(fs, "stat")
    .mockResolvedValueOnce({ size: bufferLimits.MAX_STRING_LENGTH } as Stats);
  const read = vi.spyOn(fs, "readFile");
  try {
    await expect(createHtmlExport(setup.input)).rejects.toThrow(
      "too large to assemble safely",
    );
    expect(read.mock.calls.some(([file]) => file === setup.image)).toBe(false);
  } finally {
    stat.mockRestore();
    read.mockRestore();
    await fs.rm(setup.directory, { recursive: true, force: true });
  }
});
