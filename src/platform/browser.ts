import { ASSET_VERSION } from "../core/assets";
import { acceptedImpact } from "../core/documentImpact";
import { editEffectLibrary, type EffectLibrary } from "../core/libraryEffects";
import { resolveSlide } from "../core/templates";
import { ImageWorkQueue } from "../core/imageWorkQueue";
import {
  imageDimensions,
  audienceImageProfile as outputImageProfile,
  type ImageRequirement,
  type ImageOutputProfile,
  type ImageRequestProfile,
  type PreparedImage,
  type PreparedSlideImages,
} from "../core/presentationImages";
import { ImagePreparationCoordinator } from "../core/imagePreparationCoordinator";
import {
  BROWSER_IMAGE_PREFIX,
  validBrowserImage,
  browserImageKey,
  browserImageDescriptor,
  createBrowserImage,
  type BrowserImageRecord,
} from "./browserImageCache";
import { stageDuration } from "../core/motionModel";
import {
  applyPresentationCommand,
  startSession,
  reconcileSession,
} from "../core/presentationSession";
import {
  assetCategoryCounts,
  assetSchema,
  compareAssetsByCategoryAndName,
  mediaType,
  type Asset,
} from "../core/assets";
import {
  SLIDE_TRANSFER_FILE_EXTENSION,
  parseSlideTransferBundle,
} from "../core/slideTransfer";
import type { Platform, PresenterState } from "./api";
import {
  presentationMotionStages,
  DocumentRuntime,
  parseRuntimeDocument,
} from "../core/documentRuntime";
import {
  newPresentationDocument,
  type PresentationDocument,
} from "../core/document";

interface BrowserDocumentRecord {
  document: PresentationDocument;
  epoch?: string;
  revision: number;
  savedRevision: number;
}

const BROWSER_STORAGE_VERSION = 1 as const;

const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("show-me", BROWSER_STORAGE_VERSION);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("files");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function get<T>(key: string): Promise<T | undefined> {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction("files").objectStore("files").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(key: string, value: unknown) {
  const db = await dbPromise;
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("files", "readwrite");
    transaction.objectStore("files").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function entries<T>(prefix: string): Promise<T[]> {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const output: T[] = [];
    const request = db
      .transaction("files")
      .objectStore("files")
      .openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        output.push(cursor.value);
        cursor.continue();
      } else resolve(output);
    };
    request.onerror = () => reject(request.error);
  });
}

function documentSummary(document: PresentationDocument, dirty = false) {
  return {
    id: document.documentId,
    name: document.deck.name,
    location: "browser:" + document.documentId,
    dirty,
    untitled: false,
  };
}

async function documentRecord(id: string) {
  const record = await get<BrowserDocumentRecord>("document/" + id);
  if (!record) throw new Error("Presentation is missing");
  return {
    ...record,
    document: parseRuntimeDocument(record.document),
  };
}

async function mutateDocument<T>(
  id: string,
  mutate: (record: BrowserDocumentRecord) => T,
  expected?: Pick<BrowserDocumentRecord, "epoch" | "revision">,
) {
  const db = await dbPromise;
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("files", "readwrite");
    const store = transaction.objectStore("files");
    const request = store.get("document/" + id);
    let result: T;
    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        reject(new Error("Presentation is missing"));
        return;
      }
      try {
        const record = request.result as BrowserDocumentRecord;
        if (
          expected &&
          (record.epoch !== expected.epoch ||
            record.revision !== expected.revision)
        )
          throw new Error(
            "Presentation changed in another context. Reopen it before editing.",
          );
        result = mutate(record);
        store.put(record, "document/" + id);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    transaction.oncomplete = () => resolve(result!);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Presentation write aborted"));
  });
}

async function importBrowserFiles(files: File[]) {
  const output: Asset[] = [];
  for (const file of files) {
    const type = mediaType(file.name);
    const bytes = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const old = await get<Asset>("asset/" + id);
    const asset: Asset = old
      ? { ...old, names: [...new Set([...old.names, file.name])] }
      : {
          version: ASSET_VERSION,
          id,
          filename: file.name.replace(/(\.[^.]*)$/, `__${id}$1`),
          mediaType: type.type === "video" ? "video" : "image",
          ...type,
          names: [file.name],
          bytes: file.size,
          createdAt: new Date().toISOString(),
        };
    if (!old) await put("blob/" + id, new Blob([bytes], { type: type.mime }));
    await put("asset/" + id, asset);
    output.push(asset);
  }
  return output;
}

