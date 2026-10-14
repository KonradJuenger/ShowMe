import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { newPresentationDocument } from "../../../src/core/document";
import { createMediaElement } from "../../../src/core/media";
import { ImagePreparationCoordinator } from "../../../src/core/imagePreparationCoordinator";
import { audienceImageProfile, IMAGE_RECIPE, imageIdentity, type ImageRequirement } from "../../../src/core/presentationImages";
import { audienceImageWindow } from "../../../src/core/audienceImageWindow";
import { imageWorkerConcurrency } from "../../../src/core/imageWorkQueue";

function imageDocument(assets = ["a", "b", "b", "c"]) {
  const model = newPresentationDocument("Audience image contracts");
  const first = model.slides[model.deck.slideIds[0]], meta = model.deck.slideMeta[first.id];
  model.deck.slideIds = assets.map((_, i) => "slide" + i);
  model.deck.slideMeta = Object.fromEntries(model.deck.slideIds.map(id => [id, { ...meta }]));
  model.slides = Object.fromEntries(assets.map((asset, i) => {
    const slide = { ...structuredClone(first), id: model.deck.slideIds[i] };
    const image = createMediaElement("image", { version: 1, id: asset.repeat(64), filename: "image.png", names: ["image.png"],
      type: "image", mediaType: "image", mime: "image/png", bytes: 1, width: 4096, height: 4096, createdAt: "2026-10-13T00:00:00Z" });
    image.frame.width = image.frame.height = 64;
    slide.nodes[0].children = [image];
    return [slide.id, slide];
  }));
  return model;
}

function prepared(requirement: ImageRequirement) {
  return { assetId: requirement.assetId, hash: imageIdentity(requirement.assetId, requirement.width, requirement.height),
    size: requirement.size, width: requirement.width, height: requirement.height, sourceWidth: 4096, sourceHeight: 4096,
    recipe: IMAGE_RECIPE, mime: "image/png" as const, url: "prepared:" + requirement.assetId };
}

it("fractional audience output uses one physical profile and rejects unavailable geometry", () => {
  const profile = audienceImageProfile(1596, 998, 1.6041666269302368);
  expect(profile).toEqual({ width: 2561, height: 1601 });
  expect(audienceImageProfile(1596, 998, 1.6041666269302368)).toEqual(profile);
  expect(() => audienceImageProfile(0, 1080, 1)).toThrow("geometry");
  expect(() => audienceImageProfile(1920, 1080, NaN)).toThrow("geometry");
});

it("whole-deck results are shared, navigation keeps the generation and status reads do not redirect demand", async () => {
  const model = imageDocument();
  const prepare = vi.fn(async (_id: string, requirement: ImageRequirement) => prepared(requirement));
  const coordinator = new ImagePreparationCoordinator({
    projection: (_id, slideId) => ({ documentId: model.documentId, epoch: "epoch", revision: 0, savedRevision: 0,
      deck: model.deck, slide: model.slides[slideId ?? model.deck.slideIds[0]], templates: model.templates }),
    profile: () => model.deck,
    prepare,
  });
  await coordinator.reconcile(model.documentId);
  await coordinator.ready(model.documentId);
  const status = coordinator.status(model.documentId)!;
  expect(status).toMatchObject({ total: 3, completed: 3, state: "ready" });
  const late = await coordinator.prepareSlide(model.documentId, "slide3", model.deck);
  expect(late.image?.assetId).toBe("c".repeat(64));
  coordinator.prioritize(model.documentId, "slide3");
  expect(coordinator.status(model.documentId)?.generation).toBe(status.generation);
  expect(prepare).toHaveBeenCalledTimes(3);
  const read = coordinator.status(model.documentId)!;
  read.completed = 0;
  expect(coordinator.status(model.documentId)?.completed).toBe(3);
  coordinator.close(model.documentId);
});

