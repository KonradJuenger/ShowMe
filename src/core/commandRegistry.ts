export const COMMAND_IDS = {
  objectCut: "object.cut",
  objectCopy: "object.copy",
  objectPaste: "object.paste",
  objectDuplicate: "object.duplicate",
  objectGroup: "object.group",
  objectUngroup: "object.ungroup",
  objectBringFront: "object.bring-front",
  objectBringForward: "object.bring-forward",
  objectSendBackward: "object.send-backward",
  objectSendBack: "object.send-back",
  objectDelete: "object.delete",
  mediaReplace: "media.replace",
  mediaFit: "media.fit",
  mediaFill: "media.fill",
  mediaEditCrop: "media.edit-crop",
  mediaResetCrop: "media.reset-crop",
  frameEditContent: "frame.edit-content",
  frameReplaceContent: "frame.replace-content",
  frameRemoveContent: "frame.remove-content",
  frameFit: "frame.fit",
  frameFill: "frame.fill",
  textCut: "text.cut",
  textCopy: "text.copy",
  textPaste: "text.paste",
  textSelectAll: "text.select-all",
  canvasSelectAll: "canvas.select-all",
  rulersShow: "rulers.show",
  rulersHide: "rulers.hide",
  guidesClear: "guides.clear",
  slideNew: "slide.new",
  slideCopy: "slide.copy",
  slidePaste: "slide.paste",
  slideDuplicate: "slide.duplicate",
  slideHide: "slide.hide",
  slideUnhide: "slide.unhide",
  slideDelete: "slide.delete",
  assetInsert: "asset.insert",
  motionPreviewBlock: "motion.preview-block",
  motionSetTrigger: "motion.set-trigger",
  motionMoveNextClick: "motion.move-next-click",
  motionMovePreviousClick: "motion.move-previous-click",
  motionDuplicateBlock: "motion.duplicate-block",
  motionSelectElement: "motion.select-element",
  motionOpenBlock: "motion.open-block",
  motionRemoveBlock: "motion.remove-block",
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];
export type CommandContextKind =
  | "canvas"
  | "object"
  | "image"
  | "video"
  | "frame"
  | "frame-content"
  | "text-edit"
  | "slide-selection"
  | "slide-rail-empty"
  | "asset";
export type HiddenState = "none" | "some" | "all";

export interface CommandContext {
  deckId?: string;
  currentSlideId?: string;
  textValue?: string;
  kind: CommandContextKind;
  objectIds: string[];
  primaryObjectId?: string;
  scopeId?: string;
  slideIds: string[];
  primarySlideId?: string;
  assetId?: string;
  hasObjectClipboard: boolean;
  hasSlideClipboard: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  canDeleteSlides: boolean;
  hiddenState: HiddenState;
  frameHasContent: boolean;
  showRulers?: boolean;
  textSelection?: { start: number; end: number };
}

export interface ContextMenuCommandDescriptor {
  type: "command";
  commandId: CommandId;
  label: string;
  enabled: boolean;
  accelerator?: string;
}

export interface ContextMenuSeparatorDescriptor {
  type: "separator";
}

export type ContextMenuItemDescriptor =
  ContextMenuCommandDescriptor | ContextMenuSeparatorDescriptor;

interface RegisteredCommand {
  label: string;
  accelerator?: string;
  visible?: (context: CommandContext) => boolean;
  enabled?: (context: CommandContext) => boolean;
}

const hasObjects = (context: CommandContext) => context.objectIds.length > 0;
const singleObject = (context: CommandContext) =>
  context.objectIds.length === 1;
const hasSlides = (context: CommandContext) => context.slideIds.length > 0;
const frameContext = (context: CommandContext) =>
  context.kind === "frame" || context.kind === "frame-content";

