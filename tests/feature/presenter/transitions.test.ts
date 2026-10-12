import { expect, it } from "vitest";
import { parseRuntimeDocument } from "../../../src/core/documentRuntime";
import { newPresentationDocument } from "../../../src/core/document";
import {
  applyPresentationCommand,
  startSession,
} from "../../../src/core/presentationSession";
import { resolveSlideTransition } from "../../../src/core/slideTransitions";
import {
  duplicateSlide,
  reorderSlides,
  updateSlideMeta,
  setDeckProperties,
} from "../../../src/core/editorCommands";
import {
  createSlideTransferBundle,
  parseSlideTransferBundle,
} from "../../../src/core/slideTransfer";
import { createPowerPoint } from "../../../electron/export/pptx";
import { editing } from "../../helpers/document";

function transitionDeck() {
  const deck = newPresentationDocument("Transitions").deck;
  deck.slideIds = ["a", "hidden", "b", "c"];
  deck.slideMeta = Object.fromEntries(
    deck.slideIds.map((id) => [
      id,
      {
        name: id,
        section: "",
        hidden: id === "hidden",
        templateId: null,
        transition: { kind: "fade" as const },
      },
    ]),
  );
  return deck;
}
it("presentation transition defaults persist through guarded undo and redo", async () => {
  const { session, runtime } = await editing();
  session.apply(
    setDeckProperties(session.snapshot!, {
      transitionDefaults: { kind: "fade", durationMs: 800, easing: "ease-out" },
    }),
  );
  await session.flush();
  expect(runtime.authority.document.deck.transitionDefaults).toEqual({
    kind: "fade",
    durationMs: 800,
    easing: "ease-out",
  });
  expect(
    parseRuntimeDocument(JSON.stringify(runtime.authority.document)).deck
      .transitionDefaults,
  ).toEqual(runtime.authority.document.deck.transitionDefaults);
  session.undo();
  await session.flush();
  expect(runtime.authority.document.deck.transitionDefaults).toEqual({
    kind: "none",
    durationMs: 100,
    easing: "linear",
  });
  session.undo(true);
  await session.flush();
  expect(runtime.authority.document.deck.transitionDefaults.kind).toBe("fade");
});
it("None is the default and Fade inherits 100 ms with slide overrides", () => {
  expect(resolveSlideTransition(undefined)).toEqual({
    kind: "none",
    durationMs: 100,
    easing: "linear",
  });
  expect(resolveSlideTransition({ kind: "fade" })).toEqual({
    kind: "fade",
    durationMs: 100,
    easing: "linear",
  });
  expect(
    resolveSlideTransition(
      { kind: "push", durationMs: 250 },
      { kind: "fade", durationMs: 500, easing: "ease" },
    ),
  ).toEqual({ kind: "push", durationMs: 250, easing: "ease" });
});
it("only normal forward visible-slide progression selects the incoming transition", () => {
  const deck = transitionDeck();
  const start = startSession(
    { deckId: deck.id, slideIds: [], index: null },
    deck,
    1000,
  );
  expect(start.transition).toBeUndefined();
  const next = applyPresentationCommand(start, { type: "next" }, 1100);
  expect(next.transition).toMatchObject({
    fromSlideId: "a",
    toSlideId: "b",
    startedAt: 1100,
    kind: "fade",
  });
  expect(
    applyPresentationCommand(next, { type: "previous" }, 1200).transition,
  ).toBeUndefined();
  expect(
    applyPresentationCommand(start, { type: "jump", index: 1 }, 1200)
      .transition,
  ).toBeUndefined();
  expect(
    applyPresentationCommand(start, { type: "last" }, 1200).transition,
  ).toBeUndefined();
  const last = applyPresentationCommand(start, { type: "last" }, 1200);
  expect(
    applyPresentationCommand(last, { type: "next" }, 1300).transition,
  ).toBeUndefined();
  expect(startSession(next, deck, 1400).transition).toBeUndefined();
});
it("audience readiness establishes one shared transition clock and pause preserves it", () => {
  const deck = transitionDeck();
  const start = startSession(
    { deckId: deck.id, slideIds: [], index: null },
    deck,
    1000,
    undefined,
    true,
  );
  const next = applyPresentationCommand(start, { type: "next" }, 1100);
  expect(next.transition?.startedAt).toBeUndefined();
  const ready = applyPresentationCommand(
    next,
    {
      type: "audience-ready",
      slideId: "b",
      sessionStartedAt: 1000,
      motionStartedAt: 1100,
    },
    1500,
  );
  expect(ready.transition?.startedAt).toBe(1500);
  expect(JSON.parse(JSON.stringify(ready)).transition).toEqual(
    ready.transition,
  );
  const paused = applyPresentationCommand(
    ready,
    { type: "toggle-pause" },
    1520,
  );
  const resumed = applyPresentationCommand(
    paused,
    { type: "toggle-pause" },
    2020,
  );
  expect(resumed.transition?.startedAt).toBe(2000);
});
it("incoming ownership survives duplicate, reorder and slide transfer, and PPTX reports omission", async () => {
  const { session, runtime } = await editing();
  let snapshot = updateSlideMeta(
    session.snapshot!,
    session.snapshot!.slide.id,
    { transition: { kind: "wipe", durationMs: 300 } },
  );
  snapshot = duplicateSlide(
    snapshot,
    snapshot.slide,
    "copy",
    snapshot.deck.slideMeta[snapshot.slide.id],
  );
  snapshot = reorderSlides(snapshot, "copy", null);
  expect(snapshot.deck.slideMeta.copy.transition).toEqual({
    kind: "wipe",
    durationMs: 300,
  });
  const bundle = createSlideTransferBundle(
    snapshot.deck.id,
    snapshot.deck,
    [snapshot.slide],
    snapshot.templates,
  );
  expect(parseSlideTransferBundle(bundle).slides[0].meta.transition).toEqual({
    kind: "wipe",
    durationMs: 300,
    easing: "linear",
  });
  session.apply(snapshot);
  await session.flush();
  const { warnings } = await createPowerPoint(
    {
      deck: runtime.authority.document.deck,
      slides: Object.values(runtime.authority.document.slides),
    },
    async () => null,
  );
  expect(warnings).toContainEqual(
    expect.objectContaining({
      slideId: "copy",
      code: "slide-transition-omitted",
    }),
  );
});

