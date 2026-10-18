import { EFFECT_API_VERSION } from "./effects";
import {
  effectParameters,
  numericEffectParameters,
  effectStartLabels,
  type EffectDefinition,
} from "./effects";

export type EffectAuthoringType = "shader" | "css-js";
export type EffectAffects =
  "pixels" | "backdrop" | "generated" | "element" | "text";
export const blankCss = ":scope {\n}";
export const blankTextJs =
  "function render({ text, t, p, parameters }) {\n  return text;\n}";
export function shaderBoilerplate(affects: EffectAffects) {
  return `#version 300 es
precision highp float;

${affects === "generated" ? "" : "uniform sampler2D u_input;\n"}in vec2 v_uv;
out vec4 outColor;

void main() {
  outColor = ${affects === "generated" ? "vec4(0.5, 0.5, 0.5, 1.0)" : "texture(u_input, v_uv)"};
}`;
}
export function effectAffects(definition: EffectDefinition): EffectAffects {
  if (definition.kind !== "fragment-glsl")
    return definition.target === "text" ? "text" : "element";
  return definition.input === "content"
    ? "pixels"
    : definition.input === "backdrop"
      ? "backdrop"
      : "generated";
}
export function blankEffect(type: EffectAuthoringType): EffectDefinition {
  return {
    apiVersion: EFFECT_API_VERSION,
    name: "New Effect",
    category: "effect",
    parameters: [],
    speed: 1,
    timeControl: { start: "slide", stop: { mode: "none" } },
    target: "content",
    ...(type === "shader"
      ? {
          kind: "fragment-glsl",
          input: "content",
          source: shaderBoilerplate("pixels"),
        }
      : { kind: "css", source: blankCss }),
  };
}
/** Only untouched generated boilerplate may be replaced. Authored sources survive mode changes. */
export function changeEffectAffects(
  definition: EffectDefinition,
  affects: EffectAffects,
  untouched: boolean,
): EffectDefinition {
  if (definition.kind === "fragment-glsl")
    return {
      ...definition,
      target: affects === "pixels" ? "content" : "background",
      input:
        affects === "pixels"
          ? "content"
          : affects === "backdrop"
            ? "backdrop"
            : "none",
      source: untouched ? shaderBoilerplate(affects) : definition.source,
    };
  if (affects === "text")
    return {
      ...definition,
      kind: "text-js",
      target: "text",
      source: definition.kind === "text-js" ? definition.source : blankTextJs,
      styleSource:
        definition.kind === "text-js"
          ? definition.styleSource
          : definition.source,
    };
  const { styleSource, ...rest } = definition;
  return {
    ...rest,
    kind: "css",
    target: "content",
    source:
      definition.kind === "text-js"
        ? (styleSource ?? blankCss)
        : definition.source,
  };
}
type EffectPromptContext = {
  creating?: boolean;
  previewElementName?: string;
  timeControl?: { start: string; stop: string };
};

export function extractSingleGlslFence(value: string) {
  const fences = [
    ...value.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm),
  ];
  if (fences.length !== 1 || fences[0][1].trim().toLowerCase() !== "glsl")
    return null;
  return fences[0][2].replace(/\r?\n$/, "");
}

