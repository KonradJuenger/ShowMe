import { videoPoster } from "../core/videoPoster";
import { resolveVisualSlide } from "../core/templates";
import { walkElements } from "../core/element";
import { enrichAsset } from "./mediaEnrichment";
import { EffectThumbnailPreview } from "./EffectThumbnailPreview";
import type { EffectDefinition } from "../core/effects";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createRef, useRef } from "react";
import type { DocumentProjection } from "../core/documentProjection";
import { platform } from "../platform";
import { SlideRenderer } from "./SlideRenderer";
import { waitForSlideImages } from "./audienceImagePreparation";
import { flushEffectSurfaces } from "./effectRuntime";
import type { AgentPreviewWarning } from "../core/agentPreview";
import { measureText } from "./editor/textLayout";
import { layoutHtmlExportText } from "../export/html/textOutlines";
import type { Element as SceneElement } from "../core/element";
import {
  createTextElement,
  type TextContent,
  type TextMeasurement,
} from "../core/text";
import { DEFAULT_TEXT_TYPOGRAPHY } from "../core/textTypography";
import type {
  AgentTextMeasureItem,
  AgentTextFitMeasurement,
} from "../core/agentTextMeasure";
import { validateEffectDefinitionProduction } from "./effectValidation";
import type { EffectValidationResult } from "../core/effectValidation";
import {
  resolveAgentTimelineSample,
  type AgentPreviewSample,
  type AgentSampleTrace,
} from "../core/agentPreviewSample";
import {
  resolveSlideTransition,
  type SlideTransitionPlayback,
} from "../core/slideTransitions";
import { useSlideTransition } from "./useSlideTransition";

