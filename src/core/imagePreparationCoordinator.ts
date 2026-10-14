import { resolveVisualSlide } from "./templates";
import { getPresentationSlideIds } from "./presentationSequence";
import type { DocumentProjection } from "./documentProjection";
import {
  planPresentationImages,
  type ImageOutputProfile,
  type ImageReadiness,
  type ImageRequirement,
  type PreparedImage,
  type PreparedSlideImages,
} from "./presentationImages";

interface Dependencies {
  concurrency?: number;
  slides?(
    documentId: string,
    slideIds: readonly string[],
  ):
    | Promise<readonly import("./document").Slide[]>
    | readonly import("./document").Slide[];
  projection(
    documentId: string,
    slideId?: string,
  ): Promise<DocumentProjection> | DocumentProjection;
  prepare(
    documentId: string,
    requirement: ImageRequirement,
    priority?: number,
  ): Promise<PreparedImage | null>;
  profile(): ImageOutputProfile;
}
interface ReadinessPlan {
  status: ImageReadiness;
  done: Promise<void>;
  finish: () => void;
}
interface Interest {
  cache: ReadinessPlan;
  presentation: ReadinessPlan;
  presentationRequirements: Map<string, ImageRequirement[]>;
  images: Map<string, PreparedImage>;
  signature: string;
  slideIds: string[];
  requirements: Map<string, ImageRequirement[]>;
}

const requirementKey = (requirement: ImageRequirement) =>
  `${requirement.assetId}:${requirement.width}x${requirement.height}`;

function readinessPlan(status: ImageReadiness): ReadinessPlan {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  return { status, done, finish };
}

function settlePlan(plan: ReadinessPlan) {
  if (plan.status.completed + plan.status.failures.length !== plan.status.total) return;
  plan.status.state = plan.status.failures.length ? "failed" : "ready";
  plan.finish();
}

