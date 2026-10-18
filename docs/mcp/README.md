# ShowMe MCP design

Status: Phases 1–6 are implemented for local development: inspection, production
previews and ordinary editing through the local MCP server. Editing requires both
Enable MCP and Allow agent editing. Cross-host model evaluation remains pending.

Start with [local client setup](./LOCAL_SETUP.md). See the
[Phase 4 plan](./CODEX_PHASE4_PLAN.md) and [verification/evaluation record](./CODEX_PHASE4_READONLY_EVAL.md).
The Phase 4 contract takes precedence over broader, differently named research proposals.

See [the Phase 5–6 implementation findings](./CODEX_PHASE5_6_FINDINGS.md) for the
semantic adapter, `showme.apply`, retry/commit boundaries and agent history. The
developer explicitly authorized local editing tests while model evaluation continues.

Base reviewed: `main` at `7640df7c2b4d229a4baa51567b095d9d1901946b`.

## Implemented: Phase 1 read projection

`src/core/agentProjection.ts` provides three pure application reads over an existing
`DocumentProjection`:

- `projectAgentDeck(projection)` — deck metadata and ordered slide metadata;
- `projectAgentSlide(projection, options?)` — resolved visual composition as flat
  preorder, including template ownership, layer/parent/sibling identity, base world
  bounds, bounded text previews and Effect/Motion/Presence flags;
- `projectAgentElements(projection, elementIds, options?)` — exact details for only
  the requested IDs, deduplicated and returned in visual order.

Example application usage (no MCP transport):

```ts
const projection = await runtime.projection(documentId, slideId);
const outline = projectAgentSlide(projection);
const detail = projectAgentElements(projection, [elementId], {
  includeWorldTransform: true,
});
```

Every response carries document identity, epoch, accepted/saved revisions and dirty
state. Functions never acquire state or mutate their input, and results are detached.
`AgentProjectionError` identifies unknown slides/elements and missing templates.
Slide/element reads require a presentation slide, rather than a template-editing page.

Important limits/defaults:

- A projection contains one slide. Deck metadata does not invent counts for other slides.
- Indices are zero-based. World bounds describe base-frame AABBs, not clipped,
  animated or Effect pixel bounds. Derived geometry is rounded to three decimals;
  native frames remain exact. World matrix/corners are opt-in.
- Text previews contain at most 160 Unicode code points, with length/truncation
  metadata. Exact text and resolved typography are scoped details.
- Hidden slides/layers expose structure but withhold text/content details unless
  `includeHiddenContent: true` is explicit. Locked visible layers remain inspectable.
  Existing object names remain structural metadata; this is content minimization,
  not an access-control boundary. Presence visibility is not sampled.
- Notes, filenames, filesystem paths, media bytes, Effect/stylesheet source and raw
  Motion tracks are excluded. Media uses an explicit metadata allowlist.
- Effect detail reports authored instance parameter overrides, default time controls
  and any bound schedule; it does not report sampled runtime values or compile source.
- Scoped IDs do not implicitly expand a container's children or unrelated content.
  Default payload still grows with element count; there is no pagination yet.

The deterministic seven-element test fixture produces compact JSON payloads of
407 bytes for deck metadata, 3,319 bytes for the slide outline and 1,497 bytes for
one title detail. With 90,000-character title/Effect source inputs, the slide outline
is 3,465 bytes; full bodies/source are not included. These are fixture observations,
not token budgets or performance benchmarks.

Coverage lives in `tests/feature/editor/agentProjection.test.ts` (13 explicit unit
contracts), registered as feature/editor. See [the Phase 1 plan](./CODEX_PHASE1_PLAN.md)
for implementation scope and verification commands. No authority, persisted schema,
editor UI, rendering or production rendering caller changed in this phase.

## Implemented: Phase 2 live context and setting

Main Settings now includes **MCP · Experimental → Enable MCP**, disabled by default.
The preference is stored in application settings, outside presentations. It enables
local context publication/reads and disabling it immediately clears the published
view. Phase 4 now starts/stops the authenticated loopback bridge with this same
preference, gating context, inspection and previews together.

