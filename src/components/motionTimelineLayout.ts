import { blockRange, editMotionBlock, stageDuration } from "../core/motion";
import { editPresenceSchedule } from "../core/presence";
import { resizeEffectTime } from "../core/effectSequence";
import { transitionDuration, type SlideMotion } from "../core/motionModel";
/** Reserve editable ruler space after starts whose end is an event or is unbounded. */
export function motionTimelineSpans(motion: SlideMotion) {
  return motion.stages
    .map((stage) =>
      Math.max(
        1000,
        stageDuration(stage),
        ...(stage.blocks ?? []).map((b) =>
          (b.presenceSchedule ?? b.effectSchedule) &&
          (b.presenceSchedule?.end ?? b.effectSchedule?.stop)?.mode !== "after"
            ? (b.presenceSchedule?.startOffsetMs ??
                b.effectSchedule!.startOffsetMs) + 1000
            : 0,
        ),
      ),
    )
    .map((span, index) =>
      Math.max(
        span,
        ...motion.stages.flatMap((stage, startIndex) =>
          (stage.blocks ?? []).map((b) => {
            const s = b.presenceSchedule;
            if (!s || (s.end.mode !== "click" && s.end.mode !== "next-click"))
              return 0;
            const end = s.end;
            const gate =
              end.mode === "click"
                ? motion.stages.findIndex((stage) => stage.id === end.stageId)
                : startIndex + 1;
            return gate === index ? transitionDuration(s.exitTransition) : 0;
          }),
        ),
      ),
    );
}
export type TimelineEnd = "timed" | "continuous" | "click";
/** Geometry uses each click's own ruler; event intervals span whole click columns. */
export function motionTimelineLayout(
  motion: SlideMotion,
  widths: number[],
  spans: number[],
) {
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((sum, width) => sum + width, 0),
  );
  const layout = new Map<
    string,
    {
      left: number;
      width: number;
      lane: number;
      end: TimelineEnd;
      triggerOffset?: number;
      enterWidth?: number;
      exitWidth?: number;
    }
  >();
  const lanes = new Map<string, number[]>();
  const blocks = motion.stages.flatMap((stage, index) =>
    (stage.blocks ?? []).map((block) => ({ stage, index, block })),
  );
  blocks.sort(
    (a, b) =>
      a.index - b.index ||
      blockRange(motion, a.index, a.block.id).start -
        blockRange(motion, b.index, b.block.id).start,
  );
  for (const { stage, index, block } of blocks) {
    const range = blockRange(motion, index, block.id),
      schedule = block.presenceSchedule ?? block.effectSchedule;
    const left = (range.start / Math.max(1, spans[index])) * widths[index];
    const stop = block.presenceSchedule?.end ?? block.effectSchedule?.stop;
    const end: TimelineEnd = schedule
      ? stop?.mode === "after"
        ? "timed"
        : stop?.mode === "click" || stop?.mode === "next-click"
          ? "click"
          : "continuous"
      : "timed";
    const gate =
      stop?.mode === "click"
        ? motion.stages.findIndex((s) => s.id === stop.stageId)
        : block.effectSchedule?.start && block.effectSchedule.start !== "click"
          ? 1
          : index + 1;
    const right =
      end === "click"
        ? (offsets[gate] ?? offsets.at(-1)! + widths.at(-1)!) - offsets[index]
        : end === "continuous"
          ? offsets.at(-1)! + widths.at(-1)! - offsets[index]
          : left +
            ((stop?.mode === "after"
              ? stop.durationMs
              : range.end - range.start) /
              Math.max(1, spans[index])) *
              widths[index];
    const tail =
      block.presenceSchedule &&
      stop?.mode !== "none" &&
      stop?.mode !== "slide-end"
        ? transitionDuration(block.presenceSchedule.exitTransition)
        : 0;
    const tailStage = end === "click" ? gate : index;
    const tailWidth =
      tailStage < widths.length
        ? (tail / Math.max(1, spans[tailStage])) * widths[tailStage]
        : 0;
    const width = Math.max(24, right - left + tailWidth);
    const elementIds = block.binding
      ? [block.binding.elementId]
      : [
          ...new Set(
            block.members.flatMap((m) => {
              const track = stage.tracks.find((t) => t.id === m.trackId);
              return track ? [track.elementId] : [];
            }),
          ),
        ];
    const occupied = elementIds.map((id) => lanes.get(id) ?? []);
    let lane = 0;
    while (
      occupied.some((row) => (row[lane] ?? -Infinity) > offsets[index] + left)
    )
      lane++;
    occupied.forEach((row, i) => {
      row[lane] = offsets[index] + left + width;
      lanes.set(elementIds[i], row);
    });
    layout.set(block.id, {
      left,
      width,
      lane,
      end,
      ...(tailWidth && end === "click" ? { triggerOffset: right - left } : {}),
      ...(tailWidth ? { exitWidth: tailWidth } : {}),
      ...(block.presenceSchedule &&
      transitionDuration(block.presenceSchedule.enterTransition)
        ? {
            enterWidth: Math.min(
              width,
              (transitionDuration(block.presenceSchedule.enterTransition) /
                Math.max(1, spans[index])) *
                widths[index],
            ),
          }
        : {}),
    });
  }
  return layout;
}

