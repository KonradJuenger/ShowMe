import { smartSnapAxis } from "./geometry";

export interface SnapTargetSources {
  persistent?: number[];
  slide?: number[];
  objects?: number[];
}

export interface AxisSnap {
  value: number;
  guide?: number;
  source?: keyof SnapTargetSources;
}

export interface ResizeAxisSnap {
  position: number;
  size: number;
  guide?: number;
  source?: keyof SnapTargetSources;
  anchor?: "edge" | "center";
}

export function resolveSnapAxis(
  position: number,
  size: number,
  sources: SnapTargetSources,
  tolerance: number,
): AxisSnap {
  const ordered: Array<keyof SnapTargetSources> = [
    "persistent",
    "slide",
    "objects",
  ];
  const candidates: Array<{
    value: number;
    guide: number;
    source: keyof SnapTargetSources;
    distance: number;
    priority: number;
  }> = [];

  for (const [priority, source] of ordered.entries()) {
    const targets = sources[source] ?? [];
    if (!targets.length) continue;
    const snapped = smartSnapAxis(position, size, targets, tolerance);
    if (snapped.guide === undefined) continue;
    candidates.push({
      value: snapped.value,
      guide: snapped.guide,
      source,
      distance: Math.abs(snapped.value - position),
      priority,
    });
  }

  candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority);
  const best = candidates[0];
  return best
    ? { value: best.value, guide: best.guide, source: best.source }
    : { value: position };
}

export function resolveResizeSnapAxis(
  position: number,
  size: number,
  direction: "start" | "end",
  sources: SnapTargetSources,
  tolerance: number,
  minSize = 10,
): ResizeAxisSnap {
  const ordered: Array<keyof SnapTargetSources> = [
      "persistent",
      "slide",
      "objects",
    ],
    fixedEdge = direction === "start" ? position + size : position,
    movingEdge = direction === "start" ? position : position + size,
    center = position + size / 2,
    candidates: Array<{
      position: number;
      size: number;
      guide: number;
      source: keyof SnapTargetSources;
      anchor: "edge" | "center";
      distance: number;
      priority: number;
      anchorPriority: number;
    }> = [];

  for (const [priority, source] of ordered.entries()) {
    for (const target of sources[source] ?? []) {
      const edgeDistance = Math.abs(target - movingEdge);
      if (edgeDistance <= tolerance) {
        const nextPosition = direction === "start" ? target : fixedEdge,
          nextSize =
            direction === "start" ? fixedEdge - target : target - fixedEdge;
        if (nextSize >= minSize)
          candidates.push({
            position: nextPosition,
            size: nextSize,
            guide: target,
            source,
            anchor: "edge",
            distance: edgeDistance,
            priority,
            anchorPriority: 0,
          });
      }

      const centerDistance = Math.abs(target - center);
      if (centerDistance <= tolerance) {
        const nextPosition =
            direction === "start" ? 2 * target - fixedEdge : fixedEdge,
          nextSize =
            direction === "start"
              ? fixedEdge - nextPosition
              : 2 * (target - fixedEdge);
        if (nextSize >= minSize)
          candidates.push({
            position: nextPosition,
            size: nextSize,
            guide: target,
            source,
            anchor: "center",
            distance: centerDistance,
            priority,
            anchorPriority: 1,
          });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.priority - b.priority ||
      a.anchorPriority - b.anchorPriority,
  );
  const best = candidates[0];
  return best
    ? {
        position: best.position,
        size: best.size,
        guide: best.guide,
        source: best.source,
        anchor: best.anchor,
      }
    : { position, size };
}

export function snapCoordinate(
  value: number,
  targets: number[],
  tolerance: number,
): { value: number; guide?: number } {
  let best = value,
    guide: number | undefined,
    distance = tolerance + 1;
  for (const target of targets) {
    const nextDistance = Math.abs(target - value);
    if (nextDistance < distance) {
      distance = nextDistance;
      best = target;
      guide = target;
    }
  }
  return distance <= tolerance ? { value: best, guide } : { value };
}
