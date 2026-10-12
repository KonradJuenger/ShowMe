import { blockRange, resolveMotion, motionElement } from "./motion";
import {
  slideMotionSchema,
  type SlideMotion,
  type MotionTrack,
  type MotionEase,
} from "./motionModel";
import { uid } from "./ids";
import { findElement } from "./scene";
import {
  motionPropertyDescriptor,
  unavailable,
} from "./elementPropertyDescriptors";
import type { EditorSnapshot } from "./editorCommands";
import {
  editorOperations,
  setEditorOperations,
  type EditorChange,
} from "./editorChange";
import { applyDocumentOperationsToProjection } from "./documentProjection";
import type { DocumentOperation } from "./documentOperations";

export function blockStateTimes(
  motion: SlideMotion,
  stageIndex: number,
  blockId: string,
) {
  const { block } = blockRange(motion, stageIndex, blockId);
  const stage = motion.stages[stageIndex];
  return [
    ...new Set(
      block.members.flatMap((m) => {
        const track = stage.tracks.find((t) => t.id === m.trackId)!;
        return track.keyframes
          .slice(
            track.keyframes.findIndex((k) => k.id === m.fromKeyframeId),
            track.keyframes.findIndex((k) => k.id === m.toKeyframeId) + 1,
          )
          .map((k) => k.at);
      }),
    ),
  ].sort((a, b) => a - b);
}
export function editBlockState(
  input: SlideMotion,
  stageIndex: number,
  blockId: string,
  at: number,
  action:
    | { type: "delete" }
    | { type: "retime"; to: number }
    | { type: "ease"; ease: MotionEase },
) {
  const motion = structuredClone(input),
    { block, start, end } = blockRange(motion, stageIndex, blockId);
  if (!blockStateTimes(motion, stageIndex, blockId).includes(at))
    throw new Error("Unknown state");
  if (action.type !== "ease" && (at <= start || at >= end))
    throw new Error("Start and end states are retained");
  const to = action.type === "retime" ? Math.round(action.to) : at;
  if (
    action.type === "retime" &&
    (!Number.isFinite(to) ||
      to <= start ||
      to >= end ||
      (to !== at && blockStateTimes(motion, stageIndex, blockId).includes(to)))
  )
    throw new Error("Choose an unoccupied time inside the block");
  for (const member of block.members) {
    const track = motion.stages[stageIndex].tracks.find(
      (t) => t.id === member.trackId,
    )!;
    const index = track.keyframes.findIndex((k) => k.at === at);
    const key = track.keyframes[index];
    if (!key) continue;
    const from = track.keyframes.findIndex(
        (k) => k.id === member.fromKeyframeId,
      ),
      until = track.keyframes.findIndex((k) => k.id === member.toKeyframeId);
    if (index < from || index > until) continue;
    if (action.type === "ease") {
      if (index < until) key.easeToNext = action.ease;
    } else {
      if (index === from || index === until)
        throw new Error(
          "A member's boundary state cannot be removed or retimed",
        );
      if (action.type === "delete") track.keyframes.splice(index, 1);
      else {
        key.at = to;
        track.keyframes.sort((a, b) => a.at - b.at);
      }
    }
  }
  return slideMotionSchema.parse(motion);
}
export function setBlockState(
  snapshot: EditorSnapshot,
  stageIndex: number,
  blockId: string,
  time: number,
  values: Record<string, Partial<Record<MotionTrack["property"], number>>> = {},
) {
  const motion = structuredClone(snapshot.slide.motion!),
    { block, start, end } = blockRange(motion, stageIndex, blockId);
  const at = Math.round(time);
  if (!Number.isFinite(at) || at < start || at > end)
    throw new Error("Scrub inside the selected block to edit a state");
  const overlay = resolveMotion(snapshot.slide, stageIndex, at);
  // A Move state owns both axes even when the starter only animated one.
  if (
    !block.binding &&
    block.members.some((m) =>
      /^transform\.[xy]$/.test(
        motion.stages[stageIndex].tracks.find((t) => t.id === m.trackId)!
          .property,
      ),
    )
  ) {
    const ids = new Set(
      block.members.map(
        (m) =>
          motion.stages[stageIndex].tracks.find((t) => t.id === m.trackId)!
            .elementId,
      ),
    );
    for (const elementId of ids)
      for (const property of ["transform.x", "transform.y"] as const) {
        if (
          block.members.some((m) => {
            const t = motion.stages[stageIndex].tracks.find(
              (t) => t.id === m.trackId,
            )!;
            return t.elementId === elementId && t.property === property;
          })
        )
          continue;
        let track = motion.stages[stageIndex].tracks.find(
          (t) => t.elementId === elementId && t.property === property,
        );
        if (track?.keyframes.some((k) => k.at >= start && k.at <= end))
          throw new Error(
            "Another position animation occupies this block's time",
          );
        if (!track) {
          track = { id: uid(), elementId, property, keyframes: [] };
          motion.stages[stageIndex].tracks.push(track);
        }
        const a = { id: uid(), at: start, value: { type: "base" as const } },
          b = { id: uid(), at: end, value: { type: "base" as const } };
        track.keyframes.push(a, b);
        track.keyframes.sort((a, b) => a.at - b.at);
        block.members.push({
          trackId: track.id,
          fromKeyframeId: a.id,
          toKeyframeId: b.id,
        });
      }
  }
  for (const member of block.members) {
    const track = motion.stages[stageIndex].tracks.find(
      (t) => t.id === member.trackId,
    )!;
    const a = track.keyframes.find((k) => k.id === member.fromKeyframeId)!,
      b = track.keyframes.find((k) => k.id === member.toKeyframeId)!;
    if (at < a.at || at > b.at) continue;
    const element = findElement(snapshot.slide, track.elementId)!;
    const base = motionPropertyDescriptor(
      element,
      track.property,
      snapshot.slide.effectResources,
    )?.read(element);
    if (base === undefined || base === unavailable)
      throw new Error("State property is unavailable");
    const explicit = values[track.elementId]?.[track.property];
    const value =
      explicit ?? overlay[track.elementId]?.[track.property] ?? base;
    if (!Number.isFinite(value)) throw new Error("State values must be finite");
    const existing = track.keyframes.find((k) => k.at === at);
    if (existing) {
      if (explicit !== undefined) existing.value = { type: "absolute", value };
    } else {
      const previous = track.keyframes.filter((k) => k.at < at).at(-1)!;
      track.keyframes.push({
        id: uid(),
        at,
        value: { type: "absolute", value },
        easeToNext: previous.easeToNext,
      });
      track.keyframes.sort((a, b) => a.at - b.at);
    }
  }
  return slideMotionSchema.parse(motion);
}

