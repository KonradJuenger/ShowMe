import { expect, it } from "vitest";
import {
  COMMAND_IDS,
  type CommandContext,
} from "../../../src/core/commandRegistry";
import {
  executeCommand,
  registerSlideCommandRuntime,
  unregisterSlideCommandRuntime,
  type SlideCommandRuntime,
} from "../../../src/components/contextMenuRuntime";

const context: CommandContext = {
  kind: "slide-selection",
  deckId: "deck",
  currentSlideId: "slide",
  slideIds: ["slide"],
  objectIds: [],
  hasObjectClipboard: false,
  hasSlideClipboard: true,
  canGroup: false,
  canUngroup: false,
  canDeleteSlides: true,
  hiddenState: "none",
  frameHasContent: false,
};
function runtime(action: () => Promise<void>): SlideCommandRuntime {
  return {
    getSnapshot: () => ({
      deck: { id: "deck", slideIds: ["slide", "other"], slideMeta: {} },
      slide: { id: "slide" },
    }),
    isBusy: () => false,
    getSelectedSlides: () => ["slide"],
    hasSlideClipboard: () => true,
    selectSlide: action,
    addSlide: action,
    duplicateSlides: action,
    copySlides: action,
    pasteSlides: action,
    deleteSlides: action,
    hideSlides: action,
    unhideSlides: action,
  };
}

it("slide commands await actual completion and forward one rejection", async () => {
  for (const id of [
    COMMAND_IDS.slideCopy,
    COMMAND_IDS.slidePaste,
    COMMAND_IDS.slideDuplicate,
    COMMAND_IDS.slideDelete,
  ]) {
    let finish!: () => void;
    const owner = runtime(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    registerSlideCommandRuntime(owner);
    try {
      let completed = false;
      const command = executeCommand(id, context).then((value) => {
        completed = true;
        return value;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(completed).toBe(false);
      finish();
      expect(await command).toBe(true);
    } finally {
      unregisterSlideCommandRuntime(owner);
    }
  }
  const error = new Error("Command failed");
  const owner = runtime(async () => {
    throw error;
  });
  registerSlideCommandRuntime(owner);
  try {
    await expect(executeCommand(COMMAND_IDS.slideCopy, context)).rejects.toBe(
      error,
    );
  } finally {
    unregisterSlideCommandRuntime(owner);
  }
});