let popup: Window | null = null;
let consolePopup: Window | null = null;
const imageInvalidationListeners = new Set<
  (status: import("../core/presentationImages").ImageReadiness | null) => void
>();
function notifyBrowserImageCacheChanged() {
  for (const listener of imageInvalidationListeners) listener(null);
}
let imageCachingEnabled =
  localStorage.getItem("showme-image-caching") !== "false";
const presentationRole = new URLSearchParams(location.search).get("present");
let presentation: PresenterState | null = null;
let browserAudienceProfile: ImageOutputProfile | null = null;
const channel = new BroadcastChannel("show-me-presenter");
const listeners = new Set<(state: PresenterState | null) => void>();
channel.onmessage = (event) => {
  if (event.data?.type === "image-readiness" && presentationRole) {
    for (const listener of imageInvalidationListeners) listener(event.data.status);
    return;
  }
  if (event.data?.type === "document-accepted") {
    const { documentId, accepted } = event.data;
    browserRuntimes.delete(documentId);
    for (const listener of acceptedListeners)
      listener({ documentId, accepted });
    return;
  }
  if (event.data?.type === "image-cache-setting") {
    imageCachingEnabled = event.data.enabled;
    if (imageCachingEnabled) browserImages.resume();
    else browserImages.suspend();
    notifyBrowserImageCacheChanged();
    return;
  }
  if (event.data?.type === "image-cache-cleared") {
    browserImageGeneration++;
    validatedBrowserImages.clear();
    browserImages.invalidate();
    notifyBrowserImageCacheChanged();
    return;
  }
  if (event.data?.type === "end") {
    void mutatePresentation(() => null);
    return;
  }
  if (event.data?.type !== "state") return;
  const next = event.data.state as PresenterState | null;
  if (
    presentationRole &&
    next &&
    (next.deckId !== presentation?.deckId ||
      next.contentRevision !== presentation?.contentRevision)
  )
    browserRuntimes.delete(next.deckId);
  presentation = event.data.state ?? null;
  if (!presentation) browserAudienceProfile = null;
  if (!presentationRole && presentation?.index !== null && presentation?.index !== undefined)
    browserImages.prioritize(presentation.deckId, presentation.slideIds[presentation.index]);
  listeners.forEach((listener) => listener(presentation));
  if (!presentation && presentationRole) window.close();
};

async function broadcast(state: PresenterState | null) {
  presentation = state;
  if (!state) browserAudienceProfile = null;
  await put("presentation", state);
  channel.postMessage({ type: "state", state });
  listeners.forEach((listener) => listener(state));
  if (!state) {
    popup?.close();
    consolePopup?.close();
    popup = null;
    consolePopup = null;
    if (presentationRole) window.close();
  }
}

async function currentPresentation() {
  if (presentation) return presentation;
  presentation = (await get<PresenterState | null>("presentation")) ?? null;
  return presentation;
}

async function mutatePresentation(
  change: (
    current: PresenterState | null,
  ) => PresenterState | null | Promise<PresenterState | null>,
) {
  await navigator.locks.request("show-me-presentation", async () => {
    const current = (await get<PresenterState | null>("presentation")) ?? null;
    await broadcast(await change(current));
  });
}
async function refreshPresentation(
  documentId: string,
  impact?: ReturnType<typeof acceptedImpact>,
) {
  if (impact?.presentation === "none") return;
  await mutatePresentation(async (current) => {
    if (!current || current.deckId !== documentId) return current;
    if (impact?.presentation === "content")
      return {
        ...current,
        contentRevision: (current.contentRevision ?? 0) + 1,
      };
    const runtime = await browserRuntime(documentId);
    const deck = runtime.presentationDeck(documentId);
    const motion = presentationMotionStages(
      runtime.authority.document,
      impact?.presentation === "motion"
        ? (impact.slides ?? undefined)
        : undefined,
    );
    const motionSlides =
      impact?.presentation === "motion"
        ? { ...current.motionSlides, ...motion }
        : motion;
    return reconcileSession(
      {
        ...current,
        motionSlides,
        contentRevision: (current.contentRevision ?? 0) + 1,
      },
      deck,
    );
  });
}

const browserRuntimes = new Map<string, Promise<DocumentRuntime>>();
const browserWriteLocks = new Map<string, () => void>();