The desktop application API is:

```ts
const enabled = await platform.getMcpEnabled!();
await platform.setMcpEnabled!(true);
const context = await platform.agentContext!();
```

`agentContext()` returns enabled/availability state, a monotonic process-local
`uiEpoch`, accepted document metadata/revisions, nullable editor context and a
separate compact presentation summary. Editor context identifies slide versus
template page, selection/scope, edit/media/Motion view mode and optional timeline
selection/preview stages. Timeline drafts are explicit. The native preview anchor,
sample time and running flag describe an observation, not exact playback time at
query delivery. Presenter timing likewise comes from existing state, not a new clock.

The publisher hook reads existing editor/workspace state and sends a strict typed
attach/publish/detach action through editor-main-frame-only IPC. Host-issued view
tokens and per-view sequences prevent old updates or cleanup from replacing a new
view. Document switches, successful close, navigation/reload, renderer loss and
window destruction invalidate context. Browser mode leaves this optional capability
absent. No document operations, leases, actor/history changes or persistence paths
were added.

The host service reads the existing accepted projection, removes deleted/unaccepted
selection handles, clears vanished scopes, and returns unavailable for missing pages,
epochs, templates or guest projections. Reads retry once if the view changes while
awaiting a projection; they never substitute another page or authority. Current guest
reads use the existing collaboration replica route, and disconnected guests are
unavailable. Only the preference is persisted.

`uiEpoch` tracks meaningful published UI changes, normalization, view availability
and presenter navigation. Duplicate samples, document revisions alone and passive
running time do not advance it. The publisher does not follow the workspace's
100 ms informational cursor while playing and adds no timer or animation loop.
The counter is a freshness handle, not a one-to-one count of UI actions.

Coverage: 11 feature/editor unit declarations and 2 extended/editor Electron
declarations. The Electron path exercises the actual setting, selection, timeline,
template/slide navigation, reload, payload validation and window/frame boundary.
See [the Phase 2 plan](./CODEX_PHASE2_PLAN.md) for scope and verification.

## Implemented: Phase 3 production previews

The desktop application now exposes a read-only `agentPreview()` operation:

```ts
const result = await platform.agentPreview!({
  documentId: projection.documentId,
  epoch: projection.epoch,
  revision: projection.revision,
  slideId: projection.slide.id,
  width: 960,
  height: 540,
});
if (result.ok) {
  // result.pngDataUrl, width, height, warnings, accepted IDs/revision
}
```

Inputs are strict and accept IDs/freshness fields, not document bodies or source.
Both dimensions are explicit output pixels, integer 1–2048. Successful results include
`mimeType: "image/png"`, `state: "base"`, exact output dimensions, document/slide IDs,
epoch/revision, PNG data URL and production warnings. Missing media keeps the normal
placeholder and produces `MISSING_MEDIA`; diagnosed Effects produce `EFFECT_FALLBACK`.
Warnings identify affected elements/instances without returning source or paths.

The service reuses the existing render projection, bounded native preview queue,
isolated `SlidePreviewPage` and shared `SlideRenderer`. It waits for normal image,
font and Effect readiness, including surfaces still preparing after a native resize,
then captures/resizes and clears the surface. Internal editor thumbnails retain their
existing data-URL/null contract and continue working with MCP disabled.

Only the active document's presentation slides are accepted. Inherited templates
render normally, but a template-editing page is not itself a preview target. Epoch
and exact revision are checked before and after capture. Closing/replacing the
document, disabling MCP or disabling/re-enabling it during capture discards the
result. Selection or slide navigation does not retarget an explicitly identified
slide. Guest reads use the existing collaboration projection when available.

Failures are structured `{ ok: false, error: { code, message, recoverable, ... } }`,
including `INVALID_REQUEST`, `MCP_DISABLED`, `MCP_ACCESS_CHANGED`,
`DOCUMENT_NOT_ACTIVE`, `DOCUMENT_UNAVAILABLE`, `EPOCH_CONFLICT`,
`REVISION_CONFLICT` (with actual revision), `UNKNOWN_SLIDE` and `PREVIEW_FAILED`.
The operation does not acquire editor leases, flush drafts, move selection/playhead,
save a file or modify the document.

