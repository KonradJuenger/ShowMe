import { EFFECT_SCHEDULE_VERSION } from "../core/motionModel";
import { EffectTimeControls } from "./EffectTimeControls";
import { createTextEffectRunner } from "./textEffectRunner";
import { shaderProgram, compileEffectCss } from "./effectRuntime";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  effectAuthoringDiagnostics,
  effectDefinitionSchema,
  isReservedEffectParameter,
  reconcileShaderSource,
  type EffectDefinition,
} from "../core/effects";
import type { LibraryEffectAsset } from "../core/libraryEffects";
import type { EffectSchedule } from "../core/motionModel";
import type { EditorSnapshot } from "../core/editorCommands";
import type { Element } from "../core/element";
import { platform } from "../platform";
import { requestEffectLibrary } from "./useEffectLibrary";
import { EffectEditorPreview } from "./EffectEditorPreview";
import {
  EffectErrorCopyContext,
  EffectErrorMessage,
} from "./EffectErrorMessage";
import "./EffectEditor.css";
import { EffectParameterEditor } from "./EffectParameterEditor";
import {
  blankEffect,
  blankTextJs,
  shaderBoilerplate,
  effectAffects,
  changeEffectAffects,
  buildEffectAuthoringPrompt,
  extractSingleGlslFence,
  type EffectAffects,
  type EffectAuthoringType,
} from "../core/effectAuthoring";

function draftKey(value: EffectDefinition) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

type EffectEditorProps = {
  timeControls?: ReactNode;
  timeSchedule?: EffectSchedule;
  timeControlDescription?: { start: string; stop: string };
  definition: EffectDefinition | null;
  asset?: LibraryEffectAsset;
  folder?: string;
  snapshot: EditorSnapshot;
  element: Element | null;
  onChange(definition: EffectDefinition): void;
  onClose(): void;
  onSaved(asset: LibraryEffectAsset): void | Promise<void>;
  beforeSave?(definition: EffectDefinition): boolean;
  builtin?: boolean;
  creating?: boolean;
};
export function EffectEditor(props: EffectEditorProps) {
  const drafts = useRef<Partial<Record<EffectAuthoringType, EffectDefinition>>>(
    {},
  );
  const editedSources = useRef(new Set<EffectAuthoringType>());
  const family: EffectAuthoringType | undefined = props.definition
    ? props.definition.kind === "fragment-glsl"
      ? "shader"
      : "css-js"
    : undefined;
  if (family && !props.creating) editedSources.current.add(family);
  function changeType(type: EffectAuthoringType) {
    if (family && props.definition) drafts.current[family] = props.definition;
    const next = {
      ...(drafts.current[type] ?? blankEffect(type)),
      ...(props.definition
        ? {
            name: props.definition.name,
            category: props.definition.category,
            speed: props.definition.speed,
            timeControl: props.definition.timeControl,
          }
        : {}),
    };
    props.onChange(next);
  }
  return props.definition ? (
    <EffectEditorDraft
      key={family}
      {...props}
      definition={props.definition}
      onTypeChange={changeType}
      sourceWasEdited={!!family && editedSources.current.has(family)}
      onSourceEdited={() => {
        if (family) editedSources.current.add(family);
      }}
    />
  ) : (
    <EffectEditorSetup onTypeChange={changeType} onClose={props.onClose} />
  );
}
function EffectEditorSetup({
  onTypeChange,
  onClose,
}: {
  onTypeChange(type: EffectAuthoringType): void;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <div className="effect-editor-shade">
      <div
        ref={root}
        tabIndex={-1}
        className="effect-editor"
        role="dialog"
        aria-modal="true"
        aria-label="Effect Editor"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s")
            e.preventDefault();
          if (e.key === "Tab") {
            const nodes = Array.from(
              root.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled), select",
              ),
            );
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && index <= 0) {
              e.preventDefault();
              nodes.at(-1)?.focus();
            } else if (
              !e.shiftKey &&
              (index < 0 || index === nodes.length - 1)
            ) {
              e.preventDefault();
              nodes[0]?.focus();
            }
          }
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <header>
          <strong>Effect Editor</strong>
          <span>New Effect</span>
          <button data-effect-editor-save disabled>
            Save
          </button>
          <button aria-label="Close Effect Editor" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="effect-editor-columns">
          <section aria-label="Definition">
            <h3>Definition</h3>
            <label>
              Type
              <select
                aria-label="Effect type"
                value=""
                onChange={(e) =>
                  onTypeChange(e.target.value as EffectAuthoringType)
                }
              >
                <option value="" disabled>
                  Choose a type…
                </option>
                <option value="shader">Shader</option>
                <option value="css-js">CSS + JS</option>
              </select>
            </label>
            <p>Choose how this effect is built.</p>
          </section>
          <section aria-label="Code" className="effect-editor-code">
            <h3>Code</h3>
            <p>Choose a type to begin editing code.</p>
          </section>
          <section aria-label="Preview">
            <h3>Preview</h3>
            <p>Your Effect preview will appear here.</p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
