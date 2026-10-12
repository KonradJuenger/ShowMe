import { easeProgress } from "./motionEasing";
import { z } from "zod";
import { idSchema, uid } from "./ids";
import type { Element } from "./element";
import type { SlideMotion } from "./motionModel";

export const EFFECT_API_VERSION = 1 as const;

const reservedEffectParameterNames = [
  "t",
  "p",
  "progress",
  "active",
  "time",
  "slideTime",
  "presentationTime",
  "stepTime",
  "stepIndex",
  "duration",
] as const;
export function isReservedEffectParameter(key: string) {
  return (reservedEffectParameterNames as readonly string[]).includes(key);
}
export const EFFECT_STRING_LIMIT = 4096;
const parameterBase = {
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
    .refine(
      (key) =>
        !key.startsWith("u_") &&
        !["resolution", "size"].includes(key) &&
        key !== "stepIndex",
      "Reserved runtime input name",
    ),
  label: z.string().min(1).max(100),
};
const numberParameterSchema = z
  .object({
    ...parameterBase,
    type: z.literal("number"),
    default: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();
export const effectParameterSchema = z
  .discriminatedUnion("type", [
    numberParameterSchema,
    z
      .object({
        ...parameterBase,
        type: z.literal("boolean"),
        default: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...parameterBase,
        type: z.literal("string"),
        default: z.string().max(EFFECT_STRING_LIMIT),
      })
      .strict(),
  ])
  .refine(
    (p) =>
      p.type !== "number" ||
      p.min === undefined ||
      p.max === undefined ||
      p.min <= p.max,
    "Invalid parameter range",
  );
export type EffectParameter = z.infer<typeof effectParameterSchema>;
export type NumericEffectParameter = Extract<
  EffectParameter,
  { type: "number" }
>;
export const effectParameterValueSchema = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(EFFECT_STRING_LIMIT),
]);
export type EffectParameterValue = z.infer<typeof effectParameterValueSchema>;
export const effectTimeControlSchema = z
  .object({
    start: z.enum(["presentation", "slide", "click"]),
    stop: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }).strict(),
      z.object({ mode: z.literal("next-click") }).strict(),
      z.object({ mode: z.literal("slide-end") }).strict(),
      z
        .object({
          mode: z.literal("after"),
          durationMs: z.number().int().positive().max(86400000),
        })
        .strict(),
    ]),
  })
  .strict();
export type EffectTimeControl = z.infer<typeof effectTimeControlSchema>;
export const effectDefinitionSchema = z
  .object({
    apiVersion: z.literal(EFFECT_API_VERSION),
    name: z.string().min(1).max(100),
    category: z.enum(["entrance", "exit", "effect"]),
    kind: z.enum(["fragment-glsl", "css", "text-js"]),
    target: z.enum(["text", "content", "background", "overlay"]),
    input: z.enum(["none", "content", "backdrop"]).optional(),
    source: z.string().min(1).max(100000),
    styleSource: z.string().max(100000).optional(),
    speed: z.number().finite().nonnegative().max(100).optional(),
    timeControl: effectTimeControlSchema.default({
      start: "slide",
      stop: { mode: "none" },
    }),
    parameters: z.array(effectParameterSchema).max(32),
  })
  .strict()
  .refine(
    (d) => new Set(d.parameters.map((p) => p.key)).size === d.parameters.length,
    "Duplicate effect parameter",
  )
  .refine(
    (d) =>
      d.kind !== "fragment-glsl" ||
      d.parameters.every((p) => p.type === "number"),
    "Shader parameters must be numbers",
  )
  .refine(
    (d) => d.kind !== "text-js" || d.target === "text",
    "Text code requires the Text target",
  )
  .refine(
    (d) => d.kind === "fragment-glsl" || d.input === undefined,
    "Shader input belongs to fragment shaders only",
  )

  .refine(
    (d) =>
      d.kind !== "fragment-glsl" ||
      (d.input === "content"
        ? d.target === "content"
        : d.input === "backdrop"
          ? d.target !== "text"
          : ["background", "overlay"].includes(d.target)),
    "Content shaders require the content target; procedural shaders require background or overlay",
  );
export const effectResourcesSchema = z
  .record(idSchema, effectDefinitionSchema)
  .refine(
    (resources) => Object.keys(resources).length <= 100,
    "Too many effect resources",
  )
  .refine(
    (resources) =>
      new TextEncoder().encode(JSON.stringify(resources)).byteLength <= 2000000,
    "Effect resources exceed 2 MB",
  );
export const elementEffectSchema = z
  .object({
    id: idSchema,
    resourceId: idSchema,
    enabled: z.boolean(),
    placement: z.enum(["background", "overlay", "content"]),
    parameters: z
      .record(z.string(), effectParameterValueSchema)
      .refine(
        (values) => Object.keys(values).length <= 32,
        "Too many effect values",
      ),
  })
  .strict();
export const elementEffectsSchema = z
  .array(elementEffectSchema)
  .max(16)
  .refine(
    (effects) => new Set(effects.map((e) => e.id)).size === effects.length,
    "Duplicate effect instance",
  );
