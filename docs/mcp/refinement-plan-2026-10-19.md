# ShowMe MCP refinement plan — 2026-10-19

Status: implemented in MCP 1.10.0 / discovery contract 3. See [implementation and verification](refinement-evaluation-2026-10-19.md). Advisory preflight remains deliberately conditional/deferred. The connected 1.9 host has not been reconnected to 1.10; SDK/native verification and the supported-host limitation are recorded in that report.

## Objective and starting point

Reduce the total cost of completing an editing task, including tool definitions, discovery, repeated context, mutation receipts, recovery calls and previews. Preserve successful authoring and one native document authority. Saving bytes at the expense of extra failed calls or inspections is not an improvement.

Build on the current 1.9.0 discovery implementation and preserve all existing working-tree changes. Work on the checked-out local branch; no branch, commit, push or PR is implied. The previous discovery plan is implemented, not work to repeat.

Measured starting point:

- Glass-task discovery: four authoring calls, 28,566 unique structured bytes, 60,640 mirrored wire bytes; down from ten calls and 75,417 structured bytes.
- Advertised `apply` input schema: 85,498 bytes, unchanged.
- Isolated six-slide evaluation: 24 total MCP calls, zero failed calls, successful native save and no preview warnings.
- Host-normalized tool definitions, model-context token usage and prompt-cache behavior have not been measured. Do not label schema bytes as a recurring per-turn token cost.

## Milestone 1 — shrink advertised apply metadata

This is the highest-priority change. Keep the eight tools and current operation names. Advertise the real apply envelope and request forms, with open semantic operation objects. Continue validating the complete request with the existing canonical Zod schema before dispatch.

### Design

1. Produce the advertised schema from `z.toJSONSchema(agentApplyRequestSchema)` using a narrow, deterministic projection. Preserve common fields, required fields, ID patterns, numeric constraints, budget values, array bounds, strict envelope/page objects and the mutually exclusive single-page/pages alternatives.
2. Replace only the two embedded semantic-operation item schemas: the single-page operations array and each page group's operations array. Each advertised item is an object requiring a string `type`, permitting operation-specific properties. Do not rename root or group `slideId`, add aliases, or change actual request syntax.
3. Keep `validateApplyInput`, full canonical Zod admission, bridge admission, native Effect validation, leases, actor history, DocumentAuthority and durability unchanged. Unknown operation names and malformed operation fields must still fail before native execution.
4. Keep exact operation schemas available through existing selected discovery. The tool description must say that its operation objects are intentionally open transport metadata and that unfamiliar operations require discovery.
5. Separate advertised-schema tests from admission-schema tests. Replace the existing tools/list-equals-full-schema expectation with assertions that only the intended operation-item paths differ. Preserve/add direct tests of the canonical validators; do not delete coverage to accommodate smaller metadata.

### Acceptance

- Target advertised apply input schema at **6 KiB or less**, exceeding 90% reduction from 85,498 bytes. This is an implementation target, not an observed result.
- The SDK and actual supported Codex connection preserve nested operation-specific fields when calling the tool.
- Valid single-page and multi-page batches produce the same accepted results as before.
- Invalid operation name, unknown operation field, malformed nested frame, wrong root field, missing root/group slideId, ambiguous request form, oversized payload and stale revision still reject with useful paths and no partial acceptance.
- Replayed mutations retain their historical receipt/current-observation behavior; no new execution path exists.

### Client experiment

Capture raw tools/list and the normalized tool signature available to the host. If the host exposes model-context usage, record it; otherwise mark it unknown. Run a real editing task through the actual connector, not only the SDK harness. Determine whether open operation objects survive any host-side schema normalization. Retain the canonical advertised schema if supported-host calls cannot reliably carry operation fields; investigate rather than weakening validation or silently dropping fields.

No automatic protocol fallback, second validator or environment-selected alternate tool catalog is introduced.

## Milestone 2 — sparse receipts with stable meanings

Profile receipts from creation, a one-element refinement, template edits, a shared Effect update, duplication, a no-op and a replay. Implement sparsity where it reduces complete-task bytes without requiring additional reads.

- Preserve scalar identity/admission fields: documentId, epoch, request slide context, mutationId, previousRevision, revision, transactionId, changed and replayed. Preserve currentObservation when available.
- Omit empty optional collections, rather than replacing all IDs with a new typed change language. Keep existing field names and meanings. `changed` remains a boolean.
- Preserve every nonempty created/changed/removed identity collection, native duplication idMap, authored page kinds, shared-resource ownership/users, per-page results and warnings.
- Define omitted collection/map as empty in the protocol contract. Do not use omission for an unknown or uncomputed value. Errors retain their current bounded structured diagnostics.
- Make the MCP output schema agree with the sparse wire representation. Keep the native/internal receipt and replay storage unchanged; apply the deterministic projection at the MCP boundary, including nested page receipts where appropriate.
- Verify consumers/tests explicitly rather than adding historical-format readers or a second receipt dialect. Update the MCP version, discovery contract version and documentation together for observable response-shape changes; native document formats remain v1.

Acceptance: each representative receipt is no larger; trivial/no-op receipts materially shrink; all IDs needed for the next edit remain available; replay semantics are identical; the workflow needs no extra inspections solely to compensate for omitted data. Record actual reductions rather than setting an arbitrary byte target before profiling.