function EffectEditorDraft({
  definition,
  asset,
  folder,
  snapshot,
  element,
  onChange,
  onClose,
  onSaved,
  beforeSave,
  builtin = false,
  creating = false,
  onTypeChange,
  sourceWasEdited,
  onSourceEdited,
  timeControls,
  timeControlDescription,
  timeSchedule,
}: Omit<EffectEditorProps, "definition"> & {
  definition: EffectDefinition;
  onTypeChange(type: EffectAuthoringType): void;
  sourceWasEdited: boolean;
  onSourceEdited(): void;
}) {
  const [saved, setSaved] = useState(asset);
  const [baseline, setBaseline] = useState(
    asset ? draftKey(asset.definition) : creating ? "" : draftKey(definition),
  );
  const [tested, setTested] = useState<EffectDefinition | null>(definition);
  const [copied, setCopied] = useState(false);
  const [codeTab, setCodeTab] = useState(
    definition.kind === "text-js" ? "style" : "source",
  );
  const sourceEdited = useRef(sourceWasEdited);
  const textJs = useRef(
    definition.kind === "text-js" ? definition.source : blankTextJs,
  );
  const [error, setError] = useState(""),
    [closing, setClosing] = useState(false),
    [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dirty = baseline !== draftKey(definition);
  const diagnostics = effectAuthoringDiagnostics(definition);
  useEffect(() => {
    if (closing)
      root.current
        ?.querySelector<HTMLElement>('[role="alertdialog"] button')
        ?.focus();
  }, [closing]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => previous?.focus();
  }, []);
  function update(patch: Partial<EffectDefinition>) {
    const next =
      definition.kind === "fragment-glsl" && typeof patch.source === "string"
        ? { ...reconcileShaderSource(definition, patch.source), ...patch }
        : { ...definition, ...patch };
    onChange(next);
    setError("");
  }
  async function validateCode(parsed: EffectDefinition) {
    if (parsed.kind === "fragment-glsl") shaderProgram(parsed.source);
    if (parsed.kind === "css")
      compileEffectCss(parsed.source, "studio-validation");
    if (parsed.kind === "text-js") {
      if (parsed.styleSource)
        compileEffectCss(parsed.styleSource, "studio-validation");
      const runner = createTextEffectRunner(parsed.source);
      try {
        await runner.render({
          text:
            element?.content?.type === "text"
              ? element.content.text
              : "SCRAMBLE REVEAL",
          t: 0,
          p: 0.5,
          duration: 1,
          slideTime: 0,
          presentationTime: 0,
          stepTime: 0,
          stepIndex: 0,
          active: true,
          parameters: Object.fromEntries(
            parsed.parameters.map((p) => [p.key, p.default]),
          ),
        });
      } finally {
        runner.dispose();
      }
    }
  }
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const parsed = effectDefinitionSchema.parse(definition);
          const messages = effectAuthoringDiagnostics(parsed);
          if (messages.length) throw new Error(messages.join("; "));
          await validateCode(parsed);
          if (!cancelled) {
            setTested(parsed);
            setError("");
          }
        } catch (error) {
          if (!cancelled) setError(String(error));
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Clock/parameter preview changes do not recompile source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition]);
  async function copyPrompt() {
    try {
      const prompt = buildEffectAuthoringPrompt(definition, {
        creating,
        previewElementName: element?.name,
        timeControl: timeControlDescription,
      });
      if (platform.writeTextClipboard)
        await platform.writeTextClipboard(prompt);
      else await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch (error) {
      setError("Could not copy Effect prompt: " + String(error));
    }
  }
  async function save(close = false) {
    if (saving) return;
    setSaving(true);
    try {
      const parsed = effectDefinitionSchema.parse(definition);
      if (diagnostics.length) throw new Error(diagnostics.join("; "));
      await validateCode(parsed);
      if (beforeSave && !beforeSave(parsed)) return;
      setTested(parsed);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      for (
        let attempt = 0;
        attempt < 40 &&
        !root.current?.querySelector(
          '[data-effect-ready="true"], [data-effect-error]',
        );
        attempt++
      )
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      const previewError = root.current?.querySelector<HTMLElement>(
        "[data-effect-error]",
      );
      if (previewError)
        throw new Error(previewError.dataset.effectError || "Preview failed");
      if (!root.current?.querySelector('[data-effect-ready="true"]'))
        throw new Error("Wait for the preview to finish testing.");
      const library = await requestEffectLibrary({
        type: "save",
        definition: parsed,
        id: saved?.id,
        revision: saved?.revision,
        folder: saved ? undefined : folder,
      });
      const next = saved
        ? library.entries.find((e) => e.asset.id === saved.id)!.asset
        : library.entries.at(-1)!.asset;
      setSaved(next);
      await onSaved(next);
      setBaseline(draftKey(parsed));
      setError("");
      if (close || !element || creating) onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  function close() {
    if (dirty) setClosing(true);
    else onClose();
  }
  return createPortal(
    <div className="effect-editor-shade">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Effect Editor"
        className="effect-editor"
        ref={root}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            if (closing) setClosing(false);
            else close();
          }
          if (e.key === "Tab") {
            const focusRoot =
              root.current!.querySelector('[role="alertdialog"]') ??
              root.current!;
            const nodes = Array.from(
              focusRoot.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input, select, textarea, summary, [tabindex="0"]',
              ),
            ).filter((node) => node.getClientRects().length > 0);
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && index <= 0) {
              e.preventDefault();
              nodes.at(-1)?.focus();
            } else if (
              !e.shiftKey &&
              (index === nodes.length - 1 || index < 0)
            ) {
              e.preventDefault();
              nodes[0]?.focus();
            }
          }
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <header>
          <strong>Effect Editor</strong>
          <span>
            {definition.name} · Effect definition ·{" "}
            {dirty ? "Modified" : "Saved"}
            {builtin && " · Built-in · Save creates an editable copy"}
            {element && (
              <small className="effect-preview-context">
                Previewing on {element.name || "Element"}
              </small>
            )}
          </span>
          <button
            data-effect-editor-save
            disabled={
              saving ||
              definition.parameters.some((p) =>
                isReservedEffectParameter(p.key),
              )
            }
            onClick={() => void save()}
          >
            Save
          </button>
          <button aria-label="Close Effect Editor" onClick={close}>
            ×
          </button>
        </header>
        <div className="effect-editor-columns">
          <section aria-label="Definition">
            <h3>Definition</h3>
            <label>
              Type
              <select
                aria-label="Effect type"
                value={
                  definition.kind === "fragment-glsl" ? "shader" : "css-js"
                }
                onChange={(e) =>
                  onTypeChange(e.target.value as EffectAuthoringType)
                }
              >
                <option value="shader">Shader</option>
                <option value="css-js">CSS + JS</option>
              </select>
            </label>
            <label>
              Name
              <input
                value={definition.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <label>
              Affects
              <select
                aria-label="Effect affects"
                value={effectAffects(definition)}
                onChange={(e) => {
                  const affects = e.target.value as EffectAffects;
                  const untouched =
                    !sourceEdited.current &&
                    definition.source ===
                      shaderBoilerplate(effectAffects(definition));
                  if (definition.kind === "text-js")
                    textJs.current = definition.source;
                  const next = changeEffectAffects(
                    definition,
                    affects,
                    untouched,
                  );
                  if (next.kind === "text-js" && definition.kind !== "text-js")
                    next.source = textJs.current;
                  onChange(next);
                  setCodeTab(next.kind === "text-js" ? "style" : "source");
                }}
              >
                {definition.kind === "fragment-glsl" ? (
                  <>
                    <option value="pixels">Element pixels</option>
                    <option value="backdrop">Backdrop behind frame</option>
                    <option value="generated">Generated layer</option>
                  </>
                ) : (
                  <>
                    <option value="element">Element</option>
                    <option value="text">Text</option>
                  </>
                )}
              </select>
            </label>
            {(definition.target === "background" ||
              definition.target === "overlay") &&
              definition.input !== "backdrop" && (
                <label>
                  Placement
                  <select
                    aria-label="Generated layer placement"
                    value={definition.target}
                    onChange={(e) =>
                      update({
                        target: e.target.value as "background" | "overlay",
                      })
                    }
                  >
                    <option value="background">Background</option>
                    <option value="overlay">Overlay</option>
                  </select>
                </label>
              )}
            <h3>Timing</h3>
            <p>t = Effect time · p = interval completion</p>
            {timeControls ?? (
              <EffectTimeControls
                value={{
                  start: definition.timeControl.start,
                  version: EFFECT_SCHEDULE_VERSION,
                  stop: definition.timeControl?.stop ?? { mode: "none" },
                }}
                onChange={(value) => {
                  if (value.stop.mode !== "click")
                    update({
                      timeControl: {
                        start: value.start ?? "slide",
                        stop: value.stop,
                      },
                    });
                }}
              />
            )}
            <label>
              Speed
              <div className="effect-speed">
                <input
                  aria-label="Effect speed"
                  type="number"
                  min={0}
                  max={10}
                  step={0.25}
                  value={definition.speed ?? 1}
                  onChange={(e) => update({ speed: Number(e.target.value) })}
                />
                ×
              </div>
            </label>
            <EffectParameterEditor definition={definition} onChange={update} />
          </section>
          <section aria-label="Code" className="effect-editor-code">
            <div className="effect-code-heading">
              <h3>Code</h3>
              <button onClick={() => void copyPrompt()}>Copy AI prompt</button>
            </div>
            {copied && <span role="status">Effect prompt copied</span>}
            {definition.kind !== "fragment-glsl" &&
              definition.target === "text" && (
                <div>
                  <button
                    aria-pressed={
                      definition.kind === "css" || codeTab === "style"
                    }
                    onClick={() =>
                      setCodeTab(definition.kind === "css" ? "source" : "style")
                    }
                  >
                    CSS
                  </button>
                  <button
                    aria-pressed={
                      definition.kind === "text-js" && codeTab === "source"
                    }
                    onClick={() => {
                      if (definition.kind === "css")
                        onChange(
                          changeEffectAffects(definition, "text", false),
                        );
                      setCodeTab("source");
                    }}
                  >
                    JS
                  </button>
                </div>
              )}
            <textarea
              aria-label={codeTab === "style" ? "Effect style" : "Effect code"}
              spellCheck={false}
              value={
                codeTab === "style"
                  ? (definition.styleSource ?? "")
                  : definition.source
              }
              onChange={(e) => {
                sourceEdited.current = true;
                onSourceEdited();
                setCopied(false);
                update(
                  codeTab === "style"
                    ? { styleSource: e.target.value }
                    : { source: e.target.value },
                );
              }}
              onPaste={(e) => {
                if (definition.kind !== "fragment-glsl" || codeTab !== "source")
                  return;
                const source = extractSingleGlslFence(
                  e.clipboardData.getData("text/plain"),
                );
                if (source === null) return;
                e.preventDefault();
                sourceEdited.current = true;
                onSourceEdited();
                setCopied(false);
                update({ source });
              }}
            />
            {diagnostics.map((message) => (
              <p role="alert" key={message}>
                <EffectErrorMessage message={message} />
              </p>
            ))}
            {error && (
              <p role="alert">
                <EffectErrorMessage message={error} />
              </p>
            )}
          </section>
          <EffectErrorCopyContext value={true}>
            <EffectEditorPreview
              timeSchedule={timeSchedule}
              tested={tested}
              definition={definition}
              snapshot={snapshot}
              element={element}
            />
          </EffectErrorCopyContext>
        </div>
        <footer>
          <span>
            {error || diagnostics.length
              ? "Compile error"
              : dirty
                ? "Unsaved changes"
                : "Saved"}
          </span>
        </footer>
        {closing && (
          <div className="effect-editor-discard-shade">
            <div
              className="effect-editor-discard"
              role="alertdialog"
              aria-modal="true"
              aria-label="Unsaved Effect"
              aria-describedby="effect-editor-discard-description"
            >
              <h2>Save changes to Library?</h2>
              <p id="effect-editor-discard-description">
                Your effect has unsaved changes. Save them before closing?
              </p>
              <div className="effect-editor-discard-actions">
                <button onClick={() => setClosing(false)}>Keep editing</button>
                <button onClick={onClose}>Discard changes</button>
                <button className="primary" onClick={() => void save(true)}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
