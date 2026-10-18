# Phase 1 plan: deterministic Agent Projection

Status: implemented, 2026-10-17. See README.md for the resulting API and limits.

This is Phase 1 of `CODEX_PHASED_PLAN.md`, refined by `CODEX_PHASE0_FINDINGS.md`.
The older `IMPLEMENTATION_AND_EVAL.md` uses different phase numbering; its transport
spike is not the next step.

## Outcome and gate

A caller can pass an existing `DocumentProjection` to pure functions and obtain:

1. a deck metadata outline;
2. a compact outline of the projected slide's visual composition;
3. exact, scoped details for explicitly identified elements.

The result must be useful for targeting and layout reasoning without MCP, React,
Electron, document mutations, or a model. The phase ends when focused domain tests
demonstrate that contract. Live context, capture, bridge and MCP transport follow
in later phases.

## Repository facts that constrain the API

- `DocumentProjection` contains deck metadata, one slide and optional templates.
  It does not contain every slide's body. The deck outline therefore cannot
  report per-slide element counts. Those counts belong to the projected slide's
  outline; do not fetch other slides or use `fullSnapshot()` to fill them in.
- `resolveVisualSlide()` in `src/core/templates.ts` composes inherited and local
  children in global layer order and returns source ownership. Use its resolved
  slide for inspection and geometry.
- `scene.ts` owns world matrices and bounds. Bounds describe the base frame's
  world-space AABB, not animated pixels, Effect overflow, glyph bounds, or the
  visible clipped intersection.
- An Element has orthogonal content, geometry and container fields. Expose these
  facts rather than inventing an exclusive persistent element type.
- Hidden and locked flags belong to deck layers. Slide hidden state is separate;
  Presence is timeline behavior, not the same visibility flag.
- Text formats reference real deck text-style IDs or local typography. Preserve
  that distinction and use `resolveTextTypography()` for requested exact detail.

## Proposed application API

Keep types, small helpers and exports in `src/core/agentProjection.ts`:

```ts
projectAgentDeck(projection: DocumentProjection): AgentDeckOutline;

projectAgentSlide(
  projection: DocumentProjection,
  options?: AgentSlideOptions,
): AgentSlideOutline;

projectAgentElements(
  projection: DocumentProjection,
  elementIds: readonly string[],
  options?: AgentElementOptions,
): AgentElementDetails;
```

The supplied projection determines the slide. These functions do not acquire or
refresh projections. Every result identifies `documentId`, `epoch`, `revision`
and `savedRevision`; dirty state derives from the revision fields.

Do not finalize MCP tool names, output schemas, resource URIs or universal detail
levels here. These are application read functions, not the public wire contract.

### Deck outline

Return deck ID/name, canvas size, slide count and ordered slide metadata:
ID, zero-based index, name, section, hidden state and template reference.
Report stylesheet presence without returning its source. Include no slide bodies,
speaker notes, recovery metadata, paths or unrelated template content.

### Slide outline

Return slide ID/index/name, hidden state, template reference, resolved background,
layer metadata and element count. Emit a flat preorder of the resolved composition.
Each entry contains:

- stable ID and optional existing name;
- source owner (`slide` or `template`) and the owning page ID;
- actual `parentId` (including layer roots), `layerId`, `layerIndex`, depth,
  sibling index and child count;
- content type or null, geometry type, container and clipping flags;
- world bounds and real text-style reference when present;
- bounded text preview, text length and explicit truncation state when permitted;
- Effect count, native Motion flag and Presence flag.

There is no scalar `z`, invented semantic name, or claim that template content is
slide-owned. Layer visibility/locking is available through the returned layer
metadata. Do not label template content editable solely because its layer is unlocked.

### Scoped element detail

Return only explicitly requested elements, ordered by canonical slide preorder.
Deduplicate requested IDs. A selected container does not implicitly expand its
descendants. Preserve parent/layer references without returning unrelated content.

Add exact local frame, appearance, geometry, clipping and content metadata.
Text detail includes exact text/format and resolved typography. Media detail uses
an allowlist: asset ID, media type, transform and relevant playback settings;
exclude filenames, paths and bytes in this first slice.

Include Effect instance/resource IDs, name, kind, target/input, placement, enabled
state, parameter values and timing metadata. Source and style source stay excluded.
Motion/Presence remain compact flags/stage references, without raw tracks or sampled
runtime state. Optional world matrix/corners can use existing scene/element helpers.

Unknown requested IDs reject the scoped call as a whole with a typed local error
containing the missing IDs. An empty request returns an empty list. Missing required
template data remains an explicit failure; do not silently inspect local-only content.
Keep any small error type in this module until another application consumer needs it.

## Determinism, privacy and size

- Preserve layer, sibling, Effect-instance and stage ordering. Sort dictionary keys
  where canonical output requires it, without changing meaningful array order.
- Round derived geometry to three decimal places and normalize negative zero.
  Exact native frames remain unrounded. This is output formatting, not new scene math.
