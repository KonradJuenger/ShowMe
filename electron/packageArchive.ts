import { promises as fs, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { open, type ZipFile as ReadZip, type Entry } from "yauzl";

export const PACKAGE_LIMITS = {
  entries: 10000,
  entryBytes: 4 * 1024 ** 3,
  totalBytes: 16 * 1024 ** 3,
  metadataBytes: 32 * 1024 ** 2,
};
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function entryName(value: string) {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid package entry name");
  return value;
}
export type ZipEntryInput = { name: string } & (
  { data: string | Uint8Array; file?: never } | { file: string; data?: never }
);
export async function writeStoredZipFile(file: string, input: ZipEntryInput[]) {
  if (!input.length || input.length > PACKAGE_LIMITS.entries)
    throw new Error("Package entry count exceeds limit");
  const names = new Set<string>();
  let total = 0;
  for (const item of input) {
    const name = entryName(item.name);
    if (names.has(name)) throw new Error("Package has duplicate entries");
    names.add(name);
    const bytes =
      item.file !== undefined
        ? (await fs.stat(item.file)).size
        : Buffer.byteLength(item.data);
    total += bytes;
    if (bytes > PACKAGE_LIMITS.entryBytes || total > PACKAGE_LIMITS.totalBytes)
      throw new Error("Package bytes exceed limit");
  }
  const zip = new ZipFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const output = zip.outputStream as Readable;
  const writing = pipeline(output, createWriteStream(file, { flags: "wx" }));
  zip.on("error", (error) => output.destroy(error));
  try {
    for (const item of input) {
      if (item.file !== undefined)
        zip.addFile(item.file, item.name, { compress: false });
      else
        zip.addBuffer(Buffer.from(item.data), item.name, { compress: false });
    }
    zip.end();
    await writing;
    const handle = await fs.open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
    await writing.catch(() => undefined);
    await fs.rm(file, { force: true });
    throw error;
  }
}
export interface ArchiveEntry {
  file: string;
  bytes: number;
}
export async function readArchiveEntry(
  entry: ArchiveEntry,
  maximum = PACKAGE_LIMITS.metadataBytes,
) {
  if (entry.bytes > maximum)
    throw new Error("Package metadata exceeds size limit");
  return fs.readFile(entry.file);
}
export async function readStoredZipFile(file: string) {
  const zip = await new Promise<ReadZip>((resolve, reject) =>
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
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "showme-package-"));
  const entries = new Map<string, ArchiveEntry>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const name = entryName(entry.fileName);
          if (entries.has(name))
            throw new Error("Package has duplicate entries");
          if (
            entries.size >= PACKAGE_LIMITS.entries ||
            entry.uncompressedSize > PACKAGE_LIMITS.entryBytes ||
            (total += entry.uncompressedSize) > PACKAGE_LIMITS.totalBytes
          )
            throw new Error("Package resource limit exceeded");
          if (entry.compressionMethod !== 0 || entry.isEncrypted())
            throw new Error("Package uses unsupported ZIP features");
          const source = await new Promise<NodeJS.ReadableStream>(
            (resolveStream, rejectStream) =>
              zip.openReadStream(entry, (error, stream) =>
                error ? rejectStream(error) : resolveStream(stream!),
              ),
          );
          let crc = 0xffffffff;
          let bytes = 0;
          const verify = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > entry.uncompressedSize) {
                callback(new Error("Package entry exceeds declared size"));
                return;
              }
              for (const byte of chunk)
                crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
              callback(null, chunk);
            },
          });
          const destination = path.join(folder, String(entries.size));
          await pipeline(
            source,
            verify,
            createWriteStream(destination, { flags: "wx" }),
          );
          if (
            bytes !== entry.uncompressedSize ||
            (crc ^ 0xffffffff) >>> 0 !== entry.crc32
          )
            throw new Error("Package entry failed integrity verification");
          entries.set(name, { file: destination, bytes });
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    if (!entries.size) throw new Error("Package contains no entries");
    return {
      entries,
      dispose: () => fs.rm(folder, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
  }
}
