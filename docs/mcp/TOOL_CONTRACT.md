# MCP tool and resource contract

This document describes the model-facing contract implemented on the current MCP branch.
It is intentionally smaller than ShowMe's internal API.

The public MCP contract should remain stable even when internal editor command functions change.

## Design rules

1. Prefer a few broad semantic tools over one MCP tool per backend method.
2. Do not expose raw `DocumentOperation` as the normal model-facing API.
3. Every mutation identifies its document and expected revision.
4. Resolve convenience context such as "current selection" into stable IDs before mutation.
5. Make one coherent request atomic whenever practical.
6. Return exact IDs and accepted revisions after every mutation.
7. Return errors that tell an agent how to recover.
8. Avoid prose-only success responses. Use structured outputs.
9. Read tools are read-only and marked as such.
10. ShowMe never asks an internal model to reinterpret an already model-authored request.

## 1. showme_context

Purpose: cheaply answer "what am I looking at?"

Input:

```ts
{}
```

Output:

```ts
interface ShowMeContext {
  document: {
    id: string;
    name: string;
    revision: number;
    savedRevision: number;
    dirty: boolean;
    width: number;
    height: number;
  } | null;

  editor: {
    slideId: string | null;
    selectionScopeId: string | null;
    selectionIds: string[];
  };

  presentation?: {
    active: boolean;
    slideIndex?: number;
    stepIndex?: number;
  };
}
```

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

Notes:

- This is ephemeral editor context.
- It is not an identity mechanism.
- Subsequent writes should use resolved IDs.
- If no document is open, return a successful structured result with `document: null`.

## 2. showme_inspect

Purpose: retrieve only the document context required for the task.

Proposed input:

```ts
interface InspectInput {
  documentId: string;

  target:
    | { type: "deck" }
    | { type: "slide"; slideId: string }
    | { type: "elements"; slideId: string; elementIds: string[] }
    | { type: "current-selection" };

  include?: Array<
    | "outline"
    | "content"
    | "geometry"
    | "appearance"
    | "hierarchy"
    | "motion"
    | "presence"
    | "effects"
    | "notes"
    | "stylesheet"
  >;

  depth?: number;
}
```

Defaults should be sparse.

A slide outline could return:

```json
{
  "documentId": "doc_1",
  "revision": 42,
  "slide": {
    "id": "slide_3",
    "name": "Results",
    "elements": [
      {
        "id": "title_1",
        "name": "Title",
        "type": "text",
        "frame": { "x": 120, "y": 100, "width": 800, "height": 140 },
        "textPreview": "Revenue accelerated"
      },
      {
        "id": "metric_1",
        "name": "Metric",
        "type": "text",
        "frame": { "x": 1130, "y": 280, "width": 420, "height": 220 },
        "textPreview": "26%"
      }
    ]
  }
}
```

Do not inline media bytes, giant Effect source, or every nested style property unless explicitly requested.

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

## 3. showme_apply

Purpose: perform one atomic semantic change.

Proposed input:

```ts
interface ApplyInput {
  documentId: string;
  expectedRevision: number;

  operations: ShowMeSemanticOperation[];

  label?: string;
}
```

The semantic operation union should mirror things a user can intentionally do in ShowMe, not low-level storage mechanics.

Initial set:

```ts
type ShowMeSemanticOperation =
  | {
      type: "text.set";
      slideId: string;
      elementId: string;
      text: string;
    }
  | {
      type: "elements.move";
      slideId: string;
      elementIds: string[];
      dx: number;
      dy: number;
      scopeId?: string;
    }
  | {
      type: "elements.frame.set";
      slideId: string;
      elementId: string;
      frame: {
        x: number;
        y: number;
        width: number;
        height: number;
        rotation?: number;
      };
    }
  | {
      type: "elements.appearance.patch";
      slideId: string;
      elementIds: string[];
      fill?: string | null;
      strokeColor?: string;
      strokeWidth?: number;
      opacity?: number;
      radius?: number;
    }
  | {
      type: "element.insert_text";
      slideId: string;
      parentId: string;
      frame: { x: number; y: number; width: number; height: number };
      text: string;
      name?: string;
      typography?: Partial<TextTypography>;
      autoSize?: "none" | "height" | "both";
    }
  | {
      type: "element.insert_shape";
      slideId: string;
      parentId: string;
      shape: "rectangle" | "ellipse";
      frame?: Partial<Frame>;
      appearance?: Partial<Appearance>;
      name?: string;
    }
  | {
      type: "elements.remove";
      slideId: string;
      elementIds: string[];
    }
  | {
      type: "elements.duplicate";
      slideId: string;
      elementIds: string[];
    }
  | {
      type: "elements.reparent";
      slideId: string;
      elementIds: string[];
      parentId: string;
      index?: number;
    }
  | {
      type: "slide.background.set";
      slideId: string;
      color: string;
    }
  | {
      type: "slide.notes.set";
      slideId: string;
      notes: string;
    }
  | {
      type: "motion.add_preset";
      slideId: string;
      stageIndex: number;
      elementIds: string[];
      preset: "Move" | "Scale" | "Rotate" | "Fade" | "Pulse";
    }
  | {
      type: "presence.add";
      slideId: string;
      stageIndex: number;
      elementIds: string[];
      schedule?: PresenceSchedulePatch;
    }
  | {
      type: "effect.apply";
      slideId: string;
      elementId: string;
      definition: EffectDefinition;
      existingInstanceId?: string;
      stageIndex?: number;
    }
  | {
      type: "effect.parameter.set";
      slideId: string;
      elementId: string;
      instanceId: string;
      key: string;
      value: number | boolean | string;
    };
```

