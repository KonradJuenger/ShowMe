# MCP authoring revision plan

Date: 2026-10-18. Status: proposed; implementation has not started.

Basis: [EMBER deck authoring test](deck-authoring-test-2026-10-18.md), current MCP server 1.3.0, and source review at `df31f1a733cdfb3992c15ea6f5b14ff32c9f0069`.

## Intended outcome

An agent with only the connected MCP tools can create, revise, visually check, and deliver an animated deck without repository access, hidden runtime warmup, or reconstructing its animation after every edit. The first milestone fixes the failures demonstrated by EMBER. Later milestones complete animation review and reduce authoring work.

Keep the existing path:

`MCP intent -> EditorSession -> DocumentOperation[] -> DocumentTransaction -> DocumentAuthority -> durable recovery -> accepted revision`

Keep template ownership, parent-local geometry, leases, exact revision admission, atomic failure, actor-scoped history, and mutation replay. Do not introduce another document schema, renderer, persistence path, arbitrary JavaScript executor, or Electron IPC passthrough.

## Findings that affect the design

- Cold batch measurement and effect validation failures are reproducible. `src/main.tsx` lacks lazy wrappers for two functions used by `electron/main.ts`; insertion with single-element measurement initializes the module and unblocks both.
- The server already derives its input JSON Schema from the Zod mutation schema in `mcp/server.ts`. The host-facing tool representation in this session exposed `unknown` alternatives. Do not assume the server omitted the schema: inspect raw `tools/list` and the host's projection before changing schema representation.
- `TEMPLATE_OWNED` is a correct rejection with a useful recovery suggestion. Improve discovery rather than automatically detaching templates.
- Top-level apply `slideId` currently identifies the request context; creation intentionally leaves the human's selection/navigation alone. Clarify the receipt rather than moving the editor to satisfy an agent assumption.
- Replay returns a historical receipt. Its `revision` must retain that meaning; a separately observed current revision must not rewrite the transaction result.
- Production preview intentionally renders base state. Its successful PNG and empty warnings cannot establish timeline correctness or smoothness.
- Native Presence/Effect schedules already have offsets, end events, and stable block/stage IDs. Most timeline work should expose current semantics, without changing persisted formats.
- Warm slide batches were already fast in this session. Discovery, initialization failures, repeated round trips, and inability to inspect animation are the immediate efficiency problems. Multi-slide batching is a separate transaction feature, not the first optimization.

## Milestone 1 — Reliable startup and self-contained discovery

Proposed release: server 1.4.0, preserving the current public v1 document and effect API contracts.

### 1A. Fix cold runtime initialization (P0)

Implementation locations: `src/main.tsx`, `src/components/SlidePreviewPage.tsx`, hidden-runtime orchestration in `electron/main.ts`, and `electron/agentTextMeasurement.ts`.

1. Register lazy wrappers for `measureAgentTextBatch` and `validateAgentEffect` with the same shared installation promise used by existing preview/single-text entry points. Ensure wrappers dispatch to the installed function after initialization, not back into themselves.
2. Centralize the list of runtime entry points sufficiently to prevent a future tool from omitting its startup wrapper; avoid a generic remote function invocation API.
3. Preserve bounded queue admission and the existing one-time surface recreation. On reset, load failure, or renderer loss, the next admitted request must initialize a fresh surface.
4. Separate failures into actionable, sanitized details: initialization failure, renderer loss, timeout, cancellation, and queue capacity. Preserve the public error codes where appropriate; include a `reason` and retry guidance rather than claiming all failures mean the editor is not ready.
5. Expose a cheap runtime service status in context, separate from supported capabilities and editor availability. Reading context must not create/warm Chromium or claim a service is ready before installation completes. An uninitialized service is eligible for lazy initialization, not an unavailable feature.

Acceptance:

- The first call after a fresh application launch can be `showme.measure_text`, without any preview or text insertion.
- On a separate fresh runtime, the first renderer-dependent mutation can be a valid shader, CSS, or text-JS effect. Verify each entry path without another effect test warming it first.
- A renderer reset does not make subsequent calls permanently fail.
- Failed initialization does not partially commit a batch. Cancellation, access revocation, document replacement, and queue bounds remain effective.

### 1B. Make discovery sufficient to author without source access (P1)

Implementation locations: `src/core/agentMutation.ts`, `src/core/agentAuthoring.ts`, `mcp/server.ts`, and the MCP contract/setup documentation.

