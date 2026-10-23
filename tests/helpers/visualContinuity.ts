/** Compare a fixture's visible contribution at its expected time/geometry.
 * Background/occlusion must be excluded by the caller's region/reference. */
export function visualFrameError(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length || !actual.length)
    throw new Error(
      "Continuity frames must have matching nonempty pixel regions",
    );
  let error = 0;
  for (let i = 0; i < actual.length; i++)
    error += Math.abs(actual[i] - expected[i]);
  return error / actual.length;
}

export function presentationRgb(bgra: Uint8Array) {
  const rgb = new Uint8Array((bgra.length / 4) * 3);
  for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) {
    rgb[j] = bgra[i + 2];
    rgb[j + 1] = bgra[i + 1];
    rgb[j + 2] = bgra[i];
  }
  return rgb;
}

export function fadedReference(
  background: Uint8Array,
  full: Uint8Array,
  alpha: number,
) {
  if (background.length !== full.length)
    throw new Error("Mismatched fade reference");
  return Uint8Array.from(full, (value, index) =>
    Math.round(background[index] * (1 - alpha) + value * alpha),
  );
}

export type VisualObservation = {
  frame: number;
  error: number;
};
type VisualFault = { frame: number; kind: "pixels"; error: number };
export function continuityFaults(
  observations: readonly VisualObservation[],
  limit: number,
) {
  return observations.flatMap<VisualFault>((sample) => {
    if (sample.error > limit)
      return [
        { frame: sample.frame, kind: "pixels" as const, error: sample.error },
      ];
    return [];
  });
}
