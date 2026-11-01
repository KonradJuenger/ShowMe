import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { open, type Entry, type ZipFile } from "yauzl";

const LIMITS = {
  archive: 8 * 1024 ** 3,
  entries: 10000,
  entry: 4 * 1024 ** 3,
  total: 16 * 1024 ** 3,
  xml: 8 * 1024 ** 2,
};

/** A file-backed archive: the directory is indexed once and entries are streamed on demand. */
export async function openPowerPointArchive(file: string) {
  if ((await fs.stat(file)).size > LIMITS.archive)
    throw new Error("PowerPoint archive exceeds size limit");
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    open(
      file,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, value) => (error ? reject(error) : resolve(value!)),
    ),
  );
  const entries = new Map<string, Entry>();
  try {
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      let count = 0;
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        const name = entry.fileName;
        if (++count > LIMITS.entries) {
          reject(new Error("PowerPoint archive entry count exceeds limit"));
          return;
        }
        if (/\/$/.test(name)) {
          zip.readEntry();
          return;
        }
        if (
          !name ||
          name.length > 4096 ||
          name.startsWith("/") ||
          name.includes("\\") ||
          name
            .split("/")
            .some((part) => !part || part === "." || part === "..") ||
          entries.has(name)
        ) {
          reject(new Error("PowerPoint archive directory is invalid"));
          return;
        }
        total += entry.uncompressedSize;
        if (
          entries.size >= LIMITS.entries ||
          entry.uncompressedSize > LIMITS.entry ||
          total > LIMITS.total ||
          entry.isEncrypted() ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          reject(
            new Error("PowerPoint archive exceeds supported resource limits"),
          );
          return;
        }
        entries.set(name, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    const folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "showme-powerpoint-"),
    );
    let sequence = 0;
    async function extract(name: string, maximum: number) {
      const entry = entries.get(name);
      if (!entry) throw new Error("PowerPoint entry is missing");
      if (entry.uncompressedSize > maximum)
        throw new Error("PowerPoint entry exceeds size limit");
      const source = await new Promise<NodeJS.ReadableStream>(
        (resolve, reject) =>
          zip.openReadStream(entry, (error, stream) =>
            error ? reject(error) : resolve(stream!),
          ),
      );
      const destination = path.join(folder, String(sequence++));
      let bytes = 0;
      let checksum = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          checksum = crc32(chunk, checksum);
          callback(
            bytes > maximum || bytes > entry.uncompressedSize
              ? new Error("PowerPoint expansion exceeds size limit")
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          source,
          guard,
          createWriteStream(destination, { flags: "wx" }),
        );
        if (bytes !== entry.uncompressedSize)
          throw new Error("PowerPoint entry has an invalid size");
        if (checksum !== entry.crc32)
          throw new Error("PowerPoint entry failed integrity verification");
        return destination;
      } catch (error) {
        await fs.rm(destination, { force: true });
        throw error;
      }
    }
    return {
      names: [...entries.keys()],
      async readXml(name: string) {
        const extracted = await extract(name, LIMITS.xml);
        try {
          return await fs.readFile(extracted, "utf8");
        } finally {
          await fs.rm(extracted, { force: true });
        }
      },
      extractMedia: (name: string) => extract(name, LIMITS.entry),
      async dispose() {
        zip.close();
        await fs.rm(folder, { recursive: true, force: true });
      },
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}
