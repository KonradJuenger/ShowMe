/** Parse container structure, rather than looking for marker bytes in pixel data. */
export function animatedRaster(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(at, at + length));
  if (bytes[0] === 137 && text(1, 3) === "PNG") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (text(offset + 4, 4) === "acTL") return true;
      offset += length + 12;
    }
  }
  if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      if (text(offset, 4) === "ANIM") return true;
      offset += 8 + length + (length % 2);
    }
  }
  if (text(0, 3) === "GIF") {
    let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
    let frames = 0;
    const blocks = () => {
      while (offset < bytes.length) {
        const size = bytes[offset++];
        if (!size) return;
        offset += size;
      }
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        offset++;
        blocks();
      } else if (marker === 0x2c) {
        if (++frames > 1) return true;
        const packed = bytes[offset + 8];
        offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        offset++;
        blocks();
      } else break;
    }
  }
  return false;
}
