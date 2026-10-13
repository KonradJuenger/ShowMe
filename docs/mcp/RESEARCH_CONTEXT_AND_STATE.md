# Research: giving models useful presentation state

Date: 2026-10-13

This document captures the web/repository research performed after the initial MCP architecture pass. It is research guidance, not an implementation spec. The central question was:

> What is the smallest, most faithful representation of a live ShowMe presentation that lets an external model reliably understand, edit and visually verify it?

## Executive conclusion

Do not give the model the ShowMe document.

Give it a deterministic, model-oriented projection of the ShowMe document, then let it retrieve more detail only when needed.

The recommended hierarchy is:

```text
orientation
  -> compact context
  -> scoped semantic inspection
  -> optional exact/native detail
  -> rendered visual verification
```

The durable source of truth remains ShowMe:

```text
Editor
-> EditorSession
-> DocumentOperation[]
-> DocumentTransaction
-> DocumentAuthority
-> accepted revision
```

The MCP layer should never become a second document model.

The most important implementation consequence is that **agent context deserves its own projection layer inside ShowMe**. MCP should consume that projection; MCP handlers should not individually reconstruct presentation state.

## Why raw document JSON is the wrong default

ShowMe's persisted model is designed for correctness and editing, not model comprehension. It contains:

- recursive elements and containers;
- parent-local frames and transforms;
- layers and ordering;
- text style references;
- media references;
- templates;
- slide metadata;
- Motion tracks and keyframes;
- Presence schedules;
- Effect definitions and instances;
- potentially large GLSL/CSS/JS source;
- notes and hidden content.

A model usually needs much less.

For example, visual reasoning usually needs:

```text
Title
text: "Revenue is accelerating"
world bounds: x=116 y=94 w=928 h=122
layer: main
z: 0
motion: present
```

rather than the full nested transform chain and persistence representation.

This is consistent with current context-engineering guidance: larger context windows do not remove the need to curate context. Relevant facts buried inside long inputs are used less reliably.

## Recommended context ladder

### Level 1: orientation

Use for:

- "this";
- "selected";
- "current slide";
- "what am I looking at?";
- deciding which inspection is needed.

Suggested payload:

```json
{
  "schemaVersion": "showme-context/1",
  "document": {
    "id": "doc_7h4",
    "name": "Q4 Strategy",
    "revision": 184,
    "savedRevision": 181,
    "dirty": true,
    "canvas": { "width": 1920, "height": 1080 },
    "slideCount": 12
  },
  "activeSlide": {
    "id": "slide_results",
    "index": 5,
    "name": "Results"
  },
  "selection": {
    "scopeId": "layer_main",
    "elementIds": ["metric_growth"],
    "items": [
      {
        "id": "metric_growth",
        "name": "Growth metric",
        "type": "text",
        "textPreview": "26%"
      }
    ]
  },
  "ui": {
    "mode": "editor",
    "stageIndex": 1,
    "stageTimeMs": 0,
    "uiEpoch": 73
  }
}
```

Target: roughly 0.5-1.5k tokens in ordinary cases.

### Level 2: scoped semantic inspection

Use for normal editing and reasoning.

The normal slide representation should be compact, deterministic and easy to reference.

Recommended default representation: **flat canonical preorder**, with hierarchy expressed by `parentId`.

```json
{
  "documentId": "doc_7h4",
  "revision": 184,
  "slide": {
    "id": "slide_results",
    "index": 5,
    "name": "Results",
    "templateId": "template_a",
    "elementCount": 7
  },
  "elementTree": [
    {
      "id": "title",
      "parentId": null,
      "layerId": "layer_main",
      "depth": 0,
      "z": 0,
      "name": "Title",
      "type": "text",
      "textPreview": "Revenue is accelerating",
      "worldBounds": {
        "x": 116,
        "y": 94,
        "width": 928,
        "height": 122
      },
      "styleRefs": ["text:heading"],
      "effectCount": 0,
      "motion": "present"
    }
  ]
}
```

Target: roughly 2-6k tokens for a normal slide inspection.

### Level 3: full scoped detail

Use for one/few elements when exact editing needs more information.

May include:

- exact text;
- local frame;
- derived world bounds;
- complete appearance;
- geometry;
- content metadata;
- Effect instances;
- parameter values;
- exact style definition;
- semantic Motion/Presence;
- selected native structures.

The model should not need unrelated siblings merely because it needs exact detail on one element.

### Level 4: native/debug

Expose exact ShowMe-native structures only when explicitly requested.

Examples:

- raw Motion model;
- exact Effect definition;
- full stylesheet;
- precise nested transform state;
- persisted slide structure.

