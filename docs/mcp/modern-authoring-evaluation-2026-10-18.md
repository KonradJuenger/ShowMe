# Modern theme MCP authoring evaluation — 2026-10-18

## Result

Implemented the six requested MCP improvements and authored a separate eight-slide presentation, **ShowMe — In its element**, using semantic MCP operations. Native file: `artifacts/showme-modern-motion/ShowMe — In its element.sme` (97,084 bytes at final cold reopen). Portable deliverable: `artifacts/showme-modern-portable/ShowMe — In its element.smp`. Existing presentations were preserved. No branch, commit, push, PR, publishing or sending was performed.

The presentation is closed. Cold reopen retained eight slides, three native templates (two authored and one unused default), twelve text styles (ten authored and two defaults), the imported editor screenshot and native effects. Final media/effect previews returned no warnings. Native reopen starts a fresh epoch at revision/savedRevision 0; this is normal and does not mean edits were lost.

Next implementation instructions: [NEXT_INSTANCE_HANDOFF.md](NEXT_INSTANCE_HANDOFF.md). This report records the experiment; that handoff identifies unresolved work and acceptance criteria.

## Implemented surfaces

| Request | Implementation exercised |
| --- | --- |
| Create/edit templates | Explicit template page targeting, background/content editing, inspection, apply, unused-template deletion; strict createdTemplateIds receipt |
| Named text styles | Direct text.style.define plus apply/override APIs; five typography roles in dark/light variants |
| Shared effect resources | Capture, attach and validated source update for native page resources; template inheritance for cross-slide reuse |
| Reusable slide recipes | Native slide duplicate with textReplacements keyed by source text IDs and returned idMap |
| Native workflow access | Workspace create/open/close/import-assets; exact identity and native services; raster dimension preparation |
| Transparent/expanded limits | Context budgets, explicit standard/expanded profiles, scoped CSS @supports, no reduced-motion cap |

One EditorSession/DocumentAuthority and native persistence path remain. Resources retain native page ownership. No global resource store, persisted recipe schema, arbitrary JS execution or direct document writer was added. Existing native transaction/resource/instance limits remain authoritative.

## Deck and visual review

Original cool theme: midnight blue/violet/mint procedural light alternating with pale contour fields, oversized Segoe UI and generous spacing. Two native template backgrounds and wordmarks are inherited by four slides each. One shared shader source was revised once across its dependents. All copy and structural objects are editable. Slide 2 uses a labeled screenshot from the actual running editor, imported as managed media through MCP.

Slides:

1. In its element — product introduction.
2. A canvas with range — editable composition and real editor evidence.
3. Design that carries through — shared templates and styles.
4. Motion with purpose — native click reveal and timing.
5. Build with an agent — same document authority, instantiated from slide 3 as a native recipe with four text substitutions.
6. Keep the work — native files, packaging and recovery.
7. An expressive system — GLSL, shared CSS and isolated text-JS cycling effect vocabulary, plus numeric scale Motion.
8. Make it yours — closing.

Product claims were checked against current code; source paths are in speaker notes. No customer/adoption/pricing/performance claims were invented. All eight 1440×810 previews were visually inspected. Production text measurement found three short frames; the two number boxes and one display text box were enlarged/repositioned. The final 36 resolved text appearances, including inherited wordmarks, reported zero overflow. Segoe UI was loadable on this Windows machine; exact fallback/glyph identity remains unknown.

## Authoring observations

Exactly **138 callTool requests** were logged across creation, discovery, failures, inspection, previews, navigation observations, save/close/reopen and final verification. Six tool calls returned errors (four authoring calls and two stale-identity calls during portable verification). The local harness also threw on a loading context and when assuming an inspection succeeded; these are not extra tool calls. Final counts are in `artifacts/showme-modern-motion/metrics.json`; semantic requests and results are in `tool-calls.jsonl`. No bridge credentials or preview image base64 are in that log.

| Observation | Exact result / response | Recovery / next action |
| --- | --- | --- |
| Immediate context after create | Workspace create succeeded; first context had editor:null during loading | Later context became ready; harness corrected. Improve creation receipt/readiness guidance |
| Incorrect transition argument nesting | SDK validation rejected fields at operation root instead of required value | Corrected caller request; error text expanded to ~22,100 bytes across union variants. Bounded SDK diagnostics remain P1 |
| Native style-name collision | INVALID_REQUEST, Text Style name already exists., stepIndex 2 | Entire setup batch remained unaccepted; authored names prefixed Aurora. Return conflicting IDs/names |
| Dependent build after failed setup | UNKNOWN_TEXT_STYLE, pageIndex 0, stepIndex 3 | Harness had not checked setup success. No partial page construction; repeated after successful setup |
| Imported screenshot missing dimensions | INVALID_MEDIA, The managed asset is missing prepared dimensions., stepIndex 0 | Fixed native raster preparation, added import → insert → preview regression, re-imported same hash and inserted successfully |
| Three text frames too short | Measured 163.1875 px in 140 px number boxes; 326.375 px in 275 px display box | Enlarged/repositioned frames through MCP; final zero overflow |
| CSS infinite keyframes with unbounded interval | Contract says CSS keyframes are sampled by finite progress | Replaced authored shared CSS with native --t expression under @supports; this was authoring misuse, not proof of playback failure |
| Package export | ok:true, cancelled:true, written:false at native option dialogs | Direct package action cancelled. Later native Save As created SMP successfully; typed package-action choices remain P1 handoff work |
| Native tests with overlapping desktop sessions | Revocation declaration returned successful preview instead of expected unavailable | Evaluation app closed; isolated focused rerun passed. Cause unconfirmed; do not mask with retries |

