import {
  effectAuthoringDiagnostics,
  effectDefinitionSchema,
  effectParameters,
  type EffectDefinition,
} from "../core/effects";
import type {
  EffectValidationDiagnostic,
  EffectValidationResult,
} from "../core/effectValidation";
import { compileEffectCss, shaderProgram } from "./effectRuntime";
import { createTextEffectRunner } from "./textEffectRunner";

function sourceLine(message: string) {
  for (const pattern of [
    /ERROR:\s*\d+:(\d+):/i,
    /\b0:(\d+)\b/,
    /\bline\s+(\d+)\b/i,
  ]) {
    const match = pattern.exec(message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function diagnostic(error: unknown): EffectValidationDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const line = sourceLine(message);
  return {
    severity: "error",
    message,
    ...(line === undefined ? {} : { line }),
  };
}

/** Production validation shared by Effect Studio and model-facing authoring. */
export async function validateEffectDefinitionProduction(
  input: EffectDefinition,
  options: { sampleText?: string } = {},
): Promise<EffectValidationResult> {
  const parsed = effectDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      kind: input.kind,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: "error" as const,
        message: issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      })),
    };
  const definition = parsed.data;
  const authored = effectAuthoringDiagnostics(definition);
  if (authored.length)
    return {
      ok: false,
      kind: definition.kind,
      diagnostics: authored.map((message) => ({
        severity: "error" as const,
        message,
      })),
    };
  try {
    if (definition.kind === "fragment-glsl") shaderProgram(definition.source);
    if (definition.kind === "css")
      compileEffectCss(definition.source, "studio-validation");
    if (definition.kind === "text-js") {
      if (definition.styleSource)
        compileEffectCss(definition.styleSource, "studio-validation");
      const runner = createTextEffectRunner(definition.source);
      try {
        await runner.render({
          text: options.sampleText ?? "SCRAMBLE REVEAL",
          t: 0,
          p: 0.5,
          duration: 1,
          slideTime: 0,
          presentationTime: 0,
          stepTime: 0,
          stepIndex: 0,
          active: true,
          parameters: Object.fromEntries(
            effectParameters(definition).map((parameter) => [
              parameter.key,
              parameter.default,
            ]),
          ),
        });
      } finally {
        runner.dispose();
      }
    }
  } catch (error) {
    return {
      ok: false,
      kind: definition.kind,
      diagnostics: [diagnostic(error)],
    };
  }
  return {
    ok: true,
    kind: definition.kind,
    definition,
    diagnostics: [],
  };
}

export class EffectProductionValidationError extends Error {
  constructor(readonly result: Extract<EffectValidationResult, { ok: false }>) {
    super(result.diagnostics.map(({ message }) => message).join("; "));
    this.name = "EffectProductionValidationError";
  }
}

export async function assertEffectDefinitionValid(
  definition: EffectDefinition,
  options: { sampleText?: string } = {},
) {
  const result = await validateEffectDefinitionProduction(definition, options);
  if (!result.ok) throw new EffectProductionValidationError(result);
  return result.definition;
}