export type EffectDefinition = z.infer<typeof effectDefinitionSchema>;
export const effectStartLabels = {
  presentation: "Presentation start",
  slide: "Slide start",
  click: "Click (timeline)",
} as const;
export type ShaderInput = "none" | "content" | "backdrop";
export type EffectResources = z.infer<typeof effectResourcesSchema>;
export type ElementEffect = z.infer<typeof elementEffectSchema>;
export type EffectProperty = `effects.${string}.parameters.${string}`;
export function effectProperty(
  instanceId: string,
  key: string,
): EffectProperty {
  return `effects.${instanceId}.parameters.${key}`;
}
export function parseEffectProperty(address: string) {
  const match =
    /^effects\.([a-zA-Z0-9_-]+)\.parameters\.([a-zA-Z][a-zA-Z0-9_]{0,63})$/.exec(
      address,
    );
  return match ? { instanceId: match[1], key: match[2] } : null;
}
export function effectParameter(
  element: Element,
  address: string,
  resources: EffectResources = {},
) {
  const parsed = parseEffectProperty(address);
  const instance = element.effects?.find((e) => e.id === parsed?.instanceId);
  const parameter = effectParameters(
    resources[instance?.resourceId ?? ""],
  ).find((p) => p.key === parsed?.key);
  return instance && parameter ? { instance, parameter } : null;
}
export function numericEffectParameter(
  element: Element,
  address: string,
  resources: EffectResources = {},
) {
  const binding = effectParameter(element, address, resources);
  return binding?.parameter.type === "number"
    ? { instance: binding.instance, parameter: binding.parameter }
    : null;
}
export function numericEffectParameters(
  definition: EffectDefinition | undefined,
): NumericEffectParameter[] {
  return effectParameters(definition).filter(
    (p): p is NumericEffectParameter => p.type === "number",
  );
}
export function compatibleEffectValue(
  value: unknown,
  parameter: EffectParameter,
): value is EffectParameterValue {
  return (
    typeof value === parameter.type &&
    effectParameterValueSchema.safeParse(value).success
  );
}
export function consumedParameter(
  value: EffectParameterValue,
  parameter: EffectParameter,
): EffectParameterValue {
  if (!compatibleEffectValue(value, parameter)) return parameter.default;
  return parameter.type === "number" && typeof value === "number"
    ? Math.max(
        parameter.min ?? -Infinity,
        Math.min(parameter.max ?? Infinity, value),
      )
    : value;
}
export function cssEffectValue(value: EffectParameterValue) {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  // A CSS string token preserves arbitrary authored text as one safe value.
  let result = '"';
  for (const char of value) {
    const code = char.charCodeAt(0);
    result +=
      code < 32 || code === 127 || char === '"' || char === "\\"
        ? "\\" + code.toString(16) + " "
        : char;
  }
  return result + '"';
}
export function validateEffects(
  elements: readonly Element[],
  resources: EffectResources = {},
) {
  for (const element of elements) {
    if (
      (element.effects ?? []).filter(
        (instance) =>
          instance.enabled &&
          resources[instance.resourceId]?.kind === "text-js",
      ).length > 1
    )
      throw new Error(
        "An Element can have one enabled text function; remove or disable the existing one first",
      );
    for (const instance of element.effects ?? []) {
      const definition = resources[instance.resourceId];
      if (!definition) throw new Error("Missing effect resource");
      if (
        definition.kind === "fragment-glsl" &&
        (definition.input === "content"
          ? instance.placement !== "content"
          : instance.placement === "content")
      )
        throw new Error("Shader placement must match its input mode");
      if (definition.target === "text" && element.content?.type !== "text")
        throw new Error("The Text target requires text content");
      if (
        definition.kind === "text-js" &&
        (instance.placement !== "content" || element.content?.type !== "text")
      )
        throw new Error("Text effects require an Element with text content");
      const keys = new Set(effectParameters(definition).map((p) => p.key));
      if (Object.keys(instance.parameters).some((key) => !keys.has(key)))
        throw new Error("Unknown effect parameter");
      for (const parameter of effectParameters(definition)) {
        const value = instance.parameters[parameter.key];
        if (value !== undefined && !compatibleEffectValue(value, parameter))
          throw new Error("Incompatible effect parameter value");
      }
    }
  }
}
/** Drop removed parameter targets and their block members in the same semantic mutation. */
export function filterEffectMotion(
  motion: SlideMotion | undefined,
  elements: readonly Element[],
  resources: EffectResources,
) {
  if (!motion) return undefined;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const next = structuredClone(motion);
  for (const stage of next.stages) {
    stage.tracks = stage.tracks.filter(
      (t) =>
        !t.property.startsWith("effects.") ||
        (byId.has(t.elementId) &&
          numericEffectParameter(
            byId.get(t.elementId)!,
            t.property,
            resources,
          )),
    );
    for (const block of stage.blocks ?? []) {
      if (block.binding?.kind !== "effect") continue;
      const binding = block.binding;
      const instance = byId
        .get(binding.elementId)
        ?.effects?.find((e) => e.id === binding.effectInstanceId);
      const definition = instance && resources[instance.resourceId];
      if (definition) block.label = definition.name;
    }
    const ids = new Set(stage.tracks.map((t) => t.id));
    stage.blocks = stage.blocks
      ?.map((b) => ({
        ...b,
        members: b.members.filter((m) => ids.has(m.trackId)),
      }))
      .filter(
        (b) =>
          (b.members.length || b.effectSchedule || b.presenceSchedule) &&
          (!b.binding ||
            (b.binding.kind === "presence" && byId.has(b.binding.elementId)) ||
            byId
              .get(b.binding.elementId)
              ?.effects?.some(
                (e) =>
                  e.id ===
                  (b.binding?.kind === "effect"
                    ? b.binding.effectInstanceId
                    : ""),
              )),
      );
  }
  return next;
}
/** Backdrop is always a background lens, including already persisted instances
 * whose reserved input was authored with overlay placement. */
export function effectPlacement(
  definition: EffectDefinition | undefined,
  instance: ElementEffect,
) {
  return definition?.input === "backdrop" ? "background" : instance.placement;
}

