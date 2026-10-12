import { resolveVisualSlide } from "../core/templates";
import type { Deck, Slide, TemplatePage } from "../core/document";
import { getPresentationSlideIds } from "../core/presentationSequence";
import { platform } from "../platform";
import { flattenElements } from "../core/scene";
import { isMediaContent } from "../core/media";

export interface CachedSlide {
  value: Slide;
  deck: Deck;
  revision: number;
}

/** One bounded presentation cache per open document in each renderer process. */
export class SlideCache {
  private entries = new Map<string, CachedSlide>();
  private templates: Record<string, TemplatePage> = {};
  private templateRevision = -1;
  private pending = new Map<string, Promise<CachedSlide>>();
  private protectedIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private warmed = new Set<string>();

  constructor(
    readonly deckId: string,
    readonly capacity = 12,
  ) {}

  get(id: string): CachedSlide | undefined {
    const record = this.entries.get(id);
    if (record) {
      this.entries.delete(id);
      this.entries.set(id, record);
    }
    return record;
  }

  async load(id: string): Promise<CachedSlide> {
    const cached = this.get(id);
    if (cached) return cached;
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;
    const projection = platform.documentProjection;
    if (!projection) throw new Error("Presentation projection is unavailable");
    const generation = this.generation;
    const request = projection(this.deckId, id)
      .then((value) => {
        if (this.templateRevision !== value.revision) {
          this.templates = value.templates ?? {};
          this.templateRevision = value.revision;
        }
        const record: CachedSlide = {
          value: resolveVisualSlide(
            value.deck,
            value.slide,
            this.templates,
          ).slide,
          deck: value.deck,
          revision: value.revision,
        };
        if (generation !== this.generation) return record;
        if (!this.entries.has(id)) this.put(id, record);
        return this.get(id) ?? record;
      })
      .finally(() => {
        if (this.pending.get(id) === request) this.pending.delete(id);
      });
    this.pending.set(id, request);
    return request;
  }

  put(id: string, record: CachedSlide) {
    this.entries.delete(id);
    this.entries.set(id, record);
    this.evict();
  }

  invalidate(id: string) {
    this.entries.delete(id);
  }

  clear() {
    clearTimeout(this.timer);
    ++this.generation;
    this.entries.clear();
    this.templates = {};
    this.templateRevision = -1;
    this.pending.clear();
    this.warmed.clear();
  }

  protect(ids: Iterable<string>) {
    this.protectedIds = new Set(ids);
    this.evict();
  }

  private evict() {
    while (this.entries.size > this.capacity) {
      const victim = [...this.entries.keys()].find(
        (id) => !this.protectedIds.has(id),
      );
      if (!victim) break;
      this.entries.delete(victim);
    }
  }

  /** Delay IO until the current interaction has had a chance to paint. */
  prefetch(deck: Deck, currentId: string, presentation = false) {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const sequence = presentation
      ? getPresentationSlideIds(deck)
      : deck.slideIds;
    const index = sequence.indexOf(currentId);
    const ids = [index + 1, index + 2, index - 1]
      .map((position) => sequence[position])
      .filter((id): id is string => !!id);
    const nextId = sequence[index + 1];
    this.protect([currentId, ...ids]);
    this.timer = setTimeout(() => {
      const work = async () => {
        for (const id of ids) {
          if (generation !== this.generation) return;
          try {
            const record = await this.load(id);
            if (id === nextId) void this.warmPreviews(record.value, presentation);
          } catch {
            /* Foreground navigation reports failures. */
          }
        }
      };
      if (typeof window !== "undefined" && "requestIdleCallback" in window)
        window.requestIdleCallback(() => void work(), { timeout: 800 });
      else void work();
    }, 80);
  }

  async warmPreviews(slide: Slide, presentation = false) {
    const media = new Map<string, string>();
    let videoPrepares = 0;
    for (const element of flattenElements(slide)) {
      const content = element.content;
      if (isMediaContent(content))
        media.set(content.assetId, content.type);
    }
    for (const [id, type] of media) {
      // Presentation images are decoded by their mounted prepared-image views.
      // Thumbnail fallback resolves the full original and starts redundant JPEG
      // decode/raster work alongside the first entrance.
      if (presentation && type === "image") continue;
      if (this.warmed.has(id)) continue;
      this.warmed.add(id);
      if (this.warmed.size > 48)
        this.warmed.delete(this.warmed.values().next().value!);
      try {
        const url = await platform.assetUrl(id, true);
        if (url) {
          const preview = new Image();
          preview.src = url;
          await preview.decode().catch(() => {});
          preview.src = "";
          platform.releaseUrl(url);
        } else if (type === "video" && !presentation) {
          if (videoPrepares++ >= 2) continue;
          const source = await platform.assetUrl(id);
          if (!source) continue;
          const video = document.createElement("video");
          video.preload = "metadata";
          video.muted = true;
          try {
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              const timer = setTimeout(done, 1500);
              video.onloadedmetadata = video.onerror = () => {
                clearTimeout(timer);
                done();
              };
              video.src = source;
            });
          } finally {
            video.removeAttribute("src");
            video.load();
            platform.releaseUrl(source);
          }
        }
      } catch {
        /* A missing preview must not delay navigation. */
      }
    }
  }

  dispose() {
    this.clear();
  }
}

const caches = new Map<string, SlideCache>();
export function slideCacheFor(deckId: string): SlideCache {
  let cache = caches.get(deckId);
  if (!cache) cache = new SlideCache(deckId);
  caches.delete(deckId);
  caches.set(deckId, cache);
  if (caches.size > 3) {
    const oldest = caches.keys().next().value;
    if (oldest) {
      caches.get(oldest)?.dispose();
      caches.delete(oldest);
    }
  }
  return cache;
}
