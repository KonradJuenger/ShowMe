export const presentationSizePresets = [
  { name: "16:9", label: "Widescreen 16:9", width: 1920, height: 1080 },
  { name: "4:3", label: "Standard 4:3", width: 1440, height: 1080 },
  { name: "Portrait 9:16", label: "Portrait 9:16", width: 1080, height: 1920 },
  { name: "Portrait 3:4", label: "Portrait 3:4", width: 1080, height: 1440 },
] as const;

export interface CanvasDimensions {
  width: number;
  height: number;
}

export function sameAspectRatio(a: CanvasDimensions, b: CanvasDimensions) {
  const first = a.width / a.height,
    second = b.width / b.height;
  if (![first, second].every((value) => Number.isFinite(value) && value > 0))
    return false;
  return Math.abs(first - second) <= 1e-10 * Math.max(first, second);
}

export function presentationFormat(size: CanvasDimensions) {
  return presentationSizePresets.find((preset) =>
    sameAspectRatio(size, preset),
  );
}

/** Preserve the document's unit convention; selecting its current ratio is a no-op. */
export function dimensionsForAspectRatio(
  current: CanvasDimensions,
  requested: CanvasDimensions,
): CanvasDimensions {
  if (
    ![current.width, current.height, requested.width, requested.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error("Aspect ratio dimensions must be positive and finite");
  if (sameAspectRatio(current, requested)) return current;
  const shortSide = Math.min(current.width, current.height);
  const ratio = requested.width / requested.height;
  const next =
    ratio >= 1
      ? { width: shortSide * ratio, height: shortSide }
      : { width: shortSide, height: shortSide / ratio };
  if (
    ![next.width, next.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error("Aspect ratio produces invalid canvas dimensions");
  return next;
}

/** PowerPoint stores physical page sizes in English Metric Units; use 96 px/in. */
export function powerPointCanvasSize(cx: number, cy: number) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0)
    throw new Error("PowerPoint file has invalid slide dimensions");
  return { width: cx / 9525, height: cy / 9525, scale: 1 / 9525 };
}
