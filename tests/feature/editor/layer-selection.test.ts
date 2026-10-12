import { expect, it } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createEmptyFrame } from "../../../src/core/elementFactory";
import { addLayer } from "../../../src/core/layerActions";
import { resolveCanvasHitTarget } from "../../../src/components/editorCanvasCoordinator";

function scene() {
  const document = newPresentationDocument("Layer selection");
  const original = document.slides[document.deck.slideIds[0]];
  const firstLayer = document.deck.layers[0].id;
  const { snapshot } = addLayer(
    { deck: document.deck, slide: original },
    "other-layer",
  );
  const group = createEmptyFrame("group");
  group.container = true;
  group.children = [createEmptyFrame("child")];
  snapshot.slide.nodes.find((root) => root.id === firstLayer)!.children = [
    createEmptyFrame("first"),
  ];
  snapshot.slide.nodes.find((root) => root.id === "other-layer")!.children = [
    group,
  ];
  return { slide: snapshot.slide, firstLayer };
}

it("a layer-level hit can select objects on another layer without entering their descendants", () => {
  const { slide, firstLayer } = scene();
  expect(resolveCanvasHitTarget(slide, firstLayer, "group")).toBe("group");
  expect(resolveCanvasHitTarget(slide, firstLayer, "child")).toBe("group");
});

it("entering a container retains its child selection boundary across layers", () => {
  const { slide } = scene();
  expect(resolveCanvasHitTarget(slide, "group", "child")).toBe("child");
  expect(resolveCanvasHitTarget(slide, "group", "first")).toBeNull();
});