/** Display geometry selects a gate and that gate's local time, never global elapsed time. */
export function timelineCursorAt(
  position: number,
  widths: readonly number[],
  spans: readonly number[],
) {
  const x = Math.max(
    0,
    Math.min(
      widths.reduce((a, b) => a + b, 0),
      position,
    ),
  );
  let offset = 0;
  for (let index = 0; index < widths.length; index++) {
    if (x < offset + widths[index] || index === widths.length - 1)
      return {
        stageIndex: index,
        time: ((x - offset) / widths[index]) * spans[index],
      };
    offset += widths[index];
  }
  return { stageIndex: 0, time: 0 };
}
export function timelineSeekTime(
  motion: SlideMotion,
  index: number,
  time: number,
) {
  return Math.max(0, Math.min(motionTimelineSpans(motion)[index], time));
}

/** Resize the start on the frozen gesture ruler, keeping the authored stop fixed. */
export function resizeTimelineIntervalStart(
  motion: SlideMotion,
  source: number,
  id: string,
  position: number,
  widths: readonly number[],
  spans: readonly number[],
  snap: boolean,
) {
  const range = blockRange(motion, source, id);
  const stop =
    range.block.presenceSchedule?.end ?? range.block.effectSchedule?.stop;
  if (!stop) throw new Error("Unknown timeline interval");
  const offsets = widths.map((_, index) =>
    widths.slice(0, index).reduce((sum, width) => sum + width, 0),
  );
  let { stageIndex: destination, time: start } = timelineCursorAt(
    position,
    widths,
    spans,
  );
  if (stop.mode === "after") {
    // A timed stop belongs to its own click's clock.
    destination = source;
    start = Math.max(
      0,
      ((position - offsets[source]) / widths[source]) * spans[source],
    );
    if (snap && Math.abs(position - offsets[source]) <= 12) start = 0;
    start = Math.min(Math.round(start), range.start + stop.durationMs - 1);
  } else {
    const gate =
      stop.mode === "next-click"
        ? source + 1
        : stop.mode === "click"
          ? motion.stages.findIndex((stage) => stage.id === stop.stageId)
          : motion.stages.length;
    const last = Math.min(motion.stages.length - 1, gate - 1);
    if (snap) {
      const nearest = offsets
        .map((offset, index) => ({ offset, index }))
        .filter(({ index }) => index <= last)
        .sort(
          (a, b) =>
            Math.abs(a.offset - position) - Math.abs(b.offset - position),
        )[0];
      if (nearest && Math.abs(nearest.offset - position) <= 12) {
        destination = nearest.index;
        start = 0;
      } else if (destination !== source) start = 0;
    }
    if (destination > last) {
      destination = last;
      start = snap ? 0 : Math.max(0, spans[last] - 1);
    }
    start = Math.round(start);
  }
  const end =
    stop.mode === "after"
      ? { ...stop, durationMs: range.start + stop.durationMs - start }
      : stop.mode === "next-click" && destination !== source
        ? { mode: "click" as const, stageId: motion.stages[source + 1].id }
        : stop;
  // Make a relative stop absolute before transfer so it keeps the same click.
  const anchored =
    destination === source
      ? motion
      : range.block.presenceSchedule
        ? editPresenceSchedule(motion, source, id, (s) => {
            s.end = end;
          })
        : resizeEffectTime(motion, source, id, range.start, end);
  const moved =
    destination === source
      ? anchored
      : editMotionBlock(
          anchored,
          source,
          id,
          destination,
          start,
          range.end - range.start,
        );
  return range.block.presenceSchedule
    ? editPresenceSchedule(moved, destination, id, (s) => {
        s.startOffsetMs = start;
        s.end = end;
      })
    : resizeEffectTime(moved, destination, id, start, end);
}
