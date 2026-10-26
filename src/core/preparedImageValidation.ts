import { validPng } from "./pngValidation";
import type { PreparedImageMime } from "./presentationImages";

/** Check JPEG framing, dimensions and complete entropy segments before reuse. */
export function validJpeg(bytes: Uint8Array, width: number, height: number) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2,
    frame = false,
    scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (
        length < 8 ||
        view.getUint16(offset + 3) !== height ||
        view.getUint16(offset + 5) !== width
      )
        return false;
      frame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) return false;
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
    }
  }
  return false;
}

export function validPreparedImage(
  bytes: Uint8Array,
  width: number,
  height: number,
  mime: PreparedImageMime,
) {
  return mime === "image/jpeg"
    ? validJpeg(bytes, width, height)
    : validPng(bytes, width, height);
}
