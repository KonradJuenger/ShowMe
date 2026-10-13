import { createRoot } from "react-dom/client";
import { installPreparedSlideImagesMock } from "./preparedSlideImagesMock";
import { AudienceOutput } from "../../src/components/AudienceOutput";
import { platform } from "../../src/platform";
import { newPresentationDocument } from "../../src/core/document";
import { DocumentRuntime } from "../../src/core/documentRuntime";
import { createMediaElement } from "../../src/core/media";
import {
  applyPresentationCommand,
  startSession,
} from "../../src/core/presentationSession";
import {
  IMAGE_RECIPE,
  imageIdentity,
  planPresentationImages,
  type PreparedImage,
} from "../../src/core/presentationImages";
import type { PresenterState } from "../../src/platform/api";

interface NavigationSnapshot {
  index: number | null;
  slideId: string;
  awaitingAudience: boolean;
  pendingVariants: number;
  coldVariants: number;
  lateImageDecodes: number;
  requests: Array<{
    slide: number;
    assetId: string;
    width: number;
    height: number;
  }>;
}

declare global {
  interface Window {
    audienceNavigationHarness: {
      jump: (index: number) => Promise<void>;
      releaseImages: () => void;
      snapshot: () => NavigationSnapshot;
    };
  }
}

/** Real audience composition and session clock; only image IO is gated.
 * Early slides reuse a prepared raster. Slide 25 introduces a new photograph,
 * as in the reported deck, without depending on its assets or machine speed.
 */
export function mountAudienceNavigationHarness() {
  const model = newPresentationDocument("Synthetic audience navigation");
  const first = model.slides[model.deck.slideIds[0]];
  const firstMeta = model.deck.slideMeta[first.id];
  const sharedAsset = "a".repeat(64);
  const lateAsset = "b".repeat(64);
  for (let index = 0; index < 30; index++) {
    const id = index === 0 ? first.id : crypto.randomUUID();
    const slide = structuredClone(first);
    slide.id = id;
    const image = createMediaElement("image", {
      version: 1,
      id: index === 24 ? lateAsset : sharedAsset,
      filename: "synthetic-photo.png",
      names: ["synthetic-photo.png"],
      type: "image",
      mediaType: "image",
      mime: "image/png",
      bytes: 1,
      width: 4096,
      height: 4096,
      createdAt: "2026-10-13T00:00:00Z",
    });
    image.frame.width = image.frame.height = 600;
    slide.nodes[0].children = [image];
    model.slides[id] = slide;
    model.deck.slideMeta[id] = { ...firstMeta, name: `Slide ${index + 1}` };
    if (index !== 0) model.deck.slideIds.push(id);
  }
  const runtime = new DocumentRuntime(model, {
    actorId: "audience-navigation-test",
    durableCommit: async () => {},
  });
  let state = startSession(
    { deckId: model.deck.id, slideIds: model.deck.slideIds, index: 0 },
    model.deck,
    Date.now(),
    undefined,
    true,
  );
  const listeners = new Set<(value: PresenterState | null) => void>();
  platform.getPresentation = async () => state;
  platform.onPresentation = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  platform.presentationCommand = async (command) => {
    state = applyPresentationCommand(state, command);
    for (const listener of listeners) listener(state);
  };
  platform.documentProjection = async (documentId, slideId) =>
    runtime.projection(documentId, slideId);
  platform.onImageReadiness = () => () => {};

  const requests: NavigationSnapshot["requests"] = [];
  installPreparedSlideImagesMock(model.deck, model.slides);
  const variants = new Map<string, Promise<PreparedImage>>();
  const pending = new Map<string, () => void>();
  let coldVariants = 0;
  let lateImageDecodes = 0;
  const lateUrls = new Set<string>();
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    if (lateUrls.has(this.src)) lateImageDecodes++;
    return decode.call(this);
  };
  platform.preparedImage = async (_documentId, slideId, elementId, profile) => {
    const requirement = planPresentationImages(
      model.deck,
      [model.slides[slideId]],
      profile!,
      true,
    ).find((item) =>
      item.instances.some((instance) => instance.elementId === elementId),
    )!;
    requests.push({
      slide: model.deck.slideIds.indexOf(slideId) + 1,
      assetId: requirement.assetId,
      width: requirement.width,
      height: requirement.height,
    });
    const hash = imageIdentity(
      requirement.assetId,
      requirement.width,
      requirement.height,
    );
    let variant = variants.get(hash);
    if (!variant) {
      const canvas = document.createElement("canvas");
      canvas.width = requirement.width;
      canvas.height = requirement.height;
      const context = canvas.getContext("2d")!;
      context.fillStyle =
        requirement.assetId === lateAsset ? "#c94b32" : "#2165ba";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const image: PreparedImage = {
        assetId: requirement.assetId,
        hash,
        size: requirement.size,
        width: canvas.width,
        height: canvas.height,
        sourceWidth: 4096,
        sourceHeight: 4096,
        mime: "image/png",
        recipe: IMAGE_RECIPE,
        url: canvas.toDataURL(),
      };
      if (requirement.assetId === lateAsset) {
        lateUrls.add(image.url);
        coldVariants++;
        variant = new Promise<PreparedImage>((resolve) => {
          pending.set(hash, () => {
            pending.delete(hash);
            resolve(image);
          });
        });
      } else variant = Promise.resolve(image);
      variants.set(hash, variant);
    }
    return variant;
  };
  platform.assetUrl = async () => {
    throw new Error("Unexpected original/thumbnail fallback");
  };
  platform.releaseUrl = () => {};
  window.audienceNavigationHarness = {
    jump: (index) => platform.presentationCommand({ type: "jump", index }),
    releaseImages: () => {
      // Complete any work already requested during the preceding slide's dwell.
      // Future requests remain gated until the test explicitly releases again.
      for (const release of [...pending.values()]) release();
    },
    snapshot: () => ({
      index: state.index,
      slideId: state.slideIds[state.index ?? 0],
      awaitingAudience: !!state.awaitingAudience,
      pendingVariants: pending.size,
      coldVariants,
      lateImageDecodes,
      requests: [...requests],
    }),
  };
  // Once the test releases entry work, revisits use the same prepared promises.
  // No wall-clock delay or private deck content is involved.
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  createRoot(host).render(<AudienceOutput />);
}
