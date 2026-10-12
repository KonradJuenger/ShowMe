import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  effectDefinitionSchema,
  effectParameterValueSchema,
  effectDependencies,
  effectTiming,
  effectProperty,
  numericEffectParameters,
  scanShaderParameters,
  cssEffectValue,
  reconcileShaderSource,
  type EffectDefinition,
} from "../../../src/core/effects";
import { motionPropertyDescriptor } from "../../../src/core/elementPropertyDescriptors";
import { addParameterAnimation, resolveMotion } from "../../../src/core/motion";
import { validateMotionTargets } from "../../../src/core/motionModel";
import { createTextElement } from "../../../src/core/text";
import { newPresentationDocument } from "../../../src/core/document";
import {
  insertElements,
  setElementEffectDefinition,
  setElementEffectParameterValue,
  setSlideMotion,
  duplicateElementsWithResult,
} from "../../../src/core/editorCommands";
import { findElement } from "../../../src/core/scene";
import {
  sampleEffectClocks,
  presenterEffectClockOrigins,
} from "../../../src/core/effectClocks";
import {
  startSession,
  applyPresentationCommand,
} from "../../../src/core/presentationSession";
import {
  createSlideTransferBundle,
  parseSlideTransferBundle,
  prepareSlideTransferImport,
} from "../../../src/core/slideTransfer";
import {
  captureElementsClipboard,
  parseElementsClipboardText,
  serializeElementsClipboard,
  pasteElements,
} from "../../../src/core/clipboard";
import { serverMessageSchema } from "../../../src/core/collaboration/protocol";
import { storedDocument, storageAt } from "../../helpers/storage";

