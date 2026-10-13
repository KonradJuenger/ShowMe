import type { SnapTargetSources } from "./snapping";

export type DragSnapMode = "classic" | "magnetic" | "intent";

/** Editor-local experiment settings. Distances and speeds are in screen pixels. */
export interface DragSnapSettings {
  mode: DragSnapMode;
  magneticRadius: number;
  magneticCore: number;
  intentCapture: number;
  intentRelease: number;
  intentSpeed: number;
}

export const defaultDragSnapSettings: DragSnapSettings = {
  mode: "magnetic",
  magneticRadius: 12,
  magneticCore: 2,
  intentCapture: 3,
  intentRelease: 12,
  intentSpeed: 600,
};

interface Alignment {
  position: number;
  guide: number;
  source: keyof SnapTargetSources;
  priority: number;
  anchor: number;
}

export interface DragAxisResult {
  value: number;
  /** Feedback denotes exact alignment only, never mere attraction. */
  guide?: number;
  source?: keyof SnapTargetSources;
}

const sources = ["persistent", "slide", "objects"] as const;

function lowerBound(values: readonly Alignment[], position: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid].position < position) low = mid + 1;
    else high = mid;
  }
  return low;
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

/**
 * Compile desired selection positions once, rather than scanning every target
 * for each of the three moving anchors on every pointer frame. Duplicate
 * alignments have stable guide > slide > object, then start > center > end ties.
 * Each query is O(log N), with no scene traversal or candidate sorting.
 */
export function createDragSnapAxis(
  size: number,
  targets: SnapTargetSources,
  pixelsPerUnit: number,
  settings: DragSnapSettings,
) {
  const candidates: Alignment[] = [];
  for (const [priority, source] of sources.entries()) {
    for (const guide of targets[source] ?? []) {
      if (!Number.isFinite(guide)) continue;
      for (let anchor = 0; anchor < 3; anchor++)
        candidates.push({
          position: guide - (size * anchor) / 2,
          guide,
          source,
          priority,
          anchor,
        });
    }
  }
  candidates.sort(
    (a, b) =>
      a.position - b.position || a.priority - b.priority || a.anchor - b.anchor,
  );
  const alignments = candidates.filter(
    (candidate, index) =>
      index === 0 || candidate.position !== candidates[index - 1].position,
  );
  const scale = Math.max(1e-9, pixelsPerUnit);
  const radius = settings.magneticRadius / scale;
  const capture = settings.intentCapture / scale;
  const release =
    Math.max(settings.intentRelease, settings.intentCapture) / scale;
  let held: Alignment | undefined;

  return {
    targetCount: alignments.length,
    reset() {
      held = undefined;
    },
    resolve(position: number, speedPixelsPerSecond = 0): DragAxisResult {
      if (settings.mode === "intent" && held) {
        const distance = Math.abs(position - held.position);
        if (distance <= release)
          return {
            value: held.position,
            guide: held.guide,
            source: held.source,
          };
        if (distance < 2 * release) {
          // Spatial easing releases without a position jump, timer, trailing
          // animation or permanent pointer offset. Reversing naturally re-latches.
          const weight = 1 - smoothstep((distance - release) / release);
          return { value: position + (held.position - position) * weight };
        }
        held = undefined;
      }

      const right = lowerBound(alignments, position);
      const left = right - 1;
      let index = right;
      if (
        left >= 0 &&
        (right === alignments.length ||
          Math.abs(position - alignments[left].position) <=
            Math.abs(position - alignments[right].position))
      )
        index = left;
      const candidate = alignments[index];
      if (!candidate) return { value: position };
      const distance = Math.abs(position - candidate.position);

      if (settings.mode === "intent") {
        if (distance > capture || speedPixelsPerSecond > settings.intentSpeed)
          return { value: position };
        held = candidate;
        return {
          value: candidate.position,
          guide: candidate.guide,
          source: candidate.source,
        };
      }

      // Neighbor midpoints bound each attraction basin. At a target switch the
      // correction is zero on both sides, even in a dense cluster of guides.
      const neighbor =
        alignments[index + (position < candidate.position ? -1 : 1)];
      const reach = neighbor
        ? Math.min(radius, Math.abs(neighbor.position - candidate.position) / 2)
        : radius;
      if (distance >= reach) return { value: position };
      const core = Math.min(settings.magneticCore / scale, reach * 0.35);
      if (distance <= core)
        return {
          value: candidate.position,
          guide: candidate.guide,
          source: candidate.source,
        };
      const weight = smoothstep((distance - core) / (reach - core));
      return {
        value: candidate.position + (position - candidate.position) * weight,
      };
    },
  };
}
