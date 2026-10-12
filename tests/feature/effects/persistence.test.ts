import path from "node:path";
import { type Slide } from "../../../src/core/document";
import { expect, it } from "vitest";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { effectResourcesSchema } from "../../../src/core/effects";
import { savedLibraryEffect } from "../../../src/core/libraryEffects";
import {
  setElementEffectDefinition,
  setElementEffectParameterValue,
  setSlideEffects,
  setSlideMotion,
} from "../../../src/core/editorCommands";
import { addEffectTrigger } from "../../../src/core/effectSequence";
import { findElement } from "../../../src/core/scene";
import {
  createSlideTransferBundle,
  prepareSlideTransferImport,
} from "../../../src/core/slideTransfer";
import { insertShape } from "../../helpers/document";
import { storedDocument, storageAt } from "../../helpers/storage";

it("static and time-only Effects can control time without progress tracks", () => {
  const base = blankEffect("shader");
  const instance = {
    id: "effect-instance",
    resourceId: "effect-resource",
    enabled: true,
    placement: "content" as const,
    parameters: {},
  };
  const use = (names: string[], expression: string) => ({
    ...base,
    source: base.source
      .replace(
        "in vec2 v_uv;",
        names.map((name) => `uniform float ${name};`).join("\n") +
          "\nin vec2 v_uv;",
      )
      .replace(
        "texture(u_input, v_uv)",
        `texture(u_input, v_uv) + vec4(${expression})`,
      ),
  });

  expect(
    addEffectTrigger(undefined, 0, "element", instance, base).stages[0].tracks,
  ).toEqual([]);
  expect(
    addEffectTrigger(
      undefined,
      0,
      "element",
      instance,
      use(["u_t"], "u_t * 0.0"),
    ).stages[0].tracks,
  ).toEqual([]);
  expect(
    addEffectTrigger(
      undefined,
      0,
      "element",
      instance,
      use(["u_t"], "u_t * 0.0"),
    ).stages[0].blocks,
  ).toHaveLength(1);
  expect(
    addEffectTrigger(
      undefined,
      0,
      "element",
      instance,
      use(["u_p"], "u_p * 0.0"),
    ).stages[0].blocks,
  ).toHaveLength(1);
  expect(
    addEffectTrigger(
      undefined,
      0,
      "element",
      instance,
      use(["u_t", "u_p"], "(u_t + u_p) * 0.0"),
    ).stages[0].blocks,
  ).toHaveLength(1);
});

it("saved Effect snapshots survive authority undo/redo, recovery, file reopen, package and slide transfer without Library", async () => {
  const { root, storage, session, id, runtime } = await storedDocument();
  const shape = await insertShape(session);
  const definition = {
    ...blankEffect("css-js"),
    speed: 0.5,
    timeControl: { start: "click" as const, stop: { mode: "none" as const } },
    source:
      ":scope { opacity: var(--p); filter: brightness(calc(1 + var(--t) * 0.01)); }",
  };
  const asset = savedLibraryEffect(definition);
  session.apply(
    setElementEffectDefinition(session.snapshot!, shape.id, asset.definition),
  );
  await session.flush();
  expect(
    session.snapshot!.slide.motion?.stages[0].blocks![0].effectSchedule,
  ).toMatchObject({ version: 1, start: "click", stop: { mode: "none" } });
  const slideId = session.snapshot!.slide.id;
  const applied = () =>
    findElement(session.snapshot!.slide, shape.id)!.effects![0];
  const instance = structuredClone(applied());
  await session.undo();
  await session.flush();
  expect(
    findElement(session.snapshot!.slide, shape.id)!.effects,
  ).toBeUndefined();
  await session.undo(true);
  await session.flush();
  expect(applied()).toEqual(instance);
  const scheduled = addEffectTrigger(
    undefined,
    0,
    shape.id,
    instance,
    definition,
  );
  scheduled.stages[0].blocks![0].effectSchedule!.stop = {
    mode: "after",
    durationMs: 2000,
  };
  session.apply(setSlideMotion(session.snapshot!, scheduled));
  await session.flush();
  const assertSnapshot = (slide: Slide) => {
    const effect = findElement(slide, shape.id)!.effects![0];
    expect(slide.effectResources![effect.resourceId]).toEqual(definition);
    expect(slide.motion).toEqual(scheduled);
  };
  const recoveryReader = await storageAt(root);
  const recovered = await recoveryReader.recoverUntitled(id);
  assertSnapshot(
    recoveryReader.documentRuntime(recovered.id).authority.document.slides[
      slideId
    ],
  );
  const file = path.join(root, "Effects.sme");
  await storage.saveDocument(id, file);
  const reader = await storageAt(root, "reader");
  const opened = await reader.openDocument(file);
  assertSnapshot(
    reader.documentRuntime(opened.id).authority.document.slides[slideId],
  );
  const packagedFile = path.join(root, "Effects.smp");
  await storage.packageDocument(id, packagedFile);
  const destination = await storageAt(root, "destination");
  const packaged = await destination.openPackage(packagedFile);
  assertSnapshot(
    destination.documentRuntime(packaged.id).authority.document.slides[slideId],
  );
  const bundle = createSlideTransferBundle(
    id,
    session.snapshot!.deck,
    [session.snapshot!.slide],
    runtime.authority.document.templates,
  );
  const transfer = prepareSlideTransferImport(bundle, session.snapshot!.deck);
  expect(
    transfer.slides[0].motion?.stages[0].blocks![0].effectSchedule,
  ).toEqual(scheduled.stages[0].blocks![0].effectSchedule);
  expect(Object.values(transfer.slides[0].effectResources!)).toContainEqual(
    definition,
  );
  expect(runtime.authority.document.slides[slideId].effectResources).toEqual(
    session.snapshot!.slide.effectResources,
  );
});