/** Local projection for direct manipulation; never persisted as base Element state. */
export function motionEditingSnapshot(
  base: EditorSnapshot,
  stage: number,
  time: number,
): EditorSnapshot {
  const overlay = resolveMotion(base.slide, stage, time);
  const children = (
    elements: import("./element").Element[],
  ): import("./element").Element[] =>
    elements.map((e) => ({
      ...motionElement(e, overlay),
      children: children(e.children),
    }));
  return {
    ...base,
    slide: {
      ...base.slide,
      nodes: base.slide.nodes.map((r) => ({
        ...r,
        children: children(r.children),
      })),
    },
  };
}
/** Redirect only changes to the selected block's properties. Preserve unrelated semantic operations. */
export function animationStateChange(
  base: EditorSnapshot,
  displayed: EditorSnapshot,
  change: EditorSnapshot | EditorChange,
  stage: number,
  blockId: string,
  time: number,
): EditorChange {
  const { block } = blockRange(base.slide.motion!, stage, blockId);
  const tracks = base.slide.motion!.stages[stage].tracks.filter((t) =>
    block.members.some((m) => m.trackId === t.id),
  );
  const values: Record<
    string,
    Partial<Record<MotionTrack["property"], number>>
  > = {};
  const sourceOperations = editorOperations(change);
  const textEdits = new Set(
    sourceOperations.flatMap((op) =>
      op.type === "elements.content.set"
        ? op.changes
            .filter((e) => e.value?.type === "text")
            .map((e) => e.elementId)
        : [],
    ),
  );
  const resizedMedia = new Set<string>();
  const operations: DocumentOperation[] = sourceOperations.map((op) => {
    if (
      op.type !== "elements.frame.set" &&
      op.type !== "elements.appearance.set"
    )
      return op;
    return {
      ...op,
      changes: op.changes.map((entry) => {
        const original = findElement(base.slide, entry.elementId),
          shown = findElement(displayed.slide, entry.elementId);
        if (!original || !shown) return entry;
        const value = { ...entry.value };
        const target = tracks.filter((t) => t.elementId === entry.elementId);
        const moving = target.some((t) => /^transform\.[xy]$/.test(t.property));
        const scaling = target.some((t) =>
          /^transform\.scale[XY]$/.test(t.property),
        );
        const fields =
          op.type === "elements.frame.set"
            ? (["x", "y", "rotation", "scaleX", "scaleY"] as const)
            : (["opacity"] as const);
        for (const field of fields) {
          const property = (
            field === "opacity" ? "appearance.opacity" : `transform.${field}`
          ) as MotionTrack["property"];
          const source =
            field === "opacity" ? original.appearance : original.frame;
          const visual = field === "opacity" ? shown.appearance : shown.frame;
          const before = (visual as unknown as Record<string, number>)[field],
            after = (value as unknown as Record<string, number>)[field];
          const relevant =
            target.some((t) => t.property === property) ||
            (moving && (field === "x" || field === "y"));
          if (relevant && after !== before)
            (values[entry.elementId] ??= {})[property] = after;
          if (relevant || after === before)
            (value as unknown as Record<string, number>)[field] = (
              source as unknown as Record<string, number>
            )[field];
        }
        if (
          scaling &&
          op.type === "elements.frame.set" &&
          !textEdits.has(entry.elementId)
        ) {
          const frame = value as import("./element").Element["frame"];
          for (const [size, scale] of [
            ["width", "scaleX"],
            ["height", "scaleY"],
          ] as const) {
            if (frame[size] !== shown.frame[size]) {
              (values[entry.elementId] ??= {})[`transform.${scale}`] =
                (shown.frame[scale] * frame[size]) / shown.frame[size];
              if (original.content && original.content.type !== "text")
                resizedMedia.add(entry.elementId);
            }
            frame[size] = original.frame[size];
          }
          frame.x = original.frame.x;
          frame.y = original.frame.y;
        }
        return { ...entry, value };
      }),
    } as DocumentOperation;
  });
  // Transform commands may preserve media crop after resizing. Scale states keep base media immutable.
  const kept = operations
    .map((op) =>
      op.type === "elements.content.set"
        ? {
            ...op,
            changes: op.changes.map((e) => {
              const original = findElement(base.slide, e.elementId)?.content;
              return resizedMedia.has(e.elementId) &&
                original &&
                original.type !== "text" &&
                e.value &&
                e.value.type !== "text"
                ? { ...e, value: { ...e.value, transform: original.transform } }
                : e;
            }),
          }
        : op,
    )
    .filter(
      (op) =>
        !("changes" in op && Array.isArray(op.changes) && !op.changes.length),
    );
  if (Object.keys(values).length)
    kept.push({
      type: "slide.motion.set",
      slideId: base.slide.id,
      motion: setBlockState(base, stage, blockId, time, values),
    });
  const projected = applyDocumentOperationsToProjection(base, kept);
  if (!projected) throw new Error("The active slide was removed");
  return setEditorOperations(projected, kept);
}