async function ownBrowserDocument(documentId: string) {
  if (presentationRole) return;
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely own presentation writes. Use a browser with Web Locks support.",
    );
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(
        `showme-document:${documentId}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(
              new Error(
                "This presentation is already being edited in another tab. Close that editor before reopening it here.",
              ),
            );
            return;
          }
          await new Promise<void>((release) => {
            browserWriteLocks.set(documentId, release);
            resolve();
          });
        },
      )
      .catch(reject);
  });
}

function requireBrowserWriter(documentId: string) {
  if (presentationRole || !browserWriteLocks.has(documentId))
    throw new Error(
      "This context does not own write access to the presentation",
    );
}
const acceptedListeners = new Set<
  (event: {
    documentId: string;
    accepted: import("../core/documentTransactions").AcceptedTransaction;
  }) => void
>();

async function browserRuntime(documentId: string) {
  let pending = browserRuntimes.get(documentId);
  if (pending) return pending;
  pending = (async () => {
    await ownBrowserDocument(documentId);
    const record = await documentRecord(documentId);
    if (!presentationRole && !record.epoch) {
      const epoch = crypto.randomUUID();
      await mutateDocument(
        documentId,
        (stored) => {
          stored.epoch = epoch;
        },
        record,
      );
      record.epoch = epoch;
    }
    const runtime = new DocumentRuntime(record.document, {
      actorId: "local",
      epoch: record.epoch,
      revision: record.revision,
      savedRevision: record.savedRevision,
      durableCommit: async (accepted, next) => {
        requireBrowserWriter(documentId);
        await mutateDocument(
          documentId,
          (stored) => {
            stored.document = next;
            stored.epoch = accepted.epoch;
            stored.revision = accepted.revision;
          },
          { epoch: accepted.epoch, revision: accepted.revision - 1 },
        );
      },
    });
    runtime.subscribeAccepted(documentId, (accepted) => {
      const impact = acceptedImpact(accepted, runtime.authority.document);
      if (impact.media) prepareBrowserImages(documentId, impact.slides);
      else browserImages.advanceRevision(documentId, accepted.revision);
      void refreshPresentation(documentId, impact).catch((error) =>
        console.error("Presentation refresh failed", error),
      );
      channel.postMessage({ type: "document-accepted", documentId, accepted });
      for (const listener of acceptedListeners) {
        try {
          listener({ documentId, accepted });
        } catch (error) {
          console.error("Document accepted listener failed", error);
        }
      }
    });
    return runtime;
  })();
  browserRuntimes.set(documentId, pending);
  try {
    return await pending;
  } catch (error) {
    browserRuntimes.delete(documentId);
    browserWriteLocks.get(documentId)?.();
    browserWriteLocks.delete(documentId);
    throw error;
  }
}

function resetBrowserRuntime(documentId: string) {
  browserRuntimes.delete(documentId);
}
// The owning editor observes closed windows. A pagehide also fires on reload,
// which must preserve the presentation and its elapsed timer.
window.setInterval(() => {
  if (
    !presentationRole &&
    presentation &&
    (popup?.closed || consolePopup?.closed)
  )
    void mutatePresentation(() => null);
}, 250);

const browserImageDiagnostics = {
  jobs: 0,
  cacheHits: 0,
  pending: 0,
  rssBytes: null,
};
const browserImageQueue = new ImageWorkQueue();
let browserImageGeneration = 0;
let clearingBrowserImages = false;
const validatedBrowserImages = new Set<string>();
const unsupportedBrowserImages = new Set<string>();
const pendingBrowserImages = new Map<string, Promise<PreparedImage | null>>();
const browserImageDemands = new Map<string, { priority: number; canvas?: string }>();
let activeBrowserCanvas: string | undefined;
function browserDemandPriority(demand: { priority: number; canvas?: string }) {
  return demand.canvas && activeBrowserCanvas && demand.canvas !== activeBrowserCanvas ? 0 : demand.priority;
}
async function prepareBrowserVariant(requirement: ImageRequirement, priority = 0, canvas?: string): Promise<PreparedImage | null> {
  if (clearingBrowserImages || unsupportedBrowserImages.has(requirement.assetId)) return null;
  const generation = browserImageGeneration;
  const blob = await get<Blob>("blob/" + requirement.assetId);
  if (!blob) throw new Error("Image asset is missing");
  const descriptor = await browserImageDescriptor(blob, requirement.assetId, requirement.size, requirement.width, requirement.height);
  if (!descriptor || generation !== browserImageGeneration || clearingBrowserImages) return null;
  const key = `${generation}:${descriptor.hash}`;
  const priorDemand = browserImageDemands.get(key);
  const demand = priorDemand && priorDemand.priority > priority ? priorDemand : { priority, canvas };
  browserImageDemands.set(key, demand);
  const prior = pendingBrowserImages.get(key);
  if (prior) {
    browserImageQueue.setPriorities(new Map([[key, browserDemandPriority(demand)]]));
    return prior;
  }
  const pending = navigator.locks.request("show-me-image-cache", { mode: "shared" }, () =>
    navigator.locks.request("show-me-image:" + descriptor.hash, async () => {
      if (generation !== browserImageGeneration || clearingBrowserImages) return null;
      const cacheKey = browserImageKey(descriptor.hash);
      const cached = await get<Blob>(cacheKey);
      if (cached && (validatedBrowserImages.has(cacheKey) || await validBrowserImage({ blob: cached, descriptor }, requirement.assetId))) {
        validatedBrowserImages.add(cacheKey);
        browserImageDiagnostics.cacheHits++;
        return { ...descriptor, url: cacheKey };
      }
      return browserImageQueue.run(requirement.estimatedBytes, async () => {
        if (generation !== browserImageGeneration || clearingBrowserImages) return null;
        browserImageDiagnostics.jobs++;
        browserImageDiagnostics.pending++;
        let record: BrowserImageRecord | null;
        try { record = await createBrowserImage(blob, requirement.assetId, requirement.size, descriptor.width, descriptor.height); }
        finally { browserImageDiagnostics.pending--; }
        if (!record) { unsupportedBrowserImages.add(requirement.assetId); return null; }
        if (generation !== browserImageGeneration || clearingBrowserImages) return null;
        await put(cacheKey, record.blob);
        validatedBrowserImages.add(cacheKey);
        return { ...record.descriptor, url: cacheKey };
      }, { key, priority: browserDemandPriority(browserImageDemands.get(key) ?? demand) });
    }),
  ).finally(() => { pendingBrowserImages.delete(key); browserImageDemands.delete(key); });
  pendingBrowserImages.set(key, pending);
  return pending;
}
const browserImages = new ImagePreparationCoordinator({
  slides: async (id, slideIds) => {
    const document = (await browserRuntime(id)).authority.document;
    return slideIds.map((slideId) => resolveSlide(document, slideId).slide);
  },
  projection: async (id, slideId) =>
    (await browserRuntime(id)).projection(id, slideId),
  profile: () => (presentation ? browserAudienceProfile : null) ?? outputImageProfile(screen.width, screen.height, devicePixelRatio),
  prepare: (_id, requirement, priority, canvas) => prepareBrowserVariant(requirement, priority, canvas),
});
if (!presentationRole) browserImages.subscribe(status => channel.postMessage({ type: "image-readiness", status }));
if (!imageCachingEnabled) browserImages.suspend();
function prepareBrowserImages(
  id: string,
  affectedSlides?: readonly string[] | null,
) {
  if (!presentationRole)
    void browserImages
      .reconcile(id, false, affectedSlides)
      .catch((error) => console.error("Image preparation failed", error));
}

interface ImageOwnerRequest {
  type: "showme-image-request";
  requestId: string;
  method: "prepare" | "slide" | "profile";
  documentId: string;
  slideId?: string;
  profile?: ImageRequestProfile;
}

/** Image work uses the existing owning editor; popup roles never run competing queues. */
function ownerImageRequest<T>(request: Omit<ImageOwnerRequest, "type" | "requestId">): Promise<T> {
  const owner: Window | null = window.opener;
  if (!owner || owner.closed) return Promise.reject(new Error("Presentation image owner is unavailable"));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== owner || event.data?.type !== "showme-image-response" || event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Presentation image preparation timed out")); }, 120000);
    window.addEventListener("message", receive);
    owner.postMessage({ ...request, type: "showme-image-request", requestId }, location.origin);
  });
}

if (!presentationRole) window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.data?.type !== "showme-image-request" ||
      (event.source !== popup && event.source !== consolePopup) || !event.source) return;
  const requester = event.source as Window;
  const request = event.data as ImageOwnerRequest;
  void (async () => {
    if (!presentation || request.documentId !== presentation.deckId) throw new Error("Outside presentation image session");
    if (request.method === "profile") return browserAudienceProfile ?? outputImageProfile(screen.width, screen.height, devicePixelRatio);
    const profile = request.profile;
    if (!profile || ![profile.width, profile.height].every(v => Number.isFinite(v) && v > 0 && v <= 100000) || profile.sampling) throw new Error("Invalid audience profile");
    if (request.method === "prepare") {
      if (requester !== popup) throw new Error("Unauthorized audience preparation");
      browserAudienceProfile = { width: profile.width, height: profile.height };
      browserImages.prioritize(request.documentId, presentation.slideIds[presentation.index ?? 0]);
      await browserImages.reconcile(request.documentId);
      if (imageCachingEnabled) await browserImages.ready(request.documentId, true);
      return browserAudienceProfile;
    }
    if (request.method !== "slide" || !request.slideId || !presentation.slideIds.includes(request.slideId)) throw new Error("Outside presentation slide");
    if (!imageCachingEnabled) return {};
    return browserImages.prepareSlide(request.documentId, request.slideId, profile, 0);
  })().then(result => requester.postMessage({ type: "showme-image-response", requestId: request.requestId, result }, location.origin),
    error => requester.postMessage({ type: "showme-image-response", requestId: request.requestId, error: String(error) }, location.origin));
});

const imageUrls = new Map<string, { url: string; users: number }>();
const imageUrlHashes = new Map<string, string>();
async function leaseBrowserImage(image: PreparedImage): Promise<PreparedImage> {
  let entry = imageUrls.get(image.hash);
  if (!entry) {
    const blob = await get<Blob>(browserImageKey(image.hash));
    if (!blob) throw new Error("Prepared image disappeared");
    // Another request may have installed a lease while IndexedDB was loading.
    entry = imageUrls.get(image.hash);
    if (!entry) {
      entry = { url: URL.createObjectURL(blob), users: 0 };
      imageUrls.set(image.hash, entry);
      imageUrlHashes.set(entry.url, image.hash);
    }
  }
  entry.users++;
  return { ...image, url: entry.url };
}

async function leaseSlideImages(images: PreparedSlideImages): Promise<PreparedSlideImages> {
  const leases = new Map<string, Promise<PreparedImage>>();
  try {
    return Object.fromEntries(await Promise.all(Object.entries(images).map(async ([id, image]) => {
      if (!image) return [id, null];
      let lease = leases.get(image.hash);
      if (!lease) { lease = leaseBrowserImage(image); leases.set(image.hash, lease); }
      return [id, await lease];
    })));
  } catch (error) {
    for (const result of await Promise.allSettled(leases.values())) if (result.status === "fulfilled") browser.releaseUrl(result.value.url);
    throw error;
  }
}

export const browser: Platform = {
  presentationImageDiagnostics: async () => ({ ...browserImageDiagnostics }),
  onImageReadiness: (callback) => {
    imageInvalidationListeners.add(callback);
    const unsubscribe = presentationRole ? () => {} : browserImages.subscribe(callback);
    return () => {
      unsubscribe();
      imageInvalidationListeners.delete(callback);
    };
  },
  getImageCachingEnabled: async () => imageCachingEnabled,
  async setImageCachingEnabled(enabled) {
    localStorage.setItem("showme-image-caching", String(enabled));
    imageCachingEnabled = enabled;
    if (enabled) browserImages.resume();
    else browserImages.suspend();
    channel.postMessage({ type: "image-cache-setting", enabled });
    notifyBrowserImageCacheChanged();
  },
  async imageReadiness(documentId, retry = false, slideId) {
    if (!imageCachingEnabled) return null;
    if (slideId) {
      await (await browserRuntime(documentId)).projection(documentId, slideId);
    }
    if (retry || !browserImages.status(documentId)) await browserImages.reconcile(documentId, retry);
    return browserImages.status(documentId);
  },
  async audienceImageProfile(documentId) {
    if (presentationRole) return ownerImageRequest<ImageOutputProfile>({ method: "profile", documentId });
    return browserAudienceProfile ?? outputImageProfile(screen.width, screen.height, devicePixelRatio);
  },
  async prepareAudience(documentId) {
    const profile = outputImageProfile(innerWidth, innerHeight, devicePixelRatio);
    if (presentationRole) return ownerImageRequest<ImageOutputProfile>({ method: "prepare", documentId, profile });
    browserAudienceProfile = profile;
    await browserImages.reconcile(documentId);
    if (imageCachingEnabled) await browserImages.ready(documentId, true);
    return profile;
  },
  async preparedSlideImages(documentId, slideId, profile) {
    if (!imageCachingEnabled) return {};
    const images = presentationRole
      ? await ownerImageRequest<PreparedSlideImages>({ method: "slide", documentId, slideId, profile })
      : await browserImages.prepareSlide(documentId, slideId, profile, presentation ? 0 : 1);
    return leaseSlideImages(images);
  },
  async prioritizeCanvasImages(documentId, slideId) {
    if (presentationRole) throw new Error("Unauthorized canvas priority");
    await (await browserRuntime(documentId)).projection(documentId, slideId);
    activeBrowserCanvas = `${documentId}:${slideId}`;
    browserImageQueue.setPriorities(new Map([...browserImageDemands].map(([key, demand]) => [key, browserDemandPriority(demand)])));
  },
  async preparedImage(documentId, slideId, elementId, profile) {
    if (!imageCachingEnabled) return null;
    const images = await browser.preparedSlideImages!(documentId, slideId, profile ?? await browser.audienceImageProfile!(documentId));
    const selected = images[elementId] ?? null;
    for (const url of new Set(Object.values(images).flatMap(image => image && image.hash !== selected?.hash ? [image.url] : []))) browser.releaseUrl(url);
    return selected;
  },
  async preparedAssetImage(assetId, size) {
    if (!imageCachingEnabled) return null;
    const asset = await get<Asset>("asset/" + assetId);
    if (!asset?.width || !asset.height) return null;
    const dimensions = imageDimensions(
      asset.width,
      asset.height,
      Math.min(size, Math.max(asset.width, asset.height)),
    );
    const image = await prepareBrowserVariant({
      assetId,
      size,
      ...dimensions,
      instances: [],
      slideIds: [],
      estimatedBytes: asset.width * asset.height * 24,
    });
    if (!image) return null;
    const blob = await get<Blob>(image.url);
    return blob ? { ...image, url: URL.createObjectURL(blob) } : null;
  },
  async clearPresentationImages() {
    clearingBrowserImages = true;
    browserImageGeneration++;
    validatedBrowserImages.clear();
    browserImages.suspend();
    try {
      await navigator.locks.request("show-me-image-cache", async () => {
        const db = await dbPromise;
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("files", "readwrite");
          transaction
            .objectStore("files")
            .delete(
              IDBKeyRange.bound(
                BROWSER_IMAGE_PREFIX,
                BROWSER_IMAGE_PREFIX + "\uffff",
              ),
            );

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      });
      channel.postMessage({ type: "image-cache-cleared" });
    } finally {
      clearingBrowserImages = false;
      if (imageCachingEnabled) browserImages.resume();
      notifyBrowserImageCacheChanged();
    }
  },
  async renderProjection(documentId, slideId) {
    return (await browserRuntime(documentId)).renderProjection(
      documentId,
      slideId,
    );
  },
  async documentProjection(documentId, slideId) {
    prepareBrowserImages(documentId);
    return (await browserRuntime(documentId)).projection(documentId, slideId);
  },
  async documentCommit(documentId, transaction) {
    return (await browserRuntime(documentId)).commit(documentId, transaction);
  },
  async documentAcquireLeases(documentId, scopes) {
    return (await browserRuntime(documentId)).acquire(documentId, scopes);
  },
  async documentRenewLeases(documentId, tokens) {
    return (await browserRuntime(documentId)).renew(documentId, tokens);
  },
  async documentReleaseLeases(documentId, tokens) {
    await (await browserRuntime(documentId)).release(documentId, tokens);
  },
  async documentUndo(documentId, tokens) {
    return (await browserRuntime(documentId)).undo(documentId, tokens);
  },
  async documentRedo(documentId, tokens) {
    return (await browserRuntime(documentId)).redo(documentId, tokens);
  },
  async documentHistoryState(documentId) {
    return (await browserRuntime(documentId)).historyState(documentId);
  },
  onDocumentAccepted(callback) {
    acceptedListeners.add(callback);
    return () => acceptedListeners.delete(callback);
  },
  onDocumentInvalidated() {
    return () => {};
  },
  async effectLibrary(request) {
    const db = await dbPromise;
    return new Promise<EffectLibrary>((resolve, reject) => {
      const writing = request.type !== "list" && request.type !== "reveal";
      const transaction = db.transaction(
        "files",
        writing ? "readwrite" : "readonly",
      );
      const files = transaction.objectStore("files");
      const read = files.get("effect-library-v1");
      let next: EffectLibrary;
      let failure: unknown;
      read.onsuccess = () => {
        try {
          next = editEffectLibrary(
            read.result ?? { entries: [], folders: [] },
            request,
          );
          if (writing) files.put(next, "effect-library-v1");
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(next);
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error);
    });
  },
  async getMediaLibrary() {
    return {
      path: "IndexedDB (Browser Storage)",
      isDefault: true,
      defaultPath: "IndexedDB (Browser Storage)",
    };
  },
  async chooseMediaLibrary() {
    return null;
  },
  async resetMediaLibrary() {
    return this.getMediaLibrary();
  },
  async createDocument(name) {
    const document = newPresentationDocument(name);
    resetBrowserRuntime(document.documentId);
    await put("document/" + document.documentId, {
      document,
      revision: 0,
      savedRevision: 0,
    } satisfies BrowserDocumentRecord);
    return documentSummary(document);
  },
  async openDocument() {
    return null;
  },
  async openDocumentInNewWindow() {},
  async openRecentDocument(location) {
    if (!location.startsWith("browser:"))
      throw new Error("Unknown presentation");
    const id = location.slice("browser:".length);
    const record = await documentRecord(id);
    return documentSummary(
      record.document,
      (record.revision ?? 0) !== (record.savedRevision ?? 0),
    );
  },
  async listDocuments() {
    return Promise.all(
      (await entries<BrowserDocumentRecord>("document/")).map(
        async (record) => {
          const document = parseRuntimeDocument(record.document);
          return documentSummary(
            document,
            (record.revision ?? 0) !== (record.savedRevision ?? 0),
          );
        },
      ),
    ).then((documents) =>
      documents.sort((a, b) => a.name.localeCompare(b.name)),
    );
  },
  async currentDocument() {
    return null;
  },
  async saveDocument(documentId) {
    const runtime = await browserRuntime(documentId);
    requireBrowserWriter(documentId);
    return runtime.authority.runExclusive(async (snapshot) => {
      await mutateDocument(
        documentId,
        (record) => {
          record.savedRevision = snapshot.revision;
        },
        { epoch: snapshot.epoch, revision: snapshot.revision },
      );
      runtime.authority.markSaved(snapshot.revision);
      return documentSummary(snapshot.document);
    });
  },
  async closeDocument(documentId) {
    const pending = browserRuntimes.get(documentId);
    if (pending) await pending;
    browserRuntimes.delete(documentId);
    browserWriteLocks.get(documentId)?.();
    browserWriteLocks.delete(documentId);
  },
  async saveDocumentAs(documentId) {
    return browser.saveDocument!(documentId);
  },
  onDocumentOpened() {
    return () => {};
  },
  async readSlideTransfer(files) {
    const file = files.find((candidate) =>
      candidate.name.endsWith(SLIDE_TRANSFER_FILE_EXTENSION),
    );
    if (!file) return null;
    return parseSlideTransferBundle(JSON.parse(await file.text()));
  },
  startSlideDrag() {
    return false;
  },
  async listAssets(query, offset, limit) {
    const assets = (await entries<Asset>("asset/")).filter((asset) =>
      asset.names.some((name) =>
        name.toLowerCase().includes(query.toLowerCase()),
      ),
    );
    const counts = assetCategoryCounts(assets);
    assets.sort(compareAssetsByCategoryAndName);
    return {
      items: assets.slice(offset, offset + limit),
      total: assets.length,
      counts,
    };
  },
  async getAsset(id) {
    const value = await get<Asset>("asset/" + id);
    if (!value) throw new Error("Asset is missing");
    return assetSchema.parse(value);
  },
  importAssets: (files = []) => importBrowserFiles(files),
  importDroppedFiles: (files) => importBrowserFiles(files),
  async assetUrl(id, preview) {
    const cached = preview ? await get<Blob>("preview/" + id) : undefined;
    const metadata = preview ? await get<Asset>("asset/" + id) : undefined;
    const blob =
      cached ??
      (preview && metadata?.type === "video"
        ? undefined
        : await get<Blob>("blob/" + id));
    if (preview && !cached && blob && metadata?.type !== "video") {
      try {
        const image = await createImageBitmap(blob);
        try {
          const scale = Math.min(1, 256 / image.width, 256 / image.height);
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d")!;
          context.fillStyle = "white";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const thumbnail = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.8),
          );
          if (thumbnail) {
            await put("preview/" + id, thumbnail);
            return URL.createObjectURL(thumbnail);
          }
        } finally {
          image.close();
        }
      } catch {
        // Unsupported images retain the original-image fallback.
      }
    }
    return blob ? URL.createObjectURL(blob) : null;
  },
  retainUrl(url) {
    const hash = imageUrlHashes.get(url);
    const entry = hash ? imageUrls.get(hash) : undefined;
    if (entry) entry.users++;
  },
  releaseUrl(url) {
    const hash = imageUrlHashes.get(url);
    const entry = hash ? imageUrls.get(hash) : undefined;
    if (entry && --entry.users > 0) return;
    if (hash) { imageUrls.delete(hash); imageUrlHashes.delete(url); }
    URL.revokeObjectURL(url);
  },
  async updateAsset(asset) {
    await put("asset/" + asset.id, assetSchema.parse(asset));
  },
  async storePreview(id, data) {
    await put(
      "preview/" + id,
      new Blob([new Uint8Array(data)], { type: "image/jpeg" }),
    );
  },
  async thumbnail(documentId, slideId) {
    const data = await get<string>("thumb/" + documentId + "/" + slideId);
    return data
      ? URL.createObjectURL(new Blob([data], { type: "image/svg+xml" }))
      : null;
  },
  storeThumbnail: (documentId, slideId, data) =>
    put("thumb/" + documentId + "/" + slideId, data),
  async displays() {
    return [];
  },
  async present(input) {
    browserAudienceProfile = null;
    popup = window.open(
      location.pathname + "?present=audience",
      "show-me-audience",
      "popup,width=1280,height=720",
    );
    if (!popup) throw new Error("Allow popups to open Audience Output.");
    consolePopup = window.open(
      location.pathname + "?present=console",
      "show-me-console",
      "popup,width=1280,height=900",
    );
    if (!consolePopup) {
      popup.close();
      popup = null;
      throw new Error("Allow popups to open Presenter Console.");
    }
    const projection = await (
      await browserRuntime(input.deckId)
    ).projection(input.deckId);
    const document = (await browserRuntime(input.deckId)).authority.document;
    const motionSlides = Object.fromEntries(
      Object.entries(document.slides).map(([id, slide]) => [
        id,
        slide.motion?.stages.map((s) => ({
          id: s.id,
          duration: stageDuration(s),
        })) ?? [],
      ]),
    );
    await mutatePresentation(() =>
      startSession(input, projection.deck, Date.now(), motionSlides, true),
    );
  },
  async updatePresentation(input) {
    await mutatePresentation(async (current) => {
      if (current?.deckId !== input.deckId) return current;
      const runtime = await browserRuntime(input.deckId);
      const document = runtime.authority.document;
      const motionSlides = Object.fromEntries(
        Object.entries(document.slides).map(([id, slide]) => [
          id,
          slide.motion?.stages.map((s) => ({
            id: s.id,
            duration: stageDuration(s),
          })) ?? [],
        ]),
      );
      return reconcileSession({ ...current, motionSlides }, document.deck);
    });
  },
  async getPresentation() {
    return currentPresentation();
  },
  onPresentation(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  async presentationCommand(command) {
    await mutatePresentation((current) =>
      current ? applyPresentationCommand(current, command) : null,
    );
    if (!presentationRole && presentation?.index !== null && presentation?.index !== undefined)
      browserImages.prioritize(presentation.deckId, presentation.slideIds[presentation.index]);
  },
  async navigate(index) {
    await browser.presentationCommand({ type: "jump", index });
  },
  async setBlack(value) {
    await browser.presentationCommand({ type: "black", value });
  },
  async restartPresentationMedia() {
    await browser.presentationCommand({ type: "restart-media" });
  },
  async closePresentation() {
    await mutatePresentation(() => null);
  },
  async fullscreen() {
    const audience = presentationRole === "audience" ? window : popup;
    if (!audience || audience.closed)
      throw new Error("Use the desktop app for remote fullscreen control.");
    if (audience.document.fullscreenElement)
      await audience.document.exitFullscreen();
    else await audience.document.documentElement.requestFullscreen();
  },
  async showPresenterConsole() {
    consolePopup = window.open(
      location.pathname + "?present=console",
      "show-me-console",
      "popup,width=1280,height=900",
    );
    consolePopup?.focus();
  },
  async setPresentationDisplays() {
    throw new Error("Display assignment is available in the desktop app.");
  },
};
