# MCP implementation and evaluation plan

This plan is intentionally staged. The first milestone should prove that an external agent can safely make native ShowMe edits and visually verify them. Do not build the full feature list up front.

## Phase 0: contract tests before server code

Write deterministic tests for the proposed semantic adapter without MCP transport.

Create a core-level adapter with an API conceptually like:

```ts
applyAgentOperations(snapshot, operations): EditorChange
```

Test:

- text set;
- move;
- insert text;
- insert shape;
- appearance patch;
- Motion preset;
- Presence;
- Effect apply;
- Effect parameter edit;
- invalid IDs;
- invalid edit scope;
- multiple operations becoming one accumulated change.

This establishes the model-facing semantic contract independently from protocol wiring.

Do not add a new persistence path in tests. Commit through the existing `EditorSession` / `DocumentRuntime` harness for integration coverage.

## Phase 1: read-only MCP spike

Implement only:

- `showme_context`;
- `showme_inspect`;
- `showme_render` for static slide preview.

Goals:

- prove stdio server compatibility with several clients;
- prove local ShowMe bridge discovery/authentication;
- prove the running app is the state owner;
- prove current selection can be read without exposing renderer internals;
- measure output size and call count.

Do not add writes until this loop is reliable.

Suggested manual clients:

- Codex;
- VS Code;
- Cursor;
- Claude Code or Claude Desktop if available.

The public contract should not depend on one model's quirks.

## Phase 2: atomic native edits

Add `showme_apply` with a deliberately small operation union:

1. `text.set`
2. `elements.move`
3. `elements.appearance.patch`
4. `element.insert_text`
5. `element.insert_shape`
6. `elements.remove`

Require `expectedRevision`.

Return:

- previous revision;
- accepted revision;
- transaction ID;
- resolved target IDs;
- created IDs;
- warnings.

Prove:

- one request is one coherent transaction;
- stale edits reject;
- bad operation rejects without partial application;
- accepted edits are immediately visible in the live editor;
- save/recovery remains unchanged.

Only then expand the semantic operation union.

## Phase 3: Motion and Presence

Add semantic operations over the existing runtime:

- add native Motion preset;
- add Presence;
- edit Presence schedule;
- optionally edit existing Motion timing.

Do not expose raw `SlideMotion` to the model unless inspection explicitly requests it.

Benchmark prompts:

- "Move the selected title in on click 1."
- "Have these four cards appear one by one."
- "Keep this hidden until click 3."
- "Fade this out at the next click."

Expected result: native editable Motion/Presence, not CSS/JS.

## Phase 4: Effects

Before exposing Effect writes:

1. extract shared Effect validation from `EffectEditor.tsx`;
2. expose the existing authoring contract as an MCP resource;
3. add `effect.apply`, `effect.parameter.set`, then remove/update;
4. render the result.

The agent writes source.

ShowMe validates and stores it.

Benchmark prompts:

- "Create a subtle generated shader background."
- "Make this image distort for two seconds after click 2."
- "Scramble this text from random symbols into the final text."
- "Change the existing effect but preserve its intensity parameter."
- "Make the shader less busy behind the title."

Track compile and runtime error rates separately.

## Phase 5: deterministic timeline preview

Extend `showme_render` to sample:

- click/stage index;
- stage time;
- slide entry;
- Effect timing;
- Presence state.

The agent should be able to inspect before/after states without launching a real presentation.

Benchmark:

```text
render stage 0
render stage 1 at 100 ms
render stage 1 at 800 ms
render stage 2
```

The images should match presenter sampling for the same state.

## Phase 6: broader editor semantics

Only after evaluation shows real demand, add:

- duplicate;
- reparent;
- reorder;
- resize/rotate;
- slide create/duplicate/delete/reorder;
- templates;
- text styles;
- transitions;
- media insertion;
- export.

Do not add operations because an internal method exists. Add them because agents repeatedly need them.

## Phase 7: optional workflow skill

Figma currently supplements complex MCP write workflows with Skills. ShowMe can do the same without moving logic out of MCP.

A ShowMe authoring skill should teach agents:

1. call context first when user intent is selection-relative;
2. inspect only relevant state;
3. prefer native Motion for movement;
4. use Presence for lifecycle;
5. use Effects for visual rendering/transformation;
6. read the Effect authoring resource before writing custom code;
7. apply coherent changes atomically;
8. render after visually material changes;
9. make small refinements rather than rewriting unrelated content.

