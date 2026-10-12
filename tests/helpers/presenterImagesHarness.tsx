import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { platform } from "../../src/platform";
import { newPresentationDocument } from "../../src/core/document";
import { createMediaElement } from "../../src/core/media";
import {
  IMAGE_RECIPE,
  imageIdentity,
  planPresentationImages,
} from "../../src/core/presentationImages";

/** Exercise production image requests independently of preview/shader density. */
export function mountPresenterImagesHarness() {
  const model = newPresentationDocument("Shared audience rasters");
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
    createdAt: "2026-10-11T00:00:00Z",
  });
  image.frame.width = image.frame.height = 600;
  slide.nodes[0].children = [image];
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const requests = document.createElement("output");
  requests.setAttribute("aria-label", "Image requests");
  requests.textContent = "0";
  const mount = document.createElement("div");
  host.append(requests, mount);
  let count = 0;
  platform.preparedImage = async (
    _documentId,
    _slideId,
    _elementId,
    profile,
  ) => {
    requests.textContent = String(++count);
    const requirement = planPresentationImages(
      model.deck,
      [slide],
      profile!,
    )[0];
    const canvas = document.createElement("canvas");
    canvas.width = requirement.width;
    canvas.height = requirement.height;
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!)),
    );
    return {
      assetId,
      hash: imageIdentity(assetId, canvas.width, canvas.height),
      size: Math.max(canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height,
      sourceWidth: 4096,
      sourceHeight: 4096,
      mime: "image/png",
      recipe: IMAGE_RECIPE,
      url: URL.createObjectURL(blob),
    };
  };
  function Harness() {
    const [scale, setScale] = useState(0.25);
    const [profile, setProfile] = useState({ width: 1920, height: 1080 });
    return (
      <>
        <button onClick={() => setScale(0.5)}>Resize presenter preview</button>
        <button onClick={() => setProfile({ width: 3840, height: 2160 })}>
          Choose 4K audience screen
        </button>
        <section aria-label="Audience raster">
          <SlideRenderer
            slide={slide}
            deck={model.deck}
            staticVideo
            preparedImages
            imageProfile={profile}
          />
        </section>
        <section aria-label="Presenter raster">
          <SlideRenderer
            slide={slide}
            deck={model.deck}
            staticVideo
            preparedImages
            imageProfile={profile}
            renderScale={scale}
          />
        </section>
        <output aria-label="Preview scale">{scale}</output>
      </>
    );
  }
  createRoot(mount).render(<Harness />);
}