it("slides inherit transition kind and timing independently with explicit None overrides", () => {
  const defaults = {
    kind: "fade" as const,
    durationMs: 800,
    easing: "ease-out" as const,
  };
  expect(resolveSlideTransition(undefined, defaults)).toEqual(defaults);
  expect(resolveSlideTransition({ durationMs: 250 }, defaults)).toEqual({
    ...defaults,
    durationMs: 250,
  });
  expect(resolveSlideTransition({ kind: "none" }, defaults)).toEqual({
    ...defaults,
    kind: "none",
  });
  const deck = transitionDeck();
  deck.transitionDefaults = defaults;
  delete deck.slideMeta.b.transition;
  const start = startSession(
    { deckId: deck.id, slideIds: [], index: null },
    deck,
    1000,
  );
  expect(
    applyPresentationCommand(start, { type: "next" }, 1100).transition,
  ).toMatchObject(defaults);
});
it("slide transfer and PowerPoint diagnostics use inherited presentation transitions", async () => {
  const document = newPresentationDocument("Inherited transition");
  document.deck.transitionDefaults = {
    kind: "fade",
    durationMs: 500,
    easing: "ease",
  };
  const slide = document.slides[document.deck.slideIds[0]];
  const bundle = createSlideTransferBundle(
    document.documentId,
    document.deck,
    [slide],
    document.templates,
  );
  expect(
    parseSlideTransferBundle(JSON.parse(JSON.stringify(bundle))).slides[0].meta
      .transition,
  ).toEqual(document.deck.transitionDefaults);
  const { warnings } = await createPowerPoint(
    { deck: document.deck, slides: [slide] },
    async () => null,
  );
  expect(warnings).toContainEqual(
    expect.objectContaining({
      slideId: slide.id,
      code: "slide-transition-omitted",
    }),
  );
  document.deck.slideMeta[slide.id].transition = { kind: "none" };
  expect(
    (
      await createPowerPoint(
        { deck: document.deck, slides: [slide] },
        async () => null,
      )
    ).warnings,
  ).not.toContainEqual(
    expect.objectContaining({ code: "slide-transition-omitted" }),
  );
});