it("definition updates preserve compatible instance values and Click Timeline bindings atomically", async () => {
  const { session } = await storedDocument();
  const shape = await insertShape(session);
  const definition = {
    ...blankEffect("css-js"),
    parameters: [
      {
        type: "number" as const,
        key: "strength",
        label: "Strength",
        default: 1,
        min: 0,
        max: 10,
      },
    ],
    source: ":scope { opacity: calc(var(--strength) * var(--p)); }",
  };
  session.apply(
    setElementEffectDefinition(session.snapshot!, shape.id, definition),
  );
  await session.flush();
  const instance = findElement(session.snapshot!.slide, shape.id)!.effects![0];
  session.apply(
    setSlideEffects(session.snapshot!, {
      changes: [
        {
          elementId: shape.id,
          value: [
            {
              ...instance,
              parameters: { ...instance.parameters, strength: 3 },
            },
          ],
        },
      ],
    }),
  );
  await session.flush();
  session.apply(
    setSlideMotion(
      session.snapshot!,
      addEffectTrigger(undefined, 0, shape.id, instance, definition),
    ),
  );
  await session.flush();
  const motion = structuredClone(session.snapshot!.slide.motion);
  const changed = {
    ...definition,
    speed: 2,
    name: "Changed",
    source: ":scope { opacity: var(--strength); }",
  };
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      shape.id,
      changed,
      instance.id,
    ),
  );
  await session.flush();
  const next = findElement(session.snapshot!.slide, shape.id)!.effects![0];
  expect(next.id).toBe(instance.id);
  expect(next.parameters.strength).toBe(3);
  expect(
    session.snapshot!.slide.effectResources![instance.resourceId],
  ).toBeUndefined();
  expect(Object.keys(session.snapshot!.slide.effectResources!)).toEqual([
    next.resourceId,
  ]);
  const renamed = structuredClone(motion!);
  renamed.stages[0].blocks![0].label = "Changed";
  expect(session.snapshot!.slide.motion).toEqual(renamed);
  await session.undo();
  await session.flush();
  expect(session.snapshot!.slide.motion).toEqual(motion);
  expect(session.snapshot!.slide.effectResources![instance.resourceId]).toEqual(
    definition,
  );
  expect(
    session.snapshot!.slide.effectResources![next.resourceId],
  ).toBeUndefined();
  await session.undo(true);
  await session.flush();
  expect(session.snapshot!.slide.motion).toEqual(renamed);
  expect(session.snapshot!.slide.effectResources![next.resourceId]).toEqual(
    changed,
  );
});