/** Export the complete authoring environment without requiring repository access. */
export function buildEffectAuthoringPrompt(
  definition: EffectDefinition,
  context: EffectPromptContext = {},
) {
  const control = definition.timeControl;
  const start =
    context.timeControl?.start ??
    effectStartLabels[definition.timeControl.start];
  const stop =
    context.timeControl?.stop ??
    (control?.stop.mode === "after"
      ? `After ${control.stop.durationMs / 1000} s`
      : control?.stop.mode === "next-click"
        ? "Next click"
        : control?.stop.mode === "slide-end"
          ? "Slide end"
          : "None");
  const shader = definition.kind === "fragment-glsl";
  const affects = effectAffects(definition);
  const names = {
    pixels: "Element pixels",
    backdrop: "Backdrop behind frame",
    generated: "Generated layer",
    element: "Element",
    text: "Text",
  };
  const speed = definition.speed ?? 1;
  const t = shader ? "u_t" : "t (JS) / --t (CSS)",
    p = shader ? "u_p" : "p (JS) / --p (CSS)";
  const explanation = {
    pixels:
      "This fragment shader receives rendered pixels of one Element before this Effect as a texture. Transform those pixels and return a new RGBA color for every output pixel.",
    backdrop:
      "This fragment shader receives frame-local pixels behind the frame, not pixels of the frame itself. It acts as a background lens. The frame's own text, media and other content remain sharp above the result.",
    generated:
      "This fragment shader generates its own pixels procedurally. There is no u_input or input texture. The generated layer uses " +
      definition.target +
      " placement on the Element.",
    element:
      "This Effect styles the Element's existing rendered wrapper with scoped CSS. Arbitrary JavaScript and DOM scripting are unavailable.",
    text: "This Effect styles the wrapper with scoped CSS and may optionally transform the Element's original text using an isolated JavaScript function. It returns a visual copy; it does not edit persistent document text.",
  }[affects];
  const customParameters = effectParameters(definition);
  const shaderParameters =
    numericEffectParameters(definition)
      .map(
        (parameter) =>
          `uniform float ${parameter.key}; // @param ${parameter.default}${
            parameter.min !== undefined && parameter.max !== undefined
              ? ` [${parameter.min}, ${parameter.max}]`
              : ""
          }`,
      )
      .join("\n") || "No custom float uniforms are currently declared.";
  const explicitParameters =
    customParameters
      .map(
        (parameter) =>
          `parameters.${parameter.key} / CSS --${parameter.key} // ${parameter.label}; type ${parameter.type}; default ${JSON.stringify(parameter.default)}${parameter.type === "number" ? `; range ${parameter.min ?? "unbounded"}..${parameter.max ?? "unbounded"}` : ""}`,
      )
      .join("\n") || "This Effect currently has no custom parameters.";
  const currentCode = shader
    ? "CURRENT CODE\n\nCurrent GLSL:\n```glsl\n" + definition.source + "\n```"
    : "CURRENT CODE\n\nCurrent CSS:\n```css\n" +
      (definition.kind === "text-js"
        ? (definition.styleSource ?? blankCss)
        : definition.source) +
      "\n```" +
      (affects === "text"
        ? "\n\nCurrent JS:\n" +
          (definition.kind === "text-js"
            ? "```javascript\n" + definition.source + "\n```"
            : "No JavaScript transform is currently defined. Add one only if needed.")
        : "");
  const parameterGuidance = shader
    ? `SHADER PARAMETERS

Custom top-level scalar declarations of the form:
uniform float name;
automatically become Effect controls. The uniform name is the stable key. ShowMe built-in uniforms are not controls.

Encode useful defaults and optional slider ranges directly on the declaration:
uniform float distortionStrength; // @param 12 [0, 60]
uniform float phase; // @param 0

Required annotation grammar:
@param DEFAULT
@param DEFAULT [MIN, MAX]

Ranges are optional. An unannotated custom float is valid and defaults to 0 with no slider range. Expose only useful controls. Choose visually useful defaults and practical ranges; avoid absurdly broad ranges. Omit bounds when genuinely unbounded. Prefer an active default over zero when zero would make the requested Effect appear inactive. Do not expose internal mathematical constants.

Current author metadata, expressed in the format you should return:
${shaderParameters}

Preserve compatible existing keys. Do not return a separate PARAMETERS section; parameter metadata belongs on uniform declarations in the GLSL block.`
    : `CUSTOM PARAMETERS

${explicitParameters}

Parameters are explicit number, boolean or string controls with stable keys, labels and typed defaults. Numbers have optional ranges and are the only Motion-animatable type. Boolean/Text are static instance values. JS receives native typed parameters.key values. CSS receives --key values via style.setProperty: numbers as decimal values, booleans as 1/0, strings as escaped quoted CSS string tokens, never concatenated into stylesheet source. Strings are limited to 4096 characters. Preserve existing keys and ranges where possible. If a new CSS/JS control is needed, describe it briefly before the code; do not invent references to undeclared keys. Timing names t/p and ShowMe built-ins are reserved.`;
  const response = shader
    ? "Output one complete GLSL ES 3.00 fragment shader in a glsl fenced block, ready to paste into ShowMe. Put custom control defaults/ranges directly on uniform float declarations with @param comments. Do not output a separate PARAMETERS section. Do not output a vertex shader, WebGL application, buffers, canvases, JavaScript setup or render loop."
    : "Output complete CSS and optional text JavaScript in separate css and javascript fenced blocks, ready to paste into the corresponding ShowMe tabs. Omit JavaScript if unnecessary" +
      (affects === "element"
        ? "; this Element Effect supports CSS only."
        : ". JavaScript must return a string, never HTML, DOM nodes, objects or a Promise.");
  return `You are writing a custom visual Effect for ShowMe.

ABOUT SHOWME

ShowMe is a presentation editor. Slides contain Elements such as text, images, video, SVGs, rectangles and Frames. Effects are reusable visual modules applied to Elements. The selected Element is preview context while the author edits a reusable Effect definition.

Effects are independent from ShowMe's Motion system. Start / Stop / Speed control Effect timing. A static or continuous Effect needs no Click Timeline entry. Stop After duration also provides normalized progress over that same interval. Use Presence for Element enter/exit lifecycle and numeric Effect parameters for independently animated visual controls. ShowMe supplies timing; do not implement presentation timing yourself.

CURRENT EFFECT

Name: ${definition.name}
Effect type: ${shader ? "Shader (GLSL fragment shader)" : "CSS + JS"}
Affects: ${names[affects]}${affects === "generated" ? `; placement: ${definition.target}` : ""}.
${explanation}
${context.previewElementName ? "Previewing on: " + context.previewElementName + ". This is preview context, not the scope of a document edit.\n" : ""}Speed: ${speed}x. Start: ${start}. Stop: ${stop}.
${context.creating ? "Create the requested Effect from this minimal draft." : "Modify the current Effect while preserving its existing parameter contract where possible. Do not silently rename or remove existing parameter keys."}

${shader ? shaderPromptEnvironment(affects) : cssTextPromptEnvironment(affects)}

TIMING MODEL

${shader ? "uniform float u_t;\nuniform float u_p;" : "CSS custom properties: --t, --p. Optional JS inputs: t, p."}

${t} = EFFECT TIME
Elapsed Effect seconds relative to Start, frozen by Stop, multiplied by Speed. Start Presentation start anchors t=0 at presentation playback start, even if the Effect first appears on a later slide. Start Slide start anchors t=0 at each slide activation/re-entry. Start Click anchors t=0 at the configured timeline click plus its Start offset; before that origin t stays 0 and this Effect is bypassed.
Current speed ${speed}x means one elapsed Effect second advances time by ${speed} seconds. Speed scales this Effect's delivered value, never the shared presentation clock. Consume the supplied value; do not create timers or render loops.
Explicit advanced reference clocks u_presentationTime, u_slideTime and u_stepTime (JS presentationTime, slideTime, stepTime; CSS --presentationTime, --slideTime, --stepTime) remain unscaled and independent. stepTime measures seconds since entering the current logical slide step (including Slide start). Use them only when the requested visual intentionally needs a global/reference clock independent of normal Effect time.
${shader ? "uniform float u_stepIndex; pairs with u_stepTime." : "JS stepIndex pairs with stepTime; CSS --stepIndex pairs with --stepTime."}
stepIndex is read-only integer presentation context: 0 = Slide start, 1 = Click 1, 2 = Click 2, including empty clicks. It resets on slide activation/re-entry. Inserting/removing earlier Clicks changes later numeric indexes; it is not a stable semantic event ID. Use stepIndex/stepTime to derive visuals reacting to multiple steps, never presentation navigation or scheduling. stepIndex alone is event-driven and does not require continuous redraw. Start bypass still applies. For a multi-state text transition use Start Slide / Stop None, stepIndex to select authored string states and stepTime / a duration parameter to derive the transition; t/p still describe one Effect interval.
${
  shader
    ? `SLIDE CONTEXT

uniform float u_slideIndex;
uniform float u_slideCount;
uniform float u_slideSeed;
uniform float u_previousSlideIndex;
uniform float u_previousSlideSeed;

These values are read-only presentation context. slideIndex is the zero-based index in the visible presentation sequence and slideCount is its size. slideSeed is a deterministic 0..1 value derived from the current slide identity. previousSlideIndex / previousSlideSeed describe the slide activation the presenter actually came from, including backward navigation and jumps. On initial presentation entry they equal the current slide, so an Effect does not invent a transition from an unrelated state.
Use the seeds to derive deterministic per-slide configurations and u_slideTime to blend from the previous configuration toward the current one. Do not store cross-slide state inside the shader and do not derive slide identity from elapsed presentation time.`
    : ""
}
Do not normalize time to 0..1 unless intentionally creating a repeating cycle. For example, ${shader ? "sin(u_t * 2.0)" : "Math.sin(t * 2) in JS"} is continuous oscillation; ${shader ? "fract(u_t / 4.0)" : "(t % 4) / 4 in JS"} is a repeating four-second cycle.

${p} = NORMALIZED EFFECT INTERVAL
Normalized progress 0..1 is automatically derived from the same Start → Stop After-duration interval, with optional easing (linear by default). Before Start p=0; after the duration p=1. For Next click, Click N and Slide end, p stays 0 while waiting and jumps to 1 when the actual event is reached. Stop None supplies p=1 once Start occurs. Before any Start p=0 and the Effect is bypassed. Shortening or lengthening the block changes the interval duration. Speed scales only delivered t, never p or Stop duration. Do not derive p from time in Effect code and do not hard-code a transition duration.
Use t for continuous procedural motion, Presence for Element enter/exit lifecycle, and numeric Effect parameters for independently animated visual controls. There is one interval, no independently timed progress phase. Stop freezes t while the Effect remains applied.

TIME CONTROL
Start activates this Effect and defines its time origin, Stop completes/freezes its interval, Speed scales delivered t only. Stop None is unbounded. Slide end freezes when the slide leaves. Next click and Click N freeze at the event's reached value. After duration freezes at the known duration measured after the Start offset. Start/Stop is available in the Effect Editor Timing section from creation and in the Effects sidepanel. Reusable defaults are saved with the Effect without deck-specific click IDs. Dragging its block in the Click Timeline changes the start click and delay; there are no separate click-position or delay fields in the Effect setup. Before Start this Effect is bypassed, preserving its incoming input and earlier Effects. After Stop it stays applied in its final/frozen state; stopping time does not hide or bypass it. Presence separately controls Element lifecycle. active remains the applied-state input, not a time gate. Normalized p follows the unscaled block interval; Speed scales t only. Event-based Stops (Next click, Click N, Slide end) use discrete completion p=0 while waiting and p=1 when reached, without interpolation or easing. Do not add p to time-only generators merely because their time is controlled.

${parameterGuidance}

RUNTIME RESTRICTIONS

The Effect must be self-contained. No external textures, files, network requests, shader includes, external resources, packages, imports, unsupported WebGL extensions or additional render passes. ${shader ? "No JavaScript or WebGL setup code. Declare built-in uniforms using the exact provided types, once; do not redefine their meaning or conflict with their names." : "No DOM, network/fetch, Electron bridge, files, storage, external resources or imports. The text function cannot manipulate Elements or start its own timers."}
Avoid unnecessarily expensive loops and operations: an Effect may run continuously on large Elements. Behave sensibly at different sizes and aspect ratios. Preserve transparency unless the requested visual intentionally changes it. Use the public t/p inputs for time and interval progress.

${currentCode}

HOW TO RESPOND

${response}
Use ${shader ? "u_t" : "t / --t"} for continuous motion, ${shader ? "u_p" : "p / --p"} for optional normalized finite progress, and both when appropriate. Do not replace ShowMe timing with your own clock. Keep explanation short unless requested.`;
}

