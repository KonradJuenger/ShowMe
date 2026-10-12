import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  blankEffect,
  blankTextJs,
  buildEffectAuthoringPrompt,
  changeEffectAffects,
  extractSingleGlslFence,
  shaderBoilerplate,
} from "../../../src/core/effectAuthoring";
import {
  effectAuthoringDiagnostics,
  effectDefinitionSchema,
  effectDependencies,
  effectParameters,
  effectTiming,
  reconcileShaderSource,
  scanShaderParameters,
} from "../../../src/core/effects";
import {
  sampleEffectClocks,
  presenterEffectClockOrigins,
} from "../../../src/core/effectClocks";
import {
  startSession,
  applyPresentationCommand,
} from "../../../src/core/presentationSession";
import type { SlideMotion } from "../../../src/core/motionModel";

it("blank Shader samples input unchanged and has no template controls", () => {
  const definition = blankEffect("shader");
  expect(definition).toMatchObject({
    input: "content",
    target: "content",
    parameters: [],
    speed: 1,
  });
  expect(definition.source).toContain("outColor = texture(u_input, v_uv);");
  expect(effectAuthoringDiagnostics(definition)).toEqual([]);
  expect(effectDependencies(definition)).toEqual({
    stepState: false,
    genericTime: false,
    progress: false,
    continuous: false,
  });
});

it("Affects replaces only untouched shader boilerplate and preserves authored code", () => {
  const generated = changeEffectAffects(
    blankEffect("shader"),
    "generated",
    true,
  );
  expect(generated).toMatchObject({
    input: "none",
    target: "background",
    source: shaderBoilerplate("generated"),
  });
  const authored = {
    ...generated,
    source: generated.source.replace("0.5", "0.8"),
  };
  const content = changeEffectAffects(authored, "pixels", false);
  expect(content.source).toBe(authored.source);
  expect(content.input).toBe("content");
  const backdrop = changeEffectAffects(blankEffect("shader"), "backdrop", true);
  expect(backdrop).toMatchObject({ input: "backdrop", target: "background" });
  expect(effectAuthoringDiagnostics(backdrop)).toEqual([]);
});

it("CSS and text JavaScript share one authoring family and preserve styling", () => {
  const css = {
    ...blankEffect("css-js"),
    source: ":scope { opacity: var(--p); }",
  };
  const text = changeEffectAffects(css, "text", false);
  expect(text).toMatchObject({
    kind: "text-js",
    target: "text",
    source: blankTextJs,
    styleSource: css.source,
  });
  expect(effectDependencies(text)).toEqual({
    stepState: false,
    genericTime: false,
    progress: true,
    continuous: false,
  });
  expect(changeEffectAffects(text, "element", false)).toMatchObject({
    kind: "css",
    source: css.source,
  });
});

it("dependency detection distinguishes t and p from unrelated names, comments and declarations", () => {
  const shader = blankEffect("shader");
  const hybrid = {
    ...shader,
    source: shader.source
      .replace("outColor =", "uniforms_are_not_code; outColor =")
      .replace("texture(u_input, v_uv)", "vec4(sin(u_t), u_p, 0.0, 1.0)"),
  };
  expect(effectDependencies(hybrid)).toEqual({
    stepState: false,
    genericTime: true,
    progress: true,
    continuous: true,
  });
  expect(
    effectDependencies({
      ...shader,
      source:
        "uniform float u_t; uniform float u_p; // u_t + u_p\nvoid main() {}",
    }).continuous,
  ).toBe(false);
  expect(
    effectDependencies({
      ...blankEffect("css-js"),
      source: ":scope { --padding: 1; --title: 2; opacity: var(--p); }",
    }),
  ).toEqual({
    stepState: false,
    genericTime: false,
    progress: true,
    continuous: false,
  });
  expect(
    effectDependencies({
      ...changeEffectAffects(blankEffect("css-js"), "text", false),
      source:
        'function render({ text, t, p }) { const title = "t p"; return text + title; }',
    }),
  ).toEqual({
    stepState: false,
    genericTime: false,
    progress: false,
    continuous: false,
  });
  expect(
    effectDependencies({
      ...shader,
      source: "void main() { outColor = vec4(u_t + u_p); }",
    }),
  ).toMatchObject({ continuous: true, progress: true });
});