/** Derived accepted-state service, with a single bounded queue for all documents. */
export class ImagePreparationCoordinator {
  private documents = new Map<string, Interest>();
  private serial = 0;
  private requests = new Map<string, number>();
  private running = 0;
  private runningBytes = 0;
  private paused = false;
  private priorities = new Map<string, string>();
  private listeners = new Set<(status: ImageReadiness) => void>();
  private notifications = new Map<string, ImageReadiness>();
  private notificationTimer: ReturnType<typeof setTimeout> | undefined;
  private slidePlans = new Map<string, Promise<PreparedSlideImages>>();
  private queue: Array<{
    documentId: string;
    slideIds: string[];
    bytes: number;
    presentation: boolean;
    live: () => boolean;
    run: () => Promise<void>;
  }> = [];
  constructor(private readonly dependencies: Dependencies) {}
  prioritize(documentId: string, slideId: string) {
    this.priorities.set(documentId, slideId);
    this.pump();
  }
  status(documentId: string) {
    const status = this.documents.get(documentId)?.cache.status;
    return status ? structuredClone(status) : null;
  }
  subscribe(listener: (status: ImageReadiness) => void) {
    this.listeners.add(listener);
    for (const interest of this.documents.values())
      listener(structuredClone(interest.cache.status));
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(interest: Interest) {
    if (!this.listeners.size) return;
    this.notifications.set(
      interest.cache.status.documentId,
      structuredClone(interest.cache.status),
    );
    this.notificationTimer ??= setTimeout(() => {
      this.notificationTimer = undefined;
      const snapshots = Array.from(this.notifications.values());
      this.notifications.clear();
      for (const snapshot of snapshots)
        for (const listener of this.listeners) listener(snapshot);
    }, 250);
  }
  suspend() {
    this.paused = true;
    this.queue = [];
    for (const id of this.documents.keys())
      this.requests.set(id, ++this.serial);
    for (const [id, interest] of this.documents) {
      interest.cache.finish();
      interest.presentation.finish();
      const replacement = {
        ...interest,
        images: new Map<string, PreparedImage>(),
        presentation: readinessPlan({ ...interest.presentation.status, state: "checking" }),
        cache: readinessPlan({
          ...interest.cache.status,
          generation: ++this.serial,
          state: "checking" as const,
        }),
      };
      this.documents.set(id, replacement);
      this.publish(replacement);
    }
  }
  resume() {
    this.paused = false;
    this.invalidate();
  }
  image(documentId: string, slideId: string, elementId: string) {
    return (
      this.documents.get(documentId)?.images.get(`${slideId}:${elementId}`) ??
      null
    );
  }
  images(documentId: string) {
    return Array.from(this.documents.get(documentId)?.images.values() ?? []);
  }
  close(documentId: string) {
    this.documents.get(documentId)?.cache.finish();
    this.documents.get(documentId)?.presentation.finish();
    this.notifications.delete(documentId);
    this.requests.set(documentId, ++this.serial);
    this.documents.delete(documentId);
    this.priorities.delete(documentId);
    for (const key of this.slidePlans.keys()) if (key.startsWith(documentId + ":")) this.slidePlans.delete(key);
    this.pump();
  }
  advanceRevision(documentId: string, revision: number) {
    const interest = this.documents.get(documentId);
    if (interest) interest.cache.status.revision = revision;
    if (interest) interest.presentation.status.revision = revision;
  }
  invalidate(documentIds?: readonly string[]) {
    this.slidePlans.clear();
    for (const id of documentIds ?? this.documents.keys())
      void this.reconcile(id, true);
  }

  /** Wait for the current accepted plan, including a replan while work is running. */
  async ready(documentId: string, allowFailures = false) {
    return this.waitForPlan(documentId, false, allowFailures);
  }

  /** Hidden slides/layers precache independently and cannot gate audience startup. */
  async presentationReady(documentId: string, allowFailures = false) {
    return this.waitForPlan(documentId, true, allowFailures);
  }

  private async waitForPlan(documentId: string, presentation: boolean, allowFailures: boolean) {
    for (;;) {
      const interest = this.documents.get(documentId);
      if (this.paused || !interest) throw new Error("Image preparation is unavailable");
      const plan = presentation ? interest.presentation : interest.cache;
      await plan.done;
      if (this.documents.get(documentId) !== interest) continue;
      if (plan.status.state === "failed") {
        // Derived cache failures are diagnostic outcomes. Audience geometry and
        // healthy slides must remain usable; absent variants use original IO.
        if (allowFailures) return structuredClone(plan.status);
        throw new Error(plan.status.failures.map(f => f.message).join("; "));
      }
      if (plan.status.state !== "ready") throw new Error("Image preparation was interrupted");
      return structuredClone(plan.status);
    }
  }

  /** One accepted slide/profile plan per bulk consumer, shared by all its images. */
  async prepareSlide(documentId: string, slideId: string, profile: ImageOutputProfile, priority = 0): Promise<PreparedSlideImages> {
    const projection = await this.dependencies.projection(documentId, slideId);
    const slide = resolveVisualSlide(projection.deck, projection.slide, projection.templates ?? {}).slide;
    const requirements = planPresentationImages(projection.deck, [slide], profile, true);
    const interest = this.documents.get(documentId);
    if (interest && interest.slideIds.includes(slideId) &&
        interest.cache.status.epoch === projection.epoch && interest.cache.status.revision === projection.revision &&
        interest.cache.status.profile.width === profile.width && interest.cache.status.profile.height === profile.height) {
      // A visible editor slide must not wait for unrelated slides in the deck.
      if (interest.cache.status.state === "ready" || interest.cache.status.state === "failed" ||
          requirements.every(r => r.instances.filter(i => i.slideId === slideId)
            .every(i => interest.images.has(`${slideId}:${i.elementId}`)))) {
        return Object.fromEntries(requirements.flatMap(r => r.instances
          .filter(i => i.slideId === slideId).map(i => [i.elementId, interest.images.get(`${slideId}:${i.elementId}`) ?? null])));
      }
    }
    const key = `${documentId}:${projection.epoch}:${projection.revision}:${slideId}:${profile.width}x${profile.height}`;
    let pending = this.slidePlans.get(key);
    if (!pending) {
      pending = Promise.all(requirements.map(async requirement => {
        const image = await this.dependencies.prepare(documentId, requirement, priority).catch(() => null);
        return requirement.instances.map(instance => [instance.elementId, image] as const);
      })).then(rows => Object.fromEntries(rows.flat()));
      this.slidePlans.set(key, pending);
      void pending.catch(() => { if (this.slidePlans.get(key) === pending) this.slidePlans.delete(key); });
      while (this.slidePlans.size > 128) this.slidePlans.delete(this.slidePlans.keys().next().value!);
    }
    return pending;
  }

  async reconcile(
    documentId: string,
    retry = false,
    affectedSlides?: readonly string[] | null,
  ) {
    if (this.paused) return;
    const request = ++this.serial;
    this.requests.set(documentId, request);
    const projection = await this.dependencies.projection(documentId);
    if (this.paused || this.requests.get(documentId) !== request) return;
    const profile = this.dependencies.profile();
    const visible = getPresentationSlideIds(projection.deck);
    const visibleIds = new Set(visible);
    // Queue every slide on open, independent of rail visibility or presentation
    // exclusion. Keep the visible sequence first so audience priorities stay intact.
    const demand = [...visible, ...projection.deck.slideIds.filter(id => !visibleIds.has(id))];
    const previous = this.documents.get(documentId);
    if (
      !retry &&
      previous &&
      previous.cache.status.epoch === projection.epoch &&
      previous.cache.status.revision === projection.revision &&
      JSON.stringify(previous.slideIds) === JSON.stringify(demand) &&
      JSON.stringify(previous.cache.status.profile) === JSON.stringify(profile)
    )
      return;
    const generation = ++this.serial;
    previous?.cache.finish();
    previous?.presentation.finish();
    const status: ImageReadiness = {
        documentId,
        epoch: projection.epoch,
        revision: projection.revision,
        profile,
        generation,
        state: "checking",
        total: 0,
        completed: 0,
        originals: 0,
        missing: 0,
        failures: [],
    };
    const interest: Interest = {
      cache: readinessPlan(status),
      presentation: readinessPlan(structuredClone(status)),
      presentationRequirements: new Map(),
      images: new Map(),
      requirements: new Map(),
      signature: "",
      slideIds: demand,
    };
    this.documents.set(documentId, interest);
    const live = () => this.documents.get(documentId) === interest;
    try {
      const reusable =
        !retry &&
        previous &&
        previous.cache.status.epoch === projection.epoch &&
        JSON.stringify(previous.cache.status.profile) === JSON.stringify(profile);
      const planIds =
        reusable &&
        (affectedSlides || previous.cache.status.revision === projection.revision)
          ? interest.slideIds.filter(
              (id) =>
                affectedSlides?.includes(id) || !previous.requirements.has(id),
            )
          : interest.slideIds;
      if (reusable)
        for (const id of interest.slideIds) {
          const requirements = previous.requirements.get(id);
          if (requirements) interest.requirements.set(id, requirements);
          const presentationRequirements = previous.presentationRequirements.get(id);
          if (presentationRequirements) interest.presentationRequirements.set(id, presentationRequirements);
        }
      const slides = this.dependencies.slides
        ? [...(await this.dependencies.slides(documentId, planIds))]
        : [];
      for (const id of this.dependencies.slides ? [] : planIds) {
        if (!live()) return;
        slides.push(
          resolveVisualSlide(
            projection.deck,
            (await this.dependencies.projection(documentId, id)).slide,
            projection.templates ?? {},
          ).slide,
        );
      }
      if (!live()) return;
      const latest = await this.dependencies.projection(documentId);
      if (!live()) return;
      if (
        latest.revision !== projection.revision ||
        latest.epoch !== projection.epoch
      ) {
        await this.reconcile(documentId, true);
        return;
      }
      for (const slide of slides) {
        interest.requirements.set(
          slide.id,
          planPresentationImages(projection.deck, [slide], profile, true, true),
        );
        interest.presentationRequirements.set(slide.id,
          visibleIds.has(slide.id) ? planPresentationImages(projection.deck, [slide], profile) : []);
      }
      const presentationKeys = new Set([...interest.presentationRequirements.values()].flat().map(requirementKey));
      const unique = new Map<string, ImageRequirement>();
      for (const requirement of [...interest.requirements.values()].flat()) {
        const key = `${requirement.assetId}:${requirement.width}x${requirement.height}`;
        const prior = unique.get(key);
        if (prior) {
          prior.instances.push(...requirement.instances);
          prior.slideIds = [...new Set([...prior.slideIds, ...requirement.slideIds])];
        } else unique.set(key, { ...requirement, instances: [...requirement.instances], slideIds: [...requirement.slideIds] });
      }
      const requirements = [...unique.values()];
      const signature = JSON.stringify([requirements, [...presentationKeys]]);
      if (
        !retry &&
        previous?.signature === signature &&
        previous.cache.status.state === "ready"
      ) {
        interest.images = previous.images;
        interest.signature = signature;
        interest.cache.status = {
          ...interest.cache.status,
          state: "ready",
          total: previous.cache.status.total,
          completed: previous.cache.status.completed,
          originals: previous.cache.status.originals,
        };
        interest.cache.status.generation = previous.cache.status.generation;
        interest.presentation.status = { ...previous.presentation.status,
          epoch: projection.epoch, revision: projection.revision };
        interest.presentation.finish();
        interest.cache.finish();
        this.publish(interest);
        return;
      }
      interest.signature = signature;
      interest.cache.status.total = requirements.length;
      interest.cache.status.state = requirements.length ? "preparing" : "ready";
      interest.presentation.status.total = presentationKeys.size;
      interest.presentation.status.state = presentationKeys.size ? "preparing" : "ready";
      settlePlan(interest.presentation);
      this.publish(interest);
      for (const requirement of requirements) {
        const cached =
          !retry &&
          previous &&
          Array.from(previous.images.values()).find(
            (image) =>
              image.assetId === requirement.assetId &&
              image.width === Math.min(image.sourceWidth, requirement.width) &&
              image.height === Math.min(image.sourceHeight, requirement.height),
          );
        if (cached) {
          requirement.instances.forEach((instance) =>
            interest.images.set(
              `${instance.slideId}:${instance.elementId}`,
              cached,
            ),
          );
          interest.cache.status.completed++;
          if (presentationKeys.has(requirementKey(requirement))) interest.presentation.status.completed++;
          continue;
        }
        this.queue.push({
          documentId,
          slideIds: requirement.slideIds,
          bytes: requirement.estimatedBytes,
          presentation: presentationKeys.has(requirementKey(requirement)),
          live,
          run: async () => {
            try {
              const selected = this.priorities.get(documentId) ?? interest.slideIds[0];
              const next = interest.slideIds[interest.slideIds.indexOf(selected) + 1];
              const priority = requirement.slideIds.includes(selected) ? 3 : requirement.slideIds.includes(next) ? 2 : 0;
              const image = await this.dependencies.prepare(
                documentId,
                requirement,
                priority,
              );
              if (!live()) return;
              if (image) {
                for (const instance of requirement.instances)
                  interest.images.set(
                    `${instance.slideId}:${instance.elementId}`,
                    image,
                  );
              }
              interest.cache.status.completed++;
              if (!image) interest.cache.status.originals = (interest.cache.status.originals ?? 0) + 1;
              if (presentationKeys.has(requirementKey(requirement))) {
                interest.presentation.status.completed++;
                if (!image) interest.presentation.status.originals = (interest.presentation.status.originals ?? 0) + 1;
              }
            } catch (error) {
              if (!live()) return;
              const message = error instanceof Error ? error.message : String(error);
              if (message.startsWith("Asset not found:") || message === "Image asset is missing") interest.cache.status.missing = (interest.cache.status.missing ?? 0) + 1;
              interest.cache.status.failures.push({
                assetId: requirement.assetId,
                slideIds: requirement.slideIds,
                message,
              });
              if (presentationKeys.has(requirementKey(requirement))) {
                interest.presentation.status.failures.push({ assetId: requirement.assetId, slideIds: requirement.slideIds, message });
              }
            } finally {
              if (live()) {
                settlePlan(interest.cache);
                settlePlan(interest.presentation);
              }
              if (live()) this.publish(interest);
            }
          },
        });
      }
      if (interest.cache.status.completed === interest.cache.status.total)
        interest.cache.status.state = "ready";
      if (interest.cache.status.state === "ready") interest.cache.finish();
      settlePlan(interest.presentation);
      this.publish(interest);
      this.pump();
    } catch (error) {
      if (live()) {
        interest.cache.status.state = "failed";
        interest.cache.finish();
        interest.cache.status.failures.push({
          assetId: "",
          slideIds: [],
          message: String(error),
        });
        interest.presentation.status.state = "failed";
        interest.presentation.status.failures = [...interest.cache.status.failures];
        interest.presentation.finish();
        this.publish(interest);
      }
    }
  }

  private pump() {
    this.queue = this.queue.filter((job) => job.live());
    const rank = (job: (typeof this.queue)[number]) => {
      const ids = this.documents.get(job.documentId)?.slideIds ?? [];
      const selected = this.priorities.get(job.documentId) ?? ids[0];
      const index = ids.indexOf(selected);
      return job.slideIds.includes(selected)
        ? 0
        : !job.presentation
          ? 3
        : job.slideIds.some(
              (id) => id === ids[index - 1] || id === ids[index + 1],
            )
          ? 1
          : 2;
    };
    this.queue.sort((a, b) => rank(a) - rank(b));
    while (!this.paused && this.running < (this.dependencies.concurrency ?? 2) && this.queue.length) {
      const presentationWaiting = this.queue.some(job => job.presentation);
      const index = this.queue.findIndex(
        (job) =>
          (!presentationWaiting || job.presentation) &&
          (this.running === 0 ||
          this.runningBytes + job.bytes <= 512 * 1024 * 1024),
      );
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      this.running++;
      this.runningBytes += job.bytes;
      void job.run().finally(() => {
        this.running--;
        this.runningBytes -= job.bytes;
        this.pump();
      });
    }
  }
}