it("opening queues all 100 slides and hidden-layer images without navigation and respects CPU headroom", async () => {
  const model = imageDocument(Array.from({ length: 100 }, () => "a"));
  for (const [index, slide] of Object.values(model.slides).entries()) {
    const content = slide.nodes[0].children[0].content!;
    if (content.type !== "image") throw new Error("Expected image fixture");
    content.assetId = index.toString(16).padStart(64, "0");
    if (content.transform.rule === "free") throw new Error("Expected fitted image fixture");
    content.transform.intrinsicWidth = content.transform.intrinsicHeight = 64;
  }
  model.deck.slideMeta.slide99.hidden = true;
  model.deck.slideMeta.slide98.section = "slide0";
  const hidden = structuredClone(model.slides.slide0.nodes[0].children[0]);
  hidden.id = "hidden-image";
  if (hidden.content?.type !== "image") throw new Error("Expected hidden image fixture");
  hidden.content.assetId = "f".repeat(64);
  model.deck.layers.push({ ...model.deck.layers[0], id: "hidden-layer", hidden: true });
  for (const slide of Object.values(model.slides))
    slide.nodes.push({ type: "layer", id: "hidden-layer", children: slide.id === "slide0" ? [hidden] : [] });
  for (const template of Object.values(model.templates))
    template.nodes.push({ type: "layer", id: "hidden-layer", children: [] });
  let running = 0, peak = 0;
  const releases: Array<() => void> = [], started: string[] = [], loaded: string[][] = [];
  const coordinator = new ImagePreparationCoordinator({
    concurrency: imageWorkerConcurrency(20),
    projection: (_id, slideId) => ({ documentId: model.documentId, epoch: "epoch", revision: 0, savedRevision: 0,
      deck: model.deck, slide: model.slides[slideId ?? "slide0"], templates: model.templates }),
    slides: (_id, ids) => { loaded.push([...ids]); return ids.map(id => model.slides[id]); },
    profile: () => model.deck,
    prepare: (_id, requirement) => new Promise(resolve => {
      started.push(requirement.assetId); peak = Math.max(peak, ++running);
      releases.push(() => { running--; resolve(prepared(requirement)); });
    }),
  });
  try {
    coordinator.prioritize(model.documentId, "slide50");
    await coordinator.reconcile(model.documentId);
    expect(new Set(loaded[0])).toEqual(new Set(model.deck.slideIds));
    expect(coordinator.status(model.documentId)).toMatchObject({ total: 101, state: "preparing" });
    expect(started).toHaveLength(15);
    expect(started[0]).toBe((50).toString(16).padStart(64, "0"));
    while (coordinator.status(model.documentId)?.state !== "ready") {
      await vi.waitFor(() => expect(releases.length > 0 || coordinator.status(model.documentId)?.state === "ready").toBe(true), { interval: 1 });
      for (const release of releases.splice(0)) release();
    }
    expect(new Set(started).size).toBe(101);
    expect(peak).toBe(15);
    expect(coordinator.status(model.documentId)).toMatchObject({ total: 101, completed: 101, state: "ready" });
    expect(coordinator.image(model.documentId, "slide99", "image")).not.toBeNull();
    expect(coordinator.image(model.documentId, "slide0", "hidden-image")).not.toBeNull();
    const rendered = await coordinator.prepareSlide(model.documentId, "slide0", model.deck);
    expect(rendered["hidden-image"]).toBeUndefined();
  } finally {
    coordinator.close(model.documentId);
    for (const release of releases.splice(0)) release();
  }
});

it("the editor prepares its audience variant without waiting for unrelated deck images", async () => {
  const model = imageDocument(["b", "a"]);
  let finish!: () => void;
  const prepare = vi.fn(async (_id: string, requirement: ImageRequirement) => {
    if (requirement.assetId === "b".repeat(64)) await new Promise<void>(resolve => { finish = resolve; });
    return prepared(requirement);
  });
  const coordinator = new ImagePreparationCoordinator({
    projection: (_id, slideId) => ({ documentId: model.documentId, epoch: "epoch", revision: 0, savedRevision: 0,
      deck: model.deck, slide: model.slides[slideId ?? "slide0"], templates: model.templates }),
    profile: () => model.deck,
    prepare,
  });
  try {
    await coordinator.reconcile(model.documentId);
    await vi.waitFor(() => expect(coordinator.status(model.documentId)).toMatchObject({ state: "preparing", completed: 0 }));
    let image: Awaited<ReturnType<typeof coordinator.prepareSlide>> | undefined;
    const pending = coordinator.prepareSlide(model.documentId, "slide1", model.deck, 1).then(result => { image = result; });
    await vi.waitFor(() => expect(image?.image?.assetId).toBe("a".repeat(64)));
    expect(coordinator.status(model.documentId)?.state).toBe("preparing");
    expect(prepare).toHaveBeenCalledTimes(2);
    await pending;
  } finally {
    finish();
    await coordinator.ready(model.documentId);
    coordinator.close(model.documentId);
  }
});

