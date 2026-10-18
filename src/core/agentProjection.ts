import type { DocumentProjection } from "./documentProjection";
import type { Deck, Slide } from "./document";
import type { Element, Matrix } from "./element";
import { resolveMediaFrame, transformPoint } from "./element";
import type { Box, Point } from "./geometry";
import {
  effectExecutionRange,
  effectParameters,
  effectProperty,
  numericEffectParameters,
  type EffectDefinition,
  type ElementEffect,
} from "./effects";
import type { EffectSchedule, PresenceSchedule } from "./motionModel";
import { getWorldBounds, getWorldMatrix } from "./scene";
import { resolveVisualSlide } from "./templates";
import { resolveTextTypography, type TextTypography } from "./textTypography";

export const AGENT_TEXT_PREVIEW_LENGTH = 160;

interface AgentRevision {
  documentId: string;
  epoch: string;
  revision: number;
  savedRevision: number;
  dirty: boolean;
}

export interface AgentDeckOutline extends AgentRevision {
  deck: {
    id: string;
    name: string;
    width: number;
    height: number;
    slideCount: number;
    hasStylesheet: boolean;
    stylesheet?: string;
    textStyles?: Array<{
      id: string;
      name: string;
      defaultKind?: "heading" | "text";
      typography: import("./textTypography").TextTypography;
    }>;
    slides: Array<{
      id: string;
      index: number;
      name: string;
      section: string;
      hidden: boolean;
      templateId: string | null;
    }>;
  };
}

export interface AgentSlideOptions {
  /** Hidden slide/layer content is withheld by default; Presence is not sampled. */
  includeHiddenContent?: boolean;
}

export interface AgentElementOptions extends AgentSlideOptions {
  includeWorldTransform?: boolean;
  includeEffectSource?: boolean;
  includeMotion?: boolean;
  includePresence?: boolean;
}

export interface AgentElementOutline {
  id: string;
  name?: string;
  source: "slide" | "template";
  ownerPageId: string;
  parentId: string;
  layerId: string;
  layerIndex: number;
  depth: number;
  siblingIndex: number;
  childCount: number;
  contentType: NonNullable<Element["content"]>["type"] | null;
  geometryType: Element["geometry"]["type"];
  container: boolean;
  clipChildren: boolean;
  /** Base-frame world AABB, not sampled/clipped/Effect pixel bounds. */
  worldBounds: Box;
  contentWithheld: boolean;
  textStyleId?: string;
  textPreview?: string;
  /** Unicode code points, not UTF-16 code units. */
  textLength?: number;
  textTruncated?: boolean;
  effectCount: number;
  hasMotion: boolean;
  hasPresence: boolean;
}

export interface AgentSlideOutline extends AgentRevision {
  slide: {
    id: string;
    index: number;
    name: string;
    hidden: boolean;
    templateId: string | null;
    background: string;
    elementCount: number;
  };
  layers: Array<
    Pick<
      Deck["layers"][number],
      "id" | "name" | "hidden" | "locked" | "color"
    >
  >;
  elements: AgentElementOutline[];
}

type TextContent = Extract<Element["content"], { type: "text" }>;
type MediaContent = Extract<
  Element["content"],
  { type: "image" | "svg" | "video" }
>;
export type AgentContentDetail =
  | (TextContent & { typography: TextTypography })
  | (Pick<
      MediaContent,
      "type" | "assetId" | "mediaType" | "opacity" | "lockAspect" | "transform"
    > & {
      contentFrame?: Element["frame"];
      playback?: Pick<
        Extract<MediaContent, { type: "video" }>,
        "autoplay" | "loop" | "mute" | "volume" | "startTime" | "endTime"
      >;
    })
  | null;

export interface AgentEffectSummary extends ElementEffect {
  name: string;
  kind: EffectDefinition["kind"];
  target: EffectDefinition["target"];
  input?: EffectDefinition["input"];
  motionProperties: string[];
  source?: string;
  styleSource?: string;
  parameterContract?: ReturnType<typeof effectParameters>;
  timing: {
    defaults: EffectDefinition["timeControl"];
    stageIndex?: number;
    schedule?: EffectSchedule;
  };
}

