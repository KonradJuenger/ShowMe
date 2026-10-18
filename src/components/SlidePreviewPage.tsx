import { EffectThumbnailPreview } from "./EffectThumbnailPreview";
import type { EffectDefinition } from "../core/effects";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createRef } from "react";
import type { DocumentProjection } from "../core/documentProjection";
import { platform } from "../platform";
import { SlideRenderer } from "./SlideRenderer";
import { waitForSlideImages } from "./audienceImagePreparation";
import { flushEffectSurfaces } from "./effectRuntime";
import type { AgentPreviewWarning } from "../core/agentPreview";
import { measureText } from "./editor/textLayout";
import type { Element as SceneElement } from "../core/element";
import type { TextContent, TextMeasurement } from "../core/text";
import { validateEffectDefinitionProduction } from "./effectValidation";
import type { EffectValidationResult } from "../core/effectValidation";

declare global {
  interface Window {
    measureAgentText?: (
      documentId: string,
      element: SceneElement & { content: TextContent },
    ) => Promise<TextMeasurement | null>;
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
    ) => Promise<boolean>;
  }
}

/** Isolated native capture surface; visual semantics stay in shared renderers. */
export function installSlidePreviewPage() {
  const host = document.getElementById("root")!;
  document.body.style.margin = "0";
  const root = createRoot(host);
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
  ) => {
    const profile = { width, height, mode: "live" as const };
    const marker = createRef<HTMLCanvasElement>();
    await platform.managedFonts?.(projection.documentId);
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
            <SlideRenderer
              slide={projection.slide}
              deck={projection.deck}
              templates={projection.templates}
              staticVideo
              preparedImages
              renderProfile={profile}
            />
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
