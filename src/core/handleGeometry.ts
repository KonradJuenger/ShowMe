import type { ResizeHandle } from "./geometry";
import type { Matrix } from "./element";

/** Follow the displayed handle axis, including rotated and reflected parents. */
export function resizeHandleCursor(
  handle: ResizeHandle,
  matrix: Matrix,
): string {
  const x = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const y = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const angle = Math.atan2(
    matrix[1] * x + matrix[3] * y,
    matrix[0] * x + matrix[2] * y,
  );
  const sector = ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][sector];
}

export function snapRotation(rotation: number, shiftKey: boolean): number {
  if (shiftKey) return Math.round(rotation / 15) * 15;
  const quarterTurn = Math.round(rotation / 90) * 90;
  return Math.abs(rotation - quarterTurn) <= 5 ? (quarterTurn || 0) : rotation;
}