export interface AgentElementDetail extends AgentElementOutline {
  frame: Element["frame"];
  appearance: Element["appearance"];
  geometry: Element["geometry"];
  cssClasses: string[];
  content?: AgentContentDetail;
  effects?: AgentEffectSummary[];
  motionStageIndices: number[];
  presenceStageIndices: number[];
  motion?: Array<{
    stageIndex: number;
    properties: string[];
    blockCount: number;
  }>;
  presence?: Array<{ stageIndex: number; schedule: PresenceSchedule }>;
  worldTransform?: { matrix: Matrix; corners: Point[] };
}

export interface AgentElementDetails extends AgentRevision {
  slideId: string;
  elements: AgentElementDetail[];
}

export class AgentProjectionError extends Error {
  constructor(
    public readonly code:
      "UNKNOWN_SLIDE" | "UNKNOWN_ELEMENT" | "MISSING_TEMPLATE",
    message: string,
    public readonly missingIds: readonly string[],
  ) {
    super(message);
    this.name = "AgentProjectionError";
  }
}

function revision(projection: DocumentProjection): AgentRevision {
  return {
    documentId: projection.documentId,
    epoch: projection.epoch,
    revision: projection.revision,
    savedRevision: projection.savedRevision,
    dirty: projection.revision !== projection.savedRevision,
  };
}

/** Metadata only: a DocumentProjection has no bodies/counts for other slides. */
export function projectAgentDeck(
  projection: DocumentProjection,
  options: { includeStylesheet?: boolean; includeTextStyles?: boolean } = {},
): AgentDeckOutline {
  const { deck } = projection;
  return {
    ...revision(projection),
    deck: {
      id: deck.id,
      name: deck.name,
      width: deck.width,
      height: deck.height,
      slideCount: deck.slideIds.length,
      hasStylesheet: !!deck.stylesheet,
      ...(options.includeStylesheet
        ? { stylesheet: deck.stylesheet ?? "" }
        : {}),
      ...(options.includeTextStyles
        ? {
            textStyles: deck.textStyles.map(
              ({ id, name, defaultKind, typography }) => ({
                id,
                name,
                ...(defaultKind === undefined ? {} : { defaultKind }),
                typography,
              }),
            ),
          }
        : {}),
      slides: deck.slideIds.map((id, index) => {
        const { name, section, hidden, templateId } = deck.slideMeta[id];
        return { id, index, name, section, hidden, templateId };
      }),
    },
  };
}

