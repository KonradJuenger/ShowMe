import { resolveVisualSlide } from "./templates";
import { getPresentationSlideIds } from "./presentationSequence";
import type { DocumentProjection } from "./documentProjection";
import {
  planPresentationImages,
  type ImageOutputProfile,
  type ImageReadiness,
  type ImageRequirement,
  type PreparedImage,
  type ImageRequestProfile,
  type PreparedSlideImages,
} from "./presentationImages";

interface Dependencies {
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
    canvas?: string,
  ): Promise<PreparedImage | null>;
  profile(): ImageOutputProfile;
}
interface Interest {
  status: ImageReadiness;
  images: Map<string, PreparedImage>;
  signature: string;
  slideIds: string[];
  requirements: Map<string, ImageRequirement[]>;
  done: Promise<void>;
  finish: () => void;
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
    live: () => boolean;
    run: () => Promise<void>;
  }> = [];
  constructor(private readonly dependencies: Dependencies) {}
  prioritize(documentId: string, slideId: string) {
    this.priorities.set(documentId, slideId);
    this.pump();
  }
  status(documentId: string) {
    const status = this.documents.get(documentId)?.status;
    return status ? structuredClone(status) : null;
  }
  subscribe(listener: (status: ImageReadiness) => void) {
    this.listeners.add(listener);
    for (const interest of this.documents.values())
      listener(structuredClone(interest.status));
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(interest: Interest) {
    if (!this.listeners.size) return;
    this.notifications.set(
      interest.status.documentId,
      structuredClone(interest.status),
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
      interest.finish();
      const replacement = {
        ...interest,
        images: new Map<string, PreparedImage>(),
        status: {
          ...interest.status,
          generation: ++this.serial,
          state: "checking" as const,
        },
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
    this.documents.get(documentId)?.finish();
    this.notifications.delete(documentId);
    this.requests.set(documentId, ++this.serial);
    this.documents.delete(documentId);
    this.priorities.delete(documentId);
    for (const key of this.slidePlans.keys()) if (key.startsWith(documentId + ":")) this.slidePlans.delete(key);
    this.pump();
  }
  advanceRevision(documentId: string, revision: number) {
    const interest = this.documents.get(documentId);
    if (interest) interest.status.revision = revision;
  }
  invalidate(documentIds?: readonly string[]) {
    this.slidePlans.clear();
    for (const id of documentIds ?? this.documents.keys())
      void this.reconcile(id, true);
  }

  /** Wait for the current accepted plan, including a replan while work is running. */
  async ready(documentId: string, allowFailures = false) {
    for (;;) {
      const interest = this.documents.get(documentId);
      if (this.paused || !interest) throw new Error("Image preparation is unavailable");
      await interest.done;
      if (this.documents.get(documentId) !== interest) continue;
      if (interest.status.state === "failed") {
        // Derived cache failures are diagnostic outcomes. Audience geometry and
        // healthy slides must remain usable; absent variants use original IO.
        if (allowFailures) return this.status(documentId)!;
        throw new Error(interest.status.failures.map(f => f.message).join("; "));
      }
      if (interest.status.state !== "ready") throw new Error("Image preparation was interrupted");
      return this.status(documentId)!;
    }
  }

  /** One accepted slide/profile plan per bulk consumer, shared by all its images. */
  async prepareSlide(documentId: string, slideId: string, profile: ImageRequestProfile, priority = 0): Promise<PreparedSlideImages> {
    const projection = await this.dependencies.projection(documentId, slideId);
    const interest = this.documents.get(documentId);
    if (!profile.sampling && interest && interest.slideIds.includes(slideId) &&
        interest.status.epoch === projection.epoch && interest.status.revision === projection.revision &&
        interest.status.profile.width === profile.width && interest.status.profile.height === profile.height) {
      await this.ready(documentId, true);
      if (this.documents.get(documentId) !== interest) return this.prepareSlide(documentId, slideId, profile, priority);
      return Object.fromEntries((interest.requirements.get(slideId) ?? []).flatMap(r => r.instances
        .filter(i => i.slideId === slideId).map(i => [i.elementId, interest.images.get(`${slideId}:${i.elementId}`) ?? null])));
    }
    const key = `${documentId}:${projection.epoch}:${projection.revision}:${slideId}:${profile.width}x${profile.height}:${profile.sampling ?? "exact"}`;
    let pending = this.slidePlans.get(key);
    if (!pending) {
      const slide = resolveVisualSlide(projection.deck, projection.slide, projection.templates ?? {}).slide;
      pending = Promise.all(planPresentationImages(projection.deck, [slide], profile, true).map(async requirement => {
        const image = await this.dependencies.prepare(documentId, requirement, priority, profile.sampling === "canvas" ? `${documentId}:${slideId}` : undefined).catch(() => null);
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
    const demand = getPresentationSlideIds(projection.deck);
    const previous = this.documents.get(documentId);
    if (
      !retry &&
      previous &&
      previous.status.epoch === projection.epoch &&
      previous.status.revision === projection.revision &&
      JSON.stringify(previous.slideIds) === JSON.stringify(demand) &&
      JSON.stringify(previous.status.profile) === JSON.stringify(profile)
    )
      return;
    const generation = ++this.serial;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    previous?.finish();
    const interest: Interest = {
      done, finish,
      images: new Map(),
      requirements: new Map(),
      signature: "",
      slideIds: demand,
      status: {
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
      },
    };
    this.documents.set(documentId, interest);
    const live = () => this.documents.get(documentId) === interest;
    try {
      const reusable =
        !retry &&
        previous &&
        previous.status.epoch === projection.epoch &&
        JSON.stringify(previous.status.profile) === JSON.stringify(profile);
      const planIds =
        reusable &&
        (affectedSlides || previous.status.revision === projection.revision)
          ? interest.slideIds.filter(
              (id) =>
                affectedSlides?.includes(id) || !previous.requirements.has(id),
            )
          : interest.slideIds;
      if (reusable)
        for (const id of interest.slideIds) {
          const requirements = previous.requirements.get(id);
          if (requirements) interest.requirements.set(id, requirements);
        }
      const slides = this.dependencies.slides
        ? [...(await this.dependencies.slides(documentId, planIds))]
        : [];
      for (const id of this.dependencies.slides ? [] : planIds) {
        if (!live()) return;
        if (!projection.deck.slideMeta[id].hidden)
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
      for (const slide of slides)
        interest.requirements.set(
          slide.id,
          planPresentationImages(projection.deck, [slide], profile),
        );
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
      const signature = JSON.stringify(requirements);
      if (
        !retry &&
        previous?.signature === signature &&
        previous.status.state === "ready"
      ) {
        interest.images = previous.images;
        interest.signature = signature;
        interest.status = {
          ...interest.status,
          state: "ready",
          total: previous.status.total,
          completed: previous.status.completed,
          originals: previous.status.originals,
        };
        interest.status.generation = previous.status.generation;
        interest.finish();
        this.publish(interest);
        return;
      }
      interest.signature = signature;
      interest.status.total = requirements.length;
      interest.status.state = requirements.length ? "preparing" : "ready";
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
          interest.status.completed++;
          continue;
        }
        this.queue.push({
          documentId,
          slideIds: requirement.slideIds,
          bytes: requirement.estimatedBytes,
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
              interest.status.completed++;
              if (!image) interest.status.originals = (interest.status.originals ?? 0) + 1;
            } catch (error) {
              if (!live()) return;
              const message = error instanceof Error ? error.message : String(error);
              if (message.startsWith("Asset not found:") || message === "Image asset is missing") interest.status.missing = (interest.status.missing ?? 0) + 1;
              interest.status.failures.push({
                assetId: requirement.assetId,
                slideIds: requirement.slideIds,
                message,
              });
            } finally {
              if (
                live() &&
                interest.status.completed + interest.status.failures.length ===
                  interest.status.total
              )
                interest.status.state = interest.status.failures.length
                  ? "failed"
                  : "ready";
              if (live() && ["ready", "failed"].includes(interest.status.state)) interest.finish();
              if (live()) this.publish(interest);
            }
          },
        });
      }
      if (interest.status.completed === interest.status.total)
        interest.status.state = "ready";
      if (interest.status.state === "ready") interest.finish();
      this.publish(interest);
      this.pump();
    } catch (error) {
      if (live()) {
        interest.status.state = "failed";
        interest.finish();
        interest.status.failures.push({
          assetId: "",
          slideIds: [],
          message: String(error),
        });
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
        : job.slideIds.some(
              (id) => id === ids[index - 1] || id === ids[index + 1],
            )
          ? 1
          : 2;
    };
    this.queue.sort((a, b) => rank(a) - rank(b));
    while (!this.paused && this.running < 2 && this.queue.length) {
      const index = this.queue.findIndex(
        (job) =>
          this.running === 0 ||
          this.runningBytes + job.bytes <= 512 * 1024 * 1024,
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
