# Plan: useful, bounded MCP discovery

Status: proposed implementation plan. No application code changed or implementation authorized by this document.

## Goal

A fresh agent can discover the contracts needed for the six-slide glass/shader task without repository access, unnecessary round trips, repeated global prose, or missing behavioral rules. Reduce total discovery context while preserving successful authoring, exact validation and native document ownership.

The target is usable information per task, not the smallest possible JSON response.

## Findings that change the approach

- `agentOperationContracts.ts` always includes limits, request, targets and result prose. A targeted operation query repeats all of it. Every selected operation also repeats the same generic ownership/revision description.
- `buildAgentAuthoringGuide` treats compact as a routing switch, not a consistent level of detail. A family request still returns full schemas/examples; compact shader requests return generic Effect operations instead of shader-specific guidance. Preview/delivery/workspace ignore detail for their own guides.
- Full creative-code responses reuse the human Effect Editor prompt, including repeated timing, environment, source and response instructions. MCP needs the same facts, but does not need a prompt to paste fenced code into editor tabs.
- `mcp/server.ts` mirrors the entire result into both `content` and `structuredContent`. During the evaluation, the caller printed both. Server wire bytes, caller output bytes and actual client/model context are different measurements; the last cannot be inferred from a raw response alone.
- Raw `showme.apply` tools/list already publishes the canonical schema, and an existing SDK test protects it. Host normalization may determine whether an agent can use that schema. Do not solve discovery by making the mutation contract opaque or weakening its validator.
- An existing schema digest hashes selected contract records, including prose/examples. It is not currently a document revision and should not become an implicit session cache key.

## 1. Capture a reproducible baseline

Use a deterministic read-only discovery workload with the operation names and guides needed by the glass deck. Record the actual sequence used in the evaluation and an efficient sequence achievable with today's API. This separates avoidable caller behavior from server limitations.

Measure:

- tools/list schema bytes, separately from tool-call response bytes;
- unique structured payload bytes and complete wire result bytes;
- discovery call count and time before the first mutation;
- model-visible output where the host exposes it; explicitly mark unavailable measurements;
- malformed requests attributable to missing discovery information, separately from unrelated caller mistakes.

Reuse existing SDK discovery tests and their byte attachments. Record measurements as evaluation artifacts rather than logging private document content or every authoring request. Do not rebuild or modify the user's existing deck for baseline collection.

Acceptance for this step: baseline is repeatable and distinguishes protocol overhead, guide repetition and client duplication. No invented token counts or claims that wire bytes equal model tokens.

## 2. Give operation discovery a consistent contract

Keep one authoring tool. Use its existing kinds and detail vocabulary; avoid a separate tool per operation or an expanding set of response-format switches.

Proposed behavior:

| Request | Compact response |
| --- | --- |
| `kind: operations`, no selector | Small operation catalog grouped by family, discovery version/digest and a short instruction for fetching exact contracts |
| `kind: operations`, `operations: [...]` | Exact requested schemas plus relevant semantic rules, with each shared rule included once |
| `kind: operations`, `family: ...` | The same schema response for that bounded family; no unrelated request/result prose |
| `kind: protocol` | Apply envelope, limits and global rules for revision, atomicity, ownership and receipts |

`detail: full` adds useful examples and explanation to the selected subject. It must not silently broaden selection or resend all protocol material. Compact selected schemas still include every field constraint required to construct a valid request.

Add a bounded `operations` selector (proposed maximum 32), with explicit validation for unknown names and incompatible selectors. Normalize repeated operation names and stable output ordering. Retain the existing singular `operation` selector as a supported current API, using the same selector implementation; do not create separate validation logic or historical adapters. Publish any observable response changes with an intentional MCP version update and update docs/tests together.

Separate global rules from operation-specific rules. For example, template ownership belongs with template/slide operations, slide-end Presence requiring Exit None belongs with Presence, and transition trace invariants belong with preview. Define those facts once in code and compose the relevant set per response. Do not omit non-schema constraints merely because the JSON Schema cannot express them.

Continue deriving schemas from the admission Zod variants. Remove redundant per-operation generic descriptions and repeated schema dialect declarations in a containing schema document where valid. Evaluate shared `$defs` for repeated frame/typography/timing structures only after the simpler cuts are measured. Adopt references only if the supported client resolves/presents them correctly and the resulting authoring workload still succeeds; a schema graph that is smaller but harder for the agent to use is not a win.

Use a schema digest for schema identity and a contract version for the guide's behavioral contract. Treat both as response metadata; do not add hidden per-client state, server-side already-read tracking, or conditional not-modified negotiation in the initial implementation. Explicit repeated queries remain self-contained and deterministic.