This is base slide state, with existing static-video/poster behavior. It is not a
deterministic click/time sample or an audience-session screenshot. Time-based Effects
use the production preview's existing clocks. Timeline inputs are rejected for now.
See [Phase 3 findings](./CODEX_PHASE3_FINDINGS.md) for rendering differences, test
coverage and verification. The setting's copy now refers to local context/previews
and local MCP connections, without suggesting a remote MCP service.

## Implemented: Phase 4 local read-only transport

`mcp/stdio.ts` is a standalone SDK v2 helper exposing `showme.context`,
`showme.inspect` and `showme.preview`. The host launches it with Node and an explicit
ShowMe user-data path. It discovers a running app through private per-instance
descriptors and authenticates to `electron/agentBridge.ts` on literal loopback.
Settings shows status and copies a token-free client configuration. The desktop
package ships the helper outside ASAR; no Electron run-as-Node mode is required.

`electron/agentInspection.ts` wraps existing sparse projections with strict scope,
active-document, epoch/revision and selection-UI-epoch checks. The private bridge
has exactly three read commands, browser-request protections, bounded payloads/work,
and immediate revocation. Off/on cycles rotate identity/credentials. No document
state or protocol dependencies move into the renderer.

The SDK owns stdio framing and compatibility negotiation. Structured JSON results
also have compact text; previews contain one MCP image plus metadata without repeated
image bytes. Client/model comparisons remain an explicit Phase 4 evaluation gate.
Agent writes, deterministic timeline sampling and Effect validation extraction
were the next planned capabilities after this read-only slice. Ordinary writes are
now implemented below; timeline sampling and Effect validation remain later work.

## Implemented: Phases 5–6 local editing

`showme.apply` stages up to 32 semantic operations against one explicit presentation
slide and expected document epoch/revision. Supported operations are `text.set`,
`elements.move`, `elements.frame.set`, `elements.appearance.patch`,
`element.insert_text`, `element.insert_shape` and `elements.remove`.

`electron/agentEditing.ts` uses an ordinary actor-scoped `EditorSession` and the
existing runtime/authority/durable writer. Exact revision/access checks run inside
the authority queue; native guarded stale behavior for human/LAN callers stays intact.
Auto-sized text uses production DOM/font measurement. Frame resizing shares native
Free-media/text preservation. No document/persistence format or second authority was
introduced. Collaboration guest writes are explicitly unsupported.

A process-local epoch registry shares pending requests and replays terminal receipts
for identical mutation IDs, without duplicate insertions. Accepted IDs/results survive
helper reconnect, off/on and undo. In-flight durability finishes even if the response
is lost; a timeout does not imply rejection. Registry bounds are explicit; old accepted
identities are not silently evicted. New epochs require inspection and deliberate intent.

The toolbar's Agent controls use actor `mcp-local` history. Human Ctrl+Z remains actor
`local`. User agent undo/redo works with MCP turned off and still respects native
lease/guard conflicts; shared-parent structural changes can legitimately block undo.
The compact Agent label exposes the latest change summary in its tooltip/accessibility
label. See [setup and apply examples](./LOCAL_SETUP.md) for the actual request contract.

## Research and Codex investigation

The initial architecture was followed by a second research pass focused specifically on how models should see current presentation state.

Read these before implementation:

- [RESEARCH_CONTEXT_AND_STATE.md](./RESEARCH_CONTEXT_AND_STATE.md) — current MCP/Figma/context-engineering research and the recommended Agent Projection.
- [CODEX_PHASED_PLAN.md](./CODEX_PHASED_PLAN.md) — investigation-first implementation sequence with phase gates and evals.

The research makes the model-facing read projection a first-class part of the design: compact orientation, scoped semantic inspection, world-space geometry, explicit UI epoch, on-demand source/native detail, and production-rendered visual verification.

## Goal

Build an MCP interface that lets an external agent inspect, edit, animate, preview and refine a running ShowMe presentation while preserving ShowMe's existing document, collaboration, undo, rendering and Effect semantics.

