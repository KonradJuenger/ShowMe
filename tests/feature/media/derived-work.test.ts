import { createTextElement, type TextContent } from "../../../src/core/text";
import type { ImageRequirement } from "../../../src/core/presentationImages";
import { expect, it, vi } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { documentImpact } from "../../../src/core/documentImpact";
import type { DocumentOperation } from "../../../src/core/documentOperations";
import { createBasicShape } from "../../../src/core/elementFactory";
import { createMediaElement } from "../../../src/core/media";
import { ImagePreparationCoordinator } from "../../../src/core/imagePreparationCoordinator";
import { DocumentRuntime } from "../../../src/core/documentRuntime";
import { ImageWorkQueue, imageWorkerConcurrency } from "../../../src/core/imageWorkQueue";
import { nativeImageConcurrency } from "../../../electron/imageProcessorPool";

it("native image admission stays below libuv capacity and lets foreground work overtake waiting background jobs", async () => {
  expect(nativeImageConcurrency).toBe(2);
  const queue = new ImageWorkQueue(nativeImageConcurrency);
  const releases: Array<() => void> = [], order: string[] = [];
  const active = Array.from({ length: 2 }, () => queue.run(1, () => new Promise<void>(resolve => { releases.push(resolve); })));
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  const background = queue.run(1, async () => { order.push("background"); });
  const foreground = queue.run(1, async () => { order.push("foreground"); }, { priority: 3 });
  try {
    releases.shift()!();
    await foreground;
    expect(order[0]).toBe("foreground");
  } finally {
    for (const release of releases) release();
    await Promise.all([...active, foreground, background]);
  }
});

it("image worker sizing reserves CPU headroom and bounds admitted jobs with a safe minimum and fallback", async () => {
  expect(imageWorkerConcurrency(20)).toBe(15);
  expect(imageWorkerConcurrency(8)).toBe(6);
  expect(imageWorkerConcurrency(4)).toBe(2);
  expect(imageWorkerConcurrency(2)).toBe(1);
  expect(imageWorkerConcurrency(1)).toBe(1);
  expect(imageWorkerConcurrency(undefined)).toBe(2);
  expect(imageWorkerConcurrency(NaN)).toBe(2);
  expect(imageWorkerConcurrency(Infinity)).toBe(2);
  const queue = new ImageWorkQueue(imageWorkerConcurrency(20));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let started = 0, active = 0, peak = 0;
  const jobs = Array.from({ length: 16 }, () => queue.run(1, async () => {
    started++;
    peak = Math.max(peak, ++active);
    await hold;
    active--;
  }));
  try {
    await vi.waitFor(() => expect(started).toBe(15));
  } finally {
    release();
    await Promise.all(jobs);
  }
  expect(peak).toBe(15);
});

it("visible image demand overtakes queued background work without exceeding the memory budget", async () => {
  const queue = new ImageWorkQueue(imageWorkerConcurrency(20));
  const order: string[] = [];
  let finishFirst!: () => void;
  let finishVisible!: () => void;
  const first = queue.run(
    512 * 1024 * 1024,
    () =>
      new Promise<void>((resolve) => {
        order.push("first");
        finishFirst = resolve;
      }),
  );
  await vi.waitFor(() => expect(order).toEqual(["first"]));
  const background = queue.run(1, async () => {
    order.push("background");
  });
  const visible = queue.run(
    512 * 1024 * 1024,
    () =>
      new Promise<void>((resolve) => {
        order.push("visible");
        finishVisible = resolve;
      }),
    { priority: 2, key: "visible" },
  );
  finishFirst();
  await vi.waitFor(() => expect(order).toEqual(["first", "visible"]));
  finishVisible();
  await Promise.all([first, background, visible]);
  expect(order).toEqual(["first", "visible", "background"]);
});

