import {
  effectParameters,
  isReservedEffectParameter,
  type EffectDefinition,
} from "../core/effects";
import { useRef } from "react";

export function EffectParameterEditor({
  definition,
  onChange,
}: {
  definition: EffectDefinition;
  onChange(patch: Partial<EffectDefinition>): void;
}) {
  const newKeys = useRef(new Set<string>());
  const shader = definition.kind === "fragment-glsl";
  const parameters = effectParameters(definition).filter(
    (parameter) => parameter.key !== "progress",
  );
  function update(
    index: number,
    patch: Partial<EffectDefinition["parameters"][number]>,
  ) {
    onChange({
      parameters: parameters.map((parameter, i) => {
        if (i !== index) return parameter;
        const next = {
          ...parameter,
          ...patch,
        } as EffectDefinition["parameters"][number];
        if (
          next.type === "number" &&
          ("min" in patch || "max" in patch) &&
          (next.min === undefined ||
            next.max === undefined ||
            next.min <= next.max)
        ) {
          next.default = Math.max(
            next.min ?? -Infinity,
            Math.min(next.max ?? Infinity, next.default),
          );
        }
        return next;
      }),
    });
  }
  return (
    <div className="effect-parameters">
      <h3>Parameters</h3>
      {parameters.length === 0 && (
        <p>
          {shader
            ? "Declare a custom uniform float in the shader to create a parameter."
            : "No custom parameters."}
        </p>
      )}
      {parameters.map((parameter, index) => (
        <div className="effect-parameter-definition" key={parameter.key}>
          <div className="effect-parameter-heading">
            <label>
              Name
              <input
                aria-label={`Parameter ${index + 1} name`}
                value={parameter.label}
                onChange={(e) => update(index, { label: e.target.value })}
                onBlur={() => {
                  if (shader || !newKeys.current.delete(parameter.key)) return;
                  // Name the new explicit CSS/JS control before code depends on it.
                  if (
                    new RegExp(`\\b${parameter.key}\\b`).test(
                      definition.source + " " + (definition.styleSource ?? ""),
                    )
                  )
                    return;
                  const words = parameter.label
                    .normalize("NFKD")
                    .replace(/[^a-zA-Z0-9 ]/g, "")
                    .trim()
                    .split(/\s+/);
                  let key = words
                    .map((word, i) =>
                      i === 0
                        ? word.charAt(0).toLowerCase() + word.slice(1)
                        : word.charAt(0).toUpperCase() + word.slice(1),
                    )
                    .join("")
                    .slice(0, 60);
                  if (!/^[a-zA-Z]/.test(key)) key = "parameter" + key;
                  if (
                    isReservedEffectParameter(key) ||
                    ["size", "resolution"].includes(key)
                  )
                    key += "Value";
                  const base = key;
                  let suffix = 1;
                  while (
                    parameters.some((p, i) => i !== index && p.key === key)
                  )
                    key = base + suffix++;
                  update(index, { key });
                }}
              />
            </label>
            {!shader && (
              <button
                aria-label={`Remove ${parameter.label} parameter`}
                onClick={() =>
                  onChange({
                    parameters: parameters.filter((_, i) => i !== index),
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
          {!shader && (
            <label>
              Type
              <select
                aria-label={`${parameter.label} type`}
                value={parameter.type}
                onChange={(event) => {
                  const type = event.target.value as
                    "number" | "boolean" | "string";
                  const next = {
                    key: parameter.key,
                    label: parameter.label,
                    type,
                    default:
                      type === "number" ? 0 : type === "boolean" ? false : "",
                  } as EffectDefinition["parameters"][number];
                  onChange({
                    parameters: parameters.map((p, i) =>
                      i === index ? next : p,
                    ),
                  });
                }}
              >
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
                <option value="string">Text</option>
              </select>
            </label>
          )}
          <div className="effect-parameter-fields">
            <label>
              Default
              <input
                aria-label={`${parameter.label} default`}
                type={
                  parameter.type === "boolean"
                    ? "checkbox"
                    : parameter.type === "string"
                      ? "text"
                      : "number"
                }
                step="any"
                maxLength={4096}
                checked={
                  parameter.type === "boolean" ? parameter.default : undefined
                }
                value={
                  parameter.type === "boolean" ? undefined : parameter.default
                }
                onChange={(e) =>
                  update(index, {
                    default:
                      parameter.type === "boolean"
                        ? e.target.checked
                        : parameter.type === "string"
                          ? e.target.value
                          : Number(e.target.value),
                  })
                }
              />
            </label>

            {parameter.type === "number" && (
              <>
                <label>
                  Min
                  <input
                    aria-label={`${parameter.label} minimum`}
                    type="number"
                    step="any"
                    value={parameter.min ?? ""}
                    onChange={(e) =>
                      update(index, {
                        min:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Max
                  <input
                    aria-label={`${parameter.label} maximum`}
                    type="number"
                    step="any"
                    value={parameter.max ?? ""}
                    onChange={(e) =>
                      update(index, {
                        max:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
              </>
            )}
          </div>
          {isReservedEffectParameter(parameter.key) && (
            <span role="alert">Reserved runtime input</span>
          )}
        </div>
      ))}
      {!shader && (
        <button
          onClick={() => {
            let number = 1;
            while (parameters.some((p) => p.key === `parameter${number}`))
              number++;
            newKeys.current.add(`parameter${number}`);
            onChange({
              parameters: [
                ...parameters,
                {
                  type: "number",
                  key: `parameter${number}`,
                  label: `Parameter ${number}`,
                  default: 0,
                },
              ],
            });
          }}
        >
          + Parameter
        </button>
      )}
    </div>
  );
}