## Milestone 3 — keep context live and protocol static

Separate stable authoring capability information from repeated `context` responses after measuring its share of the workflow.

- Move supported operation features, effect API version, static budgets and scoped-CSS support into `authoring(kind=protocol)` using the same fact definitions as discovery.
- Context keeps document identity/name/revision/savedRevision/dirty state, UI epoch, current page/selection/scope/mode/timeline, presentation state, MCP availability, editing availability/reason, and runtime initialization/queue state. Queue occupancy and runtime readiness are live facts, not capabilities.
- Include a small server/contract version identifier so an agent can deliberately refresh static guidance after reconnecting to an updated app. Do not add hidden already-read tracking or a schema cache framework.
- Static capability discovery must still honor MCP access. Reading context must remain passive: no renderer initialization, draft flush, navigation or presentation-time sampling.

Acceptance: repeated context responses shrink without making disabled access, initialization failure, busy queues, dirty documents or stale identities harder to diagnose. Exercise app restart, document replacement and revocation through the existing focused tests.

## Milestone 4 — diagnose batch capacity before failed writes

Address the next demonstrated workflow failure: semantic operation count does not predict native expansion cost. The glass-deck request was below the semantic limit but exceeded 256 native operations.

1. Return structured, bounded cost diagnostics on assembly overflow: semantic/native counts actually known, applicable limit, and a safe instruction to split. Do not claim an exact cost if assembly stopped before it could be computed.
2. Instrument the existing assembler for cost accounting; do not implement a second estimator with different rules.
3. Only if overflow remains common, add an explicit nonmutating preflight through the existing tool vocabulary. Its result is revision-bound and advisory: the eventual write still performs complete admission and validation. Preflight must not acquire lasting leases, create history, initialize expensive renderer work merely to estimate geometry, or commit staged operations.
4. Suggest independent page-group boundaries when determinable. Never auto-split an explicitly atomic intent; groups can share deck/styles/IDs and depend on earlier staged changes. If no safe split is knowable, report that honestly.

Acceptance: an oversized request returns useful costs without partial acceptance; following the advice succeeds for the demonstrated independent-page case. Preflight is conditional work, not a prerequisite for every normal write.

## Milestone 5 — complete-task evaluation and release decision

Use the same model/host and comparable workload for baseline/candidate runs. Preserve the user's existing presentations and use an isolated test library. The current measurements and prior native evaluation remain evidence; do not repeat benchmarks for intermediate cosmetic changes.

Workloads:

1. Create the six-slide template/shader/CSS/Presence deck, sample the visuals and save natively.
2. Refine two selected elements in an existing deck, then inspect only what is needed for another edit.
3. Update a shared template Effect, duplicate a slide using idMap, and make a subsequent targeted edit.
4. Lose an apply response and replay its mutation ID after a later accepted revision; handle a stale-revision rejection and app/document replacement.

Measure tool-registration input/output schema bytes, unique structured response bytes, complete mirrored wire bytes, discovery/total call counts, rejected calls by cause, elapsed time, follow-up inspections, final artifact correctness and save result. Record actual host context/cache/token measurements only when exposed. Compare the advertisement change separately from sparse receipts and context so gains remain attributable.

A fresh-agent usability run is desirable, but must actually start without repository/history knowledge. The previous same-agent SDK run is not that evidence. If a separate fresh session is unavailable, report the limitation and do not manufacture a claim of independent usability.

### Verification scope

- Extend existing `agentEditing.test.ts` and SDK stdio discovery/creative-authoring declarations for metadata/admission separation, sparse receipts and selector/source behavior.
- Use existing focused bridge/context tests for passive reads, revocation, restart and exact identity. Add a declaration only for a new product contract, not for serialization implementation details.
- Run typecheck, lint touched files, relevant unit/native declarations, and registry stats/audit after composition changes. Preserve explicit named declarations and current test tiers.
- Check settled slide rendering, Presence timing, transition samples and native save through existing production paths. Static PNGs do not prove live playback smoothness.
- No full/release suite or audience performance benchmark by default. Any future rendering-affecting main commit/integration still requires the repository's exact audience-navigation gate.

## Scope boundaries

Keep stable tools, exact selected schemas, descriptive operation names, authored short IDs, sparse inspection, images as image content and separate creative-code guides. Keep the existing text/structured mirror until client behavior supports a deliberate change; a host deduplication opportunity is not a reason to break text-only consumers.

Defer required/optional-only pseudo-schemas, compressed operation DSLs, ephemeral ID aliases, dynamic tool registration, universal `$defs` extraction and additional discovery detail levels. Revisit only when measured failures/costs justify them.

No new document owner, persistent schema, renderer, asset system or save path. Existing SME/SMP/public v1 compatibility and native transaction/recovery boundaries remain unchanged.

## Delivery sequence

Implement milestone 1 and evaluate its actual connector behavior first. Then deliver sparse receipts and context as focused changes with their own contract checks. Add capacity diagnostics next; add preflight only on demonstrated need. Finish with the comparable complete-task evaluation and a concise handoff containing exact checks, measured gains and limitations. Do not bundle speculative optimizations into the first schema change.
