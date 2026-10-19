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

/** Runtime facts shared by the editor prompt and bounded MCP guides. */
export function effectRuntimeContract(definition: EffectDefinition) {
  const shader = definition.kind === "fragment-glsl";
  return {
    environment: shader
      ? shaderPromptEnvironment(effectAffects(definition))
      : cssTextPromptEnvironment(effectAffects(definition)),
    timing: {
      inputs: shader
        ? "uniform float u_t;\nuniform float u_p;"
        : "CSS --t/--p; text-JS t/p.",
      time: "t is elapsed seconds relative to Start, frozen by Stop and multiplied by Speed. Presentation start anchors to playback; Slide start resets on activation/re-entry; Click start anchors to the click plus offset; before that origin t stays 0 and the Effect is bypassed. Speed scales delivered t only, never the shared clocks or interval duration. Use native clocks, not timers/render loops.",
      progress:
        "NORMALIZED EFFECT INTERVAL: p follows the unscaled Start-to-Stop After duration, with easing. Before any Start p=0 and the Effect is bypassed. After duration p=1; Stop None supplies p=1 once Start occurs. For Next click, Click N and Slide end, p stays 0 while waiting and jumps to 1 at that event. Do not derive p from time or hard-code the interval duration.",
      lifecycle:
        "Start activates this Effect and defines its time origin, Stop completes/freezes its interval, Speed scales delivered t only. After Stop the Effect stays applied, not hidden. Presence separately controls Element lifecycle. Delays use the native click timeline; there are no separate click-position or delay fields in the Effect setup.",
      reference: shader
        ? "Optional uniforms: float u_presentationTime, u_slideTime, u_stepTime, u_stepIndex. All clocks are unscaled seconds; stepIndex is 0 at slide entry, then the reached click index (including empty clicks), resetting on activation. stepTime measures time since the current step. Declare each needed uniform once with its exact type."
        : "CSS --t/--p and JS t/p are Effect clocks. Unscaled reference clocks: CSS --presentationTime, --slideTime, --stepTime and --stepIndex; JS presentationTime, slideTime, stepTime, stepIndex. stepIndex=0 at entry then the reached click index, resetting on activation; stepTime is seconds since that step. Use steps for visuals, never navigation/scheduling.",
    },
    ...(shader ? { slideContext: shaderSlideContext } : {}),
    parameters: shader
      ? "Top-level custom uniform float name becomes a numeric control. Annotate defaults/ranges: uniform float strength; // @param 12 [0, 60]. Bounds are optional; unannotated floats default to 0. Built-ins are reserved. Preserve existing keys; encode parameter metadata in source, not a separate list."
      : "Declare parameters explicitly as number, boolean or string with stable keys, labels and typed defaults; optional bounds apply to numbers. Only numbers are Motion-animatable. JS receives parameters.key; CSS receives --key. Strings are limited to 4096 characters. Preserve existing keys/types/ranges; timing names are reserved.",
    restrictions: effectRuntimeRestrictions(shader),
  };
}

const shaderSlideContext = `uniform float u_slideIndex;
uniform float u_slideCount;
uniform float u_slideSeed;
uniform float u_previousSlideIndex;
uniform float u_previousSlideSeed;

Slide index is zero-based; seeds are deterministic 0..1 values. Previous context follows the actual prior activation, including backward navigation and jumps; on first entry previous=current. Use the seeds to derive deterministic per-slide configurations and u_slideTime to blend from previous to current. Do not derive slide identity from elapsed time or retain cross-slide state.`;

function effectRuntimeRestrictions(shader: boolean) {
  return (
    "Self-contained code only: no files, network, imports, libraries, external textures, shader includes or additional render passes. " +
    (shader
      ? "No JavaScript or WebGL setup; declare built-ins once with their exact types. "
      : "No DOM, network/fetch, Electron bridge, files, storage or timers; text functions cannot manipulate Elements. ") +
    "Keep work bounded at different sizes; preserve transparency unless intentionally changing opacity."
  );
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
Current speed ${speed}x means one elapsed Effect second advances time by ${speed} seconds.
${Object.values(effectRuntimeContract(definition).timing).join("\n\n")}
${shader ? shaderSlideContext : ""}
Use t for continuous motion and p for finite progress. Do not normalize time unless intentionally creating a repeating cycle.

${parameterGuidance}

RUNTIME RESTRICTIONS

${effectRuntimeRestrictions(shader)}

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
