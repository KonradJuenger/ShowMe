import { expect, it } from "vitest";
import path from "node:path";
import { open, stat } from "node:fs/promises";
import {
  PACKAGE_LIMITS,
  readStoredZipFile,
  writeStoredZipFile,
} from "../../../electron/packageArchive";
import { hashFile } from "../../../electron/storage/io";
import { storedDocument } from "../../helpers/storage";

it("streams a generated 128 MiB media archive with verified cold extraction", async () => {
  const { root } = await storedDocument();
  const media = path.join(root, "large-video.mp4");
  const handle = await open(media, "wx");
  const chunk = Buffer.alloc(1024 ** 2, 0x5a);
  try {
    for (let index = 0; index < 128; index++) await handle.writeFile(chunk);
  } finally {
    await handle.close();
  }
  const file = path.join(root, "large.smp");
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  try {
    await writeStoredZipFile(file, [
      { name: "video/large.mp4", file: media },
      { name: "manifest.json", data: "{}" },
    ]);
    const archive = await readStoredZipFile(file);
    try {
      expect((await stat(file)).size).toBeGreaterThan(128 * 1024 ** 2);
      expect(await hashFile(archive.entries.get("video/large.mp4")!.file)).toBe(
        await hashFile(media),
      );
    } finally {
      await archive.dispose();
    }
  } finally {
    clearInterval(sample);
  }
  console.info(
    `128 MiB streaming package RSS: baseline=${baseline}, peak=${peak}, delta=${peak - baseline}`,
  );
});

it("rejects excessive archive entries and unsafe paths before writing", async () => {
  const { root } = await storedDocument();
  const file = path.join(root, "bounded.smp");
  await expect(
    writeStoredZipFile(
      file,
      Array.from({ length: PACKAGE_LIMITS.entries + 1 }, (_, index) => ({
        name: String(index),
        data: "",
      })),
    ),
  ).rejects.toThrow("count");
  await expect(
    writeStoredZipFile(file, [{ name: "../escape", data: "" }]),
  ).rejects.toThrow("entry name");
});

it("cold extraction rejects corrupted entry bytes", async () => {
  const { root } = await storedDocument();
  const file = path.join(root, "corrupt.smp");
  await writeStoredZipFile(file, [{ name: "media/data", data: "original" }]);
  const handle = await open(file, "r+");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, header.length, 0);
    await handle.write(
      Buffer.from("X"),
      0,
      1,
      30 + header.readUInt16LE(26) + header.readUInt16LE(28),
    );
  } finally {
    await handle.close();
  }
  await expect(readStoredZipFile(file)).rejects.toThrow(
    "integrity verification",
  );
});
