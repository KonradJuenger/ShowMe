const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

/** Verify disposable PNGs without an index or a sidecar checksum. */
export function validPng(bytes: Uint8Array, width: number, height: number) {
  if (
    bytes.length < 45 ||
    bytes.slice(0, 8).join(",") !== "137,80,78,71,13,10,26,10"
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) !== width || view.getUint32(20) !== height)
    return false;
  let offset = 8,
    pixels = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 8 + length;
    if (end + 4 > bytes.length) return false;
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
    }
    if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end)) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IDAT") pixels = true;
    if (type === "IEND")
      return pixels && length === 0 && end + 4 === bytes.length;
    offset = end + 4;
  }
  return false;
}
