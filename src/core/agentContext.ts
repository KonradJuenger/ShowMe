import { z } from "zod";
import { idSchema } from "./ids";
import type { DocumentProjection } from "./documentProjection";
import { findElement, getChildren } from "./scene";
import { resolveVisualSlide } from "./templates";

const index = z.number().int().nonnegative();
const time = z.number().finite().nonnegative();
export const agentEditorSnapshotSchema = z
  .object({
    documentId: idSchema,
    documentEpoch: z.string().min(1).max(100),
    observedRevision: index,
    page: z
      .object({ kind: z.enum(["slide", "template"]), id: idSchema })
      .strict(),
    selectionScopeId: idSchema.nullable(),
    selectionIds: z.array(idSchema).max(100000),
    mode: z.enum([
      "edit",
      "media-preview",
      "motion-preview",
      "motion-state-edit",
    ]),
    timeline: z
      .object({
        selectedStageIndex: index,
        stageIndex: z.number().int().min(-1),
        stageId: idSchema.nullable(),
        stageTimeMs: time,
        running: z.boolean(),
        sampledAtMs: time,
        draft: z.boolean(),
        playbackAnchor: z
          .object({ timeMs: time, startedAtMs: time })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentEditorSnapshot = z.infer<typeof agentEditorSnapshotSchema>;

export const editorAgentContextRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("attach"),
      documentId: idSchema,
      documentEpoch: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("publish"),
      token: idSchema,
      sequence: index,
      snapshot: agentEditorSnapshotSchema,
    })
    .strict(),
  z.object({ type: z.literal("detach"), token: idSchema }).strict(),
]);
export type EditorAgentContextRequest = z.infer<
  typeof editorAgentContextRequestSchema
>;
export interface EditorAgentContextReply {
  accepted: boolean;
  token: string | null;
}

export interface AgentPresentationContext {
  documentId: string;
  slideId: string | null;
  slideIndex: number | null;
  black: boolean;
  stageIndex: number | null;
  stageTimeMs: number | null;
  running: boolean;
  /** Existing presenter clock anchor; no new clock is run by the context service. */
  startedAtMs: number | null;
  restartToken: number | null;
}

export interface AgentContext {
  editing?: { enabled: boolean; available: boolean; reason: string | null };
  enabled: boolean;
  uiEpoch: number;
  availability: "disabled" | "loading" | "ready" | "unavailable";
  document: {
    id: string;
    name: string;
    epoch: string;
    revision: number;
    savedRevision: number;
    dirty: boolean;
  } | null;
  editor: AgentEditorSnapshot | null;
  presentation: AgentPresentationContext | null;
}

/** Revision and passive running time do not change the meaning of the UI context. */
export function agentUiKey(snapshot: AgentEditorSnapshot | null): string {
  if (!snapshot) return "null";
  const { observedRevision: _revision, timeline, ...ui } = snapshot;
  return JSON.stringify({
    ...ui,
    timeline: timeline && {
      selectedStageIndex: timeline.selectedStageIndex,
      stageIndex: timeline.stageIndex,
      stageId: timeline.stageId,
      stageTimeMs: timeline.running ? null : timeline.stageTimeMs,
      running: timeline.running,
      draft: timeline.draft,
      playbackAnchor: timeline.playbackAnchor,
    },
  });
}

/** Validate handles against accepted state without changing the editor's own selection. */
export function normalizeAgentEditorContext(
  snapshot: AgentEditorSnapshot,
  projection: DocumentProjection,
): AgentEditorSnapshot | null {
  if (
    snapshot.documentId !== projection.documentId ||
    snapshot.documentEpoch !== projection.epoch ||
    snapshot.observedRevision > projection.revision ||
    snapshot.page.id !== projection.slide.id
  )
    return null;
  const { deck } = projection;
  const expected =
    snapshot.page.kind === "slide" ? deck.slideIds : deck.templateIds;
  if (!expected.includes(snapshot.page.id)) return null;
  const slide =
    snapshot.page.kind === "slide"
      ? resolveVisualSlide(deck, projection.slide, projection.templates ?? {})
          .slide
      : projection.slide;
  let timeline = snapshot.timeline;
  if (timeline && !timeline.draft) {
    const stages = slide.motion?.stages ?? [];
    if (
      !stages[timeline.selectedStageIndex] ||
      (timeline.stageIndex !== -1 &&
        stages[timeline.stageIndex]?.id !== timeline.stageId)
    )
      timeline = null;
    else if (timeline.stageIndex === -1)
      timeline = { ...timeline, stageId: null };
  }
  return structuredClone({
    ...snapshot,
    selectionScopeId:
      snapshot.selectionScopeId && getChildren(slide, snapshot.selectionScopeId)
        ? snapshot.selectionScopeId
        : null,
    selectionIds: [...new Set(snapshot.selectionIds)].filter(
      (id) => !!findElement(slide, id),
    ),
    timeline,
  });
}
