import { expect, it } from "vitest";
import {
  startSession,
  applyPresentationCommand,
} from "../../../src/core/presentationSession";
import { presenterElapsedTime } from "../../../src/components/presenterViewModel";
import {
  presenterEffectClockOrigins,
  sampleEffectClocks,
} from "../../../src/core/effectClocks";

it("speaker timer waits for explicit Advance while entrance animation clocks run", () => {
  const deck = {
    slideIds: ["one", "two"],
    slideMeta: Object.fromEntries(
      ["one", "two"].map((id) => [
        id,
        { templateId: null, name: id, section: "", hidden: false },
      ]),
    ),
  };
  const start = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
    {
      one: [
        { id: "entrance", duration: 1000 },
        { id: "click", duration: 800 },
      ],
    },
    true,
  );
  const ready = applyPresentationCommand(
    start,
    {
      type: "audience-ready",
      sessionStartedAt: 1000,
      motionStartedAt: 1000,
      slideId: "one",
    },
    2000,
  );
  expect(ready.motion?.running).toBe(true);
  expect(presenterElapsedTime(ready, 60_000)).toBe(0);
  expect(
    sampleEffectClocks(presenterEffectClockOrigins(ready)!, 3000).slideTime,
  ).toBe(1);
  const advanced = applyPresentationCommand(ready, { type: "next" }, 60_000);
  expect(advanced.motion?.stageIndex).toBe(1);
  expect(advanced.elapsedStartedAt).toBe(60_000);
  expect(advanced.startedAt).toBe(1000);
  expect(presenterElapsedTime(advanced, 75_000)).toBe(15_000);
  const next = applyPresentationCommand(advanced, { type: "next" }, 80_000);
  const previous = applyPresentationCommand(next, { type: "previous" }, 90_000);
  expect(presenterElapsedTime(previous, 100_000)).toBe(40_000);
  expect(
    startSession(previous, deck, 110_000).elapsedStartedAt,
  ).toBeUndefined();
});

it("blackout, pause, media restart and slide jumps do not arm the speaker timer", () => {
  const deck = {
    slideIds: ["one", "two"],
    slideMeta: Object.fromEntries(
      ["one", "two"].map((id) => [
        id,
        { templateId: null, name: id, section: "", hidden: false },
      ]),
    ),
  };
  let state = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
  );
  state = applyPresentationCommand(state, { type: "toggle-black" }, 2000);
  state = applyPresentationCommand(state, { type: "restart-media" }, 3000);
  state = applyPresentationCommand(state, { type: "jump", index: 1 }, 4000);
  state = applyPresentationCommand(state, { type: "toggle-pause" }, 5000);
  expect(presenterElapsedTime(state, 60_000)).toBe(0);
  const advanced = applyPresentationCommand(state, { type: "next" }, 60_000);
  expect(advanced.elapsedStartedAt).toBe(60_000);
  expect(advanced.pausedAt).toBe(5000);
  expect(presenterElapsedTime(advanced, 75_000)).toBe(15_000);
  const empty = startSession(
    { deckId: "deck", slideIds: [], index: null },
    { slideIds: [], slideMeta: {} },
    1000,
  );
  expect(
    applyPresentationCommand(empty, { type: "next" }, 2000).elapsedStartedAt,
  ).toBeUndefined();
});

it("navigation and blackout preserve presentation position independently", () => {
  const deck = {
    slideIds: ["one", "two"],
    slideMeta: Object.fromEntries(
      ["one", "two"].map((id) => [
        id,
        { templateId: null, name: id, section: "", hidden: false },
      ]),
    ),
  };
  const started = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
  );
  const next = applyPresentationCommand(started, { type: "next" }, 1200);
  expect(next.index).toBe(1);
  const black = applyPresentationCommand(next, { type: "toggle-black" }, 1300);
  expect(black.black).toBe(true);
  expect(black.index).toBe(1);
  expect(
    applyPresentationCommand(black, { type: "previous" }, 1400).index,
  ).toBe(0);
});
