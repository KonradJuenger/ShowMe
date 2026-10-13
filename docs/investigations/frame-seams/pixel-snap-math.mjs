// Diagnostic render math. This does not change persisted or interaction geometry.
export function snapRect(rect, view) {
  const sx = view.scaleX * view.dpr;
  const sy = view.scaleY * view.dpr;
  const ox = view.originX * view.dpr;
  const oy = view.originY * view.dpr;
  const left = Math.round(ox + rect.x * sx);
  const right = Math.round(ox + (rect.x + rect.width) * sx);
  const top = Math.round(oy + rect.y * sy);
  const bottom = Math.round(oy + (rect.y + rect.height) * sy);
  return {
    x: (left - ox) / sx,
    y: (top - oy) / sy,
    width: (right - left) / sx,
    height: (bottom - top) / sy,
  };
}