export function newEffectInstance(
  resourceId: string,
  definition: EffectDefinition,
  placement: ElementEffect["placement"],
): ElementEffect {
  return {
    id: uid(),
    resourceId,
    enabled: true,
    placement: definition.input === "backdrop" ? "background" : placement,
    parameters: Object.fromEntries(
      effectParameters(definition).map((p) => [p.key, p.default]),
    ),
  };
}
export function importEffectResources(
  existing: EffectResources = {},
  incoming: EffectResources = {},
) {
  const resources = { ...existing },
    ids = new Map<string, string>();
  for (const [id, definition] of Object.entries(incoming)) {
    const same = Object.entries(resources).find(
      ([, d]) => JSON.stringify(d) === JSON.stringify(definition),
    );
    const destination = same?.[0] ?? (resources[id] ? uid() : id);
    resources[destination] = definition;
    ids.set(id, destination);
  }
  return { resources, ids };
}
export const effectTemplates: EffectDefinition[] = [
  {
    apiVersion: EFFECT_API_VERSION,
    timeControl: { start: "slide", stop: { mode: "none" } },
    name: "Glass Distortion",
    category: "effect",
    kind: "fragment-glsl",
    target: "content",
    input: "content",
    parameters: [
      {
        type: "number",
        key: "strength",
        label: "Distortion strength",
        default: 12,
        min: 0,
        max: 60,
      },
      {
        type: "number",
        key: "ribSpacing",
        label: "Glass rib spacing",
        default: 32,
        min: 4,
        max: 160,
      },
    ],
    source: `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_p;
uniform float u_t;
uniform vec2 u_size;
uniform float strength;
uniform float ribSpacing;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec2 size = max(u_size, vec2(1.0));
  vec2 position = v_uv * size;
  float phase = position.x * 6.2831853 / max(ribSpacing, 1.0);
  float ripple = sin(position.y * 0.035 + u_t * 1.2);
  vec2 refraction = vec2(sin(phase + ripple * 0.35), ripple * 0.2);
  vec2 uv = v_uv + refraction * max(strength, 0.0) * u_p / size;
  // Sample the premultiplied source directly, preserving its transparency.
  outColor = texture(u_input, uv);
}`,
  },
  {
    apiVersion: EFFECT_API_VERSION,
    timeControl: { start: "slide", stop: { mode: "after", durationMs: 2000 } },
    name: "CSS Reveal",
    category: "entrance",
    kind: "css",
    target: "content",
    parameters: [],
    source: `:scope {
  opacity: var(--p);
  filter: blur(calc((1 - var(--p)) * 12px));
  clip-path: inset(0 calc((1 - var(--p)) * 100%) 0 0);
}`,
  },
  {
    apiVersion: EFFECT_API_VERSION,
    timeControl: { start: "slide", stop: { mode: "after", durationMs: 2000 } },
    name: "Text Scramble",
    category: "entrance",
    kind: "text-js",
    target: "text",
    parameters: [],
    source: `function render({ text, p, t, random }) {
  if (p >= 1) return text;
  const symbols = Array.from("!§$%&/()=?_<>^°*#-:;~");
  const letters = Array.from(text);
  const tick = Math.floor(t / 0.08);
  // First scramble everything, then settle the letters from left to right.
  const settled = Math.floor(Math.max(0, p * 2 - 1) * letters.length);
  return letters.map((letter, index) => {
    if (/\\s/.test(letter) || index < settled) return letter;
    return symbols[Math.floor(random(tick * letters.length + index) * symbols.length)];
  }).join("");
}`,
  },
];