export const commandRegistry: Record<CommandId, RegisteredCommand> = {
  [COMMAND_IDS.motionPreviewBlock]: { label: "Play animation" },
  [COMMAND_IDS.motionSetTrigger]: { label: "Trigger" },
  [COMMAND_IDS.motionMoveNextClick]: { label: "Move to next click" },
  [COMMAND_IDS.motionMovePreviousClick]: { label: "Move to previous click" },
  [COMMAND_IDS.motionDuplicateBlock]: { label: "Duplicate" },
  [COMMAND_IDS.motionSelectElement]: { label: "Select Element" },
  [COMMAND_IDS.motionOpenBlock]: { label: "Open" },
  [COMMAND_IDS.motionRemoveBlock]: { label: "Remove from Click Timeline" },
  [COMMAND_IDS.objectCut]: {
    label: "Cut",
    accelerator: "CmdOrCtrl+X",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectCopy]: {
    label: "Copy",
    accelerator: "CmdOrCtrl+C",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectPaste]: {
    label: "Paste",
    accelerator: "CmdOrCtrl+V",
    enabled: (context) => context.hasObjectClipboard,
  },
  [COMMAND_IDS.objectDuplicate]: {
    label: "Duplicate",
    accelerator: "CmdOrCtrl+D",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectGroup]: {
    label: "Group",
    accelerator: "CmdOrCtrl+G",
    enabled: (context) => context.canGroup,
  },
  [COMMAND_IDS.objectUngroup]: {
    label: "Ungroup",
    accelerator: "CmdOrCtrl+Shift+G",
    enabled: (context) => context.canUngroup,
  },
  [COMMAND_IDS.objectBringFront]: {
    label: "Bring to Front",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectBringForward]: {
    label: "Bring Forward",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectSendBackward]: {
    label: "Send Backward",
    enabled: hasObjects,
  },
  [COMMAND_IDS.objectSendBack]: { label: "Send to Back", enabled: hasObjects },
  [COMMAND_IDS.objectDelete]: { label: "Delete", enabled: hasObjects },
  [COMMAND_IDS.mediaReplace]: {
    label: "Replace Media",
    visible: (context) => context.kind === "image" || context.kind === "video",
    enabled: singleObject,
  },
  [COMMAND_IDS.mediaFit]: {
    label: "Fit",
    visible: (context) => context.kind === "image" || context.kind === "video",
    enabled: singleObject,
  },
  [COMMAND_IDS.mediaFill]: {
    label: "Fill",
    visible: (context) => context.kind === "image" || context.kind === "video",
    enabled: singleObject,
  },
  [COMMAND_IDS.mediaEditCrop]: {
    label: "Edit Crop",
    visible: (context) => context.kind === "image" || context.kind === "video",
    enabled: singleObject,
  },
  [COMMAND_IDS.mediaResetCrop]: {
    label: "Reset Crop",
    visible: (context) => context.kind === "image" || context.kind === "video",
    enabled: singleObject,
  },
  [COMMAND_IDS.frameEditContent]: {
    label: "Edit Content",
    visible: (context) => context.kind === "frame",
    enabled: (context) => singleObject(context) && context.frameHasContent,
  },
  [COMMAND_IDS.frameReplaceContent]: {
    label: "Replace Content",
    visible: frameContext,
    enabled: singleObject,
  },
  [COMMAND_IDS.frameRemoveContent]: {
    label: "Remove Content",
    visible: frameContext,
    enabled: (context) => singleObject(context) && context.frameHasContent,
  },
  [COMMAND_IDS.frameFit]: {
    label: "Fit Content",
    visible: frameContext,
    enabled: (context) => singleObject(context) && context.frameHasContent,
  },
  [COMMAND_IDS.frameFill]: {
    label: "Fill Frame",
    visible: frameContext,
    enabled: (context) => singleObject(context) && context.frameHasContent,
  },
  [COMMAND_IDS.textCut]: {
    label: "Cut",
    accelerator: "CmdOrCtrl+X",
    visible: (context) => context.kind === "text-edit",
    enabled: (context) =>
      !!context.textSelection &&
      context.textSelection.end > context.textSelection.start,
  },
  [COMMAND_IDS.textCopy]: {
    label: "Copy",
    accelerator: "CmdOrCtrl+C",
    visible: (context) => context.kind === "text-edit",
    enabled: (context) =>
      !!context.textSelection &&
      context.textSelection.end > context.textSelection.start,
  },
  [COMMAND_IDS.textPaste]: {
    label: "Paste",
    accelerator: "CmdOrCtrl+V",
    visible: (context) => context.kind === "text-edit",
  },
  [COMMAND_IDS.textSelectAll]: {
    label: "Select All",
    accelerator: "CmdOrCtrl+A",
    visible: (context) => context.kind === "text-edit",
  },
  [COMMAND_IDS.canvasSelectAll]: {
    label: "Select All",
    accelerator: "CmdOrCtrl+A",
    visible: (context) => context.kind === "canvas",
  },
  [COMMAND_IDS.rulersShow]: {
    label: "Show Rulers",
    accelerator: "R",
    visible: (context) =>
      context.kind === "canvas" && context.showRulers === false,
  },
  [COMMAND_IDS.rulersHide]: {
    label: "Hide Rulers",
    accelerator: "R",
    visible: (context) =>
      context.kind === "canvas" && context.showRulers !== false,
  },
  [COMMAND_IDS.guidesClear]: {
    label: "Delete Guides",
    visible: (context) => context.kind === "canvas",
  },
  [COMMAND_IDS.slideNew]: {
    label: "New Slide",
    visible: (context) => context.kind === "slide-rail-empty",
  },
  [COMMAND_IDS.slideCopy]: {
    label: "Copy Slides",
    accelerator: "CmdOrCtrl+C",
    visible: (context) => context.kind === "slide-selection",
    enabled: hasSlides,
  },
  [COMMAND_IDS.slidePaste]: {
    label: "Paste Slides",
    accelerator: "CmdOrCtrl+V",
    visible: (context) =>
      context.kind === "slide-selection" || context.kind === "slide-rail-empty",
    enabled: (context) => context.hasSlideClipboard,
  },
  [COMMAND_IDS.slideDuplicate]: {
    label: "Duplicate Slides",
    visible: (context) => context.kind === "slide-selection",
    enabled: hasSlides,
  },
  [COMMAND_IDS.slideHide]: {
    label: "Skip Slides",
    visible: (context) =>
      context.kind === "slide-selection" && context.hiddenState !== "all",
    enabled: hasSlides,
  },
  [COMMAND_IDS.slideUnhide]: {
    label: "Unskip Slides",
    visible: (context) =>
      context.kind === "slide-selection" && context.hiddenState !== "none",
    enabled: hasSlides,
  },
  [COMMAND_IDS.slideDelete]: {
    label: "Delete Slides",
    visible: (context) => context.kind === "slide-selection",
    enabled: (context) => hasSlides(context) && context.canDeleteSlides,
  },
  [COMMAND_IDS.assetInsert]: {
    label: "Insert",
    visible: (context) => context.kind === "asset",
    enabled: (context) => !!context.assetId,
  },
};