const example = effectDefinitionSchema.parse(
  JSON.parse(
    readFileSync("tests/fixtures/effects/multi-state-scramble.json", "utf8"),
  ),
);
function typedDefinition(): EffectDefinition {
  return {
    ...example,
    parameters: [
      {
        type: "number",
        key: "amount",
        label: "Amount",
        default: 2,
        min: 0,
        max: 10,
      },
      { type: "boolean", key: "uppercase", label: "Uppercase", default: false },
      { type: "string", key: "prefix", label: "Prefix", default: "Hello " },
    ],
    source:
      "function render({ text, parameters }) { const value = parameters.prefix + text; return parameters.uppercase ? value.toUpperCase() : value; }",
  };
}
function fixture() {
  const model = newPresentationDocument("Typed");
  const slide = model.slides[model.deck.slideIds[0]];
  const element = createTextElement("text");
  const inserted = insertElements(
    { deck: model.deck, slide },
    [element],
    slide.nodes[0].id,
  );
  const snapshot = setElementEffectDefinition(
    inserted,
    element.id,
    typedDefinition(),
  );
  const applied = findElement(snapshot.slide, element.id)!;
  return { snapshot, element: applied, instance: applied.effects![0], model };
}
it("typed values are bounded primitives and only the current API is accepted", () => {
  expect(example.apiVersion).toBe(1);
  const current = typedDefinition();
  expect(effectDefinitionSchema.parse(current)).toEqual(current);
  expect(
    effectDefinitionSchema.safeParse({ ...current, apiVersion: 2 }).success,
  ).toBe(false);
  expect(
    effectDefinitionSchema.safeParse({
      ...current,
      parameters: [{ key: "amount", label: "Amount", default: 2 }],
    }).success,
  ).toBe(false);
  expect(
    effectDefinitionSchema.safeParse({
      ...current,
      parameters: [
        { type: "string", key: "stepIndex", label: "Step", default: "x" },
      ],
    }).success,
  ).toBe(false);
  for (const value of [null, {}, [], () => {}, NaN, Infinity, "x".repeat(4097)])
    expect(effectParameterValueSchema.safeParse(value).success).toBe(false);
  expect(cssEffectValue(true)).toBe("1");
  expect(cssEffectValue(false)).toBe("0");
  expect(cssEffectValue("Hello ; color:red")).toBe('"Hello ; color:red"');
  expect(
    scanShaderParameters("uniform float strength; // @param 12 [0,60]")
      .parameters[0],
  ).toMatchObject({ type: "number", default: 12, min: 0, max: 60 });
  expect(scanShaderParameters("uniform float u_stepIndex;").parameters).toEqual(
    [],
  );
  const reconciled = reconcileShaderSource(
    {
      ...example,
      kind: "fragment-glsl",
      target: "overlay",
      input: "none",
      parameters: [
        { type: "boolean", key: "strength", label: "Strength", default: true },
      ],
    },
    "uniform float strength; // @param 12 [0,60]",
  );
  expect(reconciled.parameters[0]).toMatchObject({
    type: "number",
    default: 12,
    min: 0,
    max: 60,
  });
  expect(
    scanShaderParameters("uniform bool u_stepIndex;").diagnostics,
  ).toContain("u_stepIndex must be float");
});
it("step dependencies are event-driven in JS, CSS and GLSL and stepTime stays continuous", () => {
  expect(
    effectDependencies({
      ...example,
      source: "function render({ stepIndex }) { return String(stepIndex); }",
    }),
  ).toMatchObject({ stepState: true, continuous: false });
  expect(
    effectDependencies({
      ...example,
      kind: "css",
      source: ":scope { opacity: var(--stepIndex); }",
    }),
  ).toMatchObject({ stepState: true, continuous: false });
  expect(
    effectDependencies({
      ...example,
      kind: "fragment-glsl",
      source:
        "uniform float u_stepIndex; void main() { outColor = vec4(u_stepIndex); }",
    }),
  ).toMatchObject({ stepState: true, continuous: false });
  expect(effectDependencies(example)).toMatchObject({
    stepState: true,
    continuous: true,
  });
});
it("logical stage context counts empty clicks, follows Previous, jumps, re-entry, pause and reconnect", () => {
  const deck = {
    slideIds: ["one", "two"],
    slideMeta: {
      one: { name: "One", hidden: false, section: "", templateId: null },
      two: { name: "Two", hidden: false, section: "", templateId: null },
    },
  };
  const stages = [
    { id: "start", duration: 0 },
    { id: "empty-one", duration: 0 },
    { id: "empty-two", duration: 0 },
    { id: "empty-three", duration: 0 },
  ];
  const state0 = startSession(
    { deckId: "deck", slideIds: [], index: null },
    deck,
    1000,
    { one: stages, two: stages },
  );
  const clocks = (state: typeof state0, now: number) =>
    sampleEffectClocks(presenterEffectClockOrigins(state)!, now);
  expect(clocks(state0, 1200)).toMatchObject({ stepIndex: 0, stepTime: 0.2 });
  const state1 = applyPresentationCommand(state0, { type: "next" }, 1500);
  expect(clocks(state1, 1500)).toMatchObject({ stepIndex: 1, stepTime: 0 });
  const state2 = applyPresentationCommand(state1, { type: "next" }, 2000);
  expect(clocks(state2, 2000)).toMatchObject({ stepIndex: 2, stepTime: 0 });
  expect(clocks(state2, 2500)).toMatchObject({ stepIndex: 2, stepTime: 0.5 });
  expect(clocks(structuredClone(state2), 2500)).toEqual(clocks(state2, 2500));
  expect(
    clocks(applyPresentationCommand(state2, { type: "next" }, 2600), 2600),
  ).toMatchObject({ stepIndex: 3, stepTime: 0 });
  const earlier = applyPresentationCommand(state2, { type: "previous" }, 3000);
  expect(clocks(earlier, 3000).stepIndex).toBe(1);
  const paused = applyPresentationCommand(
    state2,
    { type: "toggle-pause" },
    2500,
  );
  expect(clocks(paused, 9000)).toMatchObject({ stepIndex: 2, stepTime: 0.5 });
  const resumed = applyPresentationCommand(
    paused,
    { type: "toggle-pause" },
    9500,
  );
  expect(clocks(resumed, 10000)).toMatchObject({ stepIndex: 2, stepTime: 1 });
  const jump = applyPresentationCommand(
    state2,
    { type: "jump", index: 1 },
    3000,
  );
  expect(clocks(jump, 3000)).toMatchObject({ stepIndex: 0, stepTime: 0 });
  const reentry = applyPresentationCommand(
    jump,
    { type: "jump", index: 0 },
    4000,
  );
  expect(clocks(reentry, 4000)).toMatchObject({ stepIndex: 0, stepTime: 0 });
  // No bound Effect block is needed; backward/forward sampling reads the stage.
  expect(effectTiming(undefined, 2, 500, "text", "effect")).toMatchObject({
    stepIndex: 2,
    stepTime: 0.5,
    started: true,
  });
  expect(effectTiming(undefined, 1, 100, "text", "effect")).toMatchObject({
    stepIndex: 1,
    stepTime: 0.1,
  });
});
it("Motion accepts and interpolates numbers and rejects Boolean/Text controls", () => {
  const { snapshot, element, instance } = fixture();
  expect(numericEffectParameters(typedDefinition()).map((p) => p.key)).toEqual([
    "amount",
  ]);
  const property = effectProperty(instance.id, "amount");
  const motion = addParameterAnimation(
    undefined,
    0,
    element.id,
    property,
    "Amount",
    2,
    10,
    800,
  );
  expect(() =>
    validateMotionTargets(motion, [element], snapshot.slide.effectResources),
  ).not.toThrow();
  expect(
    resolveMotion({ ...snapshot.slide, motion }, 0, 400)[element.id][property],
  ).toBeCloseTo(6);
  for (const key of ["uppercase", "prefix"]) {
    expect(
      motionPropertyDescriptor(
        element,
        effectProperty(instance.id, key),
        snapshot.slide.effectResources,
      ),
    ).toBeUndefined();
    const invalid = addParameterAnimation(
      undefined,
      0,
      element.id,
      effectProperty(instance.id, key),
      key,
      0,
      1,
      800,
    );
    expect(() =>
      validateMotionTargets(invalid, [element], snapshot.slide.effectResources),
    ).toThrow();
  }
});
it("semantic type changes reset defaults and prune numeric tracks atomically with undo", async () => {
  const { session } = await storedDocument();
  const text = createTextElement("text");
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectDefinition(session.snapshot!, text.id, typedDefinition()),
  );
  await session.flush();
  const get = () => findElement(session.snapshot!.slide, text.id)!.effects![0];
  const instance = get();
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      text.id,
      instance.id,
      "amount",
      7,
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      text.id,
      instance.id,
      "uppercase",
      true,
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      text.id,
      instance.id,
      "prefix",
      "Welcome ",
    ),
  );
  await session.flush();
  session.apply(
    setSlideMotion(
      session.snapshot!,
      addParameterAnimation(
        undefined,
        0,
        text.id,
        effectProperty(instance.id, "amount"),
        "Amount",
        7,
        9,
        800,
      ),
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      text.id,
      { ...typedDefinition(), name: "Same types" },
      instance.id,
    ),
  );
  await session.flush();
  expect(get().parameters).toEqual({
    amount: 7,
    uppercase: true,
    prefix: "Welcome ",
  });
  const changed: EffectDefinition = {
    ...typedDefinition(),
    parameters: [
      { type: "string", key: "amount", label: "Amount", default: "New text" },
      ...typedDefinition().parameters.slice(1),
      { type: "boolean", key: "newFlag", label: "New", default: false },
    ],
  };
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      text.id,
      changed,
      instance.id,
    ),
  );
  await session.flush();
  expect(get().parameters).toEqual({
    amount: "New text",
    uppercase: true,
    prefix: "Welcome ",
    newFlag: false,
  });
  expect(session.snapshot!.slide.motion!.stages[0].tracks).toEqual([]);
  expect(session.snapshot!.slide.motion!.stages[0].blocks).toEqual([]);
  await session.undo();
  await session.flush();
  expect(get().parameters.amount).toBe(7);
  expect(session.snapshot!.slide.motion!.stages[0].tracks).toHaveLength(1);
  await session.undo(true);
  await session.flush();
  expect(get().parameters.amount).toBe("New text");
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      text.id,
      { ...changed, parameters: [] },
      instance.id,
    ),
  );
  await session.flush();
  expect(get().parameters).toEqual({});
});
it("native typed overrides survive save, package, recovery, clipboard and slide transfer", async () => {
  const { root, storage, session, id, runtime } = await storedDocument();
  const text = createTextElement("text");
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectDefinition(session.snapshot!, text.id, typedDefinition()),
  );
  await session.flush();
  const instance = findElement(session.snapshot!.slide, text.id)!.effects![0];
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      text.id,
      instance.id,
      "uppercase",
      true,
    ),
  );
  await session.flush();
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      text.id,
      instance.id,
      "prefix",
      "Hello 👋 ",
    ),
  );
  await session.flush();
  const values = { amount: 2, uppercase: true, prefix: "Hello 👋 " };
  const slideId = session.snapshot!.slide.id;
  const check = (slide: import("../../../src/core/document").Slide) =>
    expect(findElement(slide, text.id)!.effects![0].parameters).toEqual(values);
  const recovery = await storageAt(root);
  const recovered = await recovery.recoverUntitled(id);
  check(
    recovery.documentRuntime(recovered.id).authority.document.slides[slideId],
  );
  const file = path.join(root, "Typed.sme");
  await storage.saveDocument(id, file);
  const reader = await storageAt(root, "reader");
  const opened = await reader.openDocument(file);
  check(reader.documentRuntime(opened.id).authority.document.slides[slideId]);
  const pkg = path.join(root, "Typed.smp");
  await storage.packageDocument(id, pkg);
  const destination = await storageAt(root, "destination");
  const packaged = await destination.openPackage(pkg);
  check(
    destination.documentRuntime(packaged.id).authority.document.slides[slideId],
  );
  const bundle = createSlideTransferBundle(
    id,
    session.snapshot!.deck,
    [session.snapshot!.slide],
    runtime.authority.document.templates,
  );
  check(parseSlideTransferBundle(bundle).slides[0].slide);
  const transferred = prepareSlideTransferImport(
    bundle,
    session.snapshot!.deck,
  );
  expect(
    transferred.slides[0].nodes[0].children[0].effects![0].parameters,
  ).toEqual(values);
  const clipboard = captureElementsClipboard(session.snapshot!, {
    elementIds: [text.id],
    scopeId: session.snapshot!.slide.nodes[0].id,
  })!;
  expect(
    parseElementsClipboardText(serializeElementsClipboard(clipboard))!.roots[0]
      .element.effects![0].parameters,
  ).toEqual(values);
  let nextId = 0;
  const pasted = pasteElements(
    session.snapshot!,
    session.snapshot!.slide.nodes[0].id,
    clipboard,
    () => `paste-${nextId++}`,
  );
  expect(
    findElement(pasted.snapshot.slide, pasted.elementIds[0])!.effects![0]
      .parameters,
  ).toEqual(values);
  const duplicated = duplicateElementsWithResult(
    session.snapshot!,
    [text.id],
    () => `duplicate-${nextId++}`,
  );
  expect(
    findElement(duplicated.snapshot.slide, duplicated.elementIds[0])!
      .effects![0].parameters,
  ).toEqual(values);
  const wire = serverMessageSchema.parse(
    JSON.parse(
      JSON.stringify({
        type: "snapshot",
        document: runtime.authority.document,
        actorId: "remote",
        resumeToken: "a".repeat(64),
        epoch: runtime.authority.epoch,
        revision: runtime.authority.revision,
      }),
    ),
  );
  if (wire.type !== "snapshot") throw new Error("Expected snapshot");
  check(wire.document.slides[slideId]);
});