effectTemplates.push({
  apiVersion: EFFECT_API_VERSION,
  timeControl: { start: "slide", stop: { mode: "none" } },
  name: "Dithered Patterns",
  category: "effect",
  kind: "fragment-glsl",
  input: "backdrop",
  target: "background",
  parameters: [
    {
      type: "number",
      key: "cellSize",
      label: "Cell size",
      default: 8,
      min: 4,
      max: 64,
    },
    {
      type: "number",
      key: "greyLevel",
      label: "Grey level",
      default: 0.72851,
      min: 0.3,
      max: 0.95,
    },
    {
      type: "number",
      key: "chroma",
      label: "Chroma",
      default: 1.3245,
      min: 0.5,
      max: 6,
    },
    {
      type: "number",
      key: "bleed",
      label: "Bleed",
      default: 1,
      min: 0,
      max: 1,
    },
    {
      type: "number",
      key: "patternStrength",
      label: "Pattern strength",
      default: 1,
      min: 0,
      max: 1,
    },
    {
      type: "number",
      key: "amount",
      label: "Amount",
      default: 0.42017,
      min: 0,
      max: 1,
    },
  ],
  source: `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_input;
uniform vec2 u_size;
uniform float u_t;

uniform float cellSize;        // @param 8 [4, 64]
uniform float greyLevel;       // @param 0.72851 [0.3, 0.95]
uniform float chroma;          // @param 1.32450 [0.5, 6]
uniform float bleed;           // @param 1 [0, 1]
uniform float patternStrength; // @param 1 [0, 1]
uniform float amount;          // @param 0.42017 [0, 1]

out vec4 outColor;

const float STEPS = 6.0;   // 7 brightness levels per channel

// red, green, blue, cyan, magenta, amber, violet
const vec3 PRIM[7] = vec3[7](
  vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0),
  vec3(0.0, 1.0, 1.0), vec3(1.0, 0.0, 1.0), vec3(1.0, 0.65, 0.0),
  vec3(0.55, 0.1, 1.0)
);
const vec3 PRIM_SUM = vec3(3.55, 2.75, 4.0); // equal levels -> exact grey

// ---- glow fields (precomputed wave vectors) ----
const vec2 K[7] = vec2[7](
  vec2(4.968, 1.537), vec2(-1.212, 6.691), vec2(-4.581, 0.421), vec2(-2.428, -7.518),
  vec2(-3.931, 4.400), vec2(2.716, -4.078), vec2(4.130, 5.775));
const vec2 W[7] = vec2[7](
  vec2(-0.916, 2.962), vec2(-2.362, -0.428), vec2(-0.348, -3.784), vec2(2.664, -0.861),
  vec2(-2.461, -2.199), vec2(1.831, 1.220), vec2(-2.928, 2.094));
const vec2 B1[7] = vec2[7](
  vec2(0.248, 4.072), vec2(-3.335, -3.672), vec2(3.662, -0.361), vec2(-2.672, 3.695),
  vec2(1.037, -5.177), vec2(-3.268, -2.165), vec2(-4.081, 2.372));
const vec2 B2[7] = vec2[7](
  vec2(-3.513, 0.214), vec2(3.139, -2.851), vec2(0.478, 4.856), vec2(-3.047, -2.203),
  vec2(3.922, 0.785), vec2(2.828, -4.268), vec2(-1.809, -3.112));
const vec2 DRV[7] = vec2[7](   // dither-phase drift, cells per second
  vec2(1.458, 0.000), vec2(-1.290, 1.182), vec2(0.178, -2.033), vec2(1.419, 1.851),
  vec2(-2.584, -0.457), vec2(2.460, -1.565), vec2(-0.833, 3.098));
const float FR[7]   = float[7](5.98, 7.82, 5.29, 9.085, 6.785, 5.635, 8.165);
const float PH[7]   = float[7](0.0, 1.3, 2.6, 3.9, 5.2, 0.7, 2.0);
const float SPD[7]  = float[7](0.42, -0.35, 0.28, -0.50, 0.33, -0.24, 0.46);
const float WSPD[7] = float[7](0.31, -0.27, 0.22, 0.38, -0.33, 0.26, -0.21);
const float BS1[7]  = float[7](0.27, -0.21, 0.31, -0.18, 0.24, -0.29, 0.20);
const float BS2[7]  = float[7](-0.19, 0.25, -0.22, 0.33, -0.16, 0.21, -0.28);
const ivec2 BOFF[7] = ivec2[7](
  ivec2(0, 0), ivec2(3, 5), ivec2(6, 2), ivec2(1, 7),
  ivec2(5, 4), ivec2(2, 1), ivec2(7, 6));

// ---- per-channel cell patterns ----
// 0 red plus | 1 green X | 2 blue square ring | 3 cyan diamond ring (offset lattice)
// 4 magenta dots | 5 amber large plus | 6 violet large X
const float PS[7]   = float[7](6.0, 6.0, 6.0, 6.0, 4.0, 12.0, 12.0);          // lattice spacing (cells)
const vec2 POFF[7]  = vec2[7](vec2(0.0), vec2(0.0), vec2(0.0), vec2(3.0),
                              vec2(1.0), vec2(6.0), vec2(0.0));               // lattice offset (cells)
const float PPER[7] = float[7](6.2, 7.4, 8.6, 5.6, 7.0, 10.0, 12.0);          // cycle length (s)
const vec2 PDIR[7]  = vec2[7](                                                // sweep direction (phase per cell)
  vec2(0.0075, 0.005), vec2(-0.006, 0.007), vec2(0.005, -0.008), vec2(-0.008, -0.004),
  vec2(0.0, 0.010), vec2(0.009, 0.002), vec2(-0.004, -0.006));

// distance from node centre if the cell belongs to the pattern, otherwise -1
int shapeDist(int i, ivec2 r) {
  int ax = abs(r.x), ay = abs(r.y);
  if (i == 0) return ((ax == 0 && ay <= 2) || (ay == 0 && ax <= 2)) ? ax + ay : -1;
  if (i == 1) return (ax == ay && ax <= 2) ? ax : -1;
  if (i == 2) return (max(ax, ay) == 2) ? ax + ay - 2 : -1;
  if (i == 3) return (ax + ay == 2) ? abs(ax - ay) : -1;
  if (i == 4) return (ax == 0 && ay == 0) ? 0 : -1;
  if (i == 5) return ((ax == 0 && ay <= 4) || (ay == 0 && ax <= 4)) ? ax + ay : -1;
  return (ax == ay && ax <= 4) ? ax : -1;
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float bayer8(ivec2 p) {
  int x = p.x & 7, y = p.y & 7, xy = x ^ y;
  int v = ((xy & 1) << 5) | ((y & 1) << 4) | ((xy & 2) << 2)
        | ((y & 2) << 1) | ((xy & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}
float bayer4(ivec2 p) {
  int x = p.x & 3, y = p.y & 3, xy = x ^ y;
  int v = ((xy & 1) << 3) | ((y & 1) << 2) | (xy & 2) | ((y & 2) >> 1);
  return (float(v) + 0.5) / 16.0;
}

float quant(float v01, float thr) {
  float v = clamp(v01, 0.0, 1.0) * STEPS;
  float lo = floor(v);
  return (lo + step(thr, v - lo)) / STEPS;
}

void main() {
  // Baseline animation speed; transport Speed remains an additional multiplier.
  float t = u_t * 0.4;

  // ---- coarse grid centred on the element ----
  float cs = max(cellSize, 2.0);
  vec2 cellF = floor((v_uv * u_size - 0.5 * u_size) / cs);
  ivec2 cell = ivec2(cellF);
  vec2 q = (cellF + 0.5) * cs / max(u_size.x, u_size.y);

  // ---- shared grey field ----
  float s = sin(dot(q, vec2(3.9, 2.6)) + t * 0.31 + 1.2 * sin(dot(q, vec2(-2.4, 3.8)) + t * 0.22))
          + sin(dot(q, vec2(-4.6, 1.9)) - t * 0.27 + 2.0)
          + sin(length(q - vec2(0.25 * sin(t * 0.15), 0.2 * cos(t * 0.12))) * 6.0 - t * 0.35 + 1.0);
  float base = clamp(greyLevel + 0.13 * s, 0.1, 1.0);

  float sharedThr = bayer8(cell);
  float levS = quant(base, sharedThr);
  vec3 acc = levS * PRIM_SUM;

  float lo = mix(0.95, 0.5, bleed);
  float inv = 1.0 / (1.0 - lo);

  for (int i = 0; i < 7; i++) {
    // soft spectral glow for this channel
    float x = 0.5 + 0.5 * sin(dot(q, B1[i]) + t * BS1[i] + PH[i] * 2.3);
    float y = 0.5 + 0.5 * sin(dot(q, B2[i]) - t * BS2[i] + PH[i] * 1.7 + 1.0);
    float k = clamp((x * y - lo) * inv, 0.0, 1.0);
    float g = k * k;

    // this channel's own pattern lattice
    float S = PS[i];
    vec2 u = cellF - POFF[i];
    vec2 nf = floor((u + floor(S * 0.5)) / S);
    ivec2 rel = ivec2(u - nf * S);
    int d = shapeDist(i, rel);

    float pa = 0.0;    // pattern opacity at this cell
    int mode = 0;      // 0 add, 1 subtract, 2 paint (mix)
    float lvl = 0.0;
    if (d >= 0) {
      vec2 nc = nf * S + POFF[i];
      float cu = t / PPER[i] - dot(nc, PDIR[i]) + 0.08 * hash21(nf + float(i) * 17.0);
      float cyc = floor(cu);
      float cph = cu - cyc;
      float env = 1.1 * smoothstep(0.0, 0.25, cph) * (1.0 - smoothstep(0.4, 0.65, cph));
      // cells appear in Bayer order, tips last
      if (bayer8(rel + ivec2(i * 3, i * 5)) < env - 0.12 * float(d)) {
        pa = min(env, 1.0);
        float h = hash21(vec2(cyc, 3.1 + 5.7 * float(i)));
        mode = h < 0.4 ? 0 : (h < 0.75 ? 1 : 2);
        lvl = 0.1 + 0.85 * hash21(vec2(cyc + 0.5, 9.7 + float(i)));
      }
    }

    if (g > 0.01 || pa > 0.0) {
      float tgt = base;
      float thr = sharedThr;

      if (g > 0.01) {
        float warp = sin(dot(q, W[i]) + t * WSPD[i] + PH[i] * 1.7);
        float ph;
        if (i == 1 || i == 4 || i == 6) {
          vec2 c = 0.3 * vec2(sin(t * 0.17 + PH[i]), cos(t * 0.13 + PH[i] * 1.3));
          ph = length(q - c) * FR[i];
        } else {
          ph = dot(q, K[i]);
        }
        float f = 0.5 + 0.5 * sin(ph + 1.4 * warp + t * SPD[i] + PH[i]);
        tgt += (2.0 * f - 1.0) * g * 0.95;
        ivec2 p = cell + BOFF[i] + ivec2(floor(DRV[i] * t));
        float own = ((i & 1) == 0) ? bayer8(p) : bayer4(p);
        thr = mix(sharedThr, own, min(g * 3.0, 1.0));
      }

      if (pa > 0.0) {
        float amt = 2.0 * patternStrength * pa;
        if (mode == 0)      tgt += amt;                                         // add light
        else if (mode == 1) tgt -= amt;                                         // subtract light
        else                tgt = mix(tgt, lvl, min(2.0 * patternStrength, 1.0) * pa); // paint over
        ivec2 pp = cell + BOFF[i].yx;
        thr = ((i & 1) == 0) ? bayer8(pp) : bayer4(pp);
      }

      acc += (quant(tgt, thr) - levS) * PRIM[i];
    }
  }

  vec3 col = acc / PRIM_SUM;
  float grey = (col.r + col.g + col.b) / 3.0;
  col = clamp(vec3(grey) + (col - vec3(grey)) * chroma, 0.0, 1.0);

  vec4 src = texture(u_input, v_uv);
  outColor = vec4(mix(src.rgb, col, amount), mix(src.a, 1.0, amount));
}`,
});

