/** Opt-in User Timing entries, visible in Chromium's Performance panel.
 * Enable with localStorage.setItem('showme.presentationDiagnostics', 'true')
 * and reload the audience window. No document data or persistence is changed. */
export function presentationSpan(
  name: string,
  slideId: string,
  detail: Record<string, string | number | boolean> = {},
) {
  try {
    if (localStorage.getItem("showme.presentationDiagnostics") !== "true")
      return () => {};
  } catch {
    return () => {};
  }
  const start = performance.now();
  let ended = false;
  return (result: Record<string, string | number | boolean> = {}) => {
    if (ended) return;
    ended = true;
    performance.measure(`ShowMe:${name}`, {
      start,
      end: performance.now(),
      detail: { slideId, ...detail, ...result },
    });
  };
}