it("shader float uniforms define parameters with optional @param metadata", () => {
  const source = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_t;
uniform vec2 u_resolution;
// uniform float commented; // @param 99 [0, 100]
/* uniform float hidden; */
uniform float distortionStrength; // @param 12 [0, 60]
uniform float phase; // @param 2
uniform float unbounded;
uniform float broken; // @param nope [0, 1]
uniform float phase;
uniform float progress;
uniform float u_custom;
uniform vec2 direction;
void helper() { float nested = 0.0; }
void main() { outColor = vec4(distortionStrength + phase + unbounded + broken); }`;
  const scan = scanShaderParameters(source);
  expect(scan.parameters).toEqual([
    {
      type: "number" as const,
      key: "distortionStrength",
      label: "Distortion strength",
      default: 12,
      min: 0,
      max: 60,
      annotated: true,
    },
    {
      type: "number" as const,
      key: "phase",
      label: "Phase",
      default: 2,
      annotated: true,
    },
    {
      type: "number" as const,
      key: "unbounded",
      label: "Unbounded",
      default: 0,
      annotated: false,
    },
    {
      type: "number" as const,
      key: "broken",
      label: "Broken",
      default: 0,
      annotated: false,
    },
  ]);
  expect(
    scan.parameters.some((parameter) => parameter.key === "commented"),
  ).toBe(false);
  expect(scan.parameters.some((parameter) => parameter.key === "hidden")).toBe(
    false,
  );
  expect(scan.diagnostics).toContain("Duplicate uniform phase");
  expect(scan.diagnostics).toContain("Invalid @param annotation for broken");
  expect(scan.diagnostics).toContain(
    "Unsupported uniform type vec2: direction",
  );
  expect(scan.diagnostics).toContain(
    "Reserved timing parameter name: progress",
  );
  expect(scan.diagnostics).toContain("Reserved uniform name: u_custom");
  const definition = {
    ...blankEffect("shader"),
    source,
    parameters: [],
  };
  expect(effectParameters(definition)).toEqual([
    {
      type: "number" as const,
      key: "distortionStrength",
      label: "Distortion strength",
      default: 12,
      min: 0,
      max: 60,
    },
    { type: "number" as const, key: "phase", label: "Phase", default: 2 },
    {
      type: "number" as const,
      key: "unbounded",
      label: "Unbounded",
      default: 0,
    },
    { type: "number" as const, key: "broken", label: "Broken", default: 0 },
  ]);
});

it("multiline shader uniforms remain discoverable and preserve existing metadata", () => {
  const scan = scanShaderParameters(`#version 300 es
precision highp float;
uniform float
  strength;
uniform
highp float
frequency;
uniform float amount,
              phase;
uniform
sampler2D
u_input;
uniform
vec2
u_resolution;
uniform
vec3
direction;
void helper() {
  uniform float nested;
}`);
  expect(scan.parameters.map((parameter) => parameter.key)).toEqual([
    "strength",
    "frequency",
    "amount",
    "phase",
  ]);
  expect(scan.parameters.some((parameter) => parameter.key === "u_input")).toBe(
    false,
  );
  expect(
    scan.parameters.some((parameter) => parameter.key === "u_resolution"),
  ).toBe(false);
  expect(scan.parameters.some((parameter) => parameter.key === "nested")).toBe(
    false,
  );
  expect(scan.diagnostics).toContain(
    "Unsupported uniform type vec3: direction",
  );

  const base = blankEffect("shader");
  const definition = {
    ...base,
    source: base.source
      .replace(
        "in vec2 v_uv;",
        "uniform float\n  strength; // @param 12 [0, 60]\nin vec2 v_uv;",
      )
      .replace(
        "texture(u_input, v_uv)",
        "texture(u_input, v_uv + vec2(strength * 0.0))",
      ),
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Power",
        default: 12,
        min: 0,
        max: 60,
      },
    ],
  };
  expect(scanShaderParameters(definition.source).parameters[0]).toMatchObject({
    type: "number" as const,
    key: "strength",
    default: 12,
    min: 0,
    max: 60,
    annotated: true,
  });
  expect(effectParameters(definition)).toEqual([
    {
      type: "number" as const,
      key: "strength",
      label: "Power",
      default: 12,
      min: 0,
      max: 60,
    },
  ]);
  expect(effectAuthoringDiagnostics(definition)).toEqual([]);
});

it("parameter defaults must remain inside declared bounds", () => {
  expect(
    scanShaderParameters("uniform float strength; // @param 12 [0, 60]")
      .diagnostics,
  ).toEqual([]);
  expect(
    scanShaderParameters("uniform float strength; // @param -1 [0, 60]")
      .diagnostics,
  ).toContain("@param default for strength must be within [0, 60]");
  expect(
    scanShaderParameters("uniform float strength; // @param 100 [0, 60]")
      .diagnostics,
  ).toContain("@param default for strength must be within [0, 60]");

  const base = {
    ...blankEffect("css-js"),
    source: ":scope { opacity: var(--strength); }",
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Strength",
        default: 12,
        min: 0,
        max: 60,
      },
    ],
  };
  expect(effectAuthoringDiagnostics(base)).toEqual([]);
  expect(
    effectAuthoringDiagnostics({
      ...base,
      parameters: [{ ...base.parameters[0], default: -1 }],
    }),
  ).toContain("Parameter strength default must be at least 0");
  expect(
    effectAuthoringDiagnostics({
      ...base,
      parameters: [{ ...base.parameters[0], default: 100 }],
    }),
  ).toContain("Parameter strength default must be at most 60");
});

it("shader source reconciliation imports source metadata without overwriting author edits", () => {
  const base = {
    ...blankEffect("shader"),
    source: blankEffect("shader").source.replace(
      "in vec2 v_uv;",
      "uniform float strength; // @param 12 [0, 60]\nin vec2 v_uv;",
    ),
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Strength",
        default: 12,
        min: 0,
        max: 60,
      },
    ],
  };
  const changed = reconcileShaderSource(
    base,
    base.source
      .replace("@param 12 [0, 60]", "@param 14 [0, 80]")
      .replace(
        "in vec2 v_uv;",
        "uniform float phase; // @param 0\nin vec2 v_uv;",
      ),
  );
  expect(changed.parameters).toEqual([
    {
      type: "number" as const,
      key: "strength",
      label: "Strength",
      default: 14,
      min: 0,
      max: 80,
    },
    { type: "number" as const, key: "phase", label: "Phase", default: 0 },
  ]);

  const authored = {
    ...base,
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Power",
        default: 20,
        min: 1,
        max: 50,
      },
    ],
  };
  expect(
    reconcileShaderSource(
      authored,
      authored.source.replace("@param 12 [0, 60]", "@param 3 [0, 10]"),
    ).parameters,
  ).toEqual([
    {
      type: "number" as const,
      key: "strength",
      label: "Power",
      default: 20,
      min: 1,
      max: 50,
    },
  ]);
  expect(
    reconcileShaderSource(
      base,
      base.source.replace("uniform float strength; // @param 12 [0, 60]\n", ""),
    ).parameters,
  ).toEqual([]);
});

it("smart GLSL paste accepts exactly one explicit fenced shader", () => {
  expect(
    extractSingleGlslFence(
      "Here is the shader:\n\n```glsl\n#version 300 es\nvoid main() {}\n```\n",
    ),
  ).toBe("#version 300 es\nvoid main() {}");
  expect(extractSingleGlslFence("void main() {}")).toBeNull();
  expect(
    extractSingleGlslFence(
      "```glsl\nvoid main() {}\n```\n```glsl\nvoid other() {}\n```",
    ),
  ).toBeNull();
  expect(
    extractSingleGlslFence("```javascript\nvoid main() {}\n```"),
  ).toBeNull();
});

