import { expect, it } from "vitest";
import {
  startSession,
  applyPresentationCommand,
} from "../../../src/core/presentationSession";

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
