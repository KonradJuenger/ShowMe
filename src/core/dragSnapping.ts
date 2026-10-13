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
  mode: "intent",
  magneticRadius: 12,
  magneticCore: 2,
  intentCapture: 6,
  intentRelease: 12,
  intentSpeed: 600,
};

interface Alignment {
  position: number;
  guide: number;
  source: keyof SnapTargetSources;
  priority: number;
  anchor: number;
  span?: { start: number; end: number };
}

/** Semantic targets stay gesture-local; they are not part of the document format. */
export interface DragSnapTarget {
  position: number;
  source: keyof SnapTargetSources;
  kind: "start" | "center" | "end" | "guide";
  span?: { start: number; end: number };
}

export interface DragSnapTargetSources extends SnapTargetSources {
  features?: DragSnapTarget[];
}

export interface DragSnapContext {
  /** Current selection bounds on the perpendicular axis, in scope coordinates. */
  start: number;
  end: number;
  pixelsPerUnit: number;
}

interface CandidateNode {
  candidate: Alignment;
  left?: CandidateNode;
  right?: CandidateNode;
  min: number;
  max: number;
  spanStart: number;
  spanEnd: number;
  priority: number;
}

function candidateTree(
  values: readonly Alignment[],
  start = 0,
  end = values.length,
): CandidateNode | undefined {
  if (start === end) return undefined;
  const mid = (start + end) >>> 1;
  const candidate = values[mid];
  const left = candidateTree(values, start, mid);
  const right = candidateTree(values, mid + 1, end);
  return {
    candidate,
    left,
    right,
    min: values[start].position,
    max: values[end - 1].position,
    spanStart: Math.min(
      candidate.span?.start ?? -Infinity,
      left?.spanStart ?? Infinity,
      right?.spanStart ?? Infinity,
    ),
    spanEnd: Math.max(
      candidate.span?.end ?? Infinity,
      left?.spanEnd ?? -Infinity,
      right?.spanEnd ?? -Infinity,
    ),
    priority: Math.min(
      candidate.priority,
      left?.priority ?? Infinity,
      right?.priority ?? Infinity,
    ),
  };
}

function spanGap(candidate: Alignment, context?: DragSnapContext) {
  if (!candidate.span || !context) return 0;
  return (
    Math.max(
      0,
      candidate.span.start - context.end,
      context.start - candidate.span.end,
    ) * context.pixelsPerUnit
  );
}

const objectReachPixels = 24;

