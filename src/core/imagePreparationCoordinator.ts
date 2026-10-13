import { resolveVisualSlide } from "./templates";
import type { DocumentProjection } from "./documentProjection";
import {
  planPresentationImages,
  type ImageOutputProfile,
  type ImageReadiness,
  type ImageRequirement,
  type PreparedImage,
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
  ): Promise<PreparedImage | null>;
  profile(): ImageOutputProfile;
}
interface Interest {
  status: ImageReadiness;
  images: Map<string, PreparedImage>;
  signature: string;
  slideIds: string[];
  requirements: Map<string, ImageRequirement[]>;
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
  private queue: Array<{
    documentId: string;
    slideIds: string[];
    bytes: number;
    live: () => boolean;
    run: () => Promise<void>;
  }> = [];
  constructor(private readonly dependencies: Dependencies) {}
  prioritize(documentId: string, slideId: string) {
    const changed = this.priorities.get(documentId) !== slideId;
    this.priorities.set(documentId, slideId);
    if (changed && this.documents.has(documentId))
      void this.reconcile(documentId);
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
    this.notifications.delete(documentId);
    this.requests.set(documentId, ++this.serial);
    this.documents.delete(documentId);
    this.priorities.delete(documentId);
    this.pump();
  }
  advanceRevision(documentId: string, revision: number) {
    const interest = this.documents.get(documentId);
    if (interest) interest.status.revision = revision;
  }
  invalidate(documentIds?: readonly string[]) {
    for (const id of documentIds ?? this.documents.keys())
      void this.reconcile(id, true);
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
    const ids = projection.deck.slideIds.filter(
      (id) => !projection.deck.slideMeta[id].hidden,
    );
    const selectedIndex = Math.max(
      0,
      ids.indexOf(this.priorities.get(documentId) ?? ids[0]),
    );
    const demand = ids.slice(Math.max(0, selectedIndex - 1), selectedIndex + 2);
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
    const interest: Interest = {
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
      const requirements = [...interest.requirements.values()].flat();
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
        };
        interest.status.generation = previous.status.generation;
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
              const image = await this.dependencies.prepare(
                documentId,
                requirement,
              );
              if (!live()) return;
              if (image) {
                for (const instance of requirement.instances)
                  interest.images.set(
                    `${instance.slideId}:${instance.elementId}`,
                    image,
                  );
              }
              if (image) interest.status.completed++;
              else interest.status.total--;
            } catch (error) {
              if (!live()) return;
              interest.status.failures.push({
                assetId: requirement.assetId,
                slideIds: requirement.slideIds,
                message: error instanceof Error ? error.message : String(error),
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
              if (live()) this.publish(interest);
            }
          },
        });
      }
      if (interest.status.completed === interest.status.total)
        interest.status.state = "ready";
      this.publish(interest);
      this.pump();
    } catch (error) {
      if (live()) {
        interest.status.state = "failed";
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