1. Capture raw SDK `tools/list` output and compare the exported `showme.apply` schema with the host-visible representation. Determine whether nested unions, JSON Schema conversion, or host normalization lose the operation shapes. Keep this diagnosis in the implementation record.
2. Export operation-family schemas from the canonical mutation schema. Do not maintain handwritten parallel validators. Give each variant an explicit operation description and useful examples.
3. Extend `showme.authoring` with a bounded operation/family contract request. Return required fields, optional fields, enum values, limits, valid parent/target rules, examples, and result semantics. Include deck naming, transitions, slide creation/ownership, and timeline stages, which are difficult to discover today.
4. Add explicit response detail selection: compact contract versus complete creative-code prompt. Preserve the current response behavior for existing requests; document the compact mode as the preferred agent workflow. Do not return every operation schema or the long effect prompt on every call.
5. Include a contract version and family/schema digest so a client can cache static discovery per server version. Keep document-scoped examples and inspected state revision-bound; never cache accepted state by schema digest.
6. Surface bounded validation issues with operation index, field path, and expected values. Avoid dumping whole requests or effect source into errors.

Acceptance:

- A clean host conversation can author a small deck with text, parent Frame, transition, shader, CSS effect, and Motion/Presence using MCP discovery only.
- Every advertised operation has an exported contract accepted by the actual validator; examples are checked by the canonical schema.
- Measure response bytes for each family and full prompt. Record the reduction from compact discovery; do not impose an arbitrary token target before measuring.
- If host normalization still loses nested schema information, authoring discovery remains a complete usable path and documentation states the host limitation accurately.

### 1C. Clarify receipts and ownership guidance (P1)

Implementation locations: `electron/agentEditing.ts`, mutation result construction, `mcp/server.ts`, and `electron/agentInspection.ts` with the shared projection/read contracts.

- Retain current `slideId` semantics and add explicit `requestSlideId` and `authoredSlideIds`. Document `createdSlideIds` as authoritative for newly created pages. Do not change human navigation/selection.
- Return transaction-created stage/block/track IDs once timeline authoring is added in milestone 2.
- Keep replay's original transaction receipt stable. Add a separate observation containing current epoch/revision when that state can be read under the same active-document/access checks. Label it as an observation, not a promise the next write cannot conflict. If unavailable, instruct the client to refresh context rather than substituting a guessed revision.
- Make scoped authoring/inspection identify inherited template background ownership and suggest `slide.make_independent` before an agent tries to replace it. Retain rejection when ownership is violated.

Acceptance: create-and-author returns the new page unambiguously; replay after later edits reports both historical transaction identity and current observation; stale writes remain rejected; no-op and metadata-only receipts remain correct.

## Milestone 2 — Deliberate animation authoring and deterministic review

Dependency: milestone 1. Proposed release: server 1.5.0. Keep effect API 1 unless actual shader/text runtime semantics change.

### 2A. Expose native timeline schedules (P1)

Implementation locations: `src/core/agentMutation.ts`, `src/core/motion.ts`, `src/core/presence.ts`, `src/core/motionModel.ts`, existing timeline editing commands, and inspection responses.

- Expose stable stage IDs, with existing stage-index inputs still supported under exact revision checks. Return generated stage, block, track, and relevant keyframe IDs. Clients should use IDs for subsequent edits after insertion/reordering.
- Extend Presence creation with native start offset and end schedule. Add semantic update/remove for a specific Presence block, preserving its ID and unrelated blocks.
- Expose numeric Motion delay and supported native preset settings. Add semantic update/remove for the authored track/block and explicit stage create/reorder/remove behavior. Validate references and property conflicts using native rules.
- Expose Effect schedule editing, including start offset, existing click-based stops, and progress easing. Keep effect time, normalized progress, Presence lifecycle, and Motion values separate.
- Advertise limits and invalid combinations, including slide-end exit constraints. Support no-op updates and reject ambiguous/deleted/foreign IDs atomically.
- Reuse the current persisted schedule versions. If an essential feature genuinely requires a stored-format change, stop that subtask and plan the versioned writer/reader/fixture/migration work together.

Acceptance scenario: author three grouped process columns at offsets 0/150/300 ms, revise the middle delay, remove its animation, and undo/redo the changes through the agent's existing history. No duplicate blocks; children remain parent-local; human changes are preserved.

