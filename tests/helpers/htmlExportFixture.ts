import { newPresentationDocument } from "../../src/core/document";
import { createTextElement } from "../../src/core/text";
import { createMediaElement } from "../../src/core/media";
import { blankEffect, shaderBoilerplate } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import type { ExportDocument } from "../../src/export/shared";

export const hostileText =
  '</script></style> \u2028 \u2029 "quotes" \\ <b>literal</b>';
export function htmlExportFixture(): ExportDocument {
  const model = newPresentationDocument("Offline HTML fixture");
  const first = model.slides[model.deck.slideIds[0]];
  const text = createTextElement("text", { x: 40, y: 30 });
  if (text.content?.type === "text") {
    text.content.text = hostileText;
    text.content.placeholder = false;
  }
  const css = {
    ...blankEffect("css-js"),
    source:
      ":scope { color: rgb(12, 34, 56); letter-spacing: calc(var(--t) * 0.01px); } /* </style> */",
  };
  const js = {
    ...blankEffect("css-js"),
    kind: "text-js" as const,
    target: "text" as const,
    source:
      'function render({text}) { /* </script> */ return text + " worker"; }',
  };
  text.effects = [
    newEffectInstance("css", css, "content"),
    newEffectInstance("js", js, "content"),
  ];
  first.effectResources = { css, js };
  first.nodes[0].children = [text];
  first.motion = {
    stages: [
      { id: "entry", tracks: [] },
      {
        id: "click",
        tracks: [
          {
            id: "move",
            elementId: text.id,
            property: "transform.x",
            keyframes: [
              {
                id: "from",
                at: 0,
                value: { type: "offset", value: 0 },
                easeToNext: "linear",
              },
              { id: "to", at: 100, value: { type: "offset", value: 100 } },
            ],
          },
        ],
      },
    ],
  };
  const second = structuredClone(first);
  second.id = "second";
  delete second.motion;
  const media = (id: string, type: "image" | "svg" | "video") => {
    const element = createMediaElement(id, {
      version: 1,
      id,
      filename: id,
      names: [id],
      type,
      mediaType: type === "svg" ? "image" : type,
      mime: type === "video" ? "video/webm" : "image/svg+xml",
      bytes: 1,
      width: 320,
      height: 180,
      createdAt: "2026-10-24T00:00:00Z",
    });
    Object.assign(element.frame, {
      x: id === "video" ? 700 : 40,
      y: 200,
      width: 320,
      height: 180,
    });
    return element;
  };
  const image = media("image", "image");
  const svg = media("svg", "svg");
  svg.frame.y = 450;
  svg.appearance.opacity = 0.6;
  const video = media("video", "video");
  if (video.content?.type === "video") {
    video.content.startTime = 0.1;
    video.content.endTime = 0.8;
    video.content.loop = true;
  }
  const direct = blankEffect("shader");
  const generated = {
    ...blankEffect("shader"),
    input: "none" as const,
    source: shaderBoilerplate("generated"),
  };
  image.effects = [newEffectInstance("direct", direct, "content")];
  video.effects = [newEffectInstance("direct", direct, "content")];
  const panel = createTextElement("generated", { x: 1100, y: 200 });
  panel.effects = [newEffectInstance("generated", generated, "background")];
  second.effectResources = { direct, generated };
  second.nodes[0].children = [image, svg, video, panel];
  model.deck.slideIds.push(second.id);
  model.deck.slideMeta[second.id] = {
    ...model.deck.slideMeta[first.id],
    name: "Media",
  };
  model.deck.transitionDefaults = {
    kind: "fade",
    durationMs: 150,
    easing: "linear",
  };
  return { deck: model.deck, slides: [first, second] };
}
