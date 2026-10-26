import { describe, expect, it } from "vitest";
import {
  derivePresenterView,
  derivePresenterPreview,
  formatPresenterElapsedMinutes,
} from "../../../src/components/presenterViewModel";
import { newPresentationDocument } from "../../../src/core/document";
import {
  addPresence,
  sampleElementPresence,
  defaultPresenceTransition,
} from "../../../src/core/presence";
import { sampleEffectClocks } from "../../../src/core/effectClocks";
import type { PresenterState } from "../../../src/platform/api";

const NOW = 10_000;

it("rounds elapsed minutes to the nearest quarter, including whole-minute rollover", () => {
  expect(formatPresenterElapsedMinutes(0)).toBe("0");
  expect(formatPresenterElapsedMinutes(7_499)).toBe("0");
  expect(formatPresenterElapsedMinutes(7_500)).toBe("0 ¼");
  expect(formatPresenterElapsedMinutes(30_000)).toBe("0 ½");
  expect(formatPresenterElapsedMinutes(45_000)).toBe("0 ¾");
  expect(formatPresenterElapsedMinutes(60_000)).toBe("1");
  expect(formatPresenterElapsedMinutes(67_500)).toBe("1 ¼");
  expect(formatPresenterElapsedMinutes(82_500)).toBe("1 ½");
  expect(formatPresenterElapsedMinutes(97_500)).toBe("1 ¾");
  expect(formatPresenterElapsedMinutes(112_500)).toBe("2");
  expect(formatPresenterElapsedMinutes(3_615_000)).toBe("60 ¼");
});

function previewFixture() {
  const model = newPresentationDocument("Presenter snapshot");
  const slide = model.slides[model.deck.slideIds[0]];
  let motion = addPresence(
    {
      stages: [
        { id: "enter", tracks: [] },
        { id: "reveal", tracks: [] },
      ],
    },
    0,
    ["title"],
    {
      ...defaultPresenceTransition("move", "Up"),
      durationMs: 800,
      distance: 36,
    },
  );
  motion.stages[0].blocks![0].presenceSchedule!.startOffsetMs = 200;
  motion.stages[0].blocks![0].presenceSchedule!.end = { mode: "next-click" };
  motion = addPresence(motion, 1, ["detail"], {
    ...defaultPresenceTransition("fade"),
    durationMs: 600,
  });
  slide.motion = motion;
  const transport = state({
    startedAt: 1000,
    slideStartedAt: 3000,
    stepStartedAt: 3000,
    motionStageStartedOffsets: [0],
    motion: {
      stageId: "enter",
      stageIndex: 0,
      time: 0,
      startedAt: 3000,
      running: true,
    },
  });
  return { slide, transport };
}

it("presenter snapshot completes delayed entrances without revealing future clicks", () => {
  const { slide, transport } = previewFixture();
  const original = structuredClone(transport);
  for (const patch of [
    {},
    { pausedAt: 3100 },
    { awaitingAudience: true, presentationReady: false },
  ]) {
    const preview = derivePresenterPreview({ ...transport, ...patch }, slide);
    expect(preview.motionState).toMatchObject({
      stageIndex: 0,
      time: 1000,
      running: false,
    });
    const clocks = sampleEffectClocks(preview.effectClock!, NOW);
    expect(clocks).toMatchObject({
      slideTime: 1,
      stepTime: 1,
      presentationTime: 3,
    });
    expect(
      sampleElementPresence(
        slide.motion,
        "title",
        0,
        preview.motionState!.time,
        clocks,
      ).phase,
    ).toBe("present");
    expect(
      sampleElementPresence(
        slide.motion,
        "detail",
        0,
        preview.motionState!.time,
        clocks,
      ).present,
    ).toBe(false);
  }
  expect(transport).toEqual(original);
});

it("presenter snapshot follows reached clicks and freezes clocks at their endpoint", () => {
  const { slide, transport } = previewFixture();
  const preview = derivePresenterPreview(
    {
      ...transport,
      stepStartedAt: 8000,
      motionStageStartedOffsets: [0, 5000],
      motion: {
        stageId: "reveal",
        stageIndex: 1,
        time: 0,
        startedAt: 8000,
        running: true,
      },
    },
    slide,
  );
  expect(preview.motionState).toMatchObject({
    stageIndex: 1,
    time: 600,
    running: false,
  });
  const clocks = sampleEffectClocks(preview.effectClock!, NOW);
  expect(clocks).toMatchObject({ stepTime: 0.6, slideTime: 5.6 });
  expect(sampleEffectClocks(preview.effectClock!, NOW + 60_000)).toEqual(
    clocks,
  );
  expect(
    sampleElementPresence(slide.motion, "detail", 1, 600, clocks).phase,
  ).toBe("present");
  expect(
    sampleElementPresence(slide.motion, "title", 1, 600, clocks).present,
  ).toBe(false);
});

it("presenter snapshot preserves the pre-entry state and supports slides without motion", () => {
  const { slide, transport } = previewFixture();
  const before = derivePresenterPreview(
    {
      ...transport,
      motion: { ...transport.motion!, stageIndex: -1, running: false },
    },
    slide,
  );
  expect(before.motionState).toMatchObject({
    stageIndex: -1,
    time: 0,
    running: false,
  });
  expect(sampleElementPresence(slide.motion, "title", -1, 0).present).toBe(
    false,
  );
  expect(derivePresenterPreview(state(), slide).motionState).toBeUndefined();
  expect(derivePresenterPreview(null, null)).toEqual({
    motionState: undefined,
    effectClock: undefined,
  });
});

function state(patch: Partial<PresenterState> = {}): PresenterState {
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