- Limit default text previews to 160 Unicode code points, with a code-point length
  and truncation flag. Do not split surrogate pairs.
- Hidden slides/layers retain structural metadata, but their text previews and
  content-bearing detail are withheld unless `includeHiddenContent: true` is explicit.
  Locked visible content is still inspectable. Presence does not suppress content:
  this phase does not claim to sample current timeline visibility.
- Speaker notes, Effect source, stylesheet source and raw native Motion are outside
  this phase, including scoped detail.
- Treat all document strings as data. Do not interpret them as agent instructions.
- Build detached results and never mutate the supplied projection or leak mutable
  references into it.
- Default size should not grow with full text or Effect source length. It still
  grows with element count; do not claim a hard response-size bound or add speculative
  pagination in this phase. Measure fixture bytes as an observation, not an arbitrary
  pixel/token assertion.

## Work sequence

1. Add the module's result types and deck projection using current metadata only.
2. Add resolved slide traversal, ownership, ordering and production world bounds.
3. Add scoped allowlisted details, style resolution and Effect/Motion/Presence summaries.
4. Add privacy, deterministic formatting and invalid-target behavior.
5. Add one focused domain test file, register it and regenerate suite statistics.
6. Update the MCP README/Phase 0 status to describe what exists and what remains.

Do not change `DocumentAuthority`, `EditorSession`, persisted schemas, production
scene math, renderer behavior or existing editor UI for this slice. Keep the current
branch under the declared local-codex workflow; no automatic commit, push or PR.

## Verification

Place tests at `tests/feature/editor/agentProjection.test.ts`, registered as active
feature/editor unit coverage. The implementation being in core does not require
adding this feature's contracts to the tiny default core suite.

Use explicit named declarations covering:

1. deck ordering/metadata without fabricated unavailable counts;
2. deterministic resolved preorder, layers and parent/sibling identity;
3. nested rotation/scale/flip bounds, with known geometric expectations;
4. template ownership, inherited/local order and composed background;
5. hidden-content opt-in and visible locked-layer inspection;
6. Unicode preview truncation versus exact requested text and real style references;
7. scoped selection without sibling/descendant disclosure, empty and unknown IDs;
8. media metadata without filename/path/bytes;
9. Effect and Motion/Presence summaries without source/native tracks;
10. detached results, unchanged inputs and default output independent of long source/text.

Use representative deterministic fixtures and existing factories where suitable.
Avoid tests that merely compare a wrapper to the helper it calls. No browser or
Electron startup is needed.

Focused PowerShell invocation (Vitest selection is registry/config driven):

```powershell
$env:SHOWME_TEST_FILES = '["tests/feature/editor/agentProjection.test.ts"]'
try { npx vitest run } finally { Remove-Item Env:SHOWME_TEST_FILES }
```

Also run `npm run typecheck`, `npm run test:stats` and `npm run test:audit` after
implementation. Broaden only for a relevant failure or unexpected shared change.
Do not run the full suite, release packaging or audience benchmarks for this slice.
The planned new read-only module has no production rendering callers; the audience
navigation commit gate becomes relevant if implementation expands into rendering
or its preparation. No commit is part of this plan.

## Handoff and next phase

Report the implemented API, representative payload sizes, exact verification results,
privacy limits and any deviations from this plan. Phase 1 passes when a test caller
can understand and precisely target the resolved slide from the returned projection.

Then stop at the phase gate. Phase 2 adds the narrow ephemeral editor-context
publisher and `uiEpoch`; it must not move UI state into the document.

## Implementation outcome

Implemented the three planned functions in `src/core/agentProjection.ts` and 13
explicit contracts in `tests/feature/editor/agentProjection.test.ts`, registered as
feature/editor unit coverage. Public MCP names/schemas remain undecided. There are
no new production callers, mutable state owners, persistence paths or rendering changes.

The deck outline deliberately omits other slides' unavailable element counts.
Hidden-content withholding preserves existing object names as structural metadata;
it is not an access-control mechanism. Effect parameter values are authored instance
overrides, not resolved defaults or sampled animated values. Scoped exact text/media/
Effect details and opt-in world transforms share the resolved visual composition.

Representative compact JSON bytes: deck 407, seven-element slide 3,319, title detail
1,497, slide with 90,000-character title/source 3,465. Output remains proportional to
element count, not whole source/text length.

Verification completed:

- Focused PowerShell invocation above: 1 file, all 13 tests passed.
- `npm run typecheck`: passed.
- `npx eslint src/core/agentProjection.ts tests/feature/editor/agentProjection.test.ts`: passed.
- `npm run test:stats`: updated statistics (475 active tests, 77 groups).
- `npm run test:audit`: passed.
- Whitespace diff review: passed.

Browser/Electron tests, full-suite checks, packaging and audience-navigation tests
were not run. This adds a pure module without production callers and changes no
rendering or output preparation, so the audience-navigation gate is not applicable.
No commit, push or PR was created. Phase 1 is complete; Phase 2 has not started.
