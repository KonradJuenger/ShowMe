import {
  withPreviewClock,
  previewInterval,
} from "../../../src/core/motionPlayback";
import {
  parsePackageManifest,
  SHOWME_PACKAGE_FORMAT,
  SHOWME_PACKAGE_DOCUMENT_PATH,
  SHOWME_PACKAGE_VERSION,
} from "../../../src/core/package";
import path from "node:path";
import { storedDocument, storageAt } from "../../helpers/storage";
import { expect, it } from "vitest";
import {
  addPresence,
  defaultPresenceTransition,
  editPresenceSchedule,
  presenceElement,
  sampleElementPresence,
} from "../../../src/core/presence";
import { type PresenceSchedule } from "../../../src/core/motionModel";
import {
  addMotionPreset,
  editMotionBlock,
  cloneMotion,
  filterMotion,
  motionElement,
  resolveMotion,
} from "../../../src/core/motion";
import {
  motionTimelineLayout,
  motionTimelineSpans,
  timelineCursorAt,
  timelineSeekTime,
  resizeTimelineIntervalStart,
} from "../../../src/components/motionTimelineLayout";
import {
  newPresentationDocument,
  presentationDocumentSchema,
  PRESENTATION_FILE_VERSION,
} from "../../../src/core/document";
import { createBasicShape } from "../../../src/core/elementFactory";
import {
  combineMotion,
  duplicateElements,
  removeElements,
  setSlideMotion,
} from "../../../src/core/editorCommands";
import {
  captureElementsClipboard,
  serializeElementsClipboard,
  parseElementsClipboardText,
  pasteElements,
} from "../../../src/core/clipboard";
import {
  createSlideTransferBundle,
  prepareSlideTransferImport,
  parseSlideTransferBundle,
} from "../../../src/core/slideTransfer";
import { effectTiming, filterEffectMotion } from "../../../src/core/effects";
import { editing, insertShape } from "../../helpers/document";

it("Presence start resizing snaps across clicks without extending the source ruler or moving the stop", () => {
  const motion = fixture(0, { mode: "click", stageId: "click-3" });
  const id = motion.stages[0].blocks![0].id;
  const spans = motionTimelineSpans(motion);
  const resized = resizeTimelineIntervalStart(
    motion,
    0,
    id,
    150,
    [100, 100, 100, 100, 100],
    spans,
    true,
  );
  expect(resized.stages[0].blocks).toEqual([]);
  expect(resized.stages[1].blocks![0].presenceSchedule).toMatchObject({
    startOffsetMs: 0,
    end: { mode: "click", stageId: "click-3" },
  });
  expect(motionTimelineSpans(resized)[0]).toBe(spans[0]);
  expect(motion.stages[0].blocks![0].presenceSchedule!.startOffsetMs).toBe(0);
  const near = resizeTimelineIntervalStart(
    motion,
    0,
    id,
    95,
    [100, 100, 100, 100, 100],
    spans,
    true,
  );
  expect(near.stages[1].blocks![0].presenceSchedule!.startOffsetMs).toBe(0);
  const free = resizeTimelineIntervalStart(
    motion,
    0,
    id,
    150,
    [100, 100, 100, 100, 100],
    spans,
    false,
  );
  expect(free.stages[1].blocks![0].presenceSchedule!.startOffsetMs).toBe(500);
});

it("Presence start resizing backwards preserves a relative stop's original click", () => {
  const motion = fixture(2, { mode: "next-click" });
  const id = motion.stages[2].blocks![0].id;
  const resized = resizeTimelineIntervalStart(
    motion,
    2,
    id,
    150,
    [100, 100, 100, 100, 100],
    motionTimelineSpans(motion),
    true,
  );
  expect(resized.stages[1].blocks![0].presenceSchedule).toMatchObject({
    startOffsetMs: 0,
    end: { mode: "click", stageId: "click-3" },
  });
  const clamped = resizeTimelineIntervalStart(
    motion,
    2,
    id,
    350,
    [100, 100, 100, 100, 100],
    motionTimelineSpans(motion),
    true,
  );
  expect(clamped.stages[3].blocks ?? []).toHaveLength(0);
  expect(motionTimelineSpans(clamped)[2]).toBe(motionTimelineSpans(motion)[2]);
  expect(clamped.stages[2].blocks![0].presenceSchedule!.end).toEqual({
    mode: "next-click",
  });
});

