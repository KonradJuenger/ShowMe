import { expect, it, vi } from "vitest";
import JSZip from "jszip";
import sharp from "sharp";
import path from "node:path";
import { writeFile, open } from "node:fs/promises";
import { saveResolvedFontToLibrary } from "../../../electron/fontLibrary";
import {
  assertPowerPointArchiveBounds,
  assertPowerPointXmlBounds,
  POWERPOINT_LIMITS,
  readPowerPointEntry,
} from "../../../src/core/powerpointResources";
import { createTextEffectRunner } from "../../../src/components/textEffectRunner";
import { processPresentationImage } from "../../../electron/imageProcessor";
import { digest } from "../../../electron/storage/io";
import { storedDocument } from "../../helpers/storage";

it("rejects oversized font files before loading them into memory", async () => {
  const { root } = await storedDocument();
  const filePath = path.join(root, "large.ttf");
  const file = await open(filePath, "wx");
  try {
    await file.truncate(32 * 1024 ** 2 + 1);
  } finally {
    await file.close();
  }
  await expect(
    saveResolvedFontToLibrary(path.join(root, "fonts"), {
      family: "Large",
      weight: 400,
      italic: false,
      filePath,
    }),
  ).rejects.toThrow("size limit");
});

it("bounds PowerPoint declared expansion, actual streamed expansion and XML work", async () => {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", "x".repeat(8192));
  const bytes = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  expect(() => assertPowerPointArchiveBounds(bytes)).not.toThrow();
  const loaded = await JSZip.loadAsync(bytes);
  await expect(
    readPowerPointEntry(loaded, loaded.file("ppt/presentation.xml")!, 4096),
  ).rejects.toThrow("expansion");
  const changed = bytes.slice(0);
  const view = new DataView(changed);
  for (let offset = 0; offset + 46 <= changed.byteLength; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, POWERPOINT_LIMITS.entryBytes + 1, true);
      break;
    }
  }
  expect(() => assertPowerPointArchiveBounds(changed)).toThrow("expansion");
  expect(() => assertPowerPointXmlBounds("<!DOCTYPE x><x/>")).toThrow(
    "resource limits",
  );
  expect(() =>
    assertPowerPointXmlBounds("<x/>".repeat(POWERPOINT_LIMITS.xmlNodes + 1)),
  ).toThrow("work");
});

it("rejects excessive image pixels before raster processing and effect source before worker creation", async () => {
  const { root } = await storedDocument();
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  bytes.writeUInt32BE(100000, 16);
  bytes.writeUInt32BE(100000, 20);
  const source = path.join(root, "oversized.png");
  await writeFile(source, bytes);
  await expect(
    processPresentationImage(
      source,
      digest(bytes),
      256,
      path.join(root, "output.png"),
    ),
  ).rejects.toThrow(/pixel limit/);
  expect(() => createTextEffectRunner("x".repeat(100001))).toThrow(
    "source exceeds",
  );
});

it("text worker dispatch latency does not consume its execution budget and failures retain their cause", async () => {
  class ControlledWorker {
    static instance: ControlledWorker;
    onmessage?: (event: { data: Record<string, unknown> }) => void;
    onerror?: (event: ErrorEvent) => void;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { ControlledWorker.instance = this; }
  }
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ControlledWorker);
  const runner = createTextEffectRunner("function render({text}) { return text; }");
  const worker = ControlledWorker.instance;
  const input = { text: "Hello", t: 0, p: 0, duration: 1, parameters: {} };
  try {
    worker!.onmessage!({ data: { ready: true } });
    const first = runner.render(input);
    const firstId = worker!.postMessage.mock.calls[0][0].id;
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker!.terminate).not.toHaveBeenCalled();
    worker!.onmessage!({ data: { started: firstId } });
    await vi.advanceTimersByTimeAsync(400);
    worker!.onmessage!({ data: { id: firstId, text: "Hello" } });
    await expect(first).resolves.toBe("Hello");

    const second = runner.render(input);
    const rejection = expect(second).rejects.toThrow("execution budget");
    const secondId = worker!.postMessage.mock.calls[1][0].id;
    worker!.onmessage!({ data: { started: secondId } });
    await vi.advanceTimersByTimeAsync(400);
    // A duplicate acknowledgment cannot extend the execution deadline.
    worker!.onmessage!({ data: { started: secondId } });
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(worker!.terminate).toHaveBeenCalledTimes(1);
    await expect(runner.render(input)).rejects.toThrow("execution budget");
  } finally {
    runner.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