export type EffectClockEndpoint = {
  slideTime: number;
  presentationTime: number;
};
export type EffectClocks = {
  slideTime: number;
  presentationTime: number;
  stepTime?: number;
  stepIndex?: number;
  /** Logical slide-time offsets, in seconds, at which click stages were entered. */
  stageStarts?: readonly number[];
  /** Capture both clocks: local preparation can pause Slide independently. */
  slideEnd?: EffectClockEndpoint;
};
function effectStageDuration(stage: SlideMotion["stages"][number]) {
  return Math.max(
    0,
    ...stage.tracks.map((track) => track.keyframes.at(-1)?.at ?? 0),
  );
}

export function effectStageStart(
  motion: SlideMotion | undefined,
  index: number,
) {
  return (
    (motion?.stages.slice(0, Math.max(0, index)) ?? []).reduce(
      (sum, stage) => sum + effectStageDuration(stage),
      0,
    ) / 1000
  );
}

/** The bound block is the execution identity. */
export function effectExecutionRange(
  motion: SlideMotion | undefined,
  elementId: string,
  instanceId: string,
) {
  for (const [stageIndex, stage] of (motion?.stages ?? []).entries()) {
    const block = stage.blocks?.find(
      (candidate) =>
        candidate.binding?.kind === "effect" &&
        candidate.binding.elementId === elementId &&
        candidate.binding.effectInstanceId === instanceId &&
        candidate.effectSchedule,
    );
    if (!block) continue;
    return {
      schedule: block.effectSchedule!,
      stageIndex,
      start: block.effectSchedule!.startOffsetMs,
    };
  }
  return undefined;
}

