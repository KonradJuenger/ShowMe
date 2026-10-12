import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../src/core/document";
import { createBasicShape } from "../../src/core/elementFactory";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";

/** Current Template A Presentation-start timing across navigation and reconnect. */
export function templateTimingDocument() {
  const document = newPresentationDocument("Template timing");
  const first = document.slides[document.deck.slideIds[0]];
  const template = document.templates[document.deck.defaultTemplateId!];
  const shape = createBasicShape("template-background", "rectangle");
  shape.frame.width = 100;
  shape.frame.height = 100;
  shape.appearance.fill = null;
  const definition = {
    ...blankEffect("shader"),
    target: "background" as const,
    input: "none" as const,
    timeControl: {
      start: "presentation" as const,
      stop: { mode: "none" as const },
    },
    source:
      "#version 300 es\nprecision highp float;\nuniform float u_t;\nout vec4 outColor;\nvoid main() { outColor = vec4(u_t / 20.0, 0.0, 0.0, 1.0); }",
  };
  shape.effects = [
    newEffectInstance("template-effect", definition, "background"),
  ];
  template.nodes[0].children = [shape];
  template.effectResources = {
    "template-effect": definition,
  };
  for (const id of ["slide-two", "slide-three"]) {
    document.deck.slideIds.push(id);
    document.deck.slideMeta[id] = {
      ...document.deck.slideMeta[first.id],
      name: id,
    };
    document.slides[id] = { ...structuredClone(first), id };
  }
  return presentationDocumentSchema.parse(document);
}
