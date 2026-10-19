# MCP refinement implementation and evaluation — 2026-10-19

Implemented the [refinement plan](refinement-plan-2026-10-19.md) on the existing local branch, preserving the prior uncommitted discovery implementation. Server **1.10.0**, discovery contract **3**; native document/SME/SMP/Effect formats remain public v1. No branch, commit, push or PR was created.

## Changes and boundaries

- `mcp/applyTransport.ts` projects only the semantic-operation item schemas out of canonical tools/list metadata. The common envelope, request alternatives, strict root/page objects, IDs, budgets and array bounds remain derived from the canonical Zod schema. Operation objects require type:string and allow their operation-specific fields.
- SDK callbacks still execute `validateApplyInput`, then the existing canonical bridge validator. Unknown types/fields, nested constraint violations, oversized requests and stale revisions reject as before. Tests restore placeholders at the two intentionally projected schema paths and compare every other field against the canonical schema.
- Successful apply receipts omit empty top-level collections/idMap and empty collections in per-page receipts. All scalar identity/concurrency fields and nonempty IDs, authored-page/resource information, idMap and warnings remain. Nested empty resource-user lists remain meaningful and are retained. Errors, native receipts and replay storage are unchanged.
- Live context keeps document/UI/presentation state, saved/dirty status, access/editing availability and runtime state/pending count. Static features, Effect API version, CSS support and runtime capacity/lazy initialization are in protocol discovery. Shared constants define the runtime capacity and discovery contract version.
- Native assembly overflow now reports measured count, limit, semantic/processed counts, scope (page/transaction) and whether the count is complete or a lower bound. Page failures retain pageIndex. Counts come from the existing assembler. Writes still accept no partial batch and are not split automatically.
- Advisory preflight remains deferred as planned: precise diagnostics and successful deliberate splits now cover the observed case. No parallel estimator, cache, compressed DSL, compatibility reader, new tool, document authority or persistence path was added.
- The existing text/structured response mirror and image-content handling remain intact.

## Advertised metadata

| Schema representation | Before | After |
| --- | ---: | ---: |
| Generated apply input schema | 85,498 bytes | 2,124 bytes |
| Actual SDK tools/list input (adds root type=object) | 85,514 bytes (canonical equivalent) | 2,140 bytes (observed) |

Generated-schema reduction: **97.52%**. The full canonical validator remains 85,498 bytes and selected operation discovery still exposes its exact schemas. Other tool schemas remain supported; this is not a claim that total MCP/model usage decreased 97.52%.

Reproduction: `node scripts/measure-mcp-discovery.mjs docs/mcp/refinement-size-result-2026-10-19.json`.

## Comparable complete-task measurements

Compared the same six-slide shader/glass/Presence creation workflow with the prior 1.9 isolated run. Both use four authoring discovery calls and **24 total MCP calls**, with **zero failed calls**. Unique structured JSON excludes PNG image bytes; differing slide seeds are not a rendering-performance benchmark.

| Structured response bytes | 1.9 | 1.10 |
| --- | ---: | ---: |
| Context (two calls) | 3,968 | 1,964 |
| Apply receipts (four calls) | 8,632 | 7,635 |
| Authoring discovery | 28,566 | 29,279 |
| Entire 24-call workflow | 52,452 | 50,165 |

Context decreased **50.50%**, receipts **11.55%**, complete-task structured responses **4.36%** without extra calls. Protocol discovery grew because static capabilities moved there. These figures exclude the separate large tool-registration reduction. Do not combine them into a per-turn token/cache claim.

See [workflow measurements](refinement-workflow-result-2026-10-19.json) and [schema/discovery measurements](refinement-size-result-2026-10-19.json).

## Actual client and native workflows

Used isolated ShowMe profiles and the real stdio SDK, preserving the original user's running app/deck.

- `.agenttmp/refinement-evaluation.mjs`: six native slides with one shared template shader, CSS glass Frames and staggered Presence; six settled previews, two Presence samples, a transition sample and native save. Four authoring calls, 24 total calls, zero failures, zero preview warnings. Native revision/savedRevision 4.
- `.agenttmp/refinement-followup.mjs`: reopen the saved deck; inspect/edit two selected text elements; make a second edit; replay the original request after that later revision; reject a stale revision; update the shared template resource; duplicate a slide using returned native idMap and immediately edit its new text; preview/save/reopen. Twenty calls, one deliberately expected REVISION_CONFLICT, no unexpected errors or preview warnings. Final artifact has seven slides due to deliberate duplication.
- Replayed receipt retained historical revision 1 and independently reported current revision 2. This manual scenario discards a caller response; it is not presented as an actual network-loss experiment. The focused agentBridge test separately aborts a real HTTP response during durability and verifies exactly-once native insertion on replay.
- Reviewed representative settled rendering, the early stagger, the transition, and the edited duplicate. PNG samples verify appearance/timing, not live audience smoothness.

Artifacts remain in `artifacts/mcp-refinement-2026-10-19/`: tools-list.json, report.json, followup-report.json, PNGs and `library/Discovery — glass and motion.sme`. The user’s original presentation/profile was not changed or closed.

### Host limitation

The live connector in this chat still points to the user's running **1.9.0** app and has cached its older tool metadata. A read-only context confirmed that state; it was not restarted/disconnected during implementation. Its exposed apply declaration was already only 2,397 characters with operation/page bodies typed as unknown. Therefore raw schema bytes are demonstrably not the same as the model-facing signature in this host.

The new 1.10 schema is verified through actual SDK tools/list/call and production native editing. Reloading ShowMe and reconnecting MCP is required to exercise this session's connector against 1.10 metadata. An independent fresh-agent trial, host re-normalization trace and real model token/cache measurements remain unverified. No compatibility or token-saving claim depends on pretending those were run.

## Verification

Passed:

- `$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/editor/agentContext.test.ts","tests/feature/editor/agentBridge.test.ts","tests/feature/effects/authoring.test.ts"]'; npx vitest run` — **94 declarations in four files**, including strict admission, sparse replay/resource receipts, complete/lower-bound cost reporting, atomic overflow and successful explicit splits, passive context and bridge recovery/revocation.
- `node scripts/build-electron.mjs` — main/preload/stdio bundles built.
- `$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'; npx playwright test -g 'raw SDK tools list|MCP page batching|MCP creative authoring|stdio discovery survives|MCP native templates'` — **five declarations passed**: open metadata preserves nested fields but rejects invalid calls, single/multi-page production authoring, Effect validation, process restart/document replacement, templates/shared resources/recipes/native lifecycle.
- `npm run typecheck`.
- `npx eslint mcp/applyTransport.ts mcp/inputValidation.ts mcp/server.ts src/core/agentProtocol.ts src/core/agentMutation.ts src/core/agentOperationContracts.ts src/core/agentAuthoring.ts electron/main.ts electron/agentEditing.ts tests/feature/editor/agentEditing.test.ts tests/extended/agent-mcp.spec.ts`.
- `npm run test:stats` and `npm run test:audit` — **611 active declarations in 88 groups**.
- `git diff --check`.

An initial combined overflow test exceeded the default five-second unit timeout. It was split into two explicit contract declarations (per-page early overflow and combined-page complete overflow), rather than increasing timeouts, adding retries or reducing the workloads. Both passed, followed by the full focused unit run above.

Full/release/packaged/macOS checks, independent fresh-agent trials and audience performance benchmarks were not run. No rendering-affecting main commit/integration occurred, so the audience-navigation commit gate was not invoked. No test was weakened, skipped or quarantined to permit a commit.