it("a throwing image job remains failed but does not block healthy slides or per-instance original fallback", async () => {
  const model = imageDocument(["a", "b"]);
  const coordinator = new ImagePreparationCoordinator({
    projection: (_id, slideId) => ({ documentId: model.documentId, epoch: "epoch", revision: 0, savedRevision: 0,
      deck: model.deck, slide: model.slides[slideId ?? "slide0"], templates: model.templates }),
    profile: () => model.deck,
    prepare: async (_id, requirement) => {
      if (requirement.assetId === "b".repeat(64)) throw new Error("Worker failed deliberately");
      return prepared(requirement);
    },
  });
  await coordinator.reconcile(model.documentId);
  await expect(coordinator.ready(model.documentId)).rejects.toThrow("Worker failed deliberately");
  expect(await coordinator.ready(model.documentId, true)).toMatchObject({ state: "failed", completed: 1,
    failures: [{ message: "Worker failed deliberately" }] });
  expect((await coordinator.prepareSlide(model.documentId, "slide0", model.deck)).image?.assetId).toBe("a".repeat(64));
  expect(await coordinator.prepareSlide(model.documentId, "slide1", model.deck)).toEqual({ image: null });
  expect(await coordinator.prepareSlide(model.documentId, "slide1", { width: 1280, height: 720 })).toEqual({ image: null });
  expect(coordinator.status(model.documentId)?.state).toBe("failed");
  coordinator.close(model.documentId);
});

it("unsupported original rendering is counted explicitly and closing settles a preparation waiter", async () => {
  const model = imageDocument(["a"]);
  let finish!: () => void;
  const coordinator = new ImagePreparationCoordinator({
    projection: () => ({ documentId: model.documentId, epoch: "epoch", revision: 0, savedRevision: 0,
      deck: model.deck, slide: model.slides.slide0, templates: model.templates }),
    profile: () => model.deck,
    prepare: () => new Promise<null>(resolve => { finish = () => resolve(null); }),
  });
  await coordinator.reconcile(model.documentId);
  finish();
  await coordinator.ready(model.documentId);
  expect(coordinator.status(model.documentId)).toMatchObject({ total: 1, completed: 1, originals: 1, state: "ready" });
  await coordinator.reconcile(model.documentId, true);
  const waiter = coordinator.ready(model.documentId);
  const closed = expect(waiter).rejects.toThrow("unavailable");
  coordinator.close(model.documentId);
  finish();
  await closed;
});

it("resident lookahead shares identical rasters, pins required output and drops optional images over budget", () => {
  const model = imageDocument();
  const slides = new Map(Object.entries(model.slides));
  const budget = 2 * 64 * 64 * 4;
  expect(audienceImageWindow(model.deck, slides, model.deck.slideIds, 1, model.deck, "slide0", budget))
    .toEqual(["slide1", "slide2", "slide0"]);
  expect(audienceImageWindow(model.deck, slides, model.deck.slideIds, 1, model.deck, "slide0", 1))
    .toEqual(["slide1", "slide2", "slide0"]);
  expect(audienceImageWindow(model.deck, slides, model.deck.slideIds, 1, model.deck, undefined, budget))
    .toEqual(["slide1", "slide2", "slide0"]);
});

it("benchmark history preserves commit samples and separates incompatible rendering environments", async () => {
  const modulePath = "../../../scripts/audience-benchmark-history.mjs";
  const { recordAudienceBenchmark, renderAudienceHistory } = await import(
    modulePath
  );
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "showme-audience-history-"),
  );
  try {
    const report = {
      schemaVersion: 2,
      revision: "a".repeat(40),
      branch: "test",
      dirty: false,
      createdAt: "2026-10-14T00:00:00Z",
      runs: 3,
      workload: { version: 2 },
      environment: { cpu: "synthetic", width: 1920, height: 1080, dpr: 1 },
      metrics: { taskCpuMs: 100 },
      metricRanges: { taskCpuMs: { min: 95, max: 105 } },
    };
    const first = await recordAudienceBenchmark(report, folder);
    const second = await recordAudienceBenchmark(
      { ...report, revision: "b".repeat(40), metrics: { taskCpuMs: 80 } },
      folder,
    );
    const exploratory = await recordAudienceBenchmark(
      { ...report, dirty: true },
      folder,
    );
    const other = await recordAudienceBenchmark(
      { ...report, environment: { ...report.environment, dpr: 2 } },
      folder,
    );
    expect(second.group).toBe(first.group);
    expect(exploratory.group).toBe(first.group);
    expect(other.group).not.toBe(first.group);
    expect(second.machineId).toBe(first.machineId);
    const records = await renderAudienceHistory(folder);
    expect(records).toHaveLength(4);
    expect(
      records.map((record: { revision: string }) => record.revision),
    ).toEqual([
      report.revision,
      "b".repeat(40),
      report.revision,
      report.revision,
    ]);
    expect(records[1].metrics.taskCpuMs).toBe(80);
    expect(records[2].dirty).toBe(true);
    expect(await readFile(path.join(folder, "history.html"), "utf8")).toContain(
      "Include exploratory dirty working trees",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