Whole-document raw JSON should be diagnostic-only.

## World geometry should be the default geometry

ShowMe persists local frame values. Models reasoning about composition usually need world-space geometry.

Normal context should expose:

```text
worldBounds
```

and optionally:

```text
world rotation / derived transform summary
```

Exact local frames belong in full/native inspection.

This lets the model answer questions such as:

- is the title aligned with the chart?;
- which element overlaps the metric?;
- what is closest to the top-right?;
- is there enough empty space behind the headline?;

without reconstructing nested transforms.

## Stable IDs plus semantic labels

Stable ShowMe IDs are essential for safe edits but poor as the only context.

Every model-facing object should pair:

```text
id
name
type
small semantic/content preview
```

Example:

```json
{
  "id": "metric_growth",
  "name": "Growth metric",
  "type": "text",
  "textPreview": "26%"
}
```

The server creates persistent IDs. The model should not invent them.

## Separate durable revision from ephemeral UI state

There are two kinds of freshness:

### Document revision

Accepted persistent state.

Use for optimistic concurrency:

```text
expectedRevision
```

A stale write should fail rather than silently applying to changed state.

### UI epoch

Ephemeral editor state:

- active slide;
- selection;
- editing scope;
- editor/preview mode;
- current Click Timeline stage;
- current timeline time.

Recommended field:

```text
uiEpoch
```

Increment it when relevant ephemeral context changes.

This allows a model to detect that "selected object" has changed even when the document revision has not.

Current-selection mutations should resolve selection to stable IDs before the mutation is built.

## Motion and Presence need semantic summaries

Raw Motion tracks are too low-level for routine questions.

Normal inspection should answer:

- what occurs at each stage?;
- which elements move?;
- which elements appear/disappear?;
- how long?;
- which Effect begins/stops?;

Example:

```json
{
  "motion": {
    "stageCount": 2,
    "stages": [
      {
        "index": 0,
        "trigger": "slide-entry",
        "items": [
          {
            "kind": "motion",
            "label": "Title move in",
            "elementId": "title",
            "properties": ["transform.y", "appearance.opacity"],
            "durationMs": 450
          }
        ]
      },
      {
        "index": 1,
        "trigger": "click",
        "items": [
          {
            "kind": "presence",
            "elementId": "metric_growth",
            "label": "Reveal growth metric"
          }
        ]
      }
    ]
  }
}
```

The exact native model remains retrievable through explicit inspection/resource access.

## Effects should be summarized, source should be on demand

Normal inspection should include:

- Effect instance ID;
- Effect resource ID;
- name;
- type;
- target/input/placement;
- enabled;
- timing summary;
- parameter values;
- source byte count;
- source resource URI.

Do not inline source by default.

Example:

```json
{
  "instanceId": "fxi_bg",
  "resourceId": "fx_bg",
  "name": "Flow Field",
  "kind": "fragment-glsl",
  "target": "background",
  "enabled": true,
  "parameters": {
    "intensity": 0.4
  },
  "source": {
    "bytes": 6842,
    "uri": "showme://documents/doc_7h4/revisions/184/slides/slide_results/effects/fx_bg/source"
  }
}
```

For Effect authoring, separate:

1. a stable Effect ABI/resource;
2. target-specific authoring context.

That avoids repeating a large Effect prompt with every request.

The external model writes GLSL/CSS/text-JS. ShowMe validates using the production runtime. No internal model or Effect compiler is required.

## Styles should be deduplicated

Do not repeat resolved text styles on every element.

Normal tree entries should reference style IDs:

```json
{
  "styleRefs": ["text:heading"]
}
```

When requested, return a dictionary:

```json
{
  "styles": {
    "text": {
      "heading": {
        "fontFamily": "Inter",
        "fontSize": 72,
        "fontWeight": 700
      }
    }
  }
}
```

## Structure plus screenshot is the strongest normal grounding

Structured context and visual preview answer different questions.

Structure is best for:

- exact text;
- IDs;
- geometry;
- hierarchy;
- timeline metadata;
- parameter values;
- deterministic targeting.

Screenshot is best for:

- hierarchy;
- balance;
- overlap;
- legibility;
- clipping;
- visual rhythm;
- perceived Effect output.

For visual tasks the strongest loop is:

```text
context
-> inspect
-> preview
-> decide
```

and after mutation:

```text
apply/animate/effect
-> accepted revision
-> preview
-> targeted correction if needed
```

Preview must use ShowMe's production renderer, not an MCP-specific approximation.

## Deterministic preview state

A preview request should explicitly identify:

- document ID;
- revision;
- slide ID;
- viewport;
- stage/click index;
- stage time;
- clean/editor/presenter mode.

Example:

```json
{
  "documentId": "doc_7h4",
  "slideId": "slide_results",
  "revision": 187,
  "viewport": { "width": 960, "height": 540 },
  "timeline": {
    "stageIndex": 1,
    "stageTimeMs": 500
  },
  "mode": "editor-clean"
}
```

This is essential for Motion, Presence and time-based Effects.

## Semantic change sets should become first-class

After a successful mutation, return what changed semantically.

Example:

```json
{
  "fromRevision": 184,
  "toRevision": 185,
  "changes": [
    {
      "type": "text.changed",
      "slideId": "slide_results",
      "elementId": "title"
    },
    {
      "type": "element.moved",
      "slideId": "slide_results",
      "elementId": "metric_growth",
      "from": { "x": 1210, "y": 252 },
      "to": { "x": 1170, "y": 252 }
    }
  ]
}
```

This reduces repeated full-slide reads during multi-step work.

Potential read API:

```text
inspect(sinceRevision=N)
```

If history cannot produce a clean delta, explicitly require a fresh inspection.

Do not make RFC JSON Patch the primary model interface. Semantic changes are more useful to the model.

## Recommended MCP domains

Research supports six distinct model-facing domains:

```text
showme.context
showme.inspect
showme.apply
showme.animate
showme.effect
showme.preview
```

Why split writes:

```text
ordinary editing       -> apply
timeline behavior      -> animate
custom visual runtime  -> effect
```

Internally all writes still converge on the existing ShowMe command/runtime/authority path.

The exact tool count should still be tested with real models. This is a hypothesis, not a requirement.

## Mutation contract

All writes should include:

```text
documentId
expectedRevision
mutationId
explicit resolved target IDs
```

`mutationId` is recommended for bounded retry/replay protection after transport failure.

Successful writes should return:

- previous revision;
- accepted revision;
- transaction ID;
- mutation ID;
- changed IDs;
- created IDs;
- semantic change set;
- warnings.

One coherent tool call should normally equal one logical ShowMe transaction/undo unit.

## Concurrency and actor identity

The current authority model makes actor identity important.

Using a second EditorSession with actor `local` is unsafe because same-actor lease behavior does not give the MCP meaningful conflict protection against the human editor.

Safe first assumption:

```text
human actor = local
MCP actor   = mcp-local
```

Benefits:

- active human edit leases block conflicting MCP edits;
- agent edits are attributable;
- actor-scoped agent rollback is possible.

Cost:

- current local Ctrl+Z does not automatically own MCP history.

Research recommendation for first write-enabled version:

- preserve safe actor separation;
- surface an "Undo agent edit" affordance or equivalent;
- later investigate separating conflict/lease identity from user-level undo ownership.

Do not weaken lease semantics merely to get automatic Ctrl+Z.

## Privacy defaults

The context projection should minimize disclosure.

Default include:

- requested visible text;
- requested geometry/hierarchy;
- current selection;
- required style/effect/motion summaries.

Default exclude:

- speaker notes;
- hidden slide text;
- unrelated slides' full text;
- raw media bytes;
- local filesystem paths;
- source paths;
- Effect source;
- logs containing presentation body.

Presentation content must be treated as untrusted data, not instructions.

## Tool errors should be structured

Expected application failures should have stable machine-readable codes.

Important cases:

- `REVISION_CONFLICT`
- `LEASE_DENIED`
- `UNKNOWN_SLIDE`
- `UNKNOWN_ELEMENT`
- `INVALID_SCOPE`
- `UNSUPPORTED_OPERATION`
- `EFFECT_VALIDATION_ERROR`
- `PREVIEW_FAILED`
- `MISSING_MEDIA`
- `DOCUMENT_CLOSED`

Errors should tell the model whether recovery is possible and what to do next.

## Context budgets

Recommended product targets, not protocol limits:

| Context | Target |
|---|---:|
| orientation | 0.5-1.5k tokens |
| ordinary scoped inspect | 2-6k |
| full scoped inspect | 8-20k |
| whole raw document | debug only |

The point is not to enforce exact token counts. The point is to make oversized responses visibly abnormal.

## Resources

Good candidates:

```text
showme://capabilities

showme://spec/effects/v1
showme://spec/effects/v1/shader
showme://spec/effects/v1/css
showme://spec/effects/v1/text-js
showme://spec/motion/v1
showme://spec/presence/v1

showme://documents/{documentId}/revisions/{revision}/styles
showme://documents/{documentId}/revisions/{revision}/slides/{slideId}/motion/native
showme://documents/{documentId}/revisions/{revision}/slides/{slideId}/effects/{resourceId}/source
showme://documents/{documentId}/revisions/{revision}/slides/{slideId}/elements/{elementId}/effect-authoring
```