The skill is guidance. The server must remain correct without trusting the skill.

## World-class evaluation

Protocol compliance is necessary but not sufficient.

### 1. Tool-selection benchmark

Create a corpus of natural requests and record the correct tool sequence.

Examples:

```text
"What is selected?"
"Change this title to Results."
"Move the title down."
"Make these cards appear one by one."
"Add a hacker-style reveal to this number."
"Make the background shader calmer."
"Show me slide 5."
"Change the notes, not the visible slide."
```

Measure:

- correct first tool;
- unnecessary calls;
- use of native semantics;
- accidental custom-code use.

### 2. Targeting benchmark

Agent must mutate exactly the intended targets.

Cases:

- one selected element;
- multi-selection;
- nested frame;
- same element names on different slides;
- selection changes between inspect and apply;
- slide deleted between inspect and apply.

Measure unrelated mutations. Target should be effectively zero.

### 3. Concurrency benchmark

Test:

- human holds a resize lease while agent moves same element;
- agent edits another slide during human interaction;
- collaboration guest owns the target;
- revision changes after inspection;
- repeated identical transaction delivery.

Expected:

- conflicts reject cleanly;
- no lease stealing;
- no duplicate mutation after retry;
- no corrupted draft state.

### 4. Effect benchmark

Corpus should include:

- generated shader;
- content shader;
- backdrop shader;
- CSS-only Effect;
- text JS;
- bad GLSL;
- bad CSS;
- infinite/slow text JS;
- renamed parameter;
- deleted parameter still animated by Motion;
- transparency;
- non-square elements;
- 4K audience render.

Measure:

- validation success;
- false acceptance;
- runtime errors;
- deterministic replay;
- parameter preservation;
- performance.

### 5. Visual benchmark

Visual quality is not reducible to compile success.

Use both deterministic image checks and human review.

Check:

- expected element exists;
- no missing media regression;
- no unexpected clipping;
- no preview-only outlines;
- title remains legible;
- Motion state matches Click Timeline;
- Effects render in correct placement;
- editor preview and audience output agree.

For creative quality, maintain a small human-rated corpus rather than pretending a pixel diff measures aesthetics.

### 6. Context efficiency

Measure:

- tokens/bytes returned by inspect;
- number of inspect calls;
- calls per completed task;
- how often the model requests an entire deck unnecessarily.

Aim for sparse default output with explicit expansion.

### 7. Cross-client matrix

A release candidate should be tested with multiple MCP hosts.

At minimum:

| Client | context | inspect | apply | image result | resources |
|---|---:|---:|---:|---:|---:|
| Codex | | | | | |
| VS Code | | | | | |
| Cursor | | | | | |
| Claude Code/Desktop | | | | | |

Do not ship a contract that only works because one host tolerates malformed or non-standard responses.

## MCP protocol practices

Target the `2026-07-28` MCP spec and TypeScript SDK v2.

### Use stdio locally

The local helper should be launched by the MCP host.

Write protocol data to stdout only through the SDK transport.

Write diagnostics to stderr.

### Do not invent hidden protocol sessions

The current spec core is stateless.

Application state is fine, but make the state visible through explicit identifiers:

- document ID;
- revision;
- slide ID;
- element ID;
- Effect instance ID.

### Structured schemas

Use Zod/JSON Schema for every input.

Use output schemas for structured results.

Keep schema nesting bounded and understandable to a model.

Prefer enums over magic strings.

Put units in field names when ambiguity exists:

- `durationMs`;
- `stageTimeMs`.

### Tool annotations

Declare risk accurately.

Read tools:

```text
readOnlyHint=true
destructiveHint=false
idempotentHint=true
openWorldHint=false
```

Edit tools:

```text
readOnlyHint=false
destructiveHint=true
idempotentHint=false
openWorldHint=false
```

Annotations are hints, not security enforcement.

### Resources for large stable context

Use Resources for:

- Effect ABI;
- Motion semantics;
- Presence semantics;
- capabilities.

Do not duplicate these contracts in every tool description.

### Avoid deprecated features for new design

The 2026-07-28 release deprecates Roots, Sampling and MCP Logging.

Do not build ShowMe's core workflow around them.