## 3. Make compact domain guides useful

For shader/CSS/text Effect guides, compact must explain the requested domain rather than return a generic Effect family dump.

- Extract shared factual material from the Effect authoring system so the editor's full prompt and MCP guide cannot drift. Keep their presentation separate: the human editor can retain its full prompt; MCP returns concise facts and a valid operation template.
- Compact shader guide: GLSL version/output, supported built-ins, timing model, slide context, custom parameter declaration syntax, input availability and restrictions.
- Compact CSS guide: scope/at-rule rules, native clock properties, parameter mapping, paused finite keyframe semantics, backdrop styling and restrictions.
- State the common timing contract once in each self-contained response, then add domain differences. Full detail adds worked examples, not duplicated starter source in several fields.
- Scoped Effect editing retains exact-revision access checks and returns the current source once. Do not return existing private source through unscoped discovery.
- Make preview/delivery/workspace detail behavior consistent. Keep the complete transition-trace example in full preview guidance and its invariants in compact guidance.

The initial glass-task discovery budget is at most four authoring calls: protocol, selected operation contracts, shader guide and CSS guide. Context, document inspection and production measurement are separate necessary calls and must not be hidden from total-task reporting. Batched domain-guide requests are deferred unless measurement shows these remaining calls are a material bottleneck.

## 4. Address duplicate presentation at the layer we control

First fix evaluation/orchestration to emit exactly one representation: prefer structuredContent, otherwise parse/use text. Preserve images and separate human diagnostics. This requires no server protocol change.

Retain the server's current standards-compatible text/structured mirror initially. Verify supported clients with a small diagnostic fixture: structured-capable, text-only, errors and image previews. Where the host forwards both representations to model context, document the evidence and pursue host-side deduplication.

Only if duplication remains a measured major cost and the supported client's behavior is proven should the server adopt a concise text representation. That is a separate compatibility decision with explicit client tests; do not remove text, output schemas or structured fields speculatively. Do not describe a proposed MCP clarification as a guaranteed client capability.

## 5. Verify usability and publish the measured result

Deterministic tests, primarily in the existing editor agent test group:

- selected discovery is generated from the same validators and contains exactly the requested operations;
- malformed selectors fail clearly; singular and array selectors share semantics;
- compact omits global repetition but retains the non-schema rules required by its operations;
- compact creative guides contain the actual shader/CSS contract;
- scoped source/access/revision behavior remains unchanged;
- digest/order behavior is deterministic, and response size stays within a measured budget with reasonable headroom.

SDK integration:

- preserve canonical raw tools/list shapes and strict mutation admission;
- exercise new discovery through the real server/bridge;
- verify structured/text semantic consistency and the chosen client presentation;
- execute a small representative native authoring batch using only discovered information, including a template shader, a CSS Frame and staggered Presence. Use existing rendering checks for that path rather than adding a second full deck end-to-end test.

Manual task evaluation:

- From a fresh agent context with no repository reads, create a new six-slide test deck using the same requested capabilities; preserve existing decks.
- Record discovery calls/bytes and discovery-caused failed requests; compare with both baselines.
- Review production settled/Presence/transition previews and save the native artifact. Do not claim PNG samples prove playback smoothness.

Proposed success criteria: at least 60% fewer unique discovery payload bytes than the efficient current-API baseline, no more than four authoring discovery calls for this workload, and no additional discovery-caused authoring failures. Confirm the byte target after baseline collection; if it is unrealistic without hiding useful facts, report the measured tradeoff rather than weakening correctness.

Verification commands during implementation should remain focused: run the relevant `agentEditing.test.ts` declarations and targeted SDK discovery/native-authoring declarations, then typecheck and lint changed files. Update test registry review dates; run `npm run test:stats` and `npm run test:audit` if declarations/composition change. No full/release suite or audience benchmark by default. This plan alone needs diff review, not product tests. Any future rendering-affecting main commit remains subject to the repository gate.

## Scope and handoff

Implementation touches `src/core/agentOperationContracts.ts`, `src/core/agentAuthoring.ts`, shared Effect contract material, `electron/agentAuthoring.ts` as needed, MCP protocol version/docs, and focused tests. `mcp/server.ts` serialization changes are conditional on the client experiment, not a prerequisite.

No document format, persistent schema, renderer, DocumentAuthority, asset lifecycle or editing permission changes. No new remote transport, resource service, cache framework, task-specific operation bundle, or replacement presentation authoring API.

Implement in two reviewable milestones: (1) baseline plus compact batched operation discovery; (2) compact domain guides plus client experiment and a fresh task evaluation. Reassess after milestone 1 before adding schema references or further transport machinery.