it("copied prompts describe the selected contract, speed, parameters and source", () => {
  const base = blankEffect("shader");
  const definition = {
    ...base,
    speed: 0.5,
    source: base.source.replace(
      "in vec2 v_uv;",
      "uniform float strength; // @param 12 [0, 60]\nin vec2 v_uv;",
    ),
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Strength",
        default: 12,
        min: 0,
        max: 60,
      },
    ],
  };
  const prompt = buildEffectAuthoringPrompt(definition);
  expect(prompt).toContain("Element pixels");
  expect(prompt).toContain("Speed: 0.5x");
  expect(prompt).toContain("uniform float strength; // @param 12 [0, 60]");
  expect(prompt).toContain(definition.source);
  expect(prompt).toContain("Do not derive p from time");
  expect(
    buildEffectAuthoringPrompt(
      changeEffectAffects(definition, "backdrop", true),
    ),
  ).toContain("frame-local pixels behind the frame");
  expect(
    buildEffectAuthoringPrompt(
      changeEffectAffects(definition, "generated", true),
    ),
  ).toContain("No input texture");
  expect(
    buildEffectAuthoringPrompt(
      changeEffectAffects(blankEffect("css-js"), "text", false),
    ),
  ).toContain("No DOM, network/fetch, Electron bridge");
  expect(buildEffectAuthoringPrompt(blankEffect("css-js"))).toContain(
    "CSS only",
  );
});