This union should grow only when a real workflow needs it.

Do not start by exposing every current editor feature.

### Internal mapping

Examples:

```text
text.set
  -> updateText()

elements.move
  -> translateElements()

element.insert_text
  -> insertText() + updateText()

motion.add_preset
  -> addMotionPreset() + setSlideMotion()

presence.add
  -> addPresence() / editPresenceSchedule() + setSlideMotion()

effect.apply
  -> validateEffectDefinition()
  -> setElementEffectDefinition()

effect.parameter.set
  -> setElementEffectParameterValue()
```

The resulting editor changes already accumulate `DocumentOperation[]`. Commit the final combined result once.

### Output

```ts
interface ApplyResult {
  documentId: string;
  previousRevision: number;
  revision: number;
  transactionId: string;

  changes: Array<{
    kind: string;
    slideId?: string;
    elementIds?: string[];
    effectInstanceIds?: string[];
  }>;

  warnings: Array<{
    code: string;
    message: string;
  }>;
}
```

Return created IDs. An agent should never have to re-inspect just to discover what it created.

Annotations:

```text
readOnlyHint: false
destructiveHint: true
idempotentHint: false
openWorldHint: false
```

The tool is marked destructive because the union contains removal/replacement operations. If clients benefit from finer risk hints later, split additive creation from destructive editing only if evaluation shows a real benefit.

## 4. showme_render

Purpose: visual verification.

Input:

```ts
interface RenderInput {
  documentId: string;
  slideId: string;

  width?: number;
  height?: number;

  state?: {
    stageIndex?: number;
    stageTimeMs?: number;
    previewMode?: boolean;
  };
}
```

Output:

- structured metadata;
- image content block with PNG.

Example metadata:

```json
{
  "documentId": "doc_1",
  "slideId": "slide_3",
  "revision": 43,
  "width": 960,
  "height": 540,
  "stageIndex": 1,
  "stageTimeMs": 350
}
```

Use ShowMe's real renderer. Do not create an MCP-specific approximation.

The first implementation can render a static slide. Click/timing state can follow once the deterministic renderer input is cleanly factored.

Annotations:

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

## 5. showme_history

Optional first-release tool.

If the MCP uses a distinct authority actor:

```ts
interface HistoryInput {
  documentId: string;
  action: "undo" | "redo";
}
```

This acts only on MCP-owned actor history.

Never silently undo human/local history.

Annotations:

```text
readOnlyHint: false
destructiveHint: true
idempotentHint: false
openWorldHint: false
```

## Current creative extensions

The current semantic union additionally exposes:

```ts
{ type: "slide.make_independent" }
{ type: "deck.stylesheet.set"; source: string }
{ type: "elements.css_classes.set"; elementIds: string[]; classes: string[] }
{ type: "elements.reorder"; parentId: string; elementIds: string[];
  mode: "front" | "back" | "forward" | "backward" }

{ type: "effect.apply_code"; elementId: string; name: string;
  effectType: "shader" | "css" | "text-js";
  affects: "pixels" | "backdrop" | "generated" | "element" | "text";
  source: string; styleSource?: string; speed?: number;
  timeControl?: EffectTimeControl; parameters?: EffectParameter[];
  existingInstanceId?: string; stageIndex?: number }

{ type: "effect.parameter.set"; elementId: string; effectInstanceId: string;
  key: string; value: number | boolean | string }
{ type: "effect.enabled.set"; elementId: string; effectInstanceId: string; enabled: boolean }
{ type: "effect.remove"; elementId: string; effectInstanceId: string }

{ type: "background.shader.create"; name: string; source: string;
  speed?: number; timeControl?: EffectTimeControl; parameters?: EffectParameter[];
  stageIndex?: number }

{ type: "motion.add_preset"; stageIndex: number; elementIds: string[];
  preset: "Move" | "Scale" | "Rotate" | "Fade" | "Pulse" }
{ type: "motion.animate"; stageIndex: number; elementId: string; property: string;
  from: number; to: number; durationMs: number; ease?: NamedMotionEase }
{ type: "presence.add"; stageIndex: number; elementIds: string[] }
```

