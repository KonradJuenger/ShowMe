import { createRoot } from "react-dom/client";
import { useState } from "react";
import { newPresentationDocument } from "../../src/core/document";
import {
  createEmptyFrame,
  createBasicShape,
} from "../../src/core/elementFactory";
import { RightSidebar } from "../../src/components/RightSidebar";
import { LayersPanel } from "../../src/components/LayersPanel";
import type { SidebarController } from "../../src/components/sidebarEditing";
import "../../src/editor.css";
import "../../src/modernTheme.css";

export function mountLayersHarness() {
  const documentModel = newPresentationDocument("Layers fixture");
  const deck = documentModel.deck;
  const slide = documentModel.slides[deck.slideIds[0]];
  const layerId = deck.layers[0].id;
  deck.layers[0].name = "Layer 1";
  const inner = createEmptyFrame("inner");
  inner.name = "Frame B";
  inner.children = [createBasicShape("leaf", "rectangle")];
  inner.children[0].name = "Selected element";
  const outer = createEmptyFrame("outer");
  outer.name = "Frame A";
  outer.children = [inner];
  const other = createEmptyFrame("other");
  other.name = "Other frame";
  other.children = [createBasicShape("other-leaf", "rectangle")];
  slide.nodes[0].children = [outer, other];
  const secondSlide = {
    ...slide,
    id: "second-slide",
    nodes: [{ ...slide.nodes[0], children: [] }],
  };
  deck.slideIds.push(secondSlide.id);
  deck.slideMeta[secondSlide.id] = { ...deck.slideMeta[slide.id] };
  const snapshot = { deck, slide };
  const noop = () => {};
  const done = async () => {};
  const controller: SidebarController = {
    epochRef: { current: "fixture" },
    snapshotRef: { current: snapshot },
    apply: noop,
    flush: done,
    acquireEditScopes: async () => true,
    acquireElementScopes: async () => true,
    releaseLeases: done,
    beginLeaseHold: noop,
    endLeaseHold: done,
    commitPreview: noop,
    discardPreview: noop,
  };
  function Harness() {
    const [currentSlide, setCurrentSlide] = useState(slide);
    const [selection, setSelection] = useState({
      scopeId: layerId,
      elementIds: [] as string[],
    });
    return (
      <>
        <button
          onClick={() => {
            setCurrentSlide(currentSlide.id === slide.id ? secondSlide : slide);
            setSelection({ scopeId: layerId, elementIds: [] });
          }}
        >
          Switch slide
        </button>
        <button
          onClick={() =>
            setSelection({ scopeId: inner.id, elementIds: ["leaf"] })
          }
        >
          Select nested element
        </button>
        <button
          onClick={() =>
            setSelection({ scopeId: other.id, elementIds: ["other-leaf"] })
          }
        >
          Select other element
        </button>
        <output aria-label="Current scope">{selection.scopeId}</output>
        <RightSidebar
          settings={null}
          documentId={deck.id}
          snapshot={{ deck, slide: currentSlide }}
          selection={selection}
          controller={controller}
          structuralActions={{
            frameSelection: done,
            unframeSelection: done,
            reorderSelection: done,
            canFrame: () => false,
            canUnframe: () => false,
          }}
          layers={(active) => (
            <LayersPanel
              active={active}
              slide={currentSlide}
              deck={deck}
              selected={selection.elementIds}
              selectionScope={selection.scopeId}
              onEnter={(scopeId) => setSelection({ scopeId, elementIds: [] })}
              onSelect={(scopeId, id) =>
                setSelection({ scopeId, elementIds: [id] })
              }
              onReparent={noop}
              onDeleteLayer={noop}
              onLayerChange={noop}
            />
          )}
          onAddLayer={noop}
          media={null}
          showMedia={false}
          onMediaShown={noop}
          onReplaceMedia={noop}
          onCropFrame={noop}
          onEditFrame={noop}
          onMediaCenter={noop}
          onMediaReset={noop}
          onReparent={noop}
          onMediaRule={noop}
          onGuides={noop}
          onError={(error) => {
            throw error;
          }}
        />
      </>
    );
  }
  const host = document.createElement("div");
  host.style.cssText = "height:500px;width:450px";
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness />);
}
