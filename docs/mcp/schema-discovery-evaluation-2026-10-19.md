# Schema discovery implementation and evaluation — 2026-10-19

## Delivered

ShowMe MCP 1.9.0, discovery contractVersion 2. Persistent document/SME/SMP/Effect formats remain public v1. Work continued on `codex/local-mcp-server`; the shared checkout advanced to `a8fe3c3` during the work and that newer commit was preserved. This agent did not create a branch, commit, push or PR.

- `kind=protocol` supplies common apply fields (generated from the admission schema), limits, atomicity/revision/ownership rules and receipt semantics.
- `kind=operations` defaults to the catalog. `operations:[names]` accepts 1–32 names; the existing singular selector and family discovery remain available. Selectors are mutually exclusive. Unknown names and mismatched domains reject; duplicates normalize in stable catalog order.
- Selected compact responses retain exact canonical JSON Schemas and relevant non-schema rules once per response. Full adds validated examples. Global envelope prose and generic per-operation descriptions no longer repeat.
- Compact shader/CSS/text guides expose the actual runtime contract and a native operation template. Existing scoped source occurs in the template, not a repeated human editor prompt. Full adds examples. MCP and the human editor share environment, timing and restriction facts.
- Preview/workspace/delivery full examples parse against their current request schemas; compact retains schemas and constraints. Layout full adds the Frame composition workflow.
- The raw apply schema, canonical mutation validation, ownership/access checks, DocumentAuthority, transaction/recovery path and serialization fallback are retained. No schema-reference framework, hidden session cache or second authoring language was introduced.

## Measurements

Baseline captured before changes: [discovery-size-baseline-2026-10-18.json](discovery-size-baseline-2026-10-18.json). The efficient current-API sequence chooses, for each required family, the cheaper of whole-family discovery or individually selected operations, then requests the necessary full creative guides because the old compact path omitted their runtime facts.

| Measure | Baseline | Implemented |
| --- | ---: | ---: |
| Authoring discovery calls | 10 | 4 |
| Unique structured discovery bytes | 75,417 | 28,566 |
| Mirrored wire result bytes | 156,868 | 60,640 |
| Raw advertised apply input schema bytes | 85,498 | 85,498 |

Structured discovery decreased **62.12%**, mirrored wire results **61.34%**. Context, inspection, measurements and mutations are excluded from these discovery totals, not omitted from the evaluation's total-call reporting. These are bytes, not measured model tokens. No claim is made about client-side prompt injection, cache hits or per-turn token billing.

Reproduce with `node scripts/measure-mcp-discovery.mjs docs/mcp/discovery-size-result-2026-10-19.json`. The report keeps structured and mirrored bytes separate. Evaluation callers emit only the structured representation with text fallback, preserving image content. Server text/structured mirroring remains unchanged for compatibility.

## Real native evaluation

Ran `.agenttmp/discovery-evaluation.mjs` against the rebuilt Electron bundle and real stdio SDK, using an isolated user-data directory and library. Authoring used four actual discovery responses, inspected parents/template, semantic transactions, production previews and native save. The existing user deck/profile were not modified or closed.

- Six slides; a template-owned slide-aware GLSL atmosphere; CSS frosted Frames; staggered native Presence and fade transitions.
- Four authoring calls, 28,566 structured discovery bytes; **24 total MCP calls, zero failed calls**.
- Final native revision/saved revision 4. Save returned written=true, cancelled=false, format=sme, preservesAnimation=true.
- Saved artifact: `artifacts/mcp-discovery-2026-10-19/library/Discovery — glass and motion.sme`.
- Reviewed all six settled production PNGs, Presence at 400/1800 ms, and an explicit 350 ms transition. All returned zero missing-media/Effect-fallback warnings. Output and call timings are in `artifacts/mcp-discovery-2026-10-19/report.json`.

This is an isolated real-client evaluation, **not an independent fresh-agent trial**: the agent already knew the repository. It demonstrates transport/native operation correctness and observed payload cost, not that a new model will never need further discovery. PNG samples verify appearance/timing, not live audience smoothness.

## Verification

All passed:

- `$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/effects/authoring.test.ts"]'; npx vitest run` — 66 declarations in two files.
- `node scripts/build-electron.mjs` — Electron/stdio bundles built.
- `$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'; npx playwright test -g 'raw SDK tools list|MCP creative authoring'` — both declarations passed, including raw canonical schemas, compact discovery, structured/text equivalence, selector diagnostics, production Effect validation and scoped source.
- `npm run typecheck`.
- `npx eslint src/core/agentOperationContracts.ts src/core/agentAuthoring.ts src/core/effectAuthoring.ts src/core/agentRead.ts mcp/server.ts tests/feature/editor/agentEditing.test.ts tests/feature/effects/authoring.test.ts tests/extended/agent-mcp.spec.ts`.
- `npm run test:stats` and `npm run test:audit` — 607 active declarations in 88 groups.
- `git diff --check`.

No full/release suite, packaged-host smoke, repeated performance benchmark, independent fresh-agent evaluation or actual host context/token trace was run. No rendering-affecting main commit/integration was made, so the main audience-navigation commit gate was not invoked.

## Assessment of the user's pasted proposal

The strongest additional proposal is a small **advertised apply envelope** backed by the full existing runtime validator. Our unchanged 85,498-byte apply input schema warrants a separate experiment. Do not assume that all those bytes are injected every turn: host tool loading/normalization and prompt caching must be measured. Keep strict Zod admission and native transaction semantics regardless of the advertised discovery shape. The existing raw-schema regression would need an intentional contract update, not silent removal.

Other useful directions, in order:

1. Make receipts sparse by omitting irrelevant empty fields, initially preserving meaningful identity, replay/currentObservation, authored-page and resource receipts. The pasted minimal example omits important replay/concurrency context. Avoid forcing extra inspect calls merely to save a small receipt.
2. Separate genuinely static protocol capabilities from repeated context, but keep live availability/editing reasons, runtime state/queue occupancy, document saved/dirty state and current selection/timeline in context. Runtime state is not static.
3. Keep stable tools, descriptive operation names, authored short IDs and explicit creative guides. Inspection already has sparse outlines and opt-in source/Motion/Presence/world transforms; profile remaining output before extending its API.

Do not adopt a required/optional-name list as the only compact contract: it loses types, nested structure, bounds and union relationships. A generated concise reference may be worth testing later if it preserves those facts and reduces failed calls. Current exact selected schemas already achieve the measured discovery goal.

The pasted `elements.frame.set` example does match the current required fields. Its apply-envelope example does not match the current API: page groups use `slideId`, not `pageId`, and the root request also requires `slideId`. Its receipt's `changed` array also differs from the current `changed` boolean. Treat its examples as design sketches, not requests to copy.

No additional apply/context/receipt redesign was implemented solely from that evaluation request.
