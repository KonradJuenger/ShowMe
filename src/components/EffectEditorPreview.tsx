import { EFFECT_SCHEDULE_VERSION } from "../core/motionModel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  effectDependencies,
  compatibleEffectValue,
  effectTiming,
  newEffectInstance,
  type EffectDefinition,
  type EffectParameterValue,
  type EffectClockEndpoint,
} from "../core/effects";
import type { EditorSnapshot } from "../core/editorCommands";
import type { SlideMotion, EffectSchedule } from "../core/motionModel";
import type { Element } from "../core/element";
import { EffectSampleImage } from "./EffectSampleImage";
import { EffectSurface } from "./EffectSurface";
import { ContentEffectPreview } from "./ContentEffectPreview";

/** Transport stays local to Preview; code and parameter editors do not render each tick. */
export function EffectEditorPreview({
  tested,
  definition,
  snapshot,
  element,
  timeSchedule,
}: {
  tested: EffectDefinition | null;
  timeSchedule?: EffectSchedule;
  definition: EffectDefinition;
  snapshot: EditorSnapshot;
  element: Element | null;
}) {
  const [clocks, setClocks] = useState({
      presentationTime: 0,
      slideTime: 0,
      stepTime: 0,
      stageStarts: [0],
      slideEnd: undefined as EffectClockEndpoint | undefined,
    }),
    [active] = useState(true),
    [playing, setPlaying] = useState(true);
  const [source, setSource] = useState(
    element &&
      (definition.target !== "text" || element.content?.type === "text")
      ? "selection"
      : "sample",
  );
  const previewViewport = useRef<HTMLDivElement>(null);
  const [previewSize, setPreviewSize] = useState({ width: 280, height: 140 });
  useLayoutEffect(() => {
    const node = previewViewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setPreviewSize({ width: node.clientWidth, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const [values, setValues] = useState<Record<string, EffectParameterValue>>(
    {},
  );
  const dependencies = effectDependencies(tested ?? definition);
  const canPlayTime = dependencies.continuous || dependencies.progress;
  useEffect(() => {
    if (!playing || !canPlayTime) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(),
        elapsed = (now - last) / 1000;
      last = now;
      setClocks((current) => ({
        presentationTime: current.presentationTime + elapsed,
        slideTime: current.slideTime + elapsed,
        stepTime: current.stepTime + elapsed,
        stageStarts: current.stageStarts,
        slideEnd: current.slideEnd,
      }));
    }, 30);
    return () => window.clearInterval(timer);
  }, [playing, canPlayTime]);
  const previewDefinition = tested ?? definition;
  const control = previewDefinition.timeControl;
  const start = timeSchedule?.start ?? control?.start ?? "slide";
  const previewMotion: SlideMotion = {
    stages: [
      { id: "entry", tracks: [] },
      {
        id: "click",
        tracks: [],
        blocks: [
          {
            id: "preview",
            label: "Preview",
            members: [],
            binding: {
              kind: "effect",
              elementId: "preview",
              effectInstanceId: "preview",
            },
            effectSchedule: {
              version: EFFECT_SCHEDULE_VERSION,
              start,
              startOffsetMs: timeSchedule?.startOffsetMs ?? 0,
              stop: (timeSchedule?.stop.mode === "click"
                ? { mode: "click", stageId: "next" }
                : timeSchedule?.stop) ??
                control?.stop ?? { mode: "none" },
              progressEasing: timeSchedule?.progressEasing,
            },
          },
        ],
      },
      { id: "next", tracks: [] },
    ],
  };
  const stopMode = timeSchedule?.stop.mode ?? control?.stop.mode;
  const timing = effectTiming(
    previewMotion,
    clocks.stageStarts.length - 1,
    clocks.stepTime * 1000,
    "preview",
    "preview",
    clocks,
    control,
  );
  const effectTime = timing.time,
    progress = timing.progress,
    duration = timing.duration * 1000;
  const instance = useMemo(
    () =>
      tested && {
        ...newEffectInstance(
          "studio-preview",
          tested,
          tested.target === "text" || tested.target === "content"
            ? "content"
            : tested.target,
        ),
        parameters: Object.fromEntries(
          tested.parameters.map((p) => [
            p.key,
            compatibleEffectValue(values[p.key], p) ? values[p.key] : p.default,
          ]),
        ),
      },
    [tested, values],
  );

  const selectionAvailable =
    !!element &&
    (tested?.target !== "text" || element.content?.type === "text");
  const previewSource =
    (source === "selection" && !selectionAvailable) ||
    (source === "image" && tested?.input !== "content") ||
    (source === "slide" && tested?.input !== "backdrop")
      ? "sample"
      : source;
  return (
    <section aria-label="Preview">
      <h3>Preview</h3>
      <label>
        Preview source
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {definition.input === "content" && (
            <option value="image">Sample image</option>
          )}
          <option value="sample">
            {definition.kind === "text-js"
              ? "Sample text"
              : "Sample shapes/frame"}
          </option>
          <option
            value="selection"
            disabled={
              !element ||
              (definition.target === "text" && element.content?.type !== "text")
            }
          >
            Current selection
          </option>
          {definition.input === "backdrop" && (
            <option value="slide">Current slide</option>
          )}
        </select>
      </label>
      <div className="effect-code-preview" ref={previewViewport}>
        {tested &&
          instance &&
          (previewSource === "image" && tested.input === "content" ? (
            <EffectSampleImage
              definition={tested}
              instance={instance}
              progress={progress}
              duration={duration}
              time={effectTime}
              clocks={{ ...clocks, stepIndex: clocks.stageStarts.length - 1 }}
              active={active}
              started={timing.started}
            />
          ) : tested.input === "content" || tested.input === "backdrop" ? (
            <ContentEffectPreview
              definition={tested}
              instance={instance}
              element={previewSource === "sample" ? null : element}
              snapshot={snapshot}
              progress={progress}
              duration={duration}
              time={effectTime}
              clocks={{ ...clocks, stepIndex: clocks.stageStarts.length - 1 }}
              active={active}
              started={timing.started}
              wholeSlide={previewSource === "slide"}
              viewport={previewSize}
            />
          ) : (
            <EffectSurface
              definition={tested}
              instance={instance}
              width={previewSize.width}
              height={previewSize.height}
              previewTiming={{
                progress,
                time: effectTime,
                ...clocks,
                stepIndex: clocks.stageStarts.length - 1,
                active,
                started: timing.started,
                duration: duration / 1000,
              }}
            >
              <span data-text-content="true">
                {previewSource === "selection" &&
                element?.content?.type === "text"
                  ? element.content.text
                  : "SCRAMBLE REVEAL"}
              </span>
            </EffectSurface>
          ))}
      </div>
      {(canPlayTime || dependencies.stepState) && (
        <div>
          {canPlayTime && (
            <button onClick={() => setPlaying(!playing)}>
              {playing ? "Pause" : "Play time"}
            </button>
          )}
          <button
            onClick={() =>
              setClocks({
                presentationTime: 0,
                slideTime: 0,
                stepTime: 0,
                stageStarts: [0],
                slideEnd: undefined as EffectClockEndpoint | undefined,
              })
            }
          >
            {canPlayTime ? "Reset time" : "Reset"}
          </button>
          <button
            onClick={() =>
              setClocks((current) => ({
                ...current,
                stepTime: 0,
                stageStarts: [...current.stageStarts, current.slideTime],
              }))
            }
          >
            Preview click
          </button>
          {stopMode === "slide-end" && (
            <button
              onClick={() =>
                setClocks((current) => ({
                  ...current,
                  slideEnd: {
                    slideTime: current.slideTime,
                    presentationTime: current.presentationTime,
                  },
                }))
              }
            >
              Preview end
            </button>
          )}
          <output aria-label="Effect preview time">
            t = {(effectTime * (tested?.speed ?? 1)).toFixed(2)} s
          </output>
        </div>
      )}
      {dependencies.progress && (
        <output aria-label="Effect preview progress">
          p = {progress.toFixed(2)}
        </output>
      )}
      {stopMode === "after" && (
        <label>
          Time (s)
          <input
            aria-label="Effect preview interval time"
            type="range"
            min={0}
            max={duration / 1000}
            step={0.01}
            value={effectTime}
            onChange={(event) => {
              setPlaying(false);
              const seconds =
                Number(event.currentTarget.value) +
                (start === "click"
                  ? (timeSchedule?.startOffsetMs ?? 0) / 1000
                  : 0);
              setClocks({
                presentationTime: seconds,
                slideTime: seconds,
                stepTime: seconds,
                stageStarts: start === "click" ? [0, 0] : [0],
                slideEnd: undefined,
              });
            }}
          />
        </label>
      )}
      <h4>Live parameters</h4>
      {definition.parameters.map((p) => (
        <label key={p.key}>
          {p.label}
          <input
            aria-label={`Preview ${p.label}`}
            type={
              p.type === "boolean"
                ? "checkbox"
                : p.type === "string"
                  ? "text"
                  : "number"
            }
            step="any"
            min={p.type === "number" ? p.min : undefined}
            max={p.type === "number" ? p.max : undefined}
            maxLength={4096}
            checked={
              p.type === "boolean"
                ? Boolean(
                    compatibleEffectValue(values[p.key], p)
                      ? values[p.key]
                      : p.default,
                  )
                : undefined
            }
            value={
              p.type === "boolean"
                ? undefined
                : String(
                    compatibleEffectValue(values[p.key], p)
                      ? values[p.key]
                      : p.default,
                  )
            }
            onChange={(e) =>
              setValues({
                ...values,
                [p.key]:
                  p.type === "boolean"
                    ? e.target.checked
                    : p.type === "string"
                      ? e.target.value
                      : Number(e.target.value),
              })
            }
          />
        </label>
      ))}
    </section>
  );
}
