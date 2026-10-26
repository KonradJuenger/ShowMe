#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform float u_p; // 0..1 progress supplied by the Effect's timeline duration.
uniform float u_t;
uniform vec2 u_size;
uniform float strength;
uniform float ribSpacing;
uniform float reveal;
uniform float frost;
in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 size = max(u_size, vec2(1.0));
  float progress = smoothstep(0.0, 1.0, u_p);
  float amount = mix(1.0, 1.0 - progress, reveal)
    * smoothstep(0.0, 8.0, max(strength, 0.0));
  if (amount <= 0.0) {
    outColor = texture(u_input, v_uv);
    return;
  }
  float spacing = max(ribSpacing, 1.0);
  float rib = fract(v_uv.x * size.x / spacing);

  // A periodic lens profile joins neighbouring ribs with matching value
  // and slope. There is no sawtooth reset or hard seam between lenses.
  float phase = rib * 6.2831853;
  float lens = sin(phase);
  vec2 uv = v_uv;
  // A slight change in refraction keeps the glass live, while the rib
  // boundaries stay fixed and perfectly vertical.
  float refraction = max(strength, 0.0) * (1.0 + 0.03 * sin(u_t * 0.75));
  uv.x += lens * refraction * amount / size.x;

  // Frost spreads samples horizontally only. Y is always unchanged.
  float blur = max(frost, 0.0) * amount / size.x;
  vec4 color = vec4(0.0);
  for (int i = -4; i <= 4; i++) {
    vec2 sampleUv = vec2(clamp(uv.x + float(i) * blur / 4.0, 0.0, 1.0), uv.y);
    color += texture(u_input, sampleUv) / 9.0;
  }

  // Narrow bright/dark edges suggest clear fluted glass. Multiplication
  // preserves the premultiplied alpha of text and other transparent input.
  float edge = pow(0.5 + 0.5 * cos(phase), 12.0);
  color.rgb *= 1.0 + amount * (0.10 * lens - 0.18 * edge);
  outColor = color;
}