function shaderPromptEnvironment(affects: EffectAffects) {
  const input =
    affects === "generated"
      ? "No input texture is available. Do not declare or sample u_input. Generate your own RGBA pixels using normalized v_uv, geometry, time and parameters. Choose intentional alpha for the generated background/overlay."
      : `uniform sampler2D u_input;
ShowMe provides ${affects === "backdrop" ? "frame-local pixels behind the frame, rather than the frame itself. Transform those lower-scene pixels as a background lens while the frame's own content stays sharp" : "rendered pixels of the Element before this Effect. Normally sample that texture to produce the output"}.
A pass-through is outColor = texture(u_input, v_uv). Distortion usually modifies UV coordinates, then samples u_input at those coordinates. Preserve sampled source alpha unless intentionally changing opacity. Handle UVs outside 0..1 deliberately to avoid unwanted edge artifacts.`;
  return `SHADER ENVIRONMENT

Write a GLSL ES 3.00 fragment shader beginning with:
#version 300 es
precision highp float;
Write the final pixel color to out vec4 outColor.
ShowMe renders the Effect and supplies all values below. Do not create a WebGL application, vertex shader, canvas, buffers, setup code or render loop.

INPUT PIXELS

in vec2 v_uv;
v_uv is normalized 0..1 texture coordinates for the current output pixel.
${input}

ELEMENT AND RENDER SIZE

uniform vec2 u_size;
uniform vec2 u_resolution;
u_size is logical Element size in pixels. u_resolution is actual raster/render resolution. Use u_size for spacing or displacement that should stay consistent in Element pixels; use u_resolution only for raster-dependent calculations.
For example, vec2 position = v_uv * u_size converts normalized UVs to Element-space pixels, helping preserve spacing across sizes and aspect ratios.`;
}

