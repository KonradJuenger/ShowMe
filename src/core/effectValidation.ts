import type { EffectDefinition } from "./effects";

export interface EffectValidationDiagnostic {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
}

export type EffectValidationResult =
  | {
      ok: true;
      kind: EffectDefinition["kind"];
      definition: EffectDefinition;
      diagnostics: EffectValidationDiagnostic[];
    }
  | {
      ok: false;
      kind: EffectDefinition["kind"];
      diagnostics: EffectValidationDiagnostic[];
    };

export type EffectDefinitionValidator = (
  definition: EffectDefinition,
  sampleText?: string,
) => Promise<EffectValidationResult | null>;
