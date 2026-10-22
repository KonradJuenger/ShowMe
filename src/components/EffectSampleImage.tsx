import { ASSET_VERSION } from "../core/assets";
import { useMemo } from "react";
import { createMediaElement } from "../core/media";
import type { EffectDefinition, ElementEffect } from "../core/effects";
import { EffectSurface } from "./EffectSurface";

// Local preview pixels; never imported into the user's Library or presentation.
const image =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="140"><defs><linearGradient id="g"><stop stop-color="#246f98"/><stop offset="1" stop-color="#923984"/></linearGradient></defs><rect width="280" height="140" fill="url(#g)"/><circle cx="80" cy="70" r="45" fill="#ffd27b"/><path d="M140 120L200 20L260 120Z" fill="#ecf5ff"/></svg>',
  );
export function EffectSampleImage({
  definition,
  instance,
  progress,
  duration,
  time,
  clocks,
  active = true,
  started = true,
}: {
  definition: EffectDefinition;
  instance: ElementEffect;
  progress: number;
  duration: number;
  time: number;
  clocks?: {
    presentationTime: number;
    slideTime: number;
    stepTime: number;
    stepIndex?: number;
    slideIndex?: number;
    slideCount?: number;
    slideSeed?: number;
    previousSlideIndex?: number;
    previousSlideSeed?: number;
  };
  active?: boolean;
  started?: boolean;
}) {
  const element = useMemo(() => {
    const visual = createMediaElement(
      "studio-image",
      {
        version: ASSET_VERSION,
        id: "a".repeat(64),
        type: "image",
        filename: "studio.svg",
        mediaType: "image",
        mime: "image/svg+xml",
        names: ["Sample image"],
        width: 280,
        height: 140,
        bytes: 0,
        createdAt: "",
      },
      { x: 0, y: 0 },
    );
    visual.frame.width = 280;
    visual.frame.height = 140;
    return visual;
  }, []);
  const sceneTextureSource = useMemo(() => ({ element, resources: {} }), [element]);
  return (
    <div data-element-id={element.id} style={{ width: "100%", height: "100%" }}>
      <EffectSurface
        definition={definition}
        instance={instance}
        width={280}
        height={140}
        sceneTextureSource={sceneTextureSource}
        previewTiming={{
          progress,
          time,
          duration: duration / 1000,
          ...clocks,
          active,
          started,
        }}
      >
        <div style={{ width: 280, height: 140 }}>
          <div data-showme-part="content">
            <div
              data-media-asset-id={"a".repeat(64)}
              style={{ width: 280, height: 140 }}
            >
              <img alt="Sample image" src={image} width={280} height={140} />
            </div>
          </div>
        </div>
      </EffectSurface>
    </div>
  );
}
