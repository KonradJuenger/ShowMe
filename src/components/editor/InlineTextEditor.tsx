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
    controller.inputRef,
    element.frame.height,
    element.frame.width,
  ]);

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

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
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
      <textarea
        ref={controller.inputRef}
        className="inline-text"
        data-text-editor="true"
        data-context-target="text-edit"
        autoFocus
        aria-label="Edit text on slide"
        wrap={content.autoSize === "both" ? "off" : "soft"}
        value={controller.draftText}
        style={{ ...style, pointerEvents: "auto" }}
        onFocus={controller.onFocus}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.currentTarget.select();
        }}
        onCompositionStart={controller.onCompositionStart}
        onCompositionEnd={controller.onCompositionEnd}
        onChange={(event) => controller.onChange(event.target.value)}
        onKeyDown={keyDown}
        onBlur={controller.onBlur}
      />
    </div>
  );
}