it("foreground requests promote an already queued image and preserve FIFO among equal priorities", async () => {
  const queue = new ImageWorkQueue();
  const order: string[] = [];
  let finish!: () => void;
  const active = queue.run(
    512 * 1024 * 1024,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  const older = queue.run(1, async () => {
    order.push("older");
  });
  const promoted = queue.run(
    1,
    async () => {
      order.push("promoted");
    },
    { priority: 0, key: "image" },
  );
  const newer = queue.run(1, async () => {
    order.push("newer");
  });
  queue.setPriorities(new Map([["image", 2]]));
  finish();
  await Promise.all([active, older, promoted, newer]);
  expect(order).toEqual(["promoted", "older", "newer"]);
});

it("leaving a slide demotes its queued images so later slides cannot accumulate a foreground backlog", async () => {
  const queue = new ImageWorkQueue();
  const order: string[] = [];
  let finish!: () => void;
  const active = queue.run(512 * 1024 * 1024, () => new Promise<void>((resolve) => { finish = resolve; }));
  await vi.waitFor(() => expect(finish).toBeDefined());
  const old = queue.run(1, async () => { order.push("old slide"); }, { priority: 2, key: "old" });
  const current = queue.run(1, async () => { order.push("current slide"); }, { priority: 2, key: "current" });
  queue.setPriorities(new Map([["old", 0], ["current", 2]]));
  finish();
  await Promise.all([active, old, current]);
  expect(order).toEqual(["current slide", "old slide"]);
});

it("plain rectangle movement omits media and dependencies while unknown operations invalidate broadly", () => {
  const document = newPresentationDocument("Impact");
  const slideId = document.deck.slideIds[0],
    shape = createBasicShape("shape", "rectangle");
  document.slides[slideId].nodes[0].children = [shape];
  expect(
    documentImpact(
      [
        {
          type: "elements.frame.set",
          slideId,
          changes: [{ elementId: shape.id, value: { ...shape.frame, x: 50 } }],
        },
      ],
      document,
    ),
  ).toMatchObject({
    media: false,
    dependencies: false,
    visual: true,
    slides: [slideId],
  });
  expect(
    documentImpact(
      [
        {
          type: "elements.geometry.set",
          slideId,
          changes: [
            { elementId: shape.id, value: { type: "future-geometry" } },
          ],
        } as unknown as DocumentOperation,
      ],
      document,
    ),
  ).toMatchObject({ media: true, dependencies: true, visual: true });
  expect(
    documentImpact(
      [
        {
          type: "elements.frame.set",
          slideId,
          changes: [
            { elementId: shape.id, value: { ...shape.frame, futureScale: 2 } },
          ],
        } as unknown as DocumentOperation,
      ],
      document,
    ),
  ).toMatchObject({ media: true, dependencies: true, visual: true });
  expect(
    documentImpact(
      [{ type: "future.operation" } as unknown as DocumentOperation],
      document,
    ),
  ).toMatchObject({
    media: true,
    dependencies: true,
    visual: true,
    slides: null,
  });
});

it("100-slide image preparation completes the whole deck, deduplicates shared pixels and replans only affected slides", async () => {
  const document = newPresentationDocument("Demand"),
    base = document.slides[document.deck.slideIds[0]];
  const image = createMediaElement("image", {
    version: 1,
    id: "a".repeat(64),
    filename: "image.png",
    names: ["image.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: 1,
    width: 4096,
    height: 4096,
    createdAt: "2026-10-11T00:00:00Z",
  });
  base.nodes[0].children = [image];
  const meta = document.deck.slideMeta[base.id];
  document.deck.slideIds = Array.from({ length: 100 }, (_, i) => "s" + i);
  document.deck.slideMeta = Object.fromEntries(
    document.deck.slideIds.map((id) => [id, { ...meta }]),
  );
  document.slides = Object.fromEntries(
    document.deck.slideIds.map((id) => [id, { ...structuredClone(base), id }]),
  );
  let revision = 0;
  const loads: string[][] = [];
  const prepare = vi.fn(async (_id: string, requirement: ImageRequirement) => ({
    assetId: requirement.assetId,
    hash: requirement.assetId,
    size: requirement.size,
    width: requirement.width,
    height: requirement.height,
    sourceWidth: 4096,
    sourceHeight: 4096,
    recipe: "test",
    mime: "image/png" as const,
    url: "test",
  }));
  const coordinator = new ImagePreparationCoordinator({
    projection: (_id, slideId) => ({
      documentId: document.documentId,
      epoch: "test",
      revision,
      savedRevision: 0,
      deck: document.deck,
      slide: document.slides[slideId ?? "s0"],
      templates: {},
    }),
    slides: (_id, ids) => {
      loads.push([...ids]);
      return ids.map((id) => document.slides[id]);
    },
    profile: () => ({ width: 3840, height: 2160 }),
    prepare,
  });
  await coordinator.reconcile(document.documentId);
  await vi.waitFor(() =>
    expect(coordinator.status(document.documentId)?.state).toBe("ready"),
  );
  expect(loads).toEqual([document.deck.slideIds]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(coordinator.image(document.documentId, "s99", image.id)).not.toBeNull();
  document.slides.s1.nodes[0].children[0].frame.width += 100;
  revision++;
  await coordinator.reconcile(document.documentId, false, ["s1"]);
  await vi.waitFor(() =>
    expect(coordinator.status(document.documentId)?.state).toBe("ready"),
  );
  expect(loads).toEqual([document.deck.slideIds, ["s1"]]);
  const prepared = prepare.mock.calls.length;
  coordinator.prioritize(document.documentId, "s1");
  await vi.waitFor(() => {
    expect(coordinator.status(document.documentId)?.state).toBe("ready");
    expect(loads).toEqual([document.deck.slideIds, ["s1"]]);
  });
  // The new slide shares the existing variant. Navigation must retain both
  // ready pixels and accepted requirement plans for overlapping slides.
  expect(prepare).toHaveBeenCalledTimes(prepared);
  expect(coordinator.image(document.documentId, "s2", image.id)).not.toBeNull();
  coordinator.prioritize(document.documentId, "s0");
  await vi.waitFor(() =>
    expect(coordinator.status(document.documentId)?.total).toBe(2),
  );
  expect(prepare).toHaveBeenCalledTimes(prepared);
  expect(loads).toEqual([document.deck.slideIds, ["s1"]]);
  await coordinator.reconcile(document.documentId, true);
  await vi.waitFor(() =>
    expect(coordinator.status(document.documentId)?.state).toBe("ready"),
  );
  expect(prepare.mock.calls.length).toBeGreaterThan(prepared);
  const work = prepare.mock.calls.length;
  coordinator.advanceRevision(document.documentId, ++revision);
  await coordinator.reconcile(document.documentId);
  expect(prepare.mock.calls).toHaveLength(work);
  coordinator.close(document.documentId);
});

it("revision metadata reads clone no document and presenter metadata exposes no mutable authority values", () => {
  const document = newPresentationDocument("Metadata"),
    runtime = new DocumentRuntime(document, {
      actorId: "local",
      durableCommit: async () => {},
    });
  const cloning = vi.spyOn(globalThis, "structuredClone");
  try {
    expect(runtime.metadata(document.documentId).revision).toBe(0);
    expect(cloning).not.toHaveBeenCalled();
  } finally {
    cloning.mockRestore();
  }
  const view = runtime.presentationMetadata(document.documentId);
  view.deck.name = "changed";
  expect(runtime.authority.document.deck.name).toBe("Metadata");
});

it("render projections omit unrelated template content and retain revision identity", async () => {
  const document = newPresentationDocument("Projection"),
    id = document.deck.slideIds[0];
  for (let i = 0; i < 50; i++) {
    const templateId = "t" + i;
    document.deck.templateIds.push(templateId);
    document.deck.templateMeta[templateId] = {
      label:
        String.fromCharCode(65 + Math.floor(i / 26)) +
        String.fromCharCode(65 + (i % 26)),
    };
    document.templates[templateId] = {
      ...structuredClone(document.templates[document.deck.defaultTemplateId!]),
      id: templateId,
    };
    document.templates[templateId].nodes[0].children = Array.from(
      { length: 20 },
      (_, j) => createBasicShape("e" + j, "rectangle"),
    );
  }
  const runtime = new DocumentRuntime(document, {
    actorId: "local",
    durableCommit: async () => {},
  });
  const full = await runtime.projection(document.documentId, id),
    render = await runtime.renderProjection(document.documentId, id);
  expect(Object.keys(render.templates!)).toEqual([
    document.deck.defaultTemplateId,
  ]);
  expect(render.revision).toBe(full.revision);
  expect(render.slide).toEqual(full.slide);
  expect(JSON.stringify(render).length).toBeLessThan(
    JSON.stringify(full).length / 10,
  );
  render.slide.notes = "mutated";
  expect(runtime.authority.document.slides[id].notes).toBe("");
});

it("plain text content compares only changed typography and notes omit presentation work", () => {
  const before = newPresentationDocument("Typing"),
    id = before.deck.slideIds[0],
    text = createTextElement("text");
  before.slides[id].nodes[0].children = [text];
  const after = structuredClone(before),
    value = { ...(text.content as TextContent), text: "More text" };
  after.slides[id].nodes[0].children[0].content = value;
  expect(
    documentImpact(
      [
        {
          type: "elements.content.set",
          slideId: id,
          changes: [{ elementId: "text", value }],
        },
      ],
      after,
      before,
    ),
  ).toMatchObject({
    dependencies: false,
    media: false,
    presentation: "content",
  });
  expect(
    documentImpact(
      [{ type: "slide.notes.set", slideId: id, notes: "Notes" }],
      after,
      before,
    ),
  ).toMatchObject({ presentation: "none" });
});