### 2B. Add deterministic production-renderer sampling (P1)

Implementation locations: preview request/result schemas and services, `SlidePreviewPage.tsx`, existing `SlideRenderer` playback/clock inputs, motion playback/effect clocks, and the existing slide-transition renderer.

Add optional sampling to `showme.preview`; keep omitted sampling as the current base preview. Initial modes:

- **Authored/base:** current behavior, explicitly identified as unsampled.
- **Timeline sample:** a bounded activation/event trace and capture time. The trace supplies slide activation, reached clicks and their times, previous slide when relevant, and presentation origin. Derive stage starts and all clocks through existing playback logic. Reject impossible/non-monotonic traces; do not accept contradictory independent clock values.
- **Finite-complete:** at a specified reached stage, finish finite blocks whose stop is known, while sampling continuous effects at an explicit reference time. Do not invent future clicks/slide-end events or promise that an unbounded animation has a final frame.
- **Transition sample:** explicit previous/next slide and transition elapsed time, composed through the production transition path. A single-slide renderer alone cannot verify cross-slide push/wipe/fade.

Return the resolved sample context, actual stage/clock values, and warnings. Freeze the sampled scene consistently across DOM layout, CSS effects, GLSL, text workers, and raster preparation; wait for readiness and retain the native capture acknowledgement. Do not advance real presentation/editor state. Video stays a documented static poster in the first version.

Provide a bounded multi-sample request after single-sample correctness is established: at most six frames, total pixel/work budget, per-frame metadata, cancellation, and queue limits. This supports contact sheets without an uncontrolled rendering loop.

Acceptance:

- The same document/event trace/time produces the same semantic sampled state on repeated requests, independent of queue delay. Shader pixels use appropriate numerical tolerances rather than claiming cross-GPU byte identity.
- Capture before/mid/after a delayed entrance, a native numeric Motion segment, a CSS finite block, a text-JS counter, and a GLSL parameter animation.
- Verify backward navigation and jumps use the trace's actual previous slide and origins, not inferred elapsed-time identity.
- Preview does not move selection, change the active slide, add history, persist sampled text, or dirty the document.
- Access revocation, revision/epoch changes, cancellation, missing assets, effect fallback, and size changes retain existing guarantees.

Live audience playback control is deferred. Deterministic read-only sampling addresses the immediate review gap without taking over a human presentation. Sampling establishes visual/timing correctness; actual smoothness still requires an audience playback check.

## Milestone 3 — Efficient deck construction and typography feedback

Dependency: stable contracts from milestones 1–2. Implement after measuring the revised authoring workflow.

### 3A. Multi-page semantic batches (P2)

Extend the existing `showme.apply` tool with an explicit page-batch request form, mutually exclusive with the current single-slide form. Each page group has an existing target or an explicitly declared newly created slide ID. Preserve the existing request form and one mutation/revision admission for the whole transaction.

- Start with at most eight page groups and 128 total operations, plus bounded source-byte and renderer-validation budgets. Do not increase the current operation limit merely to make a demo fit.
- Build each page through native semantic commands against the same staged transaction. Later page work must see earlier staged deck/layer/style changes; reloading only accepted projections between groups would discard staged intent.
- Validate all touched pages, ownership, editability, leases and referenced assets. Commit once through the existing DocumentAuthority path. If current transaction machinery cannot provide this safely, do not emulate it with a series of separately committed writes labelled atomic.
- Return per-page results/ID mappings and one transaction receipt. A late-page failure, cancellation before admission, conflict, or replay must preserve all-or-nothing behavior and actor-scoped undo.

Acceptance: create and author a seven-slide sample in one batch; deliberately fail the final page and prove no earlier page or shared deck property committed. Confirm human selection is unchanged. Measure round trips, bytes, and end-to-end creation latency against the single-page workflow on the same machine; do not claim a render-speed improvement.

### 3B. Font and fit feedback (P2)

Extend bounded text measurement/inspection with requested font, resolved availability/fallback status where the platform can establish it, measured content extent, and overflow for an authored box. Use production font management/layout; do not infer missing fonts from guessed text widths or add another layout engine. Distinguish platform-installed and ShowMe-managed fonts. Report uncertainty rather than asserting an exact fallback the renderer cannot identify.

Acceptance: available font, missing requested font, late managed-font readiness, explicit line breaks, and clipped fixed box are explained before an agent has to discover the problem from repeated full-slide previews.

