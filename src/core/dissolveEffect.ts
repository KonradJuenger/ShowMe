import { EFFECT_API_VERSION } from "./effects";
import type { EffectDefinition } from "./effects";
/** Pixel dissolve is a programmable Effect, optionally triggered. */
export const dissolveEffect: EffectDefinition = {
  apiVersion: EFFECT_API_VERSION,
  timeControl: { start: "slide", stop: { mode: "after", durationMs: 2000 } },
  name: "Dissolve",
  category: "effect",
  kind: "fragment-glsl",
  target: "content",
  input: "content",
  parameters: [],
  source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_p;
uniform vec2 u_resolution;
in vec2 v_uv;
out vec4 outColor;
void main() {
 vec2 cell = floor(v_uv * u_resolution);
 float noise = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
 float alpha = u_p >= 1.0 ? 1.0 : (u_p <= 0.0 ? 0.0 : step(noise, u_p));
 outColor = texture(u_input, v_uv) * alpha;
}`,
};
