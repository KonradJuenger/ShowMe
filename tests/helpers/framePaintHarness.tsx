import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import { EditorCanvas } from "../../src/components/EditorCanvas";
import { newPresentationDocument } from "../../src/core/document";
import { DocumentRuntime } from "../../src/core/documentRuntime";
import {
  createEmptyFrame,
  createBasicShape,
} from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import "../../src/editor.css";

export function mountFramePaintHarness(mixed = false) {
  const model = newPresentationDocument("Paint fixture");
  model.deck.width = 800;
  model.deck.height = 400;
  const slide = model.slides[model.deck.slideIds[0]];
  const make = (id: string, x: number) => {
    const element = createEmptyFrame(id, { x, y: 80 });
    Object.assign(element.frame, { width: 130, height: 80 });
    Object.assign(element.appearance, { fill: "#336699", opacity: 0.5 });
    return element;
  };
  slide.nodes[0].children = [make("left", 80), make("right", 210)];
  if (mixed) {
    const text = createTextElement("text", { x: 380, y: 100 });
    if (text.content?.type === "text")
      text.content.text = "Logical text wrapping";
    const rotated = createBasicShape("rotated", "rectangle", {
      x: 150,
      y: 230,
    });
    Object.assign(rotated.frame, { width: 100, height: 40, rotation: 17 });
    slide.nodes[0].children.push(text, rotated);
  }
  let writes = 0;
  const runtime = new DocumentRuntime(model, {
    actorId: "paint-test",
    durableCommit: async () => {
      writes++;
    },
  });
  const before = JSON.stringify(runtime.authority.document);
  document.body.replaceChildren();
  document.body.style.cssText = "margin:0;background:white";
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  let place: (value: { scale: number; pan: number }) => void;
  function Fixture() {
    const [view, setView] = useState({ scale: 0.25, pan: 0.375 });
    place = setView;
    return (
      <div
        className="stage"
        style={{ position: "relative", width: 1200, height: 850 }}
      >
        <EditorCanvas
          documentId={model.documentId}
          transport={runtime}
          scale={view.scale}
          snapping={{ enabled: false }}
          style={{
            position: "absolute",
            left: `calc(50% + ${view.pan - (model.deck.width * view.scale) / 2}px)`,
            top: `calc(50% - ${(model.deck.height * view.scale) / 2}px)`,
          }}
        />
      </div>
    );
  }
  flushSync(() => root.render(<Fixture />));
  return {
    viewport(scale: number, pan: number) {
      flushSync(() => place({ scale, pan }));
    },
    inspect() {
      return {
        unchanged: before === JSON.stringify(runtime.authority.document),
        writes,
        revision: runtime.authority.revision,
        frames: structuredClone(
          runtime.authority.document.slides[slide.id].nodes[0].children.map(
            (e) => e.frame,
          ),
        ),
      };
    },
    async undo() {
      await runtime.undo(model.documentId, []);
    },
    async redo() {
      await runtime.redo(model.documentId, []);
    },
  };
}
