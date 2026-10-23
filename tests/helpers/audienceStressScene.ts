import type { Slide } from "../../src/core/document";
import type { Element } from "../../src/core/element";
import { createBasicShape } from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";

export const AUDIENCE_STRESS_WORKLOAD = {
  version: 3,
  slides: 30,
  imagesPerSlide: 12,
  textsPerSlide: 39,
  shapesPerSlide: 36,
  shadersPerSlide: 3,
  cssEffectsPerSlide: 6,
  motionTracksPerSlide: 24,
  uniqueImageAssets: 96,
  shaderPanelWidth: 580,
  shaderPanelHeight: 280,
  logicalWidth: 1920,
  logicalHeight: 1080,
};

/** Fixed composition and arithmetic; no private assets or random workload sizes. */
export function populateAudienceStressScene(
  slide: Slide,
  index: number,
  image: Element,
) {
  const images = Array.from({ length: 12 }, (_, i) => {
    const tile = structuredClone(image);
    tile.id = `image-${i}`;
    if (tile.content?.type === "image")
      tile.content.assetId = (16 + (index % 8) * 12 + i)
        .toString(16)
        .padStart(64, "0");
    Object.assign(tile.frame, {
      x: 30 + (i % 6) * 310,
      y: 30 + Math.floor(i / 6) * 190,
      width: 280,
      height: 160,
    });
    return tile;
  });
  const css = {
    ...blankEffect("css-js"),
    source:
      ":scope { text-shadow: 2px 2px 3px #639; background: linear-gradient(90deg,#eff,#dde); }",
  };
  const shader = {
    ...blankEffect("shader"),
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input; uniform float u_t;
in vec2 v_uv; out vec4 outColor;
void main() {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float phase = u_t * 0.6 + float(i);
    vec2 offset = vec2(sin(phase), cos(phase)) * 0.003;
    sum += texture(u_input, clamp(v_uv + offset, 0.0, 1.0));
  }
  vec4 sampled = sum / 16.0;
  vec3 background = vec3(0.90 + 0.04 * sin(u_t + v_uv.x), 0.94, 0.98);
  outColor = vec4(mix(background, sampled.rgb / max(sampled.a, 0.0001), sampled.a), 1.0);
}`,
  };
  slide.effectResources = { "stress-css": css, "stress-shader": shader };
  const texts = Array.from({ length: 36 }, (_, i) => {
    const text = createTextElement(`text-${i}`, {
      x: 30 + (i % 6) * 310,
      y: 430 + Math.floor(i / 6) * 82,
    });
    Object.assign(text.frame, { width: 270, height: 72 });
    if (text.content?.type === "text") {
      text.content.text = `Slide ${index + 1} · ${i + 1}\nTypography, wrapping & pixels`;
      if (text.content.format.kind === "local")
        text.content.format.typography.fontSize = 18 + (i % 3);
    }
    if (i < 6) text.effects = [newEffectInstance("stress-css", css, "content")];
    return text;
  });
  const shapes = Array.from({ length: 36 }, (_, i) => {
    const shape = createBasicShape(`shape-${i}`, "rectangle", {
      x: 35 + i * 51,
      y: 990,
    });
    Object.assign(shape.frame, { width: 35, height: 35 });
    shape.appearance.fill = ["#2165ba", "#c94b32", "#228855"][i % 3];
    return shape;
  });
  // Large wrapped text panels exercise DOM capture and real animated GLSL.
  const panels = Array.from({ length: 3 }, (_, i) => {
    const panel = createTextElement(`shader-panel-${i}`, {
      x: 30 + i * 620,
      y: 650,
    });
    Object.assign(panel.frame, { width: 580, height: 280 });
    if (panel.content?.type === "text") {
      panel.content.text = texts
        .slice(12 + i * 4, 16 + i * 4)
        .map((text) => (text.content?.type === "text" ? text.content.text : ""))
        .join("\n\n");
      if (panel.content.format.kind === "local")
        panel.content.format.typography.fontSize = 20;
    }
    panel.effects = [newEffectInstance("stress-shader", shader, "content")];
    return panel;
  });
  slide.nodes[0].children = [...images, ...texts, ...panels, ...shapes];
  slide.motion = {
    stages: [
      {
        id: "stress-motion",
        tracks: [...images, ...shapes.slice(0, 12)].map((element, i) => ({
          id: `track-${i}`,
          elementId: element.id,
          property: "transform.y" as const,
          keyframes: [
            {
              id: `from-${i}`,
              at: 0,
              value: { type: "offset" as const, value: 0 },
              easeToNext: "linear" as const,
            },
            {
              id: `to-${i}`,
              at: 3000,
              value: { type: "offset" as const, value: i % 2 ? 24 : -24 },
            },
          ],
        })),
      },
    ],
  };
}