Portable reopen creates an independent native document ID. The verification harness initially refreshed only epoch/revision and made two calls with the original SME ID; both correctly returned DOCUMENT_NOT_ACTIVE. Refreshing the entire context identity resolved them. A fresh-library preview then verified the screenshot inside the package without missing-media warnings. This was a harness error, not a native identity defect.

Template source updates can produce changed:true with empty element changedIds because the resource definition changed, not element records. Template inspection also exposes index:-1 and self-owned source:slide. Both are recorded as receipt/inspection ergonomics work. Capture retains the old resource entry; repeated naming can consume the native resource budget. Recipe slots are currently source IDs rather than semantic names. Non-raster media preparation and per-item partial import receipts remain outstanding.

## Measured calls

Single-run observations on this Windows machine, with different workloads; these are not comparable performance benchmarks:

- First cold production measurement: two text items, **267.33 ms**.
- Later measurement: 27 text items, **58.23 ms**; final 36 appearances, **60.22 ms**.
- Eight-page construction: **99 semantic operations**, **15,501 request bytes**, **350.48 ms**, one accepted revision.
- Four-slot native recipe duplication: **79.28 ms**.
- Template shared shader source update: **88.26 ms**.
- Workspace create: **49.49 ms**. First native save: **22.26 ms**; later overwrite: **79.38 ms**.
- Operation-family discovery: template 4,859 bytes; text 9,629; slide 7,436; effect 14,021; background 6,033; Presence 10,031; Motion 6,955; deck 5,652; element 10,233. Full shader/CSS/text guides were 10,658 / 8,915 / 10,140 bytes. These were observed before the final prompt wording update; current static digests may differ.

The repeated template/style calls represent meaningful reuse, but discovery and diagnostics still consume substantial payload. No repeated benchmark or speedup claim is made.

## Animation and navigation evidence

Thirteen frozen frames were sampled through the production renderer:

- Click reveal at 0 / 650 / 2200 ms; click at 1000 ms, revised native block offset 100 ms and entrance duration 650 ms.
- Shared shader/CSS/text-JS and numeric Motion at 0 / 1250 / 3500 ms; latter frame shows CSS replacing GLSL through isolated text-JS output.
- Forward fade at 0 / 375 / 900 ms, backward at 375 ms, jump at 0 / 375 / 900 ms. Default fade is 750 ms.

All frame warnings were empty. Representative before/after/effect/transition frames were visually inspected. Sampling preserved document and editor context exactly. Live audience controls exercised forward movement, explicit jump to slide 4, click reveal, previous-click/previous-slide behavior and jump to slide 8, then End. The editor remained on the cover with empty selection and clean state. Native running/paused observations are in navigation.json; this is correctness evidence, not frame-rate measurement.

## Verification

- `npm run build`: passed on the final semantic implementation. Subsequent edits only formatted whitespace and documentation.
- `npm run typecheck`: passed during implementation; final build includes the TypeScript check.
- `SHOWME_TEST_FILES` selecting agentEditing, agentWorkspace, agentPreview, agentDelivery, agentProjection, agentBridge, agentInspection, agentClosing and persistence/package-options, then `npx vitest run`: **9 files, 102 tests passed**.
- `SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'; npx playwright test --config playwright.electron.config.ts --output test-results-mcp-design-final`: **16 passed, 1 failed** during overlapping native UI sessions; failure retained above.
- Same selection's revocation declaration alone, `--grep 'real stdio client reads' --output test-results-mcp-design-revocation-isolated`: **1 passed**, evaluation app closed.
- Native new-feature/import declaration, `--grep 'native templates shared' --output test-results-mcp-design-import`: **1 passed**, including prepared image import/insertion/preview and lifecycle close.
- ESLint on all changed tracked TS/TSX and new source/test files: passed after correcting one prefer-const and documenting Playwright's required empty fixture destructuring.
- `npm run test:stats`: regenerated **591 active declarations / 88 groups**. `npm run test:audit`: passed.
- `git -c core.safecrlf=false diff --check`: passed.

Final isolated combined sweep is recorded in the completion addendum below. Full/release suites, packaging installers, macOS and repeated rendering benchmarks were not run. The audience-navigation commit gate was not triggered because no commit/integration was created.

## Completion addendum

Final isolated combined command:

```powershell
$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-mcp-design-isolated-final
Remove-Item Env:SHOWME_TEST_FILES
```

**17 passed (1.0 minute)**, with the evaluation app closed. This includes the revocation declaration. The prior overlapping-session failure remains recorded; interference is a plausible explanation, not a proven cause or a production fix. No test retries or assertion weakening were introduced.

After that sweep, MCP native Save As used the host-authorized destination outside the selected library root, which selects the native SMP format through existing policy. This wrote `artifacts/showme-modern-portable/ShowMe — In its element.smp` with animation and assets. It was cold-opened with fresh user-data and a fresh library root: eight slides, clean state, screenshot preview warnings empty. All presentation/editor instances were closed through MCP workspace afterward. The original SME remains intact. Direct Package action still needs typed unattended option choices; no package writer or native dialog override was used.

Final lint, build/typecheck, 102 focused unit tests, 17 isolated native declarations, registry statistics/audit and diff whitespace review pass. Full/release suites and the commit gate were not run for the reasons above.