it("Timed Presence start resizing holds its stop fixed and snaps to its own click", () => {
  let motion = fixture(1, { mode: "after", durationMs: 600 });
  const id = motion.stages[1].blocks![0].id;
  motion = editPresenceSchedule(motion, 1, id, (s) => {
    s.startOffsetMs = 200;
  });
  const resized = resizeTimelineIntervalStart(
    motion,
    1,
    id,
    105,
    [100, 100, 100, 100, 100],
    motionTimelineSpans(motion),
    true,
  );
  expect(resized.stages[1].blocks![0].presenceSchedule).toMatchObject({
    startOffsetMs: 0,
    end: { mode: "after", durationMs: 800 },
  });
});

function fixture(start = 1, end: PresenceSchedule["end"] = { mode: "none" }) {
  let m = addPresence(
    { stages: [0, 1, 2, 3, 4].map((i) => ({ id: `click-${i}`, tracks: [] })) },
    start,
    ["element"],
  );
  m = editPresenceSchedule(m, start, m.stages[start].blocks![0].id, (s) => {
    s.end = end;
  });
  return m;
}
it("Presence is discrete, optional and remains present indefinitely with End None", () => {
  expect(sampleElementPresence(undefined, "element", 0, 0).present).toBe(true);
  const m = fixture();
  expect(sampleElementPresence(m, "element", 0, 10000).present).toBe(false);
  expect(sampleElementPresence(m, "element", 1, 0).present).toBe(true);
  expect(sampleElementPresence(m, "element", 4, 999999).present).toBe(true);
  expect(m.stages[1].tracks).toEqual([]);
});
it("Enter Rotate samples the canonical recipe while renderable and composes after Animate", () => {
  const element = createBasicShape("element", "rectangle"),
    doc = newPresentationDocument("Presence");
  const slide = doc.slides[doc.deck.slideIds[0]];
  slide.nodes[0].children = [element];
  const m = fixture();
  m.stages[1].blocks![0].presenceSchedule!.enterTransition = {
    ...defaultPresenceTransition("rotate"),
    easing: "linear",
  };
  slide.motion = addMotionPreset(m, 1, [element.id], "Move");
  const zero = sampleElementPresence(slide.motion, element.id, 1, 0);
  expect(zero).toMatchObject({
    present: true,
    phase: "entering",
    transitionProgress: 0,
  });
  expect(presenceElement(element, zero).frame.rotation).toBe(
    element.frame.rotation - 25,
  );
  const half = sampleElementPresence(slide.motion, element.id, 1, 200);
  const animated = motionElement(element, resolveMotion(slide, 1, 200));
  expect(presenceElement(animated, half).frame.x).toBe(animated.frame.x);
  expect(presenceElement(animated, half).frame.rotation).toBe(
    animated.frame.rotation - 12.5,
  );
  expect(sampleElementPresence(slide.motion, element.id, 1, 400).phase).toBe(
    "present",
  );
});
it("Click End starts Exit and absence follows the full duration, including backward seeking", () => {
  const m = fixture(0, { mode: "next-click" });
  m.stages[0].blocks![0].presenceSchedule!.exitTransition = {
    ...defaultPresenceTransition("move"),
    easing: "linear",
  };
  expect(sampleElementPresence(m, "element", 0, 9000).phase).toBe("present");
  expect(sampleElementPresence(m, "element", 1, 0)).toMatchObject({
    present: true,
    phase: "exiting",
    transitionProgress: 0,
  });
  expect(sampleElementPresence(m, "element", 1, 200)).toMatchObject({
    present: true,
    phase: "exiting",
    transitionProgress: 0.5,
  });
  expect(sampleElementPresence(m, "element", 1, 400).present).toBe(false);
  expect(sampleElementPresence(m, "element", 0, 200).present).toBe(true);
  expect(sampleElementPresence(m, "element", 1, 100).transitionProgress).toBe(
    0.25,
  );
});
it("Timed End triggers Exit after duration; End None never runs an authored Exit", () => {
  const m = fixture(0, { mode: "after", durationMs: 2000 });
  const s = m.stages[0].blocks![0].presenceSchedule!;
  s.exitTransition = defaultPresenceTransition("fade");
  expect(sampleElementPresence(m, "element", 0, 1999).phase).toBe("present");
  expect(sampleElementPresence(m, "element", 0, 2200).phase).toBe("exiting");
  expect(sampleElementPresence(m, "element", 0, 2400).present).toBe(false);
  s.end = { mode: "none" };
  expect(sampleElementPresence(m, "element", 4, 99999).phase).toBe("present");
});
it("Repeated Presence intervals reconstruct independently and reject overlap including exit tails", () => {
  let m = fixture(1, { mode: "click", stageId: "click-2" });
  m = addPresence(m, 4, ["element"]);
  expect(
    [0, 1, 2, 3, 4].map(
      (i) => sampleElementPresence(m, "element", i, 0).present,
    ),
  ).toEqual([false, true, false, false, true]);
  expect(sampleElementPresence(m, "element", 1, 0).present).toBe(true);
  expect(() => addPresence(m, 2, ["element"])).toThrow(/overlap/);
  const first = fixture(1, { mode: "next-click" });
  first.stages[1].blocks![0].presenceSchedule!.exitTransition =
    defaultPresenceTransition("fade");
  expect(() => addPresence(first, 2, ["element"])).toThrow(/overlap/);
});
it("Recorded past click origins preserve transitions across early clicks and slide re-entry resets Enter", () => {
  const m = fixture(0, { mode: "click", stageId: "click-2" });
  m.stages[0].blocks![0].presenceSchedule!.enterTransition =
    defaultPresenceTransition("fade");
  expect(
    sampleElementPresence(m, "element", 1, 100, {
      slideTime: 0.2,
      presentationTime: 18.4,
      stepTime: 0.1,
      stageStarts: [0, 0.1],
    }).phase,
  ).toBe("entering");
  expect(sampleElementPresence(m, "element", 0, 0).transitionProgress).toBe(0);
});
it("Presence leaves independent presentation-relative Effect time intact when reappearing", () => {
  const m = addPresence(fixture(1, { mode: "next-click" }), 4, ["element"]);
  const clocks = {
    presentationTime: 18.4,
    slideTime: 3.4,
    stepTime: 0.4,
    stageStarts: [0, 1, 2, 2.5, 3],
  };
  expect(sampleElementPresence(m, "element", 4, 400, clocks).present).toBe(
    true,
  );
  expect(
    effectTiming(m, 4, 400, "element", "shader", clocks, {
      start: "presentation",
      stop: { mode: "none" },
    }).time,
  ).toBe(18.4);
});
it("Presence uses shared end geometry and keeps the click marker before the exit tail", () => {
  const m = fixture(1, { mode: "click", stageId: "click-3" }),
    block = m.stages[1].blocks![0];
  block.presenceSchedule!.exitTransition = defaultPresenceTransition("fade");
  const layout = () =>
    motionTimelineLayout(
      m,
      [100, 100, 100, 100, 100],
      [1000, 1000, 1000, 1000, 1000],
    ).get(block.id)!;
  expect(layout()).toMatchObject({
    left: 0,
    width: 240,
    end: "click",
    triggerOffset: 200,
  });
  block.presenceSchedule!.end = { mode: "next-click" };
  expect(layout()).toMatchObject({ width: 140, triggerOffset: 100 });
  block.presenceSchedule!.end = { mode: "after", durationMs: 500 };
  expect(layout()).toMatchObject({ width: 90, end: "timed" });
  block.presenceSchedule!.end = { mode: "none" };
  expect(layout()).toMatchObject({ width: 400, end: "continuous" });
  block.presenceSchedule!.end = { mode: "slide-end" };
  expect(layout()).toMatchObject({ width: 400, end: "continuous" });
});
it("Presence ownership and clicked End remap through clone/combine and filter with Elements", () => {
  const m = fixture(1, { mode: "click", stageId: "click-3" });
  const copy = cloneMotion(m, new Map([["element", "copy"]]))!;
  const combined = combineMotion(m, copy);
  expect(combined.stages[1].blocks![1]).toMatchObject({
    binding: { kind: "presence", elementId: "copy" },
    presenceSchedule: { end: { stageId: "click-3" } },
  });
  expect(
    filterMotion(combined, new Set(["copy"]))!.stages[1].blocks,
  ).toHaveLength(1);
  expect(
    filterEffectMotion(m, [createBasicShape("element", "rectangle")], {})!
      .stages[1].blocks,
  ).toHaveLength(1);
});
it("Element duplication, clipboard paste, slide transfer and deletion preserve Presence through semantic mutations", async () => {
  const { session, runtime } = await editing();
  const shape = await insertShape(session, "element");
  session.apply(
    setSlideMotion(
      session.snapshot!,
      fixture(1, { mode: "click", stageId: "click-3" }),
    ),
  );
  await session.flush();
  let serial = 0;
  const duplicate = duplicateElements(
    session.snapshot!,
    [shape.id],
    () => `copy-${serial++}`,
  );
  expect(duplicate.slide.motion!.stages[1].blocks).toHaveLength(2);
  const payload = captureElementsClipboard(session.snapshot!, {
    scopeId: session.snapshot!.slide.nodes[0].id,
    elementIds: [shape.id],
  })!;
  const parsed = parseElementsClipboardText(
    serializeElementsClipboard(payload),
  )!;
  const pasted = pasteElements(
    session.snapshot!,
    session.snapshot!.slide.nodes[0].id,
    parsed,
    () => `paste-${serial++}`,
  );
  expect(pasted.snapshot.slide.motion!.stages[1].blocks).toHaveLength(2);
  const bundle = createSlideTransferBundle(
    session.snapshot!.deck.id,
    session.snapshot!.deck,
    [session.snapshot!.slide],
    runtime.authority.document.templates,
  );
  expect(parseSlideTransferBundle(bundle).slides[0].slide.motion).toEqual(
    session.snapshot!.slide.motion,
  );
  expect(bundle.version).toBe(1);
  expect(() => parseSlideTransferBundle({ ...bundle, version: 2 })).toThrow();
  expect(
    parseElementsClipboardText(
      "show-me-elements:v2:" + JSON.stringify({ ...payload, version: 2 }),
    ),
  ).toBeNull();
  const imported = prepareSlideTransferImport(bundle, session.snapshot!.deck);
  const bound = imported.slides[0].motion!.stages[1].blocks![0];
  expect(bound.binding!.elementId).toBe(
    imported.slides[0].nodes[0].children[0].id,
  );
  expect(bound.presenceSchedule!.end).toEqual({
    mode: "click",
    stageId: imported.slides[0].motion!.stages[3].id,
  });
  expect(
    removeElements(session.snapshot!, [shape.id]).slide.motion!.stages[1]
      .blocks,
  ).toEqual([]);
});
it("Current Presence round-trips and unsupported presentations are rejected", () => {
  const doc = newPresentationDocument("Presence"),
    slide = doc.slides[doc.deck.slideIds[0]];
  slide.nodes[0].children = [createBasicShape("element", "rectangle")];
  slide.motion = fixture();
  expect(
    presentationDocumentSchema.parse(JSON.parse(JSON.stringify(doc))),
  ).toEqual(doc);
  expect(
    presentationDocumentSchema.safeParse({ ...doc, version: 2 }).success,
  ).toBe(false);
  expect(
    presentationDocumentSchema.safeParse({
      ...doc,
      deck: { ...doc.deck, version: 2 },
    }).success,
  ).toBe(false);
});

