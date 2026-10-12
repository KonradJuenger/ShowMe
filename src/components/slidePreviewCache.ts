// Disposable compositions captured from the canonical renderer. Bounded by bytes.
const previews = new Map<string, string>();
let bytes = 0;
export function slidePreview(key: string) {
  const value = previews.get(key);
  if (value) {
    previews.delete(key);
    previews.set(key, value);
  }
  return value ?? null;
}
export function storeSlidePreview(key: string, value: string) {
  if (value.length + key.length > 2 * 1024 * 1024) return;
  const previous = previews.get(key);
  if (previous) bytes -= (previous.length + key.length) * 2;
  previews.delete(key);
  previews.set(key, value);
  bytes += (value.length + key.length) * 2;
  while (bytes > 16 * 1024 * 1024 || previews.size > 100) {
    const first = previews.keys().next().value!;
    bytes -= (previews.get(first)!.length + first.length) * 2;
    previews.delete(first);
  }
}
