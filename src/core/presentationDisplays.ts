export interface PresentationDisplayAssignment {
  presenterDisplayId: number;
  audienceDisplayId: number;
}

export interface PresentationDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
  presenter: boolean;
  audience: boolean;
}

export type PresentationView = "presenter" | "audience";

/** Display preferences belong to the runtime, never the document. */
export function resolvePresentationDisplays(
  displays: readonly { id: number }[],
  primaryId: number,
  requested: PresentationDisplayAssignment | null = null,
): PresentationDisplayAssignment {
  const primary =
    displays.find((display) => display.id === primaryId) ?? displays[0];
  if (!primary) throw new Error("No displays available");
  if (
    requested &&
    displays.some((d) => d.id === requested.presenterDisplayId) &&
    displays.some((d) => d.id === requested.audienceDisplayId) &&
    (displays.length === 1 ||
      requested.presenterDisplayId !== requested.audienceDisplayId)
  )
    return requested;
  return {
    presenterDisplayId: primary.id,
    audienceDisplayId:
      displays.find((display) => display.id !== primary.id)?.id ?? primary.id,
  };
}

/** Dropping on the other view swaps it; unassigned screens leave it in place. */
export function assignPresentationView(
  current: PresentationDisplayAssignment,
  view: PresentationView,
  displayId: number,
): PresentationDisplayAssignment {
  const key = view === "audience" ? "audienceDisplayId" : "presenterDisplayId";
  const other =
    view === "audience" ? "presenterDisplayId" : "audienceDisplayId";
  return {
    ...current,
    [key]: displayId,
    [other]: current[other] === displayId ? current[key] : current[other],
  };
}