The MCP should feel like operating ShowMe, not like editing its JSON format.

A good result is:

- few model-facing tools;
- native editable ShowMe output;
- one canonical persistence path;
- atomic multi-part edits;
- useful visual feedback;
- deterministic, structured errors;
- safe behavior while a human is editing;
- no hidden model inside ShowMe;
- no second document runtime;
- no direct mutation of `.sme` files.

## Existing architecture is the foundation

ShowMe already has the important boundary:

```text
Editor
  -> EditorSession
  -> DocumentOperation[]
  -> DocumentTransaction
  -> DocumentAuthority
  -> durable recovery
  -> accepted revision
```

MCP mutations must eventually enter this exact path.

Do not introduce:

- an MCP-owned document copy;
- an MCP-specific document schema;
- a second `DocumentAuthority`;
- direct file editing;
- a separate Effect persistence model;
- a general-purpose JavaScript execution tool.

The MCP layer should translate compact semantic requests into the same command functions and document operations already used by the editor.

## Proposed system

```text
MCP host
ChatGPT / Codex / Claude / Cursor / VS Code
                 |
                 | MCP
                 v
        showme-mcp helper
        local process, stdio
                 |
                 | private local bridge
                 v
        running ShowMe desktop app
                 |
        +--------+---------+
        |                  |
   editor context      semantic edits
        |                  |
        v                  v
   current slide      EditorSession /
   selection          DocumentRuntime
   scope                    |
        |                   v
        |             DocumentAuthority
        |                   |
        +--------+----------+
                 |
                 v
             renderer
                 |
                 v
              preview
```

The MCP helper owns protocol translation only. It does not own presentation state.

For the first implementation, target local desktop workflows. A remote/cloud MCP can be designed later without changing the semantic tool contract.

## Public MCP surface

Keep the public surface intentionally small.

### `showme_context`

Read the active editor context.

Returns enough information to resolve phrases such as "this slide", "the selected title" or "these elements":

- active document ID;
- current slide ID;
- current selection IDs;
- current editing scope;
- current accepted revision;
- deck size;
- presentation name.

This is ephemeral UI context, not persisted document data.

### `showme_inspect`

Read selected presentation state with an explicit scope and requested detail.

Examples:

- deck outline;
- one slide;
- selected elements;
- element tree;
- geometry;
- text;
- appearance;
- Motion;
- Presence;
- Effects;
- notes;
- theme/stylesheet.

Default responses should be sparse. The agent should not receive the whole presentation because it asked about one title.

### `showme_apply`

Apply one atomic semantic edit transaction.

The input contains a list of high-level ShowMe operations such as:

- set text;
- insert text/shape/frame;
- set frame or appearance;
- move/resize/rotate;
- duplicate/delete/reparent/reorder;
- set slide background/notes;
- add/edit native Motion;
- add/edit Presence;
- apply/update/remove an Effect;
- set Effect parameters;
- create/delete/reorder slides.

The adapter uses existing ShowMe command functions to produce `DocumentOperation[]`, then commits through the canonical authority.

One tool call should normally correspond to one coherent undo/history unit.

### `showme_render`

Return a rendered preview for visual inspection.

At minimum:

- document ID;
- slide ID;
- width/height;
- PNG result.

Then extend it to deterministic presentation states:

- stage/click index;
- stage time;
- optional presentation/slide clock state;
- Preview mode rather than editor overlays.

For a presentation editor, visual verification is part of correctness.

### `showme_history`

MCP-owned undo/redo for agent edits, if MCP uses a separate authority actor. Keep this narrow. It should not be a general "undo whatever the human last did" tool.

This tool may be omitted from the first spike until the actor model is settled.

## Resources, not giant tool descriptions

Use MCP resources for stable read-only authoring contracts:

```text
showme://spec/effects
showme://spec/motion
showme://spec/presence
showme://spec/document-semantics
showme://effect-authoring/{documentId}/{slideId}/{elementId}
```

The Effect authoring resource should be generated by the existing `buildEffectAuthoringPrompt()` path. This is the correct place for the detailed GLSL/CSS/JS ABI.