const objectMenu: Array<CommandId | "separator"> = [
  COMMAND_IDS.objectCut,
  COMMAND_IDS.objectCopy,
  COMMAND_IDS.objectPaste,
  COMMAND_IDS.objectDuplicate,
  "separator",
  COMMAND_IDS.objectGroup,
  COMMAND_IDS.objectUngroup,
  "separator",
  COMMAND_IDS.objectBringFront,
  COMMAND_IDS.objectBringForward,
  COMMAND_IDS.objectSendBackward,
  COMMAND_IDS.objectSendBack,
  "separator",
  COMMAND_IDS.objectDelete,
];

const mediaMenu: Array<CommandId | "separator"> = [
  COMMAND_IDS.objectCut,
  COMMAND_IDS.objectCopy,
  COMMAND_IDS.objectPaste,
  COMMAND_IDS.objectDuplicate,
  "separator",
  COMMAND_IDS.mediaReplace,
  COMMAND_IDS.mediaFit,
  COMMAND_IDS.mediaFill,
  COMMAND_IDS.mediaEditCrop,
  COMMAND_IDS.mediaResetCrop,
  "separator",
  COMMAND_IDS.objectBringFront,
  COMMAND_IDS.objectBringForward,
  COMMAND_IDS.objectSendBackward,
  COMMAND_IDS.objectSendBack,
  "separator",
  COMMAND_IDS.objectDelete,
];

