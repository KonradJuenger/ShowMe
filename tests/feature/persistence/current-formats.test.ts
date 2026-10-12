import { expect, it } from "vitest";
import { assetSchema } from "../../../src/core/assets";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { effectDefinitionSchema } from "../../../src/core/effects";
import {
  libraryEffectSchema,
  savedLibraryEffect,
} from "../../../src/core/libraryEffects";
import { addEffectTrigger } from "../../../src/core/effectSequence";
import { addPresence } from "../../../src/core/presence";
import {
  effectScheduleSchema,
  presenceScheduleSchema,
  slideMotionSchema,
} from "../../../src/core/motionModel";

it("asset metadata accepts public v1 and rejects unsupported versions", () => {
  const asset = {
    version: 1,
    id: "a".repeat(64),
    filename: "synthetic.png",
    names: ["synthetic.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: 1,
    createdAt: "2026-10-12T00:00:00Z",
  };
  expect(assetSchema.parse(asset)).toEqual(asset);
  expect(assetSchema.safeParse({ ...asset, version: 2 }).success).toBe(false);
});

it("Effect definitions and Library envelopes write public v1 and reject unsupported versions", () => {
  const definition = blankEffect("css-js");
  const asset = savedLibraryEffect(definition);
  expect(definition.apiVersion).toBe(1);
  expect(asset.version).toBe(1);
  expect(libraryEffectSchema.parse(JSON.parse(JSON.stringify(asset)))).toEqual(
    asset,
  );
  expect(
    effectDefinitionSchema.safeParse({ ...definition, apiVersion: 2 }).success,
  ).toBe(false);
  expect(libraryEffectSchema.safeParse({ ...asset, version: 2 }).success).toBe(
    false,
  );
});

it("Effect and Presence schedules use public v1 in the shared Click Timeline", () => {
  const definition = blankEffect("css-js");
  const instance = {
    id: "instance",
    resourceId: "resource",
    enabled: true,
    placement: "content" as const,
    parameters: {},
  };
  const timeline = addPresence(
    addEffectTrigger(undefined, 0, "element", instance, definition),
    0,
    ["element"],
  );
  const blocks = timeline.stages[0].blocks!;
  const effect = blocks.find((block) => block.effectSchedule)!.effectSchedule!;
  const presence = blocks.find(
    (block) => block.presenceSchedule,
  )!.presenceSchedule!;
  expect(effect.version).toBe(1);
  expect(presence.version).toBe(1);
  expect(slideMotionSchema.parse(JSON.parse(JSON.stringify(timeline)))).toEqual(
    timeline,
  );
  expect(
    effectScheduleSchema.safeParse({ ...effect, version: 2 }).success,
  ).toBe(false);
  expect(
    presenceScheduleSchema.safeParse({ ...presence, version: 2 }).success,
  ).toBe(false);
});