## Milestone 4 — Native save and bounded export (P2)

Dependency: native save/export service review. This is delivery capability, separate from document mutation batching.

- Add a dedicated semantic document-delivery tool using current save, Save As, and export/package services. Begin with native save and a clearly identified export format supported by the existing application.
- Support an existing associated destination or the native Save As picker. Unattended export may use a destination explicitly configured/authorized by the user or host. Do not add arbitrary filesystem reads/writes, direct `.sme` serialization, or automatic overwrites outside the existing destination policy.
- Require exact document identity/epoch and an expected revision. Define draft flushing explicitly: do not silently include another actor's unaccepted editor draft. Snapshot the accepted revision through current services and report the revision actually written; later edits remain dirty.
- Return saved/exported revision, format, destination/artifact reference, cancellation/error, and overwrite outcome. Saving must not create a synthetic authoring revision or second undo history.
- Preserve `.sme`/`.smp`/asset/current recovery semantics and existing export behavior for effects. State whether an export is static or preserves animation; do not imply that PDF/PPTX can reproduce arbitrary GLSL/CSS/JS playback.

Acceptance: first save, existing-destination save, cancelled picker, export failure, concurrent edit, document replacement, and package asset fidelity use the current service contracts. The agent can distinguish a live dirty deck from an actual native file deliverable.

## Verification and rollout

Use existing active test files where their contracts fit. Add explicit named declarations, register additions/changes in `tests/registry.json`, update `lastReviewed`, and regenerate stats/audit after test composition changes. Avoid a second end-to-end test for a contract already protected deterministically.

Focused unit/service selections:

- Milestone 1: `agentEditing.test.ts`, `agentBridge.test.ts`, and relevant discovery/context tests. Contract generation checks belong near the canonical operation/schema owners.
- Milestone 2: motion/Presence deterministic domain tests plus `agentPreview.test.ts`; Electron coverage is required for the real CSS/GLSL/worker/native-capture boundary.
- Milestone 3: agent transaction assembly/editing tests, with an Electron SDK workflow only for the full multi-page boundary.
- Milestone 4: existing save/persistence/package service tests plus the MCP delivery adapter and one relevant native round trip.

Example PowerShell focused commands (select only files touched by the milestone):

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/editor/agentBridge.test.ts","tests/feature/editor/agentPreview.test.ts"]'
npx vitest run
Remove-Item Env:SHOWME_TEST_FILES

# Rebuild when testing changed Electron/renderer code; these native tests use built assets.
npm run build
$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-mcp-authoring-revision
Remove-Item Env:SHOWME_TEST_FILES

npm run test:stats
npm run test:audit
git diff --check
```

Native cold-start declarations must launch fresh runtimes for the failing entry points. A large integration scenario that first inserts auto-sized text would conceal the demonstrated startup bug. Do not add retries to mask it.

Run relevant lint/static checks for changed files. Run the audience-navigation gate against the exact candidate before a rendering-affecting commit on main or integration, as required by AGENTS.md. Do not run the full/release suite or packaging after every milestone by default. Native Windows verification is the first target; macOS native behavior remains explicitly pending until run there.

For each milestone, update `TOOL_CONTRACT.md`, `AUTHORING_CAPABILITY_MATRIX.md`, architecture/setup guidance where affected, and the findings record. Rebuild/restart the app and reconnect the MCP host so exported schemas and implementation match. Version protocol additions consistently; preserve existing current v1 requests and meanings. No historical development adapters are needed.

Final evaluation: recreate an EMBER-sized deck in a fresh session using tools only, record errors, discovery bytes, tool-call count, cold and warm service latency, edit/replay behavior, sample-frame results, and saved artifact status. Compare equivalent workloads on the same machine. Keep measured results separate from target behavior.

## Recommended implementation order

1. Cold-start entry points and focused native regression coverage.
2. Canonical contract discovery, actionable validation, and clear receipts.
3. Native schedule editing with stable IDs.
4. Deterministic single-frame preview, then transitions and bounded multi-frame review.
5. Re-evaluate measured workflow cost; add multi-page batches and font/fit feedback.
6. Native save/export delivery through existing services.

Do not combine these into one broad rewrite. Milestone 1 should be independently useful and reviewable; the more ambitious transaction and delivery changes must not delay fixing the proven startup failure.