function SampledPreviewSlide({
  projection,
  trace,
  transition,
  active,
  width,
  height,
  complete = false,
}: {
  projection: DocumentProjection;
  trace: AgentSampleTrace;
  transition?: SlideTransitionPlayback;
  active: boolean;
  width: number;
  height: number;
  complete?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const resolved = resolveAgentTimelineSample(projection, trace, complete);
  const state = useSlideTransition(
    root,
    projection.slide.id,
    active,
    1,
    transition,
    trace.captureTimeMs,
  );
  return (
    <div
      ref={root}
      style={{
        position: "absolute",
        inset: 0,
        width: projection.deck.width,
        height: projection.deck.height,
        transform: "scale(1)",
        opacity: state.visible ? 1 : 0,
        zIndex: active ? 2 : 1,
      }}
    >
      <SlideRenderer
        slide={projection.slide}
        deck={projection.deck}
        templates={projection.templates}
        staticVideo
        preparedImages
        renderProfile={{ width, height, mode: "live" }}
        motionState={resolved.playback}
        effectClock={resolved.origins}
      />
    </div>
  );
}

declare global {
  interface Window {
    layoutHtmlExportText?: typeof layoutHtmlExportText;
    prepareAgentMedia?: (asset: import("../core/assets").Asset) => Promise<{
      asset: import("../core/assets").Asset | null;
      preview: number[] | null;
      failure?: "unsupported" | "pending";
    }>;
    measureAgentText?: (
      documentId: string,
      element: SceneElement & { content: TextContent },
    ) => Promise<TextMeasurement | null>;
    measureAgentTextBatch?: (
      documentId: string,
      items: readonly AgentTextMeasureItem[],
    ) => Promise<AgentTextFitMeasurement[] | null>;
    composeEffectThumbnail?: (definition: EffectDefinition) => Promise<boolean>;
    validateAgentEffect?: (
      definition: EffectDefinition,
      sampleText?: string,
    ) => Promise<EffectValidationResult>;
    clearSlidePreview?: () => void;
    slidePreviewWarnings?: () => AgentPreviewWarning[];
    composeSlidePreview?: (
      projection: DocumentProjection,
      width: number,
      height: number,
      captureToken: string,
      sample?: AgentPreviewSample,
      previous?: DocumentProjection,
    ) => Promise<boolean>;
  }
}

/** Isolated native capture surface; visual semantics stay in shared renderers. */
export function installSlidePreviewPage() {
  window.layoutHtmlExportText = layoutHtmlExportText;
  const host = document.getElementById("root")!;
  document.body.style.margin = "0";
  const root = createRoot(host);
  window.prepareAgentMedia = async (asset) => {
    let prepared: import("../core/assets").Asset | null = null,
      preview: number[] | null = null;
    try {
      await enrichAsset(
        asset,
        {
          assetUrl: platform.assetUrl,
          releaseUrl: platform.releaseUrl,
          updateAsset: async (value) => {
            prepared = value;
          },
          storePreview: async (_id, bytes) => {
            preview = Array.from(bytes);
          },
        },
        8000,
      );
      return { asset: prepared, preview };
    } catch (error) {
      // Decoder rejection is an item failure, not renderer loss: do not restart/retry the runtime.
      return {
        asset: prepared,
        preview,
        failure:
          error instanceof Error && error.message === "Could not decode media"
            ? "unsupported"
            : "pending",
      };
    }
  };
  window.measureAgentText = async (documentId, element) => {
    await platform.managedFonts?.(documentId);
    const typography =
      element.content.format.kind === "local"
        ? element.content.format.typography
        : null;
    if (!typography) return null;
    await document.fonts.load(
      `${typography.italic ? "italic " : ""}${typography.fontWeight} ${typography.fontSize}px ${typography.fontFamily}`,
      element.content.text || " ",
    );
    await document.fonts.ready;
    return measureText(element);
  };
  window.measureAgentTextBatch = async (documentId, items) => {
    const managed = (await platform.managedFonts?.(documentId)) ?? [];
    const elements = items.map((item, index) => {
      const element = createTextElement(
        `agent-measure-${index}`,
      ) as SceneElement & { content: TextContent };
      element.frame = { ...element.frame, width: item.width };
      element.content = {
        ...element.content,
        text: item.text,
        placeholder: false,
        autoSize: "height",
        format: {
          kind: "local",
          typography: {
            ...DEFAULT_TEXT_TYPOGRAPHY,
            ...(item.typography ?? {}),
          },
        },
      };
      return element;
    });
    await Promise.all(
      elements.map((element) => {
        const typography =
          element.content.format.kind === "local"
            ? element.content.format.typography
            : DEFAULT_TEXT_TYPOGRAPHY;
        return document.fonts.load(
          `${typography.italic ? "italic " : ""}${typography.fontWeight} ${typography.fontSize}px ${typography.fontFamily}`,
          element.content.text || " ",
        );
      }),
    );
    await document.fonts.ready;
    const measurements = elements.map((element) => measureText(element));
    if (
      !measurements.every(
        (measurement): measurement is TextMeasurement => measurement !== null,
      )
    )
      return null;
    return Promise.all(
      measurements.map(
        async (measurement, index): Promise<AgentTextFitMeasurement> => {
          const typography =
            elements[index].content.format.kind === "local"
              ? elements[index].content.format.typography
              : DEFAULT_TEXT_TYPOGRAPHY;
          const requested = typography.fontFamily;
          const isManaged = managed.some(
            ({ family }) =>
              family.toLocaleLowerCase() === requested.toLocaleLowerCase(),
          );
          const generic = [
            "serif",
            "sans-serif",
            "monospace",
            "system-ui",
            "cursive",
            "fantasy",
          ].includes(requested.toLocaleLowerCase());
          let availability: "available" | "unavailable" | "unknown" =
            isManaged || generic ? "available" : "unknown";
          if (availability === "unknown" && !requested.includes(",")) {
            try {
              await new FontFace(
                "agent-availability-probe",
                `local(${JSON.stringify(requested)})`,
              ).load();
              availability = "available";
            } catch {
              availability = "unavailable";
            }
          }
          return {
            ...measurement,
            contentExtent: { ...measurement },
            overflow: {
              horizontal: measurement.width > items[index].width + 0.01,
              vertical:
                items[index].height !== undefined &&
                measurement.height > items[index].height! + 0.01,
            },
            font: {
              requested,
              availability,
              source: isManaged
                ? "managed"
                : generic
                  ? "generic"
                  : availability === "available"
                    ? "platform"
                    : "unknown",
              fallback:
                availability === "available"
                  ? "unknown"
                  : availability === "unavailable"
                    ? "possible"
                    : "unknown",
              resolvedFamily: null,
            },
          };
        },
      ),
    );
  };
  window.validateAgentEffect = (definition, sampleText) =>
    validateEffectDefinitionProduction(definition, { sampleText });
  window.clearSlidePreview = () => flushSync(() => root.render(null));
  window.slidePreviewWarnings = () => {
    const warnings: AgentPreviewWarning[] = [];
    const elementIds = (nodes: Element[]) =>
      [
        ...new Set(
          nodes.flatMap((node) => {
            const id = node
              .closest("[data-element-id]")
              ?.getAttribute("data-element-id");
            return id ? [id] : [];
          }),
        ),
      ].sort();
    const missing = [...host.querySelectorAll('[data-missing-media="true"]')];
    if (missing.length)
      warnings.push({
        code: "MISSING_MEDIA",
        message: "The preview contains missing media placeholders.",
        elementIds: elementIds(missing),
      });
    const errors = [
      ...host.querySelectorAll("[data-effect-id][data-effect-error]"),
    ].filter((node) => !!node.getAttribute("data-effect-error"));
    if (errors.length)
      warnings.push({
        code: "EFFECT_FALLBACK",
        message: "An Effect reported a production runtime diagnostic.",
        elementIds: elementIds(errors),
        effectInstanceIds: [
          ...new Set(
            errors.flatMap((node) => {
              const id = node
                .closest("[data-effect-id]")
                ?.getAttribute("data-effect-id");
              return id ? [id] : [];
            }),
          ),
        ].sort(),
      });
    return warnings;
  };
  window.composeEffectThumbnail = async (definition) => {
    flushSync(() =>
      root.render(<EffectThumbnailPreview definition={definition} />),
    );
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const ready = await flushEffectSurfaces(host);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return ready && !host.querySelector('[role="status"]');
  };
  window.composeSlidePreview = async (
    projection,
    width,
    height,
    captureToken,
    sample,
    previous,
  ) => {
    const profile = { width, height, mode: "live" as const };
    const marker = createRef<HTMLCanvasElement>();
    await platform.managedFonts?.(projection.documentId);
    // Prepare static posters before mount: an empty img list is not media readiness.
    for (const page of [projection, ...(previous ? [previous] : [])]) {
      const visual = resolveVisualSlide(
        page.deck,
        page.slide,
        page.templates ?? {},
      ).slide;
      for (const element of walkElements(
        visual.nodes.flatMap((layer) => layer.children),
      )) {
        if (
          element.content?.type === "video" &&
          !(await videoPoster(
            platform,
            element.content.assetId,
            element.content.startTime,
          ))
        )
          return false;
      }
    }
    flushSync(() =>
      root.render(
        <>
          <div
            style={{
              width: projection.deck.width,
              height: projection.deck.height,
              transform: `scale(${width / projection.deck.width}, ${height / projection.deck.height})`,
              transformOrigin: "top left",
            }}
          >
            {sample ? (
              sample.mode === "transition" && previous ? (
                <>
                  <SampledPreviewSlide
                    key={`out-${captureToken}`}
                    projection={previous}
                    trace={sample.outgoing}
                    active={false}
                    width={width}
                    height={height}
                    transition={{
                      ...resolveSlideTransition(
                        projection.deck.slideMeta[projection.slide.id]
                          .transition,
                        projection.deck.transitionDefaults,
                      ),
                      fromSlideId: previous.slide.id,
                      toSlideId: projection.slide.id,
                      startedAt: sample.incoming.activationMs,
                    }}
                  />
                  <SampledPreviewSlide
                    key={`in-${captureToken}`}
                    projection={projection}
                    trace={sample.incoming}
                    active
                    width={width}
                    height={height}
                    transition={{
                      ...resolveSlideTransition(
                        projection.deck.slideMeta[projection.slide.id]
                          .transition,
                        projection.deck.transitionDefaults,
                      ),
                      fromSlideId: previous.slide.id,
                      toSlideId: projection.slide.id,
                      startedAt: sample.incoming.activationMs,
                    }}
                  />
                </>
              ) : sample.mode !== "transition" ? (
                <SampledPreviewSlide
                  key={captureToken}
                  projection={projection}
                  trace={sample}
                  complete={sample.mode === "finite-complete"}
                  active
                  width={width}
                  height={height}
                />
              ) : null
            ) : (
              <SlideRenderer
                slide={projection.slide}
                deck={projection.deck}
                templates={projection.templates}
                staticVideo
                preparedImages
                renderProfile={profile}
              />
            )}
          </div>
          <canvas
            aria-hidden="true"
            width={1}
            height={12}
            style={{
              position: "fixed",
              left: 0,
              top: height,
              width,
              height: 48,
              zIndex: 2147483647,
              imageRendering: "pixelated",
              pointerEvents: "none",
            }}
            ref={marker}
          />
        </>,
      ),
    );
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    try {
      await waitForSlideImages(host, abort.signal);
      await document.fonts.ready;
      await Promise.all(
        [...host.querySelectorAll("img")].map((image) =>
          image.decode().catch(() => {}),
        ),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      // A native resize can publish fresh surface density after the first flush.
      // Wait on the actual readiness contract within the existing capture deadline.
      while (!abort.signal.aborted) {
        if (await flushEffectSurfaces(host)) {
          if (abort.signal.aborted) return false;
          // A frame from the initial DOM commit must not qualify before readiness.
          const context = marker.current?.getContext("2d");
          if (!context) return false;
          const value = parseInt(captureToken, 16);
          for (let row = 0; row < 12; row++) {
            context.fillStyle = `rgb(${[0, 1, 2].map((channel) => (Math.floor(value / 2 ** (35 - row * 3 - channel)) % 2 ? 224 : 32)).join(",")})`;
            context.fillRect(0, row, 1, 1);
          }
          return true;
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