function cssTextPromptEnvironment(affects: EffectAffects) {
  return `CSS + JS ENVIRONMENT

SCOPED CSS

Use :scope { ... } to style only this Effect's wrapper. Only :scope, @keyframes and nested @supports rules are supported; selectors inside @supports must also be :scope. Descendant/global selectors and other at-rules are unavailable. ShowMe privately scopes keyframe names. CSS animations are paused and sampled by finite progress, not autonomous browser playback; do not rely on CSS transitions or browser animation clocks.
--t exposes continuous seconds; --p exposes interval completion. Declared parameters become CSS custom properties named --key: numbers are numeric tokens, booleans are 1/0, and strings are escaped quoted CSS string tokens. Reference them with var(--key), using calc() when numeric values need units (for example calc(var(--strength) * 1px)). CSS does not use GLSL uniforms. A minimal identity style is :scope { }.

${
  affects === "text"
    ? `OPTIONAL TEXT JAVASCRIPT

function render({ text, t, p, parameters }) {
  return text;
}

ShowMe invokes this synchronous function in an isolated worker with bounded execution time. text is the original Element text, not the previous transformed result. t and p are numeric runtime values sampled from the same Effect interval; parameters maps stable declared keys to values using their native authored types: number, boolean or string. A deterministic random(seed) helper is also available if needed.
Return exactly a string of at most 100,000 characters. The string is displayed as text, never HTML; do not return markup for rendering, a DOM node, object or Promise. Original document text stays unchanged. CSS can style the wrapper independently while JS transforms visible characters.
No window/document/DOM access, network/fetch, Electron bridge, arbitrary files, browser storage, worker creation, imports or external libraries. Do not access Element objects or manipulate arbitrary DOM. Keep work bounded so the worker does not time out. JS is optional; keep the identity transform or omit it when CSS alone suffices.`
    : `ELEMENT CSS ONLY

This Effect supports CSS only. No text JavaScript is available because the target is Element, not Text. Do not return a JS function or suggest DOM scripting. Optional isolated text transformations are available only when the author deliberately selects Affects = Text.`
}`;
}