Stable specs can be cacheable longer than document-specific state.

## Current MCP guidance verified during research

As of 2026-10-13:

- current MCP specification revision is `2026-07-28`;
- the TypeScript SDK v2 is the stable line for that revision;
- tools support structured inputs and outputs;
- tool results can return images;
- Resources/resource links are appropriate for larger or reusable context;
- the modern protocol core is stateless;
- current subscriptions are invalidation/refetch oriented;
- current SDKs include cache hints;
- local stdio remains appropriate for process-launched desktop integrations;
- remote implementations should use current Streamable HTTP guidance;
- localhost HTTP requires DNS-rebinding/Host/Origin protections;
- tool annotations are hints, not security enforcement.

Avoid building new ShowMe architecture around deprecated legacy MCP features.

## External systems reviewed

### Figma MCP

Useful patterns:

- sparse structural metadata before rich context;
- targeted node/design context;
- separate motion context;
- screenshot tool;
- shader/source content through resources;
- guidance to avoid giant selections;
- inspect before write;
- native structured canvas writes;
- workflow skills for complex repeated behavior.

ShowMe should borrow the progressive disclosure pattern, not Figma's document model.

### Anthropic tool/context engineering guidance

Useful principles:

- context is finite even when windows are large;
- progressive disclosure;
- few high-signal tools;
- tool response design matters as much as tool implementation;
- realistic evals are essential;
- preserve important state outside the prompt and retrieve it when needed.

### Long-context research

"Lost in the Middle" supports the practical warning that relevant information can become harder to use when buried inside long inputs.

Implication for ShowMe: do not equate "the model can technically fit the whole presentation" with "the model should receive the whole presentation."

## Strongest design principle

```text
Keep truth outside the context window.
Give the model stable handles into truth.
Load only the slice needed for the next decision.
```

For ShowMe this means:

```text
ShowMe document/runtime
        |
        v
deterministic Agent Projection
        |
        v
MCP tools/resources
        |
        v
external model
```

not:

```text
ShowMe internals
        |
        v
large ad hoc MCP responses
        |
        v
model reconstructs application semantics
```

## Questions still requiring repository investigation

Research does not settle these; Codex should inspect the real code before implementation:

1. Where is the cleanest place to derive world bounds for agent inspection without duplicating renderer scene logic?
2. Which current UI state already exists outside React, and what minimal bridge is needed for active slide/selection/stage?
3. Can production preview already render an explicit stage/time deterministically, or must presenter sampling be factored?
4. What accepted-transaction information is retained that could produce semantic deltas?
5. What is the safest way to expose an MCP actor while preserving intuitive undo?
6. Which semantic editor commands depend on renderer-only measurement/services?
7. Which Effect validation pieces can be shared directly and which require live renderer/WebGL execution?
8. How should a helper discover and authenticate to a running app on Windows and macOS?
9. Does a six-tool domain split actually improve model performance over a smaller apply-oriented surface?
10. Which exact read payloads are enough for real tasks before the model asks for native detail?

## Primary references

Current MCP:

- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/resources.mdx
- https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/index.mdx
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- https://blog.modelcontextprotocol.io/posts/2026-07-28/

Creative MCP reference:

- https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
- https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/
- https://developers.figma.com/docs/figma-mcp-server/generative-plugins-and-shaders/
- https://developers.figma.com/docs/figma-mcp-server/avoid-large-frames/

Tool/context engineering:

- https://www.anthropic.com/engineering/writing-tools-for-agents
- https://www.anthropic.com/engineering/code-execution-with-mcp
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

Long-context / iterative-agent background:

- https://arxiv.org/abs/2307.03172
- https://arxiv.org/abs/2210.03629

## Relationship to the existing MCP branch documents

This research strengthens the existing architecture rather than replacing it.

Keep:

- one ShowMe authority;
- no direct `.sme` mutation;
- no second runtime;
- external model authors Effects;
- production Effect validation;
- production renderer;
- semantic edits;
- expected revisions;
- safe lease handling.

Add/emphasize:

- first-class Agent Projection;
- `uiEpoch`;
- world bounds as normal geometry;
- flat deterministic element tree;
- semantic Motion/Presence summary;
- Effect source via resources;
- semantic change sets/deltas;
- structure + screenshot grounding;
- explicit context budgets;
- privacy minimization;
- `mutationId` replay protection;
- evaluate tool-domain split with real clients.
