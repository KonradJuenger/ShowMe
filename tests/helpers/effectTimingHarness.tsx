import { createRoot } from "react-dom/client";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import {
  startSession,
  applyPresentationCommand,
} from "../../src/core/presentationSession";
import { presenterEffectClockOrigins } from "../../src/core/effectClocks";
import { templateTimingDocument } from "./effectTimingFixture";

export function mountEffectTimingHarness() {
  const documentModel = templateTimingDocument();
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let state = startSession(
    { deckId: documentModel.deck.id, slideIds: [], index: null },
    documentModel.deck,
    1000,
  );
  const render = (now: number) => {
    const id = state.slideIds[state.index!];
    root.render(
      <SlideRenderer
        key={id}
        deck={documentModel.deck}
        slide={documentModel.slides[id]}
        templates={documentModel.templates}
        presentation
        staticVideo
        effectClock={{ ...presenterEffectClockOrigins(state)!, pausedAt: now }}
      />,
    );
  };
  render(1000);
  return (index: number, now: number) => {
    state = applyPresentationCommand(state, { type: "jump", index }, now);
    render(now);
  };
}