it("Accepted Presence survives durable recovery, save and portable package through the same authority", async () => {
  const { root, storage, session, id } = await storedDocument();
  await insertShape(session, "element");
  const m = fixture(1, { mode: "click", stageId: "click-3" });
  session.apply(setSlideMotion(session.snapshot!, m));
  await session.flush();
  expect(session.lastError).toBeNull();
  const restarted = await storageAt(root);
  const recovered = await restarted.recoverUntitled(id);
  expect(
    restarted.documentRuntime(recovered.id).authority.document.slides[
      session.snapshot!.slide.id
    ].motion,
  ).toEqual(m);
  const saved = path.join(root, "Presence.sme");
  await storage.saveDocument(id, saved);
  const reader = await storageAt(root, "reader"),
    opened = await reader.openDocument(saved);
  expect(
    reader.documentRuntime(opened.id).authority.document.slides[
      session.snapshot!.slide.id
    ].motion,
  ).toEqual(m);
  const packed = path.join(root, "Presence.smp");
  await storage.packageDocument(id, packed);
  const destination = await storageAt(root, "destination"),
    imported = await destination.openPackage(packed);
  expect(
    destination.documentRuntime(imported.id).authority.document.slides[
      session.snapshot!.slide.id
    ].motion,
  ).toEqual(m);
});

