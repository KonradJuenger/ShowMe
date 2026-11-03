import { useRef } from "react";
import {
  readTextRunDom,
  readTextDomSelection,
  writeTextDomSelection,
  writeTextRunDom,
} from "./textRunDom";
import { resolveTextTypography } from "../../core/textTypography";
import { useLayoutEffect, type CSSProperties, type KeyboardEvent } from "react";
import type { Matrix } from "../../core/element";
import type { TextElement } from "../../core/text";
import type { TextEditingController } from "./useTextEditing";

export function InlineTextEditor({
  element,
  deck,
  world,
  controller,
}: {
  element: TextElement;
  deck: import("../../core/document").Deck;
  world: Matrix;
  controller: TextEditingController;
}) {
  const content = {
    ...element.content,
    ...resolveTextTypography(deck, element.content),
  };
  const justifyContent =
    content.verticalAlign === "middle"
      ? "center"
      : content.verticalAlign === "bottom"
        ? "flex-end"
        : "flex-start";

  const composing = useRef(false);
  useLayoutEffect(() => {
    const area = controller.inputRef.current;
    if (!area || composing.current) return;
    if (
      JSON.stringify(readTextRunDom(area)) !==
      JSON.stringify(controller.draftRuns)
    ) {
      const selection = readTextDomSelection(area);
      writeTextRunDom(area, controller.draftRuns, true);
      if (selection) writeTextDomSelection(area, selection);
    }
  }, [controller.draftRuns, controller.inputRef]);

  useLayoutEffect(() => {
    const area = controller.inputRef.current;
    if (!area) return;
    area.style.height = "0px";
    area.style.height = `${Math.min(
      element.frame.height,
      Math.max(content.fontSize * content.lineHeight, area.scrollHeight),
    )}px`;
  }, [
    content.fontFamily,
    content.fontSize,
    content.fontWeight,
    content.bold,
    content.italic,
    content.lineHeight,
    content.letterSpacing,
    content.autoSize,
    controller.draftText,
    controller.draftRuns,
    controller.inputRef,
    element.frame.height,
    element.frame.width,
  ]);

  useLayoutEffect(() => {
    const area = controller.inputRef.current;
    if (!area) return;
    const beforeInput = (input: InputEvent) => {
      if (composing.current || input.isComposing || !input.cancelable) return;
      if (input.inputType === "insertText" && input.data !== null) {
        input.preventDefault();
        controller.insertText(input.data);
      } else if (
        input.inputType === "insertParagraph" ||
        input.inputType === "insertLineBreak"
      ) {
        input.preventDefault();
        controller.insertText("\n");
      } else if (input.inputType === "formatBold") {
        input.preventDefault();
        controller.toggleBold();
      } else if (input.inputType.startsWith("format")) {
        input.preventDefault();
      } else if (
        input.inputType === "historyUndo" ||
        input.inputType === "historyRedo"
      ) {
        input.preventDefault();
        void controller.history(input.inputType === "historyRedo");
      }
    };
    area.addEventListener("beforeinput", beforeInput);
    document.addEventListener("selectionchange", controller.refreshSelection);
    controller.refreshSelection();
    return () => {
      area.removeEventListener("beforeinput", beforeInput);
      document.removeEventListener(
        "selectionchange",
        controller.refreshSelection,
      );
    };
  }, [controller]);

  const style: CSSProperties = {
    width: "100%",
    minHeight: 0,
    padding: 0,
    margin: 0,
    border: 0,
    outline: 0,
    resize: "none",
    overflow: "hidden",
    background: "transparent",
    boxSizing: "border-box",
    fontFamily: content.fontFamily,
    fontWeight: content.bold
      ? Math.max(700, content.fontWeight)
      : content.fontWeight,
    fontStyle: content.italic ? "italic" : "normal",
    fontSize: content.fontSize,
    color: content.color,
    textAlign: content.align,
    lineHeight: content.lineHeight,
    letterSpacing: content.letterSpacing,
    whiteSpace: content.autoSize === "both" ? "pre" : "pre-wrap",
    overflowWrap: content.autoSize === "both" ? "normal" : "anywhere",
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !composing.current
    ) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "z" || key === "y") {
        event.preventDefault();
        event.stopPropagation();
        if (key === "b") controller.toggleBold();
        else void controller.history(key === "y" || event.shiftKey);
        return;
      }
    }
    if (event.key !== "Escape" || composing.current) return;
    event.preventDefault();
    event.stopPropagation();
    void controller.exit();
  };

  return (
    <div
      data-text-edit-overlay="true"
      data-element-id={element.id}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: element.frame.width,
        height: element.frame.height,
        transform: `matrix(${world.join(",")})`,
        transformOrigin: "0 0",
        display: "flex",
        flexDirection: "column",
        justifyContent,
        zIndex: 1300,
        pointerEvents: "none",
      }}
    >
      <div
        ref={controller.inputRef}
        className="inline-text"
        data-text-editor="true"
        data-context-target="text-edit"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Edit text on slide"
        style={{ ...style, pointerEvents: "auto" }}
        onFocus={controller.onFocus}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          writeTextDomSelection(event.currentTarget, {
            start: 0,
            end: controller.draftText.length,
          });
          controller.refreshSelection();
        }}
        onCompositionStart={() => {
          composing.current = true;
          controller.onCompositionStart();
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          controller.onChange(readTextRunDom(event.currentTarget));
          controller.onCompositionEnd();
        }}
        onInput={(event) =>
          controller.onChange(readTextRunDom(event.currentTarget))
        }
        onCopy={(event) => {
          const selected = readTextDomSelection(event.currentTarget);
          if (!selected) return;
          event.preventDefault();
          event.clipboardData.setData(
            "text/plain",
            controller.draftText.slice(selected.start, selected.end),
          );
        }}
        onCut={(event) => {
          const selected = readTextDomSelection(event.currentTarget);
          if (!selected || composing.current) return;
          event.preventDefault();
          event.clipboardData.setData(
            "text/plain",
            controller.draftText.slice(selected.start, selected.end),
          );
          controller.insertText("");
        }}
        onPaste={(event) => {
          event.preventDefault();
          controller.insertText(
            event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"),
          );
        }}
        onDrop={(event) => event.preventDefault()}
        onKeyUp={controller.refreshSelection}
        onPointerUp={controller.refreshSelection}
        onKeyDown={keyDown}
        onBlur={controller.onBlur}
      />
    </div>
  );
}