The external host/model already performs generation. ShowMe does not need MCP Sampling to write shaders.

### Prompts are optional

MCP Prompts can expose convenient user-triggered workflows later, but they are not required for the editing architecture.

Possible future prompts:

- "Improve selected slide";
- "Add restrained motion";
- "Audit presentation consistency".

These should compose normal tools, not add hidden capabilities.

### Tasks are unnecessary initially

ShowMe edits should be fast synchronous calls.

Do not use the Tasks extension for ordinary editing.

It may make sense later for expensive exports or full-deck batch analysis, but only if those workflows genuinely exceed normal request timing.

## Security tests

Before enabling writes, add tests for:

- unauthenticated local bridge request;
- invalid token;
- non-loopback request;
- hostile Host/Origin if HTTP is used;
- oversized request;
- invalid Zod payload;
- arbitrary filesystem path attempts;
- Effect source size limits;
- malformed IDs;
- calls after document close;
- bridge token file permissions where testable.

The MCP helper must not be an Electron IPC proxy.

## Repository placement when implementation starts

Suggested structure:

```text
src/
  core/
    agentOperations.ts        # semantic operation schema + pure mapping
    agentInspection.ts        # compact read projections
    agentResults.ts           # stable errors/results

electron/
  agentBridge.ts              # private authenticated local bridge
  agentContext.ts             # latest editor context

mcp/
  package.json
  src/
    server.ts                 # MCP registration
    showmeClient.ts           # private bridge client
    schemas.ts
```

Do not put model-specific logic in core.

Do not make React components part of the public MCP contract.

## Tests when implementation starts

Use the repo's existing test philosophy.

Likely mapping:

- semantic adapter: core/editor feature tests;
- Effect authoring/validation: effects feature tests;
- authority/lease/revision behavior: editor/persistence feature tests;
- local Electron bridge: focused extended/Electron test;
- MCP protocol server: small deterministic unit/integration test;
- render result: existing media/effects/presenter harnesses where possible.

Run only relevant areas during development.

Broaden for changes to `DocumentAuthority`, storage schema, Electron security boundary or release packaging.

## Release gate

Do not call the MCP ready merely because a client connects.

Minimum release gate:

- read-only context/inspection works across at least three clients;
- common edits are atomic and native;
- stale revisions reject;
- active human lease conflicts are safe;
- Effect validation shares production code;
- rendered previews are visually useful;
- no direct file mutation;
- no alternate document authority;
- no arbitrary code execution tool;
- benchmark corpus has a documented success baseline;
- all public tool inputs/outputs are versioned by server release and covered by tests.

The first public MCP should be small and boring enough that agents can trust it.


## Visual authoring benchmark corpus

The expanded semantic surface is intended to support these future model evaluations
without repository access:

### Task A: editorial title slide

Start from a blank slide. Build a restrained title, subtitle, rule and page marker
with exact frames and typography. Render through the production preview and refine.

### Task B: image + text layout

Start with a ShowMe-managed image asset ID. Insert it through the bounded managed
asset operation, build a large cropped image beside text, use Frame fill/crop
semantics, and verify the content transform through structured inspection.

### Task C: structured information slide

Build a three-column information layout using normal shapes, text, alignment,
distribution, grouping and duplication. Verify hierarchy and parent-local geometry.

### Task D: creative slide

Build a typographic composition using normal authoring primitives plus a CSS,
text-JS or GLSL Effect. Animate a native or numeric Effect property through Motion.

### Task E: repair an existing slide

Inspect a deliberately weak layout, improve hierarchy/spacing/typography and z-order,
then compare structured state and production previews before/after.

The real Electron MCP suite now covers the core prerequisite for this corpus: a client
can create a complete title slide from scratch in one semantic batch, inspect it and
render the production PNG.

## Current authoring boundary

Implemented now: slide lifecycle/order/hidden state/templates, layer management,
text/shape/Frame creation, parent-local transform/appearance, hierarchy/z-order,
duplicate/group/ungroup/reparent, alignment/distribution, Text Styles, existing-media
Frame/crop transforms, deck CSS, Effects, Motion, Presence and production preview.

Managed image/SVG/video insertion is supported by existing authorized asset ID.
Intentionally unsupported: importing arbitrary filesystem paths or raw bytes into the
Library through MCP.
