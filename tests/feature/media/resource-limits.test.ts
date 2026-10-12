import { expect, it } from "vitest";
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
