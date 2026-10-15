import { newPresentationDocument } from "../core/document";
import { newEffectInstance, type EffectDefinition } from "../core/effects";
import { ContentEffectPreview } from "./ContentEffectPreview";
import { EffectSurface } from "./EffectSurface";

/** Fixed sample and clocks, using the same renderer as Effect Editor. */
export function EffectThumbnailPreview({
  definition,
}: {
  definition: EffectDefinition;
}) {
  const document = newPresentationDocument("Effect thumbnail");
  const snapshot = {
    deck: document.deck,
    slide: document.slides[document.deck.slideIds[0]],
  };
  const instance = {
    ...newEffectInstance("thumbnail-effect", definition, "content"),
    id: "thumbnail-instance",
  };
  const clocks = {
    presentationTime: 1,
    slideTime: 1,
    stepTime: 1,
    slideSeed: 42,
    previousSlideSeed: 42,
    slideIndex: 0,
    previousSlideIndex: 0,
    slideCount: 1,
    stepIndex: 0,
  };
  return (
    <div
      style={{
        position: "relative",
        width: 280,
        height: 140,
        overflow: "hidden",
        background: "#245684",
        color: "white",
        font: "700 28px sans-serif",
      }}
    >
      {definition.kind === "css" ||
      definition.input === "content" ||
      definition.input === "backdrop" ? (
        <ContentEffectPreview
          definition={definition}
          instance={instance}
          element={null}
          snapshot={snapshot}
          progress={0.5}
          duration={2000}
          time={1}
          clocks={clocks}
        />
      ) : (
        <EffectSurface
          definition={definition}
          instance={instance}
          width={280}
          height={140}
          previewTiming={{
            progress: 0.5,
            time: 1,
            duration: 2,
            ...clocks,
            active: true,
            started: true,
          }}
        >
          <span
            data-text-content="true"
            style={{ display: "block", padding: 24 }}
          >
            ShowMe
            <br />
            Effects
          </span>
        </EffectSurface>
      )}
    </div>
  );
}
