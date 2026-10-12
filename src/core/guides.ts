import {
  guideSetSchema,
  type GuideSet,
  type ManualGuide,
} from "./guideModel";
import { uid } from "./ids";
import type { EditorSnapshot } from "./editorCommands";
import { flattenElements, locateElement } from "./scene";
import { elementWorldGeometry } from "./selectionGeometry";

import type { Deck } from "./document";
export type { Deck };

export type GuideAxis = ManualGuide["axis"];
export interface ResolvedGuide {
  axis: GuideAxis;
  position: number;
  source: "generated" | "manual";
  id?: string;
}

export interface GuideSetDraft {
  name: string;
  margins: GuideSet["margins"];
  columns: GuideSet["columns"];
  rows: GuideSet["rows"];
  manualGuides: ManualGuide[];
}

export const emptyGuideSetDraft = (name = "Default Guides"): GuideSetDraft => ({
  name,
  margins: null,
  columns: null,
  rows: null,
  manualGuides: [],
});

const uniqueSorted = (values: number[]) =>
  [...new Set(values.map((value) => Math.round(value * 1e9) / 1e9))].sort(
    (a, b) => a - b,
  );

export function validateGuideSetGeometry(
  guideSet: Pick<GuideSet, "margins" | "columns" | "rows">,
  width: number,
  height: number,
): string | null {
  const margins = guideSet.margins ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const availableWidth = width - margins.left - margins.right,
    availableHeight = height - margins.top - margins.bottom;
  if (availableWidth < 0) return "Left and right margins exceed slide width";
  if (availableHeight < 0) return "Top and bottom margins exceed slide height";
  if (guideSet.columns) {
    const gutters =
      Math.max(0, guideSet.columns.count - 1) * guideSet.columns.gutter;
    if (gutters > availableWidth)
      return "Column gutters exceed available width";
  }
  if (guideSet.rows) {
    const gutters = Math.max(0, guideSet.rows.count - 1) * guideSet.rows.gutter;
    if (gutters > availableHeight) return "Row gutters exceed available height";
  }
  return null;
}

export function deriveGuides(
  guideSet: GuideSet,
  width: number,
  height: number,
): ResolvedGuide[] {
  const error = validateGuideSetGeometry(guideSet, width, height);
  if (error) throw new Error(error);
  const vertical: number[] = [],
    horizontal: number[] = [],
    margins = guideSet.margins ?? { top: 0, right: 0, bottom: 0, left: 0 };

  if (guideSet.margins) {
    vertical.push(margins.left, width - margins.right);
    horizontal.push(margins.top, height - margins.bottom);
  }

  if (guideSet.columns) {
    const { count, gutter } = guideSet.columns,
      available = width - margins.left - margins.right,
      columnWidth = (available - (count - 1) * gutter) / count;
    for (let index = 0; index < count; index++) {
      const start = margins.left + index * (columnWidth + gutter);
      vertical.push(start, start + columnWidth);
    }
  }

  if (guideSet.rows) {
    const { count, gutter } = guideSet.rows,
      available = height - margins.top - margins.bottom,
      rowHeight = (available - (count - 1) * gutter) / count;
    for (let index = 0; index < count; index++) {
      const start = margins.top + index * (rowHeight + gutter);
      horizontal.push(start, start + rowHeight);
    }
  }

  const guides: ResolvedGuide[] = [
    ...uniqueSorted(vertical).map((position) => ({
      axis: "vertical" as const,
      position,
      source: "generated" as const,
    })),
    ...uniqueSorted(horizontal).map((position) => ({
      axis: "horizontal" as const,
      position,
      source: "generated" as const,
    })),
    ...guideSet.manualGuides.map((guide) => ({
      axis: guide.axis,
      position: guide.position,
      source: "manual" as const,
      id: guide.id,
    })),
  ];

  // A manual guide can land exactly on a generated grid line. Rendering both
  // makes a one-pixel guide look doubled, so collapse coincident lines and
  // keep the manual one because it remains draggable.
  const unique = new Map<string, ResolvedGuide>();
  for (const guide of guides) {
    const key = `${guide.axis}:${Math.round(guide.position * 1e6)}`,
      previous = unique.get(key);
    if (!previous || guide.source === "manual") unique.set(key, guide);
  }
  return [...unique.values()];
}

export function resolveGuideSetId(deck: Deck): string | null {
  return deck.defaultGuideSetId;
}

export function resolveGuideSet(deck: Deck): GuideSet | null {
  const id = resolveGuideSetId(deck);
  return id ? (deck.guideSets[id] ?? null) : null;
}

export function resolveGuides(deck: Deck): ResolvedGuide[] {
  const guideSet = resolveGuideSet(deck);
  return guideSet ? deriveGuides(guideSet, deck.width, deck.height) : [];
}

function checked<T extends Deck>(deck: T): T {
  return deck;
}