const frameMenu: Array<CommandId | "separator"> = [
  COMMAND_IDS.objectCut,
  COMMAND_IDS.objectCopy,
  COMMAND_IDS.objectPaste,
  COMMAND_IDS.objectDuplicate,
  "separator",
  COMMAND_IDS.objectBringFront,
  COMMAND_IDS.objectBringForward,
  COMMAND_IDS.objectSendBackward,
  COMMAND_IDS.objectSendBack,
  "separator",
  COMMAND_IDS.objectDelete,
];

const menuDefinitions: Record<
  CommandContextKind,
  Array<CommandId | "separator">
> = {
  canvas: [
    COMMAND_IDS.objectPaste,
    COMMAND_IDS.canvasSelectAll,
    "separator",
    COMMAND_IDS.rulersShow,
    COMMAND_IDS.rulersHide,
    COMMAND_IDS.guidesClear,
  ],
  object: objectMenu,
  image: mediaMenu,
  video: mediaMenu,
  frame: frameMenu,
  "frame-content": frameMenu,
  "text-edit": [
    COMMAND_IDS.textCut,
    COMMAND_IDS.textCopy,
    COMMAND_IDS.textPaste,
    "separator",
    COMMAND_IDS.textSelectAll,
  ],
  "slide-selection": [
    COMMAND_IDS.slideCopy,
    COMMAND_IDS.slidePaste,
    COMMAND_IDS.slideDuplicate,
    "separator",
    COMMAND_IDS.slideHide,
    COMMAND_IDS.slideUnhide,
    "separator",
    COMMAND_IDS.slideDelete,
  ],
  "slide-rail-empty": [COMMAND_IDS.slideNew, COMMAND_IDS.slidePaste],
  asset: [COMMAND_IDS.assetInsert],
};

export function commandVisible(id: CommandId, context: CommandContext) {
  return (
    menuDefinitions[context.kind].includes(id) &&
    (commandRegistry[id].visible?.(context) ?? true)
  );
}

export function commandEnabled(id: CommandId, context: CommandContext) {
  const command = commandRegistry[id];
  return (
    (command.visible?.(context) ?? true) &&
    (command.enabled?.(context) ?? true)
  );
}

export function resolveContextMenuItems(
  context: CommandContext,
): ContextMenuItemDescriptor[] {
  const output: ContextMenuItemDescriptor[] = [];
  for (const entry of menuDefinitions[context.kind]) {
    if (entry === "separator") {
      if (output.length && output[output.length - 1]?.type !== "separator")
        output.push({ type: "separator" });
      continue;
    }
    if (!commandVisible(entry, context)) continue;
    const command = commandRegistry[entry];
    output.push({
      type: "command",
      commandId: entry,
      label: command.label,
      enabled: commandEnabled(entry, context),
      ...(command.accelerator ? { accelerator: command.accelerator } : {}),
    });
  }
  if (output[output.length - 1]?.type === "separator") output.pop();
  return output;
}

export async function executeRegisteredCommand(
  id: CommandId,
  context: CommandContext,
  executor: (id: CommandId, context: CommandContext) => void | Promise<void>,
) {
  if (!commandEnabled(id, context)) return false;
  await executor(id, context);
  return true;
}