it("AI prompt exports ShowMe context before the contract and leaves the user's sentence at the end", () => {
  const definition = {
    ...blankEffect("shader"),
    name: "Ribbed Glass",
    speed: 2,
  };
  const prompt = buildEffectAuthoringPrompt(definition, {
    previewElementName: "Image 3",
  });
  const sections = [
    "ABOUT SHOWME",
    "CURRENT EFFECT",
    "SHADER ENVIRONMENT",
    "TIMING MODEL",
    "SHADER PARAMETERS",
    "RUNTIME RESTRICTIONS",
    "CURRENT CODE",
    "HOW TO RESPOND",
    "WHAT I WANT TO CREATE",
    "MY REQUEST:",
  ];
  const positions = sections.map((section) => prompt.indexOf(section));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(prompt).toContain("ShowMe is a presentation editor");
  expect(prompt).toContain(
    "Effects are independent from ShowMe's Motion system",
  );
  expect(prompt).toContain("Name: Ribbed Glass");
  expect(prompt).toContain("Previewing on: Image 3");
  expect(prompt).toContain(
    "preserving its existing parameter contract where possible",
  );
  expect(prompt).toContain(
    "one elapsed Effect second advances time by 2 seconds",
  );
  expect(prompt).toContain("NORMALIZED EFFECT INTERVAL");
  expect(prompt).toContain("Before any Start p=0 and the Effect is bypassed");
  expect(prompt).toContain("p stays 0 while waiting and jumps to 1");
  expect(prompt).toContain("Stop None supplies p=1 once Start occurs");
  expect(prompt).toContain("Presence separately controls Element lifecycle");
  expect(prompt).not.toContain("including before a future Click Start");
  expect(prompt).not.toContain("Time source:");
  expect(prompt).toContain("Start: Slide start. Stop: None.");
  expect(prompt).toContain(
    "there are no separate click-position or delay fields",
  );
  expect(prompt).toContain(
    "Start activates this Effect and defines its time origin, Stop completes/freezes its interval, Speed scales delivered t only",
  );
  expect(buildEffectAuthoringPrompt(definition)).toContain(
    "before that origin t stays 0",
  );
  expect(prompt).toContain("vec2 position = v_uv * u_size");
  expect(prompt).toContain("No custom float uniforms are currently declared.");
  expect(prompt).toContain("Do not return a separate PARAMETERS section");
  expect(prompt).toContain("simply append a sentence");
  expect(
    prompt.endsWith("MY REQUEST:\n[DESCRIBE THE EFFECT OR CHANGE HERE]"),
  ).toBe(true);
  expect(prompt.match(/```/g)).toHaveLength(2);
  expect(buildEffectAuthoringPrompt(definition, { creating: true })).toContain(
    "Create the requested Effect from this minimal draft",
  );
});

it("CSS/text prompts export their actual scoped runtime and existing sources without implying DOM scripting", () => {
  const definition = changeEffectAffects(blankEffect("css-js"), "text", false);
  const prompt = buildEffectAuthoringPrompt(definition);
  expect(prompt).toContain("Only :scope and @keyframes rules are supported");
  expect(prompt).toContain("isolated worker with bounded execution time");
  expect(prompt).toContain(
    "text is the original Element text, not the previous transformed result",
  );
  expect(prompt).toContain(
    "Return exactly a string of at most 100,000 characters",
  );
  expect(prompt).toContain("never HTML");
  expect(prompt).toContain("var(--key)");
  expect(prompt).toContain("calc(var(--strength) * 1px)");
  expect(prompt).toContain("numbers are numeric tokens");
  expect(prompt).toContain("booleans are 1/0");
  expect(prompt).toContain("strings are escaped quoted CSS string tokens");
  expect(prompt).toContain("native authored types: number, boolean or string");
  expect(prompt).not.toContain("parameters are numeric CSS custom properties");
  expect(prompt).not.toContain("keys to current numeric values");
  expect(prompt).toContain("Current CSS:\n```css\n" + definition.styleSource);
  expect(prompt).toContain("Current JS:\n```javascript\n" + definition.source);
  expect(prompt.match(/```/g)).toHaveLength(4);
  const element = buildEffectAuthoringPrompt(blankEffect("css-js"));
  expect(element).not.toContain("function render(");
  expect(element).not.toContain("Current JS:");
  expect(element).toContain("this Element Effect supports CSS only");
  expect(element).toContain("booleans are 1/0");
  expect(element).toContain("strings are escaped quoted CSS string tokens");
});

it("step clocks continue beyond finite Motion, reset at clicks and retain slide/presentation phase", () => {
  const deck = {
    slideIds: ["one", "two"],
    slideMeta: {
      one: { templateId: null, name: "One", section: "", hidden: false },
      two: { templateId: null, name: "Two", section: "", hidden: false },
    },
  };
  const started = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
    {
      one: [
        { id: "start", duration: 400 },
        { id: "click", duration: 400 },
      ],
      two: [],
    },
  );
  const clocks = (state: typeof started, now: number) =>
    sampleEffectClocks(presenterEffectClockOrigins(state)!, now);
  expect(clocks(started, 9400)).toEqual({
    stepIndex: 0,
    stepTime: 8.4,
    slideTime: 8.4,
    presentationTime: 8.4,
  });
  const clicked = applyPresentationCommand(started, { type: "next" }, 9400);
  expect(presenterEffectClockOrigins(clicked)?.stageStartedOffsets).toEqual([
    0, 8400,
  ]);
  expect(clocks(clicked, 9800)).toEqual({
    stepIndex: 1,
    stepTime: 0.4,
    slideTime: 8.8,
    presentationTime: 8.8,
  });
  expect(clocks(clicked, 17800).stepTime).toBe(8.4);

  const paused = applyPresentationCommand(
    clicked,
    { type: "toggle-pause" },
    10000,
  );
  expect(clocks(paused, 12000)).toEqual({
    stepIndex: 1,
    stepTime: 0.6,
    slideTime: 9,
    presentationTime: 9,
  });
  expect(presenterEffectClockOrigins(paused)?.stageStartedOffsets).toEqual([
    0, 8400,
  ]);
  const resumed = applyPresentationCommand(
    paused,
    { type: "toggle-pause" },
    12000,
  );
  expect(clocks(resumed, 12400)).toEqual({
    stepIndex: 1,
    stepTime: 1,
    slideTime: 9.4,
    presentationTime: 9.4,
  });
  expect(presenterEffectClockOrigins(resumed)?.stageStartedOffsets).toEqual([
    0, 8400,
  ]);

  const backward = applyPresentationCommand(
    clicked,
    { type: "previous" },
    10400,
  );
  expect(backward.motion?.stageIndex).toBe(0);
  expect(presenterEffectClockOrigins(backward)?.stageStartedOffsets).toEqual([
    9000,
  ]);
  const forwardAgain = applyPresentationCommand(
    backward,
    { type: "next" },
    11000,
  );
  expect(forwardAgain.motion?.stageIndex).toBe(1);
  expect(
    presenterEffectClockOrigins(forwardAgain)?.stageStartedOffsets,
  ).toEqual([9000, 10000]);

  const next = applyPresentationCommand(clicked, { type: "next" }, 17800);
  expect(clocks(next, 18800)).toEqual({
    stepIndex: 0,
    stepTime: 1,
    slideTime: 1,
    presentationTime: 17.8,
  });
});

it("Click time and progress share the bound interval and stay instance-specific", () => {
  const motion: SlideMotion = {
    stages: [
      { id: "start", tracks: [], blocks: [] },
      {
        id: "click-1",
        tracks: [],
        blocks: [
          {
            id: "a-block",
            label: "A",
            effectSchedule: {
              version: 1,
              start: "click",
              startOffsetMs: 400,
              stop: { mode: "after", durationMs: 800 },
            },
            binding: {
              kind: "effect" as const,
              elementId: "element",
              effectInstanceId: "effect-a",
            },
            members: [],
          },
        ],
      },
      {
        id: "click-2",
        tracks: [],
        blocks: [
          {
            id: "b-block",
            label: "B",
            effectSchedule: {
              version: 1,
              start: "click",
              startOffsetMs: 200,
              stop: { mode: "after", durationMs: 800 },
            },
            binding: {
              kind: "effect" as const,
              elementId: "element",
              effectInstanceId: "effect-b",
            },
            members: [],
          },
        ],
      },
    ],
  };
  const sample = (
    instanceId: string,
    stageIndex: number,
    slideTime: number,
    stageStarts: number[],
    stageTime = 0,
  ) =>
    effectTiming(motion, stageIndex, stageTime, "element", instanceId, {
      presentationTime: slideTime,
      slideTime,
      stepTime: Math.max(0, slideTime - (stageStarts[stageIndex] ?? 0)),
      stageStarts,
    });

  expect(sample("effect-a", 0, 2, [0]).time).toBe(0);
  expect(sample("effect-a", 1, 3.2, [0, 3])).toMatchObject({
    time: 0,
    duration: 0.8,
  });
  expect(sample("effect-a", 1, 3.9, [0, 3]).time).toBeCloseTo(0.5);
  expect(sample("effect-a", 1, 5, [0, 3]).time).toBeCloseTo(0.8);
  expect(sample("effect-a", 2, 8, [0, 3, 6]).time).toBeCloseTo(0.8);
  expect(sample("effect-b", 1, 5, [0, 3]).time).toBe(0);
  expect(sample("effect-b", 2, 6.1, [0, 3, 6]).time).toBe(0);
  expect(sample("effect-b", 2, 6.7, [0, 3, 6]).time).toBeCloseTo(0.5);
});

it("Effect definitions accept only the current API and reject unknown clock metadata", () => {
  const current = blankEffect("shader");
  expect(effectDefinitionSchema.parse(current)).toEqual(current);
  expect(
    effectDefinitionSchema.safeParse({ ...current, apiVersion: 2 }).success,
  ).toBe(false);
  expect(
    effectDefinitionSchema.safeParse({ ...current, timeSource: "slide" })
      .success,
  ).toBe(false);
});

it("Moving Glass uses continuous time and strength without an independent reveal", () => {
  const definition = effectDefinitionSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../fixtures/effects/moving-glass.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(effectDependencies(definition)).toMatchObject({
    continuous: true,
    progress: false,
  });
  expect(definition.timeControl).toEqual({
    start: "slide",
    stop: { mode: "none" },
  });
  expect(
    effectParameters(definition).map((parameter) => parameter.key),
  ).toEqual(["strength"]);
});
