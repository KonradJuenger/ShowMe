import type JSZip from "jszip";

export const POWERPOINT_LIMITS = {
  archiveBytes: 256 * 1024 ** 2,
  entries: 10000,
  entryBytes: 64 * 1024 ** 2,
  totalBytes: 512 * 1024 ** 2,
  xmlBytes: 8 * 1024 ** 2,
  xmlNodes: 100000,
};

/** Bound central-directory work before JSZip allocates its entry objects. */
export function assertPowerPointArchiveBounds(buffer: ArrayBuffer) {
  if (buffer.byteLength > POWERPOINT_LIMITS.archiveBytes)
    throw new Error("PowerPoint archive exceeds size limit");
  const view = new DataView(buffer);
  let end = -1;
  for (
    let offset = buffer.byteLength - 22;
    offset >= Math.max(0, buffer.byteLength - 65557);
    offset--
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === buffer.byteLength
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("PowerPoint archive directory is missing");
  const count = view.getUint16(end + 10, true);
  if (count > POWERPOINT_LIMITS.entries)
    throw new Error("PowerPoint archive entry count exceeds limit");
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const stop = offset + size;
  if (stop > end) throw new Error("PowerPoint archive directory is invalid");
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > stop || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("PowerPoint archive directory is invalid");
    const bytes = view.getUint32(offset + 24, true);
    total += bytes;
    if (
      bytes > POWERPOINT_LIMITS.entryBytes ||
      total > POWERPOINT_LIMITS.totalBytes
    )
      throw new Error("PowerPoint expansion exceeds size limit");
    const nameBytes = view.getUint16(offset + 28, true);
    if (nameBytes > 4096)
      throw new Error("PowerPoint entry name exceeds size limit");
    offset +=
      46 +
      nameBytes +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (offset > stop)
      throw new Error("PowerPoint archive directory is invalid");
  }
  if (offset !== stop)
    throw new Error("PowerPoint archive directory is invalid");
}

export function assertPowerPointXmlBounds(value: string) {
  if (
    value.length > POWERPOINT_LIMITS.xmlBytes ||
    /<!DOCTYPE|<!ENTITY/i.test(value)
  )
    throw new Error("PowerPoint XML exceeds supported resource limits");
  let nodes = 0;
  for (let index = 0; index < value.length; index++)
    if (value[index] === "<" && ++nodes > POWERPOINT_LIMITS.xmlNodes)
      throw new Error("PowerPoint XML work exceeds limit");
}

interface EntryStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): EntryStream;
  on(event: "error", callback: (error: Error) => void): EntryStream;
  on(event: "end", callback: () => void): EntryStream;
  pause(): void;
  resume(): void;
}
const budgets = new WeakMap<JSZip, { bytes: number }>();
export async function readPowerPointEntry(
  zip: JSZip,
  entry: JSZip.JSZipObject,
  maximum = POWERPOINT_LIMITS.entryBytes,
) {
  // JSZip documents internalStream, but its bundled declarations omit it.
  const stream = (
    entry as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): EntryStream;
    }
  ).internalStream("uint8array");
  const budget = budgets.get(zip) ?? { bytes: 0 };
  budgets.set(zip, budget);
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let failed = false;
    stream
      .on("data", (chunk) => {
        if (failed) return;
        bytes += chunk.length;
        budget.bytes += chunk.length;
        if (bytes > maximum || budget.bytes > POWERPOINT_LIMITS.totalBytes) {
          failed = true;
          stream.pause();
          chunks.length = 0;
          reject(new Error("PowerPoint expansion exceeds size limit"));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", reject)
      .on("end", () => {
        if (failed) return;
        const result = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      });
    stream.resume();
  });
}