/** Range tree prunes both alignment distance and perpendicular object locality. */
function intentCandidate(
  root: CandidateNode | undefined,
  position: number,
  previous: number | undefined,
  capture: number,
  release: number,
  context?: DragSnapContext,
  strongerThan = Infinity,
  blockedPosition?: number,
) {
  let best: Alignment | undefined;
  const searchReach = Math.max(capture, release);
  const low = Math.max(
    position - searchReach,
    Math.min(position, previous ?? position) - capture,
  );
  const high = Math.min(
    position + searchReach,
    Math.max(position, previous ?? position) + capture,
  );
  const padding = context
    ? objectReachPixels / Math.max(1e-9, context.pixelsPerUnit)
    : Infinity;
  const visit = (node: CandidateNode | undefined) => {
    if (
      !node ||
      node.priority >= strongerThan ||
      node.max < low ||
      node.min > high
    )
      return;
    if (
      context &&
      (node.spanEnd < context.start - padding ||
        node.spanStart > context.end + padding)
    )
      return;
    const candidate = node.candidate;
    const distance = Math.abs(candidate.position - position);
    const crossed =
      previous !== undefined &&
      candidate.position >= Math.min(position, previous) &&
      candidate.position <= Math.max(position, previous);
    if (
      candidate.priority < strongerThan &&
      candidate.position !== blockedPosition &&
      (distance <= capture || (crossed && distance <= release)) &&
      spanGap(candidate, context) <= objectReachPixels &&
      (!best ||
        candidate.priority < best.priority ||
        (candidate.priority === best.priority &&
          (distance < Math.abs(best.position - position) ||
            (distance === Math.abs(best.position - position) &&
              candidate.anchor < best.anchor))))
    )
      best = candidate;
    visit(node.left);
    visit(node.right);
  };
  visit(root);
  return best;
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
 * Magnetic queries use binary search. Intent queries prune a range tree by
 * distance, object span and target strength without rebuilding scene geometry.
 */
export function createDragSnapAxis(
  size: number,
  targets: DragSnapTargetSources,
  pixelsPerUnit: number,
  settings: DragSnapSettings,
) {
  const candidates: Alignment[] = [];
  if (settings.mode === "intent" && targets.features) {
    for (const target of targets.features) {
      // Canvas start/end boundaries accept their matching outer edge; canvas
      // centers accept the center. Object centers never attract moving edges.
      const anchors =
        target.source === "slide"
          ? [target.kind === "start" ? 0 : target.kind === "end" ? 2 : 1]
          : target.kind === "guide"
            ? [0, 1, 2]
            : target.kind === "center"
              ? [1]
              : [0, 2];
      const priority =
        target.source === "persistent"
          ? 0
          : target.source === "slide" && target.kind !== "center"
            ? 1
            : target.kind !== "center"
              ? 2
              : target.source === "slide"
                ? 3
                : 4;
      for (const anchor of anchors)
        candidates.push({
          position: target.position - (size * anchor) / 2,
          guide: target.position,
          source: target.source,
          priority,
          anchor,
          span: target.span,
        });
    }
  } else
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
  // Keep distinct spans at equal coordinates: the closest object can differ as
  // the selection moves along a line. Magnetic uses its original scalar index.
  const intentTree =
    settings.mode === "intent"
      ? candidateTree(
          candidates
            .slice()
            .sort(
              (a, b) =>
                a.position - b.position ||
                (a.span?.start ?? -Infinity) - (b.span?.start ?? -Infinity) ||
                a.priority - b.priority,
            ),
        )
      : undefined;
  const scale = Math.max(1e-9, pixelsPerUnit);
  const radius = settings.magneticRadius / scale;
  const capture = settings.intentCapture / scale;
  const release = Math.max(0, settings.intentRelease) / scale;
  let held: Alignment | undefined;
  let capturedPosition: number | undefined;
  let blockedPosition: number | undefined;
  let previousPosition: number | undefined;

  return {
    targetCount: alignments.length,
    reset() {
      held = undefined;
      previousPosition = undefined;
      capturedPosition = undefined;
      blockedPosition = undefined;
    },
    resolve(
      position: number,
      speedPixelsPerSecond = 0,
      context?: DragSnapContext,
    ): DragAxisResult {
      const previous = previousPosition;
      previousPosition = position;
      if (settings.mode === "intent") {
        if (
          blockedPosition !== undefined &&
          Math.abs(position - blockedPosition) > capture
        )
          blockedPosition = undefined;
        const candidate =
          speedPixelsPerSecond <= settings.intentSpeed
            ? intentCandidate(
                intentTree,
                position,
                previous,
                capture,
                release,
                context,
                held?.priority,
                blockedPosition,
              )
            : undefined;
        if (candidate) {
          held = candidate;
          capturedPosition = position;
          return {
            value: held.position,
            guide: held.guide,
            source: held.source,
          };
        }
      }
      if (settings.mode === "intent" && held) {
        const distance = Math.abs(position - held.position);
        const gap = spanGap(held, context);
        if (
          (distance <= release || position === capturedPosition) &&
          gap <= objectReachPixels
        )
          return {
            value: held.position,
            guide: held.guide,
            source: held.source,
          };
        if (distance < 2 * release && gap < 2 * objectReachPixels) {
          // Spatial easing releases without a position jump, timer, trailing
          // animation or permanent pointer offset. Reversing naturally re-latches.
          const weight =
            (1 - smoothstep((distance - release) / release)) *
            (1 - smoothstep((gap - objectReachPixels) / objectReachPixels));
          return { value: position + (held.position - position) * weight };
        }
        blockedPosition =
          gap >= 2 * objectReachPixels ? undefined : held.position;
        held = undefined;
        if (speedPixelsPerSecond <= settings.intentSpeed) {
          held = intentCandidate(
            intentTree,
            position,
            previous,
            capture,
            release,
            context,
            Infinity,
            blockedPosition,
          );
          if (held) {
            capturedPosition = position;
            return {
              value: held.position,
              guide: held.guide,
              source: held.source,
            };
          }
        }
      }

      if (settings.mode === "intent") return { value: position };

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
