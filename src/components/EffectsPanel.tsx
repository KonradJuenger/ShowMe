import { EFFECT_SCHEDULE_VERSION } from "../core/motionModel";
import {
  addEffectTrigger,
  findEffectTrigger,
  editEffectSchedule,
} from "../core/effectSequence";
import { dissolveEffect } from "../core/dissolveEffect";
import { useEffect, useRef, useState } from "react";
import { EffectTimeControls } from "./EffectTimeControls";
import type { MotionWorkspace } from "./MotionWorkspace";
import { EffectEditor } from "./EffectEditor";
import { EffectLibraryPanel } from "./EffectLibraryPanel";
import { useEffectLibrary } from "./useEffectLibrary";
import { type LibraryEffectAsset } from "../core/libraryEffects";
import {
  effectParameters,
  consumedParameter,
  effectProperty,
  effectTemplates,
  type EffectDefinition,
  type EffectParameterValue,
  type ElementEffect,
  effectStartLabels,
  effectDependencies,
} from "../core/effects";
import {
  setSlideEffects,
  setElementEffectDefinition,
  setElementEffectParameterValue,
  type EditorSnapshot,
} from "../core/editorCommands";
import { findElement, isEditableScope } from "../core/scene";
import type { Element } from "../core/element";
import type { SidebarController } from "./sidebarEditing";
import { scopesForOperations } from "../core/documentAuthority";
import { editorOperations } from "../core/editorChange";
import "./EffectsPanel.css";
function EffectParameterControl({
  definition,
  instance,
  parameter,
  onPreview,
  onCommitPreview,
  onCommitValue,
}: {
  definition: EffectDefinition;
  instance: ElementEffect;
  parameter: EffectDefinition["parameters"][number];
  onPreview(value: number): void;
  onCommitPreview(): void;
  onCommitValue(value: EffectParameterValue): void;
}) {
  const storedValue = instance.parameters[parameter.key] ?? parameter.default;
  const numberInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = numberInput.current;
    if (
      !input ||
      parameter.type !== "number" ||
      input === document.activeElement
    )
      return;
    input.value = String(consumedParameter(storedValue, parameter));
  }, [storedValue, parameter]);
  if (parameter.type !== "number")
    return (
      <div className="effect-instance-parameter">
        <span className="effect-instance-parameter-name">
          {parameter.label}
        </span>
        {parameter.type === "boolean" ? (
          <input
            type="checkbox"
            aria-label={`${definition.name} ${parameter.label}`}
            checked={storedValue === true}
            onChange={(event) => onCommitValue(event.target.checked)}
          />
        ) : (
          <input
            type="text"
            aria-label={`${definition.name} ${parameter.label}`}
            maxLength={4096}
            key={`${instance.id}-${parameter.key}-${storedValue}`}
            defaultValue={String(storedValue)}
            onBlur={(event) => {
              if (event.target.value !== storedValue)
                onCommitValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        )}
      </div>
    );
  const numericValue =
    typeof storedValue === "number" ? storedValue : parameter.default;
  const bounded =
    parameter.min !== undefined &&
    parameter.max !== undefined &&
    Number.isFinite(parameter.min) &&
    Number.isFinite(parameter.max);
  const value = bounded
    ? (consumedParameter(numericValue, parameter) as number)
    : numericValue;
  return (
    <div className="effect-instance-parameter">
      <span className="effect-instance-parameter-name">{parameter.label}</span>
      <div className="effect-instance-parameter-values">
        {bounded && (
          <input
            aria-label={`${definition.name} ${parameter.label} slider`}
            type="range"
            min={parameter.min}
            max={parameter.max}
            step="any"
            value={value}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) onPreview(next);
            }}
            onPointerUp={onCommitPreview}
            onPointerCancel={onCommitPreview}
            onKeyUp={onCommitPreview}
            onBlur={onCommitPreview}
          />
        )}
        <input
          aria-label={`${definition.name} ${parameter.label}`}
          type="number"
          step="any"
          min={parameter.min}
          max={parameter.max}
          ref={numberInput}
          key={`${instance.id}-${parameter.key}`}
          defaultValue={value}
          onBlur={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (!Number.isFinite(next)) {
              event.currentTarget.value = String(value);
              return;
            }
            const committed = Math.max(parameter.min ?? -Infinity, next);
            event.currentTarget.value = String(committed);
            if (committed !== value) onCommitValue(committed);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape")
                event.currentTarget.value = String(value);
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </div>
  );
}