it("Free scrubbing samples all displayed local time independently of finite Motion duration", () => {
  const m = addMotionPreset(undefined, 0, ["element"], "Move");
  m.stages.push({ id: "empty", tracks: [] });
  expect(motionTimelineSpans(m)).toEqual([1000, 1000]);
  expect(timelineSeekTime(m, 0, 750)).toBe(750);
  expect(timelineCursorAt(75, [100, 100], [1000, 1000])).toEqual({
    stageIndex: 0,
    time: 750,
  });
  expect(timelineCursorAt(175, [100, 100], [1000, 1000])).toEqual({
    stageIndex: 1,
    time: 750,
  });
  expect(timelineCursorAt(25, [100, 100], [1000, 1000])).toEqual({
    stageIndex: 0,
    time: 250,
  });
  expect(timelineSeekTime(m, 1, 1000)).toBe(1000);
});

it("Current package manifests validate and unsupported versions are rejected", () => {
  const manifest = parsePackageManifest({
    format: SHOWME_PACKAGE_FORMAT,
    packageVersion: SHOWME_PACKAGE_VERSION,
    documentVersion: PRESENTATION_FILE_VERSION,
    sourceDocumentId: "source",
    documentName: "Presence",
    documentPath: SHOWME_PACKAGE_DOCUMENT_PATH,
    createdAt: "2026-10-10T00:00:00.000Z",
    lockMediaFiles: false,
    assets: [],
  });
  expect(() =>
    parsePackageManifest({
      ...manifest,
      packageVersion: 2,
      documentVersion: 2,
    }),
  ).toThrow();
  expect(manifest.packageVersion).toBe(SHOWME_PACKAGE_VERSION);
  expect(manifest.documentVersion).toBe(PRESENTATION_FILE_VERSION);
});

