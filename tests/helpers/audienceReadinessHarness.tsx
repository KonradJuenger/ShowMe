import { createRoot } from "react-dom/client";
import { installPreparedSlideImagesMock } from "./preparedSlideImagesMock";
import { useRef } from "react";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { usePreparedSlideImages } from "../../src/components/usePreparedSlideImages";
import { platform } from "../../src/platform";
import { newPresentationDocument } from "../../src/core/document";
import { createMediaElement } from "../../src/core/media";
import {
  IMAGE_RECIPE,
  type PreparedImage,
} from "../../src/core/presentationImages";

/** Control preparation and both probe/visible decodes without sleeping. */
export function mountAudienceReadinessHarness(
  mode:
    "prepared" | "unsupported" | "failed" | "decode-failed" | "prepared-failed",
) {
  const model = newPresentationDocument("Audience readiness");
  const slide = model.slides[model.deck.slideIds[0]];
  const assetId = "a".repeat(64);
  const image = createMediaElement("image", {
    version: 1,
    id: assetId,
    filename: "image.png",
    names: ["image.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: 1,
    width: 4096,
    height: 4096,
    createdAt: "2026-10-12T00:00:00Z",
  });
  image.frame.width = image.frame.height = 600;
  if (
    mode === "failed" &&
    image.content?.type === "image" &&
    image.content.transform.rule !== "free"
  ) {
    image.content.transform.intrinsicWidth =
      image.content.transform.intrinsicHeight = null;
  }
  slide.nodes[0].children = [image];
  installPreparedSlideImagesMock(model.deck, model.slides);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 600;
  const url = canvas.toDataURL();
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const decodes = document.createElement("output");
  decodes.setAttribute("aria-label", "Pending decodes");
  decodes.textContent = "0";
  host.append(decodes);
  const pending: Array<{ resolve: () => void; reject: () => void }> = [];
  HTMLImageElement.prototype.decode = function () {
    return new Promise<void>((resolve, reject) => {
      pending.push({
        resolve,
        reject: () => reject(new Error("Broken raster")),
      });
      decodes.textContent = String(pending.length);
    });
  };
  let finishPreparation: () => void = () => {};
  platform.preparedImage = () =>
    new Promise<PreparedImage | null>((resolve) => {
      finishPreparation = () =>
        resolve(
          mode === "prepared" || mode === "prepared-failed"
            ? {
                assetId,
                hash: "exact",
                size: 600,
                width: 600,
                height: 600,
                sourceWidth: 4096,
                sourceHeight: 4096,
                mime: "image/png",
                recipe: IMAGE_RECIPE,
                url,
              }
            : null,
        );
    });
  platform.assetUrl = async (_id, preview) => {
    if (preview) throw new Error("Audience must not request previews");
    return mode === "failed" ? "data:image/png;base64,broken" : url;
  };
  let failedDecodes = 0;
  function Harness() {
    const root = useRef<HTMLDivElement>(null);
    const ready = usePreparedSlideImages(root, slide, 1, model.deck.id);
    return (
      <>
        <button onClick={() => finishPreparation()}>Finish preparation</button>
        <button
          onClick={() => {
            const next = pending.shift();
            if (
              mode === "decode-failed" ||
              (mode === "prepared-failed" && failedDecodes++ === 0)
            )
              next?.reject();
            else next?.resolve();
            decodes.textContent = String(pending.length);
          }}
        >
          Finish decode
        </button>
        <output aria-label="Audience readiness">
          {ready ? "ready" : "waiting"}
        </output>
        <div ref={root}>
          <SlideRenderer
            slide={slide}
            deck={model.deck}
            preparedImages
            imageProfile={model.deck}
          />
        </div>
      </>
    );
  }
  const mount = document.createElement("div");
  host.append(mount);
  createRoot(mount).render(<Harness />);
}
