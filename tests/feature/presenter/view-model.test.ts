import { describe, expect, it } from "vitest";
import { derivePresenterView } from "../../../src/components/presenterViewModel";
import type { PresenterState } from "../../../src/platform/api";

const NOW = 10_000;

function state(
  patch: Partial<PresenterState> = {},
): PresenterState {
  return {
    deckId: "deck",
    slideIds: ["one", "two"],
    index: 0,
    presentationReady: true,
    ...patch,
  };
}

const stages = [
  { id: "a", duration: 1000 },
  { id: "b", duration: 800 },
  { id: "c", duration: 600 },
];

describe("presenter view model", () => {
  it("describes ordinary slide advance and the end of the deck", () => {
    const first = derivePresenterView(state(), NOW);
    expect(first.readinessLabel).toBe("Ready");
    expect(first.advanceDetail).toBe("Slide 2 / 2");
    expect(first.canAdvance).toBe(true);
    expect(first.canPrevious).toBe(false);

    const last = derivePresenterView(state({ index: 1 }), NOW);
    expect(last.advanceDetail).toBe("End");
    expect(last.canAdvance).toBe(false);
    expect(last.canPrevious).toBe(true);
  });

  it("describes the next Motion stage while active or settled", () => {
    const active = derivePresenterView(
      state({
        motionSlides: { one: stages },
        motion: {
          stageId: "a",
          stageIndex: 0,
          time: 0,
          startedAt: NOW - 200,
          running: true,
        },
      }),
      NOW,
    );
    expect(active.readinessLabel).toBe("Animating");
    expect(active.advanceDetail).toBe("Animation 2 / 3");
    expect(active.canPrevious).toBe(true);

    const settled = derivePresenterView(
      state({
        motionSlides: { one: stages },
        motion: {
          stageId: "b",
          stageIndex: 1,
          time: 800,
          startedAt: NOW - 1000,
          running: false,
        },
      }),
      NOW,
    );
    expect(settled.readinessLabel).toBe("Ready");
    expect(settled.advanceDetail).toBe("Animation 3 / 3");
    expect(settled.canPrevious).toBe(true);
  });

  it("advances from a settled final Motion stage to the next slide", () => {
    const view = derivePresenterView(
      state({
        motionSlides: { one: stages },
        motion: {
          stageId: "c",
          stageIndex: 2,
          time: 600,
          startedAt: NOW - 1000,
          running: false,
        },
      }),
      NOW,
    );
    expect(view.readinessLabel).toBe("Ready");
    expect(view.advanceDetail).toBe("Slide 2 / 2");
    expect(view.canAdvance).toBe(true);
  });

  it("keeps final-slide Advance aligned with the runtime while its final Motion is active", () => {
    const view = derivePresenterView(
      state({
        index: 1,
        motionSlides: { two: stages },
        motion: {
          stageId: "c",
          stageIndex: 2,
          time: 0,
          startedAt: NOW - 100,
          running: true,
        },
      }),
      NOW,
    );
    expect(view.readinessLabel).toBe("Animating");
    expect(view.advanceDetail).toBe("Finish animation 3 / 3");
    expect(view.canAdvance).toBe(true);

    const settled = derivePresenterView(
      state({
        index: 1,
        motionSlides: { two: stages },
        motion: {
          stageId: "c",
          stageIndex: 2,
          time: 600,
          startedAt: NOW - 1000,
          running: false,
        },
      }),
      NOW,
    );
    expect(settled.advanceDetail).toBe("End");
    expect(settled.canAdvance).toBe(false);
  });

  it("reflects Previous through Motion stages without inventing navigation", () => {
    const beforeFirstStage = derivePresenterView(
      state({
        motionSlides: { one: stages },
        motion: {
          stageId: "a",
          stageIndex: -1,
          time: 0,
          startedAt: NOW,
          running: false,
        },
      }),
      NOW,
    );
    expect(beforeFirstStage.advanceDetail).toBe("Animation 1 / 3");
    expect(beforeFirstStage.canPrevious).toBe(false);

    const onSecondStage = derivePresenterView(
      state({
        motionSlides: { one: stages },
        motion: {
          stageId: "b",
          stageIndex: 1,
          time: 800,
          startedAt: NOW,
          running: false,
        },
      }),
      NOW,
    );
    expect(onSecondStage.canPrevious).toBe(true);
  });

  it("prioritizes blackout, pause and audience preparation in readiness", () => {
    const motion = {
      stageId: "a",
      stageIndex: 0,
      time: 0,
      startedAt: NOW - 100,
      running: true,
    };
    expect(
      derivePresenterView(
        state({ motionSlides: { one: stages }, motion, pausedAt: NOW - 50 }),
        NOW,
      ).readinessLabel,
    ).toBe("Paused");
    expect(
      derivePresenterView(
        state({
          motionSlides: { one: stages },
          motion,
          pausedAt: NOW - 50,
          black: true,
        }),
        NOW,
      ).readinessLabel,
    ).toBe("Audience black");
    expect(
      derivePresenterView(
        state({
          motionSlides: { one: stages },
          motion: { ...motion, running: false },
          awaitingAudience: true,
          presentationReady: false,
        }),
        NOW,
      ).readinessLabel,
    ).toBe("Preparing audience");
  });

  it("reports active transitions and no-visible-slide state", () => {
    const transitioning = derivePresenterView(
      state({
        transition: {
          kind: "fade",
          durationMs: 500,
          easing: "linear",
          fromSlideId: "one",
          toSlideId: "two",
          startedAt: NOW - 100,
        },
      }),
      NOW,
    );
    expect(transitioning.readinessLabel).toBe("Animating");

    const empty = derivePresenterView(
      state({ slideIds: [], index: null }),
      NOW,
    );
    expect(empty.readinessLabel).toBe("No slide");
    expect(empty.advanceDetail).toBe("No slide");
    expect(empty.canAdvance).toBe(false);
    expect(empty.canPrevious).toBe(false);
  });
});
