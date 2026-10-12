import {
  COMMAND_IDS,
  commandEnabled,
  executeRegisteredCommand,
  type CommandContext,
  type CommandId,
} from "../core/commandRegistry";
import {
  getSlideCommandRuntime,
  revalidateCommandContext,
} from "./editor/commandRuntimeState";

export {
  getSlideCommandRuntime,
  registerSlideCommandRuntime,
  revalidateCommandContext,
  unregisterSlideCommandRuntime,
} from "./editor/commandRuntimeState";
export type { SlideCommandRuntime } from "./editor/commandRuntimeState";

async function executeCommandAction(id: CommandId) {
  const runtime = getSlideCommandRuntime();
  if (id === COMMAND_IDS.slideNew) return runtime?.addSlide();
  if (id === COMMAND_IDS.slideCopy) return runtime?.copySlides();
  if (id === COMMAND_IDS.slidePaste) return runtime?.pasteSlides();
  if (id === COMMAND_IDS.slideDuplicate)
    return runtime?.duplicateSlides();
  if (id === COMMAND_IDS.slideHide) return runtime?.hideSlides();
  if (id === COMMAND_IDS.slideUnhide) return runtime?.unhideSlides();
  if (id === COMMAND_IDS.slideDelete) return runtime?.deleteSlides();
}

export async function executeCommand(
  id: CommandId,
  context: CommandContext,
) {
  const current = revalidateCommandContext(context);
  if (!current || !commandEnabled(id, current)) return false;
  return executeRegisteredCommand(id, current, (command) =>
    executeCommandAction(command),
  );
}