it("Preview origins record reached gates only and retain actual waits when advancing", () => {
  const stages = [
    { id: "start", duration: 400 },
    { id: "one", duration: 0 },
    { id: "two", duration: 400 },
  ];
  const first = withPreviewClock(
    null,
    {
      stageId: "start",
      stageIndex: 0,
      time: 750,
      startedAt: 0,
      running: false,
    },
    stages,
    0,
  )!;
  expect(first.effectClock!.stageStarts).toEqual([0]);
  const next = withPreviewClock(
    first,
    { stageId: "one", stageIndex: 1, time: 0, startedAt: 0, running: false },
    stages,
    0,
  )!;
  expect(next.effectClock!.stageStarts).toEqual([0, 750]);
  expect(next.effectClock!.stageStart).toBe(750);
});

it("Early click Exit starts at the sampled halfway Enter envelope for every transition family", () => {
  const element = createBasicShape("element", "rectangle");
  for (const kind of ["fade", "move", "scale", "rotate"] as const) {
    const m = fixture(0, { mode: "next-click" });
    const s = m.stages[0].blocks![0].presenceSchedule!;
    s.enterTransition = {
      ...defaultPresenceTransition(kind),
      easing: "linear",
    };
    s.exitTransition = { ...defaultPresenceTransition(kind), easing: "linear" };
    const before = presenceElement(
      element,
      sampleElementPresence(m, element.id, 0, 200),
    );
    const at = presenceElement(
      element,
      sampleElementPresence(m, element.id, 1, 0, {
        slideTime: 0.2,
        presentationTime: 0.2,
        stageStarts: [0, 0.2],
      }),
    );
    expect(at.frame).toEqual(before.frame);
    expect(at.appearance.opacity).toBeCloseTo(0.5);
    const half = presenceElement(
      element,
      sampleElementPresence(m, element.id, 1, 200, {
        slideTime: 0.4,
        presentationTime: 0.4,
        stageStarts: [0, 0.2],
      }),
    );
    expect(half.appearance.opacity).toBeCloseTo(0.25);
  }
});
it("New Enter supersedes the old Exit at one quarter of its duration without reviving it", () => {
  let m = fixture(0, { mode: "next-click" });
  m.stages[0].blocks![0].presenceSchedule!.exitTransition = {
    ...defaultPresenceTransition("fade"),
    easing: "linear",
  };
  m = addPresence(m, 2, ["element"]);
  const s = m.stages[2].blocks![0].presenceSchedule!;
  s.end = { mode: "after", durationMs: 100 };
  s.enterTransition = {
    ...defaultPresenceTransition("fade"),
    easing: "linear",
  };
  const clocks = {
    slideTime: 0.3,
    presentationTime: 0.3,
    stageStarts: [0, 0.2, 0.3],
  };
  expect(
    sampleElementPresence(m, "element", 1, 100, clocks).transitionProgress,
  ).toBeCloseTo(0.25);
  expect(sampleElementPresence(m, "element", 2, 0, clocks)).toMatchObject({
    phase: "entering",
    transitionProgress: 0,
  });
  expect(
    sampleElementPresence(m, "element", 2, 100, { ...clocks, slideTime: 0.4 })
      .present,
  ).toBe(false);
});
it("New click Enter supersedes an older timed interval that is still active", () => {
  let m = fixture(0, { mode: "after", durationMs: 2000 });
  m = addPresence(m, 1, ["element"]);
  m.stages[1].blocks![0].presenceSchedule!.enterTransition = {
    ...defaultPresenceTransition("fade"),
    easing: "linear",
  };
  expect(
    sampleElementPresence(m, "element", 1, 100, {
      slideTime: 0.6,
      presentationTime: 0.6,
      stageStarts: [0, 0.5],
    }),
  ).toMatchObject({ phase: "entering", transitionProgress: 0.25 });
});
it("Presence rejects generic duplication and Slide end transitions", () => {
  const m = fixture();
  expect(() =>
    editMotionBlock(m, 1, m.stages[1].blocks![0].id, 2, 50, 100, true),
  ).toThrow(/another Presence/);
  expect(m.stages[1].blocks![0].presenceSchedule!.startOffsetMs).toBe(0);
  expect(() =>
    editPresenceSchedule(m, 1, m.stages[1].blocks![0].id, (s) => {
      s.end = { mode: "slide-end" };
      s.exitTransition = defaultPresenceTransition("fade");
    }),
  ).toThrow(/Exit None/);
});
it("Preview ignores past linked ends and retains only the finite current Exit tail", () => {
  const m = fixture(0, { mode: "next-click" });
  m.stages[0].blocks![0].presenceSchedule!.exitTransition =
    defaultPresenceTransition("fade");
  const state = {
    stageId: "click-1",
    stageIndex: 1,
    time: 100,
    running: false,
    startedAt: 0,
    effectClock: { stageStart: 200, stageStarts: [0, 200] },
  };
  expect(previewInterval(m, state, 0)).toEqual({ waits: false, duration: 400 });
  expect(
    previewInterval(
      m,
      {
        ...state,
        stageIndex: 3,
        stageId: "click-3",
        effectClock: { stageStart: 1000, stageStarts: [0, 200, 800, 1000] },
      },
      0,
    ),
  ).toEqual({ waits: false, duration: 0 });
  const fx = {
    id: "fx",
    label: "Effect",
    binding: {
      kind: "effect" as const,
      elementId: "element",
      effectInstanceId: "instance",
    },
    members: [],
    effectSchedule: {
      version: 1 as const,
      start: "click" as const,
      startOffsetMs: 0,
      stop: { mode: "next-click" as const },
    },
  };
  m.stages[0].blocks!.push(fx);
  expect(previewInterval(m, state, 0).waits).toBe(false);
});