export function compileEffectTiming(
  motion: SlideMotion | undefined,
  elementId: string,
  instanceId: string,
  defaults?: EffectTimeControl,
) {
  const range = effectExecutionRange(motion, elementId, instanceId);
  const stop = range?.schedule.stop ?? defaults?.stop;
  const starts: number[] = [];
  let elapsed = 0;
  for (const stage of motion?.stages ?? []) {
    starts.push(elapsed);
    elapsed += effectStageDuration(stage) / 1000;
  }
  const binding = {
    range,
    starts,
    stopIndex:
      stop?.mode === "click"
        ? (motion?.stages.findIndex((stage) => stage.id === stop.stageId) ?? -1)
        : -1,
  };
  return {
    range,
    sample: (stageIndex: number, time: number, clocks?: EffectClocks) =>
      effectTiming(
        motion,
        stageIndex,
        time,
        elementId,
        instanceId,
        clocks,
        defaults,
        binding,
      ),
  };
}
type TimingBinding = {
  range: ReturnType<typeof effectExecutionRange>;
  starts: number[];
  stopIndex: number;
};

/** Generic Effect time has one origin and one optional endpoint. */
export function effectTiming(
  motion: SlideMotion | undefined,
  stageIndex: number,
  time: number,
  elementId: string,
  instanceId: string,
  clocks?: EffectClocks,
  defaults?: EffectTimeControl,
  binding?: TimingBinding,
) {
  const range = binding
    ? binding.range
    : effectExecutionRange(motion, elementId, instanceId);
  const schedule = range?.schedule;
  const start = schedule?.start ?? defaults?.start ?? "slide";
  const stop = schedule?.stop ?? defaults?.stop ?? { mode: "none" as const };
  const slideTime =
    clocks?.slideTime ??
    (binding?.starts[stageIndex] ?? effectStageStart(motion, stageIndex)) +
      Math.max(0, time) / 1000;
  const presentationTime = clocks?.presentationTime ?? slideTime;
  const stepTime = clocks?.stepTime ?? Math.max(0, time) / 1000;
  const clickOrigin =
    range && stageIndex >= range.stageIndex
      ? (clocks?.stageStarts?.[range.stageIndex] ??
        (range.stageIndex === stageIndex
          ? Math.max(0, slideTime - Math.max(stepTime, time / 1000))
          : (binding?.starts[range.stageIndex] ??
            effectStageStart(motion, range.stageIndex))))
      : undefined;
  const offset = (schedule?.startOffsetMs ?? 0) / 1000;
  const origin = resolveEffectStartOrigin(start, clickOrigin, offset);
  const stopAt = resolveEffectStop(
    stop,
    motion,
    start === "click" ? (range?.stageIndex ?? 0) : 0,
    stageIndex,
    clocks,
    start === "presentation",
    binding,
  );
  const sampled = sampleEffectTime(
    start === "presentation" ? presentationTime : slideTime,
    origin,
    stopAt,
    stop.mode === "after" ? stop.durationMs / 1000 : undefined,
  );
  const duration = stop.mode === "after" ? stop.durationMs / 1000 : 0;
  const progress = !sampled.started
    ? 0
    : duration
      ? sampled.time >= duration
        ? 1
        : easeProgress(sampled.time / duration, schedule?.progressEasing)
      : stop.mode === "none" || (stopAt !== undefined && !sampled.running)
        ? 1
        : 0;
  return {
    ...sampled,
    progress,
    duration,
    slideTime,
    presentationTime,
    stepTime,
    stepIndex: Math.max(0, Math.trunc(clocks?.stepIndex ?? stageIndex)),
    active: true,
  };
}

export function resolveEffectStartOrigin(
  start: EffectTimeControl["start"],
  clickOrigin: number | undefined,
  offset = 0,
): number | undefined {
  return start === "click"
    ? clickOrigin === undefined
      ? undefined
      : clickOrigin + offset
    : offset;
}

export function resolveEffectStop(
  stop: import("./motionModel").EffectSchedule["stop"],
  motion: SlideMotion | undefined,
  startIndex: number,
  stageIndex: number,
  clocks?: EffectClocks,
  presentationOrigin = false,
  binding?: TimingBinding,
): number | undefined {
  const endpoint = stop.mode === "slide-end" ? clocks?.slideEnd : undefined;
  if (endpoint)
    return presentationOrigin ? endpoint.presentationTime : endpoint.slideTime;
  const endIndex =
    stop.mode === "next-click"
      ? startIndex + 1
      : stop.mode === "click"
        ? (binding?.stopIndex ??
          motion?.stages.findIndex((s) => s.id === stop.stageId) ??
          -1)
        : -1;
  return endIndex >= 0 && !!motion?.stages[endIndex] && stageIndex >= endIndex
    ? (clocks?.stageStarts?.[endIndex] ??
        binding?.starts[endIndex] ??
        effectStageStart(motion, endIndex)) +
        (presentationOrigin && clocks
          ? clocks.presentationTime - clocks.slideTime
          : 0)
    : undefined;
}

