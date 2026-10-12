export function reorder<T>(values: T[], from: number, to: number): T[] {
  const out = [...values];
  const [v] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, v);
  return out;
}

export const snap = (value: number, enabled = true) =>
  enabled ? Math.round(value / 10) * 10 : value;