export function createGuideSet(
  deck: Deck,
  draft: GuideSetDraft,
  options: { id?: string; makeDefault?: boolean } = {},
): { deck: Deck; guideSet: GuideSet } {
  const guideSet = guideSetSchema.parse({ ...draft, id: options.id ?? uid() });
  const error = validateGuideSetGeometry(guideSet, deck.width, deck.height);
  if (error) throw new Error(error);
  const next = checked({
    ...deck,
    guideSets: { ...deck.guideSets, [guideSet.id]: guideSet },
    defaultGuideSetId: options.makeDefault
      ? guideSet.id
      : deck.defaultGuideSetId,
  });
  return { deck: next, guideSet };
}

export function updateGuideSet(
  deck: Deck,
  guideSetId: string,
  patch: Partial<Omit<GuideSet, "id">>,
): Deck {
  const current = deck.guideSets[guideSetId];
  if (!current) throw new Error("GuideSet not found");
  const guideSet = guideSetSchema.parse({
    ...current,
    ...patch,
    id: guideSetId,
  });
  const error = validateGuideSetGeometry(guideSet, deck.width, deck.height);
  if (error) throw new Error(error);
  return checked({
    ...deck,
    guideSets: { ...deck.guideSets, [guideSetId]: guideSet },
  });
}

export function deleteGuideSet(deck: Deck, guideSetId: string): Deck {
  if (!deck.guideSets[guideSetId]) return deck;
  const guideSets = { ...deck.guideSets };
  delete guideSets[guideSetId];
  return checked({
    ...deck,
    guideSets,
    defaultGuideSetId:
      deck.defaultGuideSetId === guideSetId ? null : deck.defaultGuideSetId,
  });
}

export function setDefaultGuideSet(
  deck: Deck,
  guideSetId: string | null,
): Deck {
  if (guideSetId !== null && !deck.guideSets[guideSetId])
    throw new Error("GuideSet not found");
  return checked({ ...deck, defaultGuideSetId: guideSetId });
}

export function clearGuides(deck: Deck): Deck {
  return checked({
    ...deck,
    guideSets: {},
    defaultGuideSetId: null,
  });
}

export function addManualGuide(
  deck: Deck,
  guideSetId: string,
  axis: GuideAxis,
  position: number,
  id = uid(),
): { deck: Deck; guide: ManualGuide } {
  const guide = { id, axis, position };
  return {
    deck: updateGuideSet(deck, guideSetId, {
      manualGuides: [
        ...(deck.guideSets[guideSetId]?.manualGuides ?? []),
        guide,
      ],
    }),
    guide,
  };
}

export function moveManualGuide(
  deck: Deck,
  guideSetId: string,
  guideId: string,
  position: number,
): Deck {
  const guideSet = deck.guideSets[guideSetId];
  if (!guideSet) throw new Error("GuideSet not found");
  let found = false;
  const manualGuides = guideSet.manualGuides.map((guide) => {
    if (guide.id !== guideId) return guide;
    found = true;
    return { ...guide, position };
  });
  if (!found) throw new Error("Manual guide not found");
  return updateGuideSet(deck, guideSetId, { manualGuides });
}

export function removeManualGuide(
  deck: Deck,
  guideSetId: string,
  guideId: string,
): Deck {
  const guideSet = deck.guideSets[guideSetId];
  if (!guideSet) throw new Error("GuideSet not found");
  return updateGuideSet(deck, guideSetId, {
    manualGuides: guideSet.manualGuides.filter((guide) => guide.id !== guideId),
  });
}

export function guideSnapTargets(
  snapshot: EditorSnapshot,
  axis: GuideAxis,
  options: {
    guides: boolean;
    slide: boolean;
    objects: boolean;
    excludeGuideId?: string;
  },
): number[] {
  const persistent = options.guides
    ? resolveGuides(snapshot.deck)
        .filter(
          (guide) =>
            guide.axis === axis &&
            (!options.excludeGuideId || guide.id !== options.excludeGuideId),
        )
        .map((guide) => guide.position)
    : [];
  const slide = options.slide
    ? axis === "vertical"
      ? [0, snapshot.deck.width / 2, snapshot.deck.width]
      : [0, snapshot.deck.height / 2, snapshot.deck.height]
    : [];
  const hiddenLayers = new Set(
    snapshot.deck.layers.filter((layer) => layer.hidden).map((layer) => layer.id),
  );
  const objects = options.objects
    ? flattenElements(snapshot.slide).flatMap((element) => {
        const location = locateElement(snapshot.slide, element.id);
        if (!location || hiddenLayers.has(location.layerId)) return [];
        const box = elementWorldGeometry(snapshot.slide, element.id);
        return axis === "vertical"
          ? [box.x, box.x + box.width / 2, box.x + box.width]
          : [box.y, box.y + box.height / 2, box.y + box.height];
      })
    : [];
  return [...persistent, ...slide, ...objects];
}