function resolved(projection: DocumentProjection) {
  const { deck, slide, templates = {} } = projection;
  const index = deck.slideIds.indexOf(slide.id);
  if (index < 0)
    throw new AgentProjectionError(
      "UNKNOWN_SLIDE",
      "Projection must identify a presentation slide",
      [slide.id],
    );
  const meta = deck.slideMeta[slide.id];
  if (meta.templateId && !templates[meta.templateId])
    throw new AgentProjectionError(
      "MISSING_TEMPLATE",
      "Required template is unavailable",
      [meta.templateId],
    );
  return { ...resolveVisualSlide(deck, slide, templates), meta, index };
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

function roundedBounds(bounds: Box): Box {
  return {
    x: rounded(bounds.x),
    y: rounded(bounds.y),
    width: rounded(bounds.width),
    height: rounded(bounds.height),
  };
}

function stageReferences(slide: Slide) {
  const motion = new Map<string, number[]>(),
    presence = new Map<string, number[]>();
  for (const [index, stage] of (slide.motion?.stages ?? []).entries()) {
    for (const id of new Set(stage.tracks.map((track) => track.elementId)))
      motion.set(id, [...(motion.get(id) ?? []), index]);
    for (const id of new Set(
      (stage.blocks ?? []).flatMap((block) =>
        block.binding?.kind === "presence" && block.presenceSchedule
          ? [block.binding.elementId]
          : [],
      ),
    ))
      presence.set(id, [...(presence.get(id) ?? []), index]);
  }
  return { motion, presence };
}

/** One derived visual view per call; no cache or mutable presentation ownership. */
function inspectSlide(
  projection: DocumentProjection,
  options: AgentSlideOptions,
) {
  const { deck } = projection;
  const view = resolved(projection);
  const { slide, sources, meta } = view;
  const stages = stageReferences(slide);
  const entries: Array<{ element: Element; outline: AgentElementOutline }> = [];
  for (const [layerIndex, layer] of deck.layers.entries()) {
    const root = slide.nodes[layerIndex];
    const contentWithheld =
      !options.includeHiddenContent && (meta.hidden || layer.hidden);
    const visit = (
      children: readonly Element[],
      parentId: string,
      depth: number,
    ) => {
      for (const [siblingIndex, element] of children.entries()) {
        const source = sources.get(element.id)!;
        const text =
          element.content?.type === "text" && !contentWithheld
            ? element.content
            : null;
        // Retain only the preview while counting code points, even for long text.
        let textLength = 0,
          textPreview = "";
        if (text)
          for (const point of text.text) {
            if (textLength < AGENT_TEXT_PREVIEW_LENGTH) textPreview += point;
            textLength++;
          }
        entries.push({
          element,
          outline: {
            id: element.id,
            ...(element.name !== undefined ? { name: element.name } : {}),
            source,
            ownerPageId: source === "template" ? meta.templateId! : slide.id,
            parentId,
            layerId: layer.id,
            layerIndex,
            depth,
            siblingIndex,
            childCount: element.children.length,
            contentType: element.content?.type ?? null,
            geometryType: element.geometry.type,
            container: element.container,
            clipChildren: element.clipChildren,
            worldBounds: roundedBounds(getWorldBounds(slide, element.id)),
            contentWithheld,
            ...(text
              ? {
                  textPreview,
                  textLength,
                  textTruncated: textLength > AGENT_TEXT_PREVIEW_LENGTH,
                  ...(text.format.kind === "style"
                    ? { textStyleId: text.format.styleId }
                    : {}),
                }
              : {}),
            effectCount: element.effects?.length ?? 0,
            hasMotion: stages.motion.has(element.id),
            hasPresence: stages.presence.has(element.id),
          },
        });
        visit(element.children, element.id, depth + 1);
      }
    };
    visit(root.children, root.id, 0);
  }
  return { ...view, entries, stages };
}

export function projectAgentSlide(
  projection: DocumentProjection,
  options: AgentSlideOptions = {},
): AgentSlideOutline {
  const { slide, meta, index, entries } = inspectSlide(projection, options);
  return {
    ...revision(projection),
    slide: {
      id: slide.id,
      index,
      name: meta.name,
      hidden: meta.hidden,
      templateId: meta.templateId,
      background: slide.background,
      elementCount: entries.length,
    },
    layers: projection.deck.layers.map(
      ({ id, name, hidden, locked, color }) => ({
        id,
        name,
        hidden,
        locked,
        color,
      }),
    ),
    elements: entries.map(({ outline }) => outline),
  };
}

function contentDetail(element: Element, deck: Deck): AgentContentDetail {
  const content = element.content;
  if (!content) return null;
  if (content.type === "text")
    return { ...content, typography: resolveTextTypography(deck, content) };
  return {
    type: content.type,
    assetId: content.assetId,
    mediaType: content.mediaType,
    opacity: content.opacity,
    lockAspect: content.lockAspect,
    transform: content.transform,
    ...(resolveMediaFrame(element)
      ? { contentFrame: resolveMediaFrame(element)! }
      : {}),
    ...(content.type === "video"
      ? {
          playback: {
            autoplay: content.autoplay,
            loop: content.loop,
            mute: content.mute,
            volume: content.volume,
            startTime: content.startTime,
            endTime: content.endTime,
          },
        }
      : {}),
  };
}

function effectDetails(
  element: Element,
  slide: Slide,
  includeSource = false,
): AgentEffectSummary[] {
  return (element.effects ?? []).map((instance) => {
    const definition = slide.effectResources![instance.resourceId];
    const range = effectExecutionRange(slide.motion, element.id, instance.id);
    return {
      id: instance.id,
      resourceId: instance.resourceId,
      enabled: instance.enabled,
      placement: instance.placement,
      // Authored instance values, not a claim about sampled animated values.
      parameters: Object.fromEntries(
        Object.keys(instance.parameters)
          .sort()
          .map((key) => [key, instance.parameters[key]]),
      ),
      name: definition.name,
      kind: definition.kind,
      target: definition.target,
      ...(definition.input !== undefined ? { input: definition.input } : {}),
      motionProperties: numericEffectParameters(definition).map((parameter) =>
        effectProperty(instance.id, parameter.key),
      ),
      ...(includeSource
        ? {
            source: definition.source,
            ...(definition.styleSource === undefined
              ? {}
              : { styleSource: definition.styleSource }),
            parameterContract: effectParameters(definition),
          }
        : {}),
      timing: {
        defaults: definition.timeControl,
        ...(range
          ? { stageIndex: range.stageIndex, schedule: range.schedule }
          : {}),
      },
    };
  });
}

function motionSummary(slide: Slide, elementId: string) {
  return (slide.motion?.stages ?? []).flatMap((stage, stageIndex) => {
    const tracks = stage.tracks.filter((track) => track.elementId === elementId);
    const blocks = (stage.blocks ?? []).filter(
      (block) => block.binding?.elementId === elementId,
    );
    return tracks.length || blocks.length
      ? [
          {
            stageIndex,
            properties: [...new Set(tracks.map((track) => track.property))],
            blockCount: blocks.length,
          },
        ]
      : [];
  });
}

function presenceSummary(slide: Slide, elementId: string) {
  return (slide.motion?.stages ?? []).flatMap((stage, stageIndex) =>
    (stage.blocks ?? []).flatMap((block) =>
      block.binding?.kind === "presence" &&
      block.binding.elementId === elementId &&
      block.presenceSchedule
        ? [{ stageIndex, schedule: structuredClone(block.presenceSchedule) }]
        : [],
    ),
  );
}

function worldTransform(
  slide: Slide,
  element: Element,
): NonNullable<AgentElementDetail["worldTransform"]> {
  const m = getWorldMatrix(slide, element.id);
  return {
    matrix: [
      rounded(m[0]),
      rounded(m[1]),
      rounded(m[2]),
      rounded(m[3]),
      rounded(m[4]),
      rounded(m[5]),
    ],
    corners: [
      { x: 0, y: 0 },
      { x: element.frame.width, y: 0 },
      { x: element.frame.width, y: element.frame.height },
      { x: 0, y: element.frame.height },
    ].map((point) => {
      const world = transformPoint(m, point);
      return { x: rounded(world.x), y: rounded(world.y) };
    }),
  };
}

/** Only explicit IDs are expanded; ordering is visual preorder, not request order. */
export function projectAgentElements(
  projection: DocumentProjection,
  elementIds: readonly string[],
  options: AgentElementOptions = {},
): AgentElementDetails {
  const { slide, entries, stages } = inspectSlide(projection, options);
  const requested = new Set(elementIds);
  const known = new Set(entries.map(({ element }) => element.id));
  const missing = [...requested].filter((id) => !known.has(id)).sort();
  if (missing.length)
    throw new AgentProjectionError(
      "UNKNOWN_ELEMENT",
      "Requested elements are unavailable on this slide",
      missing,
    );
  return structuredClone({
    ...revision(projection),
    slideId: slide.id,
    elements: entries
      .filter(({ element }) => requested.has(element.id))
      .map(({ element, outline }) => ({
        ...outline,
        frame: element.frame,
        appearance: element.appearance,
        geometry: element.geometry,
        cssClasses: [...(element.cssClasses ?? [])],
        ...(!outline.contentWithheld
          ? {
              content: contentDetail(element, projection.deck),
              effects: effectDetails(
                element,
                slide,
                options.includeEffectSource ?? false,
              ),
            }
          : {}),
        motionStageIndices: stages.motion.get(element.id) ?? [],
        presenceStageIndices: stages.presence.get(element.id) ?? [],
        ...(options.includeMotion
          ? { motion: motionSummary(slide, element.id) }
          : {}),
        ...(options.includePresence
          ? { presence: presenceSummary(slide, element.id) }
          : {}),
        ...(options.includeWorldTransform
          ? { worldTransform: worldTransform(slide, element) }
          : {}),
      })),
  });
}