export function sampleEffectTime(
  now: number,
  origin: number | undefined,
  stopAt?: number,
  duration?: number,
) {
  const elapsed =
    origin === undefined
      ? 0
      : Math.max(0, Math.min(now, stopAt ?? Infinity) - origin);
  return {
    started: origin !== undefined && now >= origin,
    time: Math.min(elapsed, duration ?? Infinity),
    running:
      origin !== undefined &&
      now >= origin &&
      (stopAt === undefined || now < stopAt) &&
      (duration === undefined || elapsed + 1e-9 < duration),
  };
}
/** Execution identity is explicit; never inferred from authored source. */
export function effectExecutionActive(
  motion: SlideMotion | undefined,
  index: number,
  time: number,
  elementId: string,
  instanceId: string,
) {
  return effectTiming(motion, index, time, elementId, instanceId).active;
}

export function effectParameterLabel(key: string) {
  const words = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export type ShaderParameterCandidate = NumericEffectParameter & {
  annotated: boolean;
};

const shaderBuiltinUniforms: Record<string, string> = {
  u_input: "sampler2D",
  u_t: "float",
  u_p: "float",
  u_stepTime: "float",
  u_stepIndex: "float",
  u_active: "float",
  u_slideTime: "float",
  u_presentationTime: "float",
  u_duration: "float",
  u_size: "vec2",
  u_resolution: "vec2",
};

const shaderNumber =
  "[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+))(?:[eE][+-]?\\d+)?";
const shaderParamAnnotation = new RegExp(
  "^@param\\s+(" +
    shaderNumber +
    ")(?:\\s+\\[\\s*(" +
    shaderNumber +
    ")\\s*,\\s*(" +
    shaderNumber +
    ")\\s*\\])?\\s*$",
);

function withoutBlockComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

function updateBraceDepth(source: string, depth: number) {
  for (const char of source) {
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Small deterministic GLSL scanner for top-level custom scalar uniforms.
 * It deliberately is not a general GLSL parser.
 */
export function scanShaderParameters(source: string) {
  const diagnostics: string[] = [];
  const parameters: ShaderParameterCandidate[] = [];
  const uniforms = new Set<string>();
  const stripped = withoutBlockComments(source);
  const code = stripped.replace(/\/\/[^\n]*/g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const uniform = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);/g;
  let depth = 0;
  let cursor = 0;
  for (const match of code.matchAll(uniform)) {
    const index = match.index ?? 0;
    depth = updateBraceDepth(code.slice(cursor, index), depth);
    cursor = index + match[0].length;
    if (depth !== 0) continue;
    const type = match[1];
    const declarations = match[2]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const lineEnd = stripped.indexOf("\n", cursor);
    const trailing = stripped.slice(
      cursor,
      lineEnd < 0 ? stripped.length : lineEnd,
    );
    const comment = /^\s*\/\/\s*(.*)$/.exec(trailing)?.[1].trim() ?? "";
    for (const declaration of declarations) {
      const parsed = /^([a-zA-Z][a-zA-Z0-9_]*)(\s*\[[^\]]*\])?$/.exec(
        declaration,
      );
      if (!parsed) continue;
      const name = parsed[1];
      const array = Boolean(parsed[2]);
      if (uniforms.has(name)) {
        diagnostics.push("Duplicate uniform " + name);
        continue;
      }
      uniforms.add(name);
      if (array) {
        diagnostics.push("Uniform arrays are unsupported: " + name);
        continue;
      }
      const builtinType = shaderBuiltinUniforms[name];
      if (builtinType) {
        if (type !== builtinType)
          diagnostics.push(name + " must be " + builtinType);
        continue;
      }
      if (isReservedEffectParameter(name)) {
        diagnostics.push("Reserved timing parameter name: " + name);
        continue;
      }
      if (name.startsWith("u_") || ["resolution", "size"].includes(name)) {
        diagnostics.push("Reserved uniform name: " + name);
        continue;
      }
      if (type !== "float") {
        diagnostics.push("Unsupported uniform type " + type + ": " + name);
        continue;
      }
      let value: ShaderParameterCandidate = {
        type: "number",
        key: name,
        label: effectParameterLabel(name),
        default: 0,
        annotated: false,
      };
      if (comment.includes("@param")) {
        const annotation = shaderParamAnnotation.exec(comment);
        if (!annotation) {
          diagnostics.push("Invalid @param annotation for " + name);
        } else {
          const defaultValue = Number(annotation[1]);
          const min =
            annotation[2] === undefined ? undefined : Number(annotation[2]);
          const max =
            annotation[3] === undefined ? undefined : Number(annotation[3]);
          if (
            !Number.isFinite(defaultValue) ||
            (min !== undefined && !Number.isFinite(min)) ||
            (max !== undefined && !Number.isFinite(max)) ||
            (min !== undefined && max !== undefined && min > max)
          ) {
            diagnostics.push("Invalid @param annotation for " + name);
          } else if (
            (min !== undefined && defaultValue < min) ||
            (max !== undefined && defaultValue > max)
          ) {
            diagnostics.push(
              "@param default for " +
                name +
                " must be within [" +
                min +
                ", " +
                max +
                "]",
            );
          } else {
            value = {
              ...value,
              default: defaultValue,
              ...(min === undefined ? {} : { min }),
              ...(max === undefined ? {} : { max }),
              annotated: true,
            };
          }
        }
      }
      parameters.push(value);
    }
  }
  return { parameters, diagnostics };
}

function parameterContractEqual(
  parameter: EffectDefinition["parameters"][number],
  candidate: ShaderParameterCandidate | undefined,
) {
  return (
    parameter.type === "number" &&
    !!candidate &&
    parameter.default === candidate.default &&
    parameter.min === candidate.min &&
    parameter.max === candidate.max
  );
}

function shaderParameterMetadata(definition: EffectDefinition) {
  if (definition.kind !== "fragment-glsl") return definition.parameters;
  const discovered = scanShaderParameters(definition.source).parameters;
  const existing = new Map(
    definition.parameters
      .filter((p): p is NumericEffectParameter => p.type === "number")
      .map((p) => [p.key, p]),
  );
  return discovered.map(({ annotated: _annotated, ...candidate }) => ({
    ...candidate,
    ...existing.get(candidate.key),
  }));
}

/**
 * Reconcile a shader source edit with its source-owned uniform keys.
 * Existing author metadata wins unless it still exactly reflects the previous
 * source annotation, in which case a changed @param annotation is imported.
 */
export function reconcileShaderSource(
  definition: EffectDefinition,
  source: string,
): EffectDefinition {
  if (definition.kind !== "fragment-glsl") return { ...definition, source };
  const previous = new Map(
    scanShaderParameters(definition.source).parameters.map((p) => [p.key, p]),
  );
  const existing = new Map(
    definition.parameters
      .filter((p): p is NumericEffectParameter => p.type === "number")
      .map((p) => [p.key, p]),
  );
  const parameters = scanShaderParameters(source).parameters.map(
    ({ annotated: _annotated, ...candidate }) => {
      const current = existing.get(candidate.key);
      if (!current) return candidate;
      const oldCandidate = previous.get(candidate.key);
      const sourceOwned = parameterContractEqual(current, oldCandidate);
      return sourceOwned
        ? { ...candidate, label: current.label }
        : { ...candidate, ...current };
    },
  );
  return { ...definition, source, parameters };
}

/** Source dependencies control clock updates and Studio transport disclosure. */
export function effectDependencies(definition: EffectDefinition) {
  const clean = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .replace(/\buniform\s+[^;]+;/g, "");
  const source = clean(definition.source).replace(
    definition.kind === "text-js"
      ? /\bfunction\s+render\s*\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g
      : /$^/g,
    "",
  );
  const css = clean(
    definition.kind === "css"
      ? definition.source
      : (definition.styleSource ?? ""),
  );
  const shader = definition.kind === "fragment-glsl";
  const js = definition.kind === "text-js";
  const genericTime = shader
    ? /\bu_t\b/.test(source)
    : /--t(?![\w-])/.test(css) || (js && /\bt\b/.test(source));
  return {
    genericTime,
    stepState: shader
      ? /\bu_stepIndex\b/.test(source)
      : /--stepIndex(?![\w-])/.test(css) ||
        (js && /\bstepIndex\b/.test(source)),
    progress: shader
      ? /\bu_p\b/.test(source)
      : /--p(?![\w-])|@keyframes\b/.test(css) || (js && /\bp\b/.test(source)),
    continuous:
      genericTime ||
      (shader
        ? /\bu_(?:slideTime|presentationTime|stepTime)\b/.test(source)
        : /--(?:slideTime|presentationTime|stepTime)(?![\w-])/.test(css) ||
          (js && /\b(?:slideTime|presentationTime|stepTime)\b/.test(source))),
  };
}

/** All authored typed controls; numericEffectParameters is the Motion subset. */
export function effectParameters(definition: EffectDefinition | undefined) {
  return definition
    ? shaderParameterMetadata(definition).filter(
        (p) => !isReservedEffectParameter(p.key),
      )
    : [];
}

/** Authoring checks do not invalidate previously saved custom controls. */
export function effectAuthoringDiagnostics(
  definition: EffectDefinition,
): string[] {
  const parsed = effectDefinitionSchema.safeParse(definition);
  return [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message)),
    ...definition.parameters
      .filter((p) => isReservedEffectParameter(p.key))
      .map((p) => "Reserved timing parameter name: " + p.key),
    ...definition.parameters.flatMap((parameter) => {
      if (parameter.type !== "number") return [];
      if (
        parameter.min !== undefined &&
        parameter.max !== undefined &&
        parameter.min > parameter.max
      )
        return [];
      if (parameter.min !== undefined && parameter.default < parameter.min)
        return [
          `Parameter ${parameter.key} default must be at least ${parameter.min}`,
        ];
      if (parameter.max !== undefined && parameter.default > parameter.max)
        return [
          `Parameter ${parameter.key} default must be at most ${parameter.max}`,
        ];
      return [];
    }),
    ...shaderDiagnostics(definition),
  ];
}

/** Includes inactive declarations that WebGL may optimize away. */
export function shaderDiagnostics(definition: EffectDefinition): string[] {
  if (definition.kind !== "fragment-glsl") return [];
  const scan = scanShaderParameters(definition.source);
  const keys = new Set(scan.parameters.map((p) => p.key));
  const diagnostics = [...scan.diagnostics];
  const clean = withoutBlockComments(definition.source).replace(
    /\/\/[^\n]*/g,
    "",
  );
  if (
    (definition.input ?? "none") === "none" &&
    /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?sampler2D\s+u_input\b/.test(
      clean,
    )
  )
    diagnostics.push("u_input is unavailable without shader input");
  for (const parameter of definition.parameters) {
    if (parameter.key === "progress") continue;
    if (
      !keys.has(parameter.key) ||
      (clean.match(new RegExp("\\b" + parameter.key + "\\b", "g"))?.length ??
        0) < 2
    )
      diagnostics.push(
        "Effect parameter " + parameter.key + " is unused by GLSL",
      );
  }
  return diagnostics;
}