The MCP tool description should not repeat thousands of tokens of Effect documentation.

## Effects: the agent writes the code

Do not build an "Effect compiler" that calls another model.

The MCP client already has a model.

Correct flow:

```text
agent decides an Effect is appropriate
  -> read ShowMe Effect authoring resource
  -> agent writes GLSL / CSS / text JS
  -> showme_apply receives normal EffectDefinition
  -> ShowMe validates it using the production Effect runtime
  -> setElementEffectDefinition(...)
  -> normal document transaction
  -> showme_render
  -> agent visually checks result
```

Extract the Effect validation currently embedded in `EffectEditor.tsx` into a reusable production function so the Effect Editor and MCP use identical validation.

Keep Effect Library ownership separate:

- "apply this Effect" changes the presentation;
- "save this Effect to my library" changes the Library.

Generated Effects should not automatically pollute the global Effect Library.

## Motion and Presence stay native

Agents should use ShowMe's native abstractions instead of generating code for ordinary animation.

Examples:

```text
"move the title in"          -> native Motion
"pulse these three cards"    -> native Motion
"show this from click 2"     -> Presence
"scramble these characters"  -> text Effect
"distort this image"         -> shader Effect
"flowing generated backdrop" -> generated shader Effect
```

The MCP should expose these as semantic operations while preserving ShowMe's existing Motion/Presence model.

## Important open decision: actor identity

`DocumentAuthority` currently uses `actorId` for both lease ownership and actor-scoped history.

This creates a real trade-off.

### Reuse actor `local`

Advantage:

- normal Ctrl+Z naturally includes agent edits.

Problem:

- leases from the same actor do not conflict;
- acquiring the same scope replaces the same actor's lease;
- a second MCP-side session could invalidate or interfere with an active local editor gesture.

Therefore a second independent `EditorSession` using actor `local` is not safe enough.

### Separate MCP actor

Advantage:

- proper lease conflict with active human edits;
- clean attribution;
- agent undo/redo can be actor-scoped;
- behaves like a collaborator.

Problem:

- normal local Ctrl+Z does not currently own the MCP actor's history.

Recommended first implementation: use a distinct MCP actor for safety, surface lease conflicts clearly, and provide MCP-owned rollback. Before release, decide whether the editor should gain a user-facing way to undo/revert the latest accepted agent transaction.

A stronger future design could separate "lease identity" from "history ownership", but that is a DocumentAuthority design change and should not be introduced casually.

## Current MCP protocol target

As of 2026-10-13:

- target MCP specification `2026-07-28`;
- use the stable TypeScript SDK v2 (`@modelcontextprotocol/server`);
- use stdio for the local process-spawned MCP helper;
- use Streamable HTTP if a remote service is added later;
- do not build new features on deprecated Roots, Sampling or Logging;
- do not rely on hidden MCP protocol session state;
- use explicit ShowMe IDs/revisions in requests;
- use JSON Schema / Zod input and output schemas;
- return `structuredContent` that conforms to declared output schemas;
- set tool annotations deliberately (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

References:

- https://modelcontextprotocol.io/
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://developers.figma.com/docs/figma-mcp-server/

Figma is useful as a current creative-tool reference, particularly its separation of sparse metadata, richer context, native write operations, screenshots, shader source and workflow Skills. ShowMe should borrow those reliability patterns, not copy Figma's document model.

## What "world-class" means here

Not maximum tool count.

It means the agent can reliably complete real presentation work with few calls:

```text
inspect only what matters
  -> make one coherent native edit
  -> receive exact changed IDs + revision
  -> render the relevant state
  -> inspect the image
  -> make one targeted refinement if necessary
```

Measure:

- task success;
- correct target selection;
- schema-valid calls;
- calls per successful task;
- unrelated mutations;
- stale revision handling;
- lease conflict handling;
- deterministic replay;
- visual correctness;
- editor/audience/export parity;
- Effect compile/runtime success;
- recovery after failed calls;
- cross-client behavior.

See the other documents in this folder for the proposed contracts, integration seams and implementation sequence.