export function EffectsPanel({
  snapshot,
  element,
  controller,
  onError,
  workspace,
}: {
  workspace: MotionWorkspace;
  snapshot: EditorSnapshot;
  element: Element | null;
  controller: SidebarController;
  onError(error: unknown): void;
}) {
  const editingTemplate = snapshot.deck.templateIds.includes(snapshot.slide.id);
  function timeControls(instanceId?: string) {
    const instance = element?.effects?.find((i) => i.id === instanceId);
    if (!element || !instance) return undefined;
    const trigger = findEffectTrigger(
      snapshot.slide.motion,
      element.id,
      instance.id,
    );
    const schedule =
      trigger &&
      snapshot.slide.motion?.stages[trigger.index].blocks?.find(
        (b) => b.id === trigger.id,
      )?.effectSchedule;
    const definition = snapshot.slide.effectResources![instance.resourceId];
    const start = schedule?.start ?? definition.timeControl.start;
    const startIndex =
      start === "click"
        ? (trigger?.index ?? (workspace.open ? workspace.active : 0))
        : 0;
    return (
      <EffectTimeControls
        easing={schedule?.progressEasing}
        onEasingChange={
          !editingTemplate && effectDependencies(definition).progress
            ? (easing) => {
                workspace.change((motion) => {
                  const next = trigger
                    ? motion!
                    : addEffectTrigger(
                        motion,
                        workspace.open ? workspace.active : 0,
                        element.id,
                        instance,
                        definition,
                      );
                  const target = findEffectTrigger(
                    next,
                    element.id,
                    instance.id,
                  )!;
                  return editEffectSchedule(
                    next,
                    target.index,
                    target.id,
                    (value) => {
                      value.progressEasing = easing;
                    },
                  );
                });
              }
            : undefined
        }
        value={
          schedule
            ? {
                ...schedule,
                start,
              }
            : {
                version: EFFECT_SCHEDULE_VERSION,
                start,
                stop: definition.timeControl?.stop ?? { mode: "none" },
              }
        }
        clicks={(snapshot.slide.motion?.stages ?? []).flatMap((stage, index) =>
          index > startIndex ? [{ id: stage.id, label: `Click ${index}` }] : [],
        )}
        onChange={(value) => {
          if (editingTemplate && value.stop.mode !== "click") {
            const timeControl = { start: value.start, stop: value.stop };
            void change((current) => {
              const target = findElement(current.slide, element.id)!;
              const applied = target.effects!.find(
                (effect) => effect.id === instance.id,
              )!;
              const currentDefinition =
                current.slide.effectResources![applied.resourceId];
              return setElementEffectDefinition(
                current,
                element.id,
                { ...currentDefinition, timeControl },
                instance.id,
              );
            });
            return;
          }
          workspace.change((m) => {
            const index =
              trigger?.index ?? (workspace.open ? workspace.active : 0);
            const next = trigger
              ? m!
              : addEffectTrigger(m, index, element.id, instance, {
                  ...definition,
                  timeControl: {
                    ...definition.timeControl,
                    start: value.start,
                  },
                });
            const target = findEffectTrigger(next, element.id, instance.id)!;
            return editEffectSchedule(next, target.index, target.id, (s) => {
              Object.assign(s, value);
              if (s.start === "click" && s.stop.mode === "click") {
                const stopId = s.stop.stageId;
                if (
                  next.stages.findIndex((stage) => stage.id === stopId) <=
                  target.index
                )
                  s.stop = { mode: "none" };
              }
            });
          });
        }}
      />
    );
  }
  const [draft, setDraft] = useState<{
    definition: EffectDefinition | null;
    instanceId?: string;
    original?: string;
    asset?: LibraryEffectAsset;
    builtin?: boolean;
    creating?: boolean;
  } | null>(null);
  const { library, error: libraryError } = useEffectLibrary();
  const [managing, setManaging] = useState(false);
  const [picking, setPicking] = useState(false);
  const dragged = useRef<string | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const [focusInstanceId, setFocusInstanceId] = useState<string | null>(null);
  useEffect(() => {
    const focus = (event: Event) => {
      const instanceId = (event as CustomEvent<{ instanceId?: string }>).detail
        ?.instanceId;
      if (!instanceId) return;
      setManaging(false);
      setPicking(false);
      setFocusInstanceId(instanceId);
    };
    document.addEventListener("showme-effect-focus", focus);
    return () => document.removeEventListener("showme-effect-focus", focus);
  }, []);
  useEffect(() => {
    if (!focusInstanceId) return;
    const target = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-effect-instance]") ??
        [],
    ).find((node) => node.dataset.effectInstance === focusInstanceId);
    target?.scrollIntoView({ block: "nearest" });
    target?.focus();
    setFocusInstanceId(null);
  }, [focusInstanceId]);
  const queue = useRef(Promise.resolve());
  const resources = snapshot.slide.effectResources ?? {};
  const editable =
    !!element && isEditableScope(snapshot.slide, snapshot.deck, element.id);
  function change(
    edit: (
      current: EditorSnapshot,
    ) => Parameters<typeof setSlideEffects>[1] | EditorSnapshot,
    applied?: () => void,
  ) {
    const slideId = snapshot.slide.id,
      epoch = controller.epochRef.current;
    const pending = queue.current.then(async () => {
      await controller.flush();
      if (
        controller.epochRef.current !== epoch ||
        controller.snapshotRef.current?.slide.id !== slideId
      )
        throw new Error("The originating slide changed. Reopen Effect Editor.");
      const before = controller.snapshotRef.current!;
      const editResult = edit(before);
      const result =
        "slide" in editResult
          ? editResult
          : setSlideEffects(before, editResult);
      if (
        !(await controller.acquireEditScopes(
          scopesForOperations(before, editorOperations(result)),
        ))
      )
        throw new Error("This slide is being edited by another collaborator");
      try {
        const current = controller.snapshotRef.current;
        if (
          !current ||
          current.slide.id !== slideId ||
          controller.epochRef.current !== epoch
        )
          throw new Error(
            "The originating slide changed. Reopen Effect Editor.",
          );
        if (JSON.stringify(current) !== JSON.stringify(before))
          throw new Error(
            "The document changed while preparing this effect. Try again.",
          );
        controller.apply(result);
        await controller.flush();
        applied?.();
      } finally {
        await controller.releaseLeases();
      }
    });
    queue.current = pending.catch(onError);
    return pending;
  }
  function updateInstance(
    instanceId: string,
    update: (instance: ElementEffect) => ElementEffect | null,
    commit = true,
  ) {
    const current = controller.snapshotRef.current;
    if (!element || !current) return;
    try {
      const target = findElement(current.slide, element.id);
      if (!target || !isEditableScope(current.slide, current.deck, element.id))
        throw new Error("Select an editable Element");
      controller.apply(
        setSlideEffects(current, {
          changes: [
            {
              elementId: element.id,
              value: (target.effects ?? []).flatMap((instance) => {
                if (instance.id !== instanceId) return [instance];
                const next = update(instance);
                return next ? [next] : [];
              }),
            },
          ],
        }),
        commit,
      );
      if (commit) void controller.flush().catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  function attach(definition: EffectDefinition) {
    if (!element) return;
    const elementId = element.id;
    void change((current) =>
      setElementEffectDefinition(
        current,
        elementId,
        definition,
        undefined,
        workspace.open ? workspace.active : 0,
      ),
    );
    setPicking(false);
  }
  async function saved(asset: LibraryEffectAsset) {
    if (!draft || !element) return;
    const elementId = element.id,
      opening = draft;
    await change(
      (current) => {
        const target = findElement(current.slide, elementId);
        if (!target || !isEditableScope(current.slide, current.deck, elementId))
          throw new Error("The originating Element is unavailable");
        const instance = target.effects?.find(
          (i) => i.id === opening.instanceId,
        );
        if (
          opening.instanceId &&
          (!instance ||
            JSON.stringify(
              current.slide.effectResources?.[instance.resourceId],
            ) !== opening.original)
        )
          throw new Error(
            "The originating Effect changed. Reopen its definition.",
          );
        return setElementEffectDefinition(
          current,
          elementId,
          asset.definition,
          opening.instanceId,
          workspace.open ? workspace.active : 0,
        );
      },
      () => setDraft(null),
    );
  }
  function destructive(definition: EffectDefinition) {
    const current = controller.snapshotRef.current;
    if (!current || current.slide.id !== snapshot.slide.id || !element)
      throw new Error("The originating Element is unavailable");
    setElementEffectDefinition(
      current,
      element.id,
      definition,
      draft?.instanceId,
    );
    const instance = element?.effects?.find((i) => i.id === draft?.instanceId);
    if (!instance) return true;
    const keys = new Set(effectParameters(definition).map((p) => p.key));
    const removed = Object.keys(instance.parameters).filter(
      (key) => !keys.has(key),
    );
    const tracks =
      snapshot.slide.motion?.stages
        .flatMap((s) => s.tracks)
        .filter(
          (t) =>
            t.elementId === element?.id &&
            removed.some(
              (key) => t.property === effectProperty(instance.id, key),
            ),
        ) ?? [];
    return (
      (!removed.length && !tracks.length) ||
      window.confirm(
        `Saving removes ${removed.length} parameter override(s) and ${tracks.length} Motion track(s). Save anyway?`,
      )
    );
  }
  return (
    <section ref={root} className="effects-panel" aria-label="Applied Effects">
      <nav className="effect-panel-navigation" aria-label="Effects views">
        <button aria-pressed={!managing} onClick={() => setManaging(false)}>
          Applied
        </button>
        <button aria-pressed={managing} onClick={() => setManaging(true)}>
          My Effects
        </button>
      </nav>
      {managing ? (
        <EffectLibraryPanel
          snapshot={snapshot}
          canApply={(definition) =>
            editable &&
            (definition.target !== "text" || element?.content?.type === "text")
          }
          onApply={(definition) => {
            attach(definition);
            setManaging(false);
          }}
        />
      ) : (
        <>
          <p>{element?.name ?? (element ? "Element" : "Select an Element")}</p>
          {libraryError && <p role="alert">{libraryError}</p>}
          {picking ? (
            <>
              <button onClick={() => setPicking(false)}>← Effects</button>
              <h3>Add Effect</h3>
              <button
                disabled={!editable}
                onClick={() => {
                  setPicking(false);
                  setDraft({ definition: null, creating: true });
                }}
              >
                + New Effect
              </button>
              {[
                {
                  name: "My Effects",
                  entries: library.entries.map(({ asset }) => ({
                    definition: asset.definition,
                    id: asset.id,
                  })),
                },
                {
                  name: "Built-in",
                  entries: [dissolveEffect, ...effectTemplates].map(
                    (definition) => ({ definition, id: definition.name }),
                  ),
                },
              ].map((group) => (
                <div key={group.name}>
                  <h4>{group.name}</h4>
                  <div className="effect-picker-options">
                    {group.entries.map(({ definition, id }) => (
                      <button
                        key={id}
                        disabled={
                          !editable ||
                          (definition.target === "text" &&
                            element?.content?.type !== "text")
                        }
                        onClick={() => attach(structuredClone(definition))}
                      >
                        {definition.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <h4>Applied</h4>
              {element?.effects?.map((instance) => {
                const definition = resources[instance.resourceId];
                if (!definition) return null;

                return (
                  <fieldset
                    key={instance.id}
                    data-effect-instance={instance.id}
                    tabIndex={-1}
                    disabled={!editable}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const source = dragged.current;
                      dragged.current = null;
                      if (!source || source === instance.id) return;
                      const elementId = element.id;
                      void change((current) => {
                        const effects = [
                          ...(findElement(current.slide, elementId)?.effects ??
                            []),
                        ];
                        const from = effects.findIndex((i) => i.id === source),
                          to = effects.findIndex((i) => i.id === instance.id);
                        if (from < 0 || to < 0) return {};
                        effects.splice(to, 0, effects.splice(from, 1)[0]);
                        return { changes: [{ elementId, value: effects }] };
                      });
                    }}
                  >
                    <legend
                      draggable={editable}
                      onDragStart={(event) => {
                        dragged.current = instance.id;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", instance.id);
                      }}
                      onDragEnd={() => {
                        dragged.current = null;
                      }}
                    >
                      ≡ {definition.name}
                    </legend>
                    {effectParameters(definition).map((parameter) => (
                      <EffectParameterControl
                        key={parameter.key}
                        definition={definition}
                        instance={instance}
                        parameter={parameter}
                        onPreview={(value) =>
                          updateInstance(
                            instance.id,
                            (current) => ({
                              ...current,
                              parameters: {
                                ...current.parameters,
                                [parameter.key]: value,
                              },
                            }),
                            false,
                          )
                        }
                        onCommitPreview={() => {
                          controller.commitPreview();
                          void controller.flush().catch(onError);
                        }}
                        onCommitValue={(value) => {
                          const elementId = element.id;
                          void change((current) =>
                            setElementEffectParameterValue(
                              current,
                              elementId,
                              instance.id,
                              parameter.key,
                              value,
                            ),
                          );
                        }}
                      />
                    ))}
                    <EffectParameterControl
                      definition={definition}
                      instance={{
                        ...instance,
                        parameters: { effectSpeed: definition.speed ?? 1 },
                      }}
                      parameter={{
                        type: "number",
                        key: "effectSpeed",
                        label: "Speed",
                        default: 1,
                        min: 0,
                        max: Math.max(10, definition.speed ?? 1),
                      }}
                      onPreview={(speed) => {
                        const current = controller.snapshotRef.current;
                        if (!current) return;
                        const liveInstance = findElement(
                          current.slide,
                          element.id,
                        )?.effects?.find((i) => i.id === instance.id);
                        const live =
                          current.slide.effectResources?.[
                            liveInstance?.resourceId ?? ""
                          ];
                        if (!live) return;
                        controller.apply(
                          setElementEffectDefinition(
                            current,
                            element.id,
                            { ...live, speed },
                            instance.id,
                          ),
                          false,
                        );
                      }}
                      onCommitPreview={() => {
                        controller.commitPreview();
                        void controller.flush().catch(onError);
                      }}
                      onCommitValue={(speed) => {
                        if (typeof speed !== "number") return;
                        const elementId = element.id;
                        void change((current) => {
                          const live = findElement(
                            current.slide,
                            elementId,
                          )?.effects?.find((i) => i.id === instance.id);
                          const resource =
                            current.slide.effectResources?.[
                              live?.resourceId ?? ""
                            ];
                          if (!resource) throw new Error("Effect unavailable");
                          return setElementEffectDefinition(
                            current,
                            elementId,
                            {
                              ...resource,
                              speed: Math.min(100, speed),
                            },
                            instance.id,
                          );
                        });
                      }}
                    />
                    <div className="effect-instance-section">
                      {timeControls(instance.id)}
                    </div>
                    <div
                      className="effect-instance-actions"
                      aria-label={`${definition.name} actions`}
                    >
                      <button
                        onClick={() =>
                          setDraft({
                            definition: {
                              ...structuredClone(definition),
                            },
                            instanceId: instance.id,
                            original: JSON.stringify(definition),
                            asset: library.entries.find(
                              (e) =>
                                JSON.stringify(e.asset.definition) ===
                                JSON.stringify(definition),
                            )?.asset,
                            builtin:
                              !library.entries.some(
                                (entry) =>
                                  JSON.stringify(entry.asset.definition) ===
                                  JSON.stringify(definition),
                              ) &&
                              [dissolveEffect, ...effectTemplates].some(
                                (d) =>
                                  d.name === definition.name &&
                                  d.kind === definition.kind &&
                                  d.source === definition.source,
                              ),
                          })
                        }
                      >
                        Edit definition…
                      </button>
                      <button
                        onClick={() =>
                          updateInstance(instance.id, (i) => ({
                            ...i,
                            parameters: Object.fromEntries(
                              effectParameters(definition).map((p) => [
                                p.key,
                                p.default,
                              ]),
                            ),
                          }))
                        }
                      >
                        Reset parameters
                      </button>
                      <button
                        onClick={() =>
                          updateInstance(instance.id, (i) => ({
                            ...i,
                            enabled: !i.enabled,
                          }))
                        }
                      >
                        {instance.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        onClick={() => updateInstance(instance.id, () => null)}
                      >
                        Remove
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <button disabled={!editable} onClick={() => setPicking(true)}>
                + Add Effect
              </button>
            </>
          )}
          <button onClick={() => workspace.setOpen(true)}>
            Click Timeline
          </button>
        </>
      )}
      {draft && (
        <EffectEditor
          timeControls={
            editingTemplate ? undefined : timeControls(draft.instanceId)
          }
          timeSchedule={(() => {
            if (!element || !draft.instanceId) return undefined;
            const trigger = findEffectTrigger(
              snapshot.slide.motion,
              element.id,
              draft.instanceId,
            );
            return trigger
              ? snapshot.slide.motion?.stages[trigger.index].blocks?.find(
                  (b) => b.id === trigger.id,
                )?.effectSchedule
              : undefined;
          })()}
          timeControlDescription={(() => {
            const trigger =
              element &&
              draft.instanceId &&
              findEffectTrigger(
                snapshot.slide.motion,
                element.id,
                draft.instanceId,
              );
            const schedule =
              trigger &&
              snapshot.slide.motion?.stages[trigger.index].blocks?.find(
                (b) => b.id === trigger.id,
              )?.effectSchedule;
            return schedule
              ? {
                  start: effectStartLabels[schedule.start],
                  stop:
                    schedule.stop.mode === "click"
                      ? `Click ${snapshot.slide.motion!.stages.findIndex((s) => schedule.stop.mode === "click" && s.id === schedule.stop.stageId)}`
                      : schedule.stop.mode === "after"
                        ? `After ${schedule.stop.durationMs / 1000} s`
                        : schedule.stop.mode === "next-click"
                          ? "Next click"
                          : schedule.stop.mode === "slide-end"
                            ? "Slide end"
                            : "None",
                }
              : undefined;
          })()}
          definition={draft.definition}
          asset={draft.asset}
          builtin={draft.builtin}
          creating={draft.creating}
          snapshot={snapshot}
          element={element}
          onChange={(definition) => setDraft({ ...draft, definition })}
          onClose={() => setDraft(null)}
          onSaved={saved}
          beforeSave={destructive}
        />
      )}
    </section>
  );
}