Shader operations reconcile `uniform float ... // @param ...` declarations through the
same source reconciliation used by Effect Studio. Effect code is then validated using
the real WebGL2 program linker, scoped CSS compiler, or isolated text-JS worker. Failed
validation returns structured diagnostics and does not mutate the document.

### showme.authoring

`showme.authoring` accepts one of
`background-shader`, `content-shader`, `backdrop-shader`, `css-effect`,
`text-effect` or `motion`. With no document scope it returns a creation contract and
starter. With exact document/epoch/revision/slide scope plus element/effect IDs it also
returns the current authored source. The Effect ABI comes from
`buildEffectAuthoringPrompt()`, not a duplicated MCP-only specification.

## Effect authoring resource

The current `buildEffectAuthoringPrompt()` already exports a complete authoring ABI without requiring repository access.

Expose it through a dynamic resource rather than repeating it in tool descriptions.

Concept:

```text
showme://effect-authoring/{documentId}/{slideId}/{elementId}
```

The resource should include:

- current Effect definition or a blank definition;
- Effect family and affects mode;
- existing source;
- existing parameter contract;
- timing;
- preview element name;
- current ShowMe Effect runtime rules.

The agent then writes source itself and sends the complete definition through `showme_apply`.

## Capabilities resource

Expose a cheap machine-readable resource:

```text
showme://capabilities
```

Example:

```json
{
  "documentVersion": 1,
  "effectApiVersion": 1,
  "supports": {
    "motion": true,
    "presence": true,
    "shaderEffects": true,
    "cssEffects": true,
    "textJsEffects": true,
    "renderPreview": true,
    "templates": true,
    "pptxExport": true,
    "pdfExport": true
  }
}
```

This is better than teaching clients behavior from server version strings.

## Error model

Errors need stable codes plus human-readable messages.

Examples:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "Presentation changed from revision 42 to 43. Re-inspect the affected slide and retry.",
  "documentId": "doc_1",
  "expectedRevision": 42,
  "actualRevision": 43,
  "recoverable": true
}
```

```json
{
  "code": "LEASE_DENIED",
  "message": "The selected element is currently being edited by another actor.",
  "slideId": "slide_3",
  "elementId": "title_1",
  "recoverable": true
}
```

```json
{
  "code": "EFFECT_VALIDATION_ERROR",
  "message": "Shader compilation failed.",
  "diagnostics": [
    {
      "line": 47,
      "severity": "error",
      "message": "..."
    }
  ],
  "recoverable": true
}
```

Other useful codes:

- `NO_ACTIVE_DOCUMENT`;
- `UNKNOWN_SLIDE`;
- `UNKNOWN_ELEMENT`;
- `INVALID_SCOPE`;
- `UNSUPPORTED_OPERATION`;
- `PREVIEW_FAILED`;
- `MISSING_MEDIA`;
- `DOCUMENT_CLOSED`.

Do not ask the model to parse arbitrary exception strings when a stable code is possible.

## Tool result discipline

Every tool with structured data should declare an output schema.

Return both:

- `structuredContent` for machines;
- concise text only where it helps humans.

Do not return giant success prose.

Stable ordering matters for cacheability and model consistency.

## Expected revision

All writes should include `expectedRevision`.

The MCP layer may internally need to refresh its projection, but it must not silently apply an intent to materially different state.

For a revision mismatch:

1. reject;
2. return the current revision;
3. identify whether the requested targets still exist when cheap;
4. let the agent inspect and retry.

Do not implement hidden "best effort" mutation against stale state.

## Current selection

`current-selection` is a convenience only.

A write request should resolve it to explicit IDs before the transaction is constructed, and the result should report those resolved IDs.

This prevents a delayed tool call from accidentally following a user's later selection change.

## Generated IDs

ShowMe should create IDs, not the model.

The model can optionally supply human-facing names.

Return all generated IDs in `ApplyResult`.

## Why not dozens of tools?

A tool catalog is part of model context and tool choice is itself a reliability problem.

Bad:

```text
set_x
set_y
set_width
set_height
set_fill
set_opacity
create_shader
set_shader_source
set_effect_start
set_effect_stop
...
```

Better:

```text
showme_context
showme_inspect
showme_apply
showme_render
showme_history (optional)
```

Internal APIs stay granular. The MCP contract stays semantic.