it("replacing an Effect retains a shared definition until its last instance is replaced", async () => {
  const { session } = await storedDocument();
  const first = await insertShape(session);
  const second = await insertShape(session, "second-shape");
  const definition = blankEffect("css-js");
  session.apply(
    setElementEffectDefinition(session.snapshot!, first.id, definition),
  );
  await session.flush();
  const instance = findElement(session.snapshot!.slide, first.id)!.effects![0];
  const shared = { ...instance, id: "shared-instance" };
  session.apply(
    setSlideEffects(session.snapshot!, {
      changes: [{ elementId: second.id, value: [shared] }],
    }),
  );
  await session.flush();
  const changed = { ...definition, name: "Changed" };
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      first.id,
      changed,
      instance.id,
    ),
  );
  await session.flush();
  expect(session.snapshot!.slide.effectResources![instance.resourceId]).toEqual(
    definition,
  );
  expect(findElement(session.snapshot!.slide, second.id)!.effects![0]).toEqual(
    shared,
  );
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      second.id,
      changed,
      shared.id,
    ),
  );
  await session.flush();
  expect(
    session.snapshot!.slide.effectResources![instance.resourceId],
  ).toBeUndefined();
  expect(Object.keys(session.snapshot!.slide.effectResources!)).toHaveLength(2);
});

it("slide Effect resources accept exactly 2 MB of UTF-8 JSON and reject larger totals", () => {
  const definition = blankEffect("css-js");
  const resources = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `resource-${index}`,
      { ...definition, source: "a".repeat(100000) },
    ]),
  );
  const excess =
    new TextEncoder().encode(JSON.stringify(resources)).byteLength - 2000000;
  resources["resource-0"].source = "a".repeat(100000 - excess);
  expect(effectResourcesSchema.safeParse(resources).success).toBe(true);
  resources["resource-0"].source += "é";
  const rejected = effectResourcesSchema.safeParse(resources);
  expect(rejected.success).toBe(false);
  if (!rejected.success)
    expect(rejected.error.issues).toContainEqual(
      expect.objectContaining({ message: "Effect resources exceed 2 MB" }),
    );
});

it("numeric entry expands an instance range durably and definition edits clamp it with undo", async () => {
  const { session, runtime } = await storedDocument();
  const shape = await insertShape(session);
  const definition = {
    ...blankEffect("css-js"),
    parameters: [
      {
        type: "number" as const,
        key: "amount",
        label: "Amount",
        default: 1,
        min: 0,
        max: 10,
      },
    ],
  };
  session.apply(
    setElementEffectDefinition(session.snapshot!, shape.id, definition),
  );
  await session.flush();
  const instance = findElement(session.snapshot!.slide, shape.id)!.effects![0];
  session.apply(
    setElementEffectParameterValue(
      session.snapshot!,
      shape.id,
      instance.id,
      "amount",
      25,
    ),
  );
  await session.flush();
  const expanded = findElement(session.snapshot!.slide, shape.id)!.effects![0];
  expect(expanded.parameters.amount).toBe(25);
  expect(
    (
      session.snapshot!.slide.effectResources![expanded.resourceId]
        .parameters[0] as { max?: number }
    ).max,
  ).toBe(25);
  expect(
    runtime.authority.document.slides[session.snapshot!.slide.id]
      .effectResources,
  ).toEqual(session.snapshot!.slide.effectResources);
  await session.undo();
  await session.flush();
  expect(
    findElement(session.snapshot!.slide, shape.id)!.effects![0].parameters
      .amount,
  ).toBe(1);
  await session.undo(true);
  await session.flush();
  session.apply(
    setElementEffectDefinition(
      session.snapshot!,
      shape.id,
      definition,
      instance.id,
    ),
  );
  await session.flush();
  expect(
    findElement(session.snapshot!.slide, shape.id)!.effects![0].parameters
      .amount,
  ).toBe(10);
  await session.undo();
  await session.flush();
  expect(
    findElement(session.snapshot!.slide, shape.id)!.effects![0].parameters
      .amount,
  ).toBe(25);
});
