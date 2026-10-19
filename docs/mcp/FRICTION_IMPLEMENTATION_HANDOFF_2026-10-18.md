# Friction implementation handoff — 2026-10-18

**Current continuation:** the user subsequently authorized committing and pushing
the reviewed source to existing PR #14. Stay on `codex/local-mcp-server`; no main
integration is authorized. The original session record below remains historical.
Local `.codex/` and `/artifacts/` contents are preserved and now ignored.

Execution profile: local-codex. Work remains on `codex/local-mcp-server`, starting HEAD `df31f1a733cdfb3992c15ea6f5b14ff32c9f0069`. All previous and current implementation changes remain uncommitted. Preserve the complete working tree, `.codex/`, existing presentations and artifacts. No branch, commit, push, PR, publication or sending is authorized. Read AGENTS.md before continuing.

The six earlier MCP features were already present and were not rebuilt. This continuation addressed their remaining boundary/receipt friction and conducted a NEW eight-slide evaluation. Server version is **1.8.0**; document, package, asset and native schedule formats remain public v1. No sub-agents were used.

## Final presentation and evidence

- Editable SME: `artifacts/showme-editorial-signal/library/ShowMe — Editorial signal.sme`.
- FINAL portable SMP: `artifacts/showme-editorial-signal/library/ShowMe — Editorial signal 2.smp`.
- The unsuffixed SMP is an earlier checkpoint. Native destination policy correctly allocated a new suffix instead of overwriting it.
- All eight slides visually inspected; 48 production-measured text appearances with zero overflow; 29 captured frames including 14 deterministic timeline/transition samples.
- Final portable package cold-opened in a fresh library, complete identity refreshed, corrected media-caption IDs confirmed, SVG/PNG/WebM visible without warnings. Georgia is not embedded; delivery returns a native font warning.
- Eight slides, three authored templates plus mandatory default, seven authored styles plus two defaults. The native recipe retains shared template/style references and substitutes five discovered text slots. Native timeline blocks were revised by stable IDs.
- 116 real MCP callTool requests, zero error responses; an intentional missing-file item is recorded within a successful non-atomic import receipt. Metrics, exact requests/results, captures, fit and cold-open evidence are under `artifacts/showme-editorial-signal`.
- All evaluation apps are closed. Runtime user-data is private infrastructure; do not publish/copy bridge descriptors or tokens. Earlier failure evidence remains intact.

Read `editorial-signal-evaluation-2026-10-18.md` for every observed issue, recovery, useful latencies and test failures. Original `NEXT_INSTANCE_HANDOFF.md` remains as historical context with a pointer here.

## Implemented changes

1. **SDK validation.** `mcp/inputValidation.ts` and `mcp/server.ts` retain canonical Standard Schema JSON metadata, then run the same canonical Zod schemas before bridge dispatch. This uses the SDK-supported Standard Schema adapter rather than modifying SDK internals. SDK 2.3's schema-failure path only returns text, so callback admission is deliberate. All tools return bounded structured INVALID_REQUEST envelopes. Apply diagnostics select the canonical single/page request and matching operation schemas: malformed known fields, unknown operations and missing root fields have useful paths. Full atomic request refinements still run. At most eight issues, 300-character paths and 200-character messages; sources are not echoed. Real SDK regressions preserve exact raw tools/list schemas.
2. **Workspace receipts and interaction safety.** `electron/main.ts` returns complete native document identity, initial slide/template IDs, authority readiness and explicit context polling instructions. Refresh COMPLETE identity after package open. `src/core/editorSession.ts` exposes unaccepted work, including local previews, queued/pending intent, failures, history groups and lease holds. `useAgentContextPublisher.ts` supplies a fixed internal idle check that also refuses focused text/notes inputs and motion drafts/previews. Native create/open recheck access/revision/idle before activation; close rechecks after authority draining. Native leases also block switches. No human draft is flushed or discarded.
3. **Typed package options.** `src/core/agentDelivery.ts` accepts package-only `{mediaLocked:boolean,speakerNotes:"include"|"remove"}`. Main routes both values to existing package services under native destination policy and exact persistence-lock admission. Omission preserves interactive choices. Explicit unattended choices return font warnings without informational dialogs. Native regression checks notes removal and cold package assets; the presentation package includes notes deliberately.
4. **Production media preparation and recovery.** The isolated runtime calls the SAME `mediaEnrichment.ts` path as native human imports, covering raster orientation, SVG dimensions, video metadata and posters. It returns metadata/poster bytes; only main writes native catalog/previews after admission. `ipcRouter.ts` recognizes that surface for scoped asset/font reads only, not arbitrary IPC or writes. Import results are explicitly non-atomic with indexed per-item IDs, failures and not-attempted states. A late decode failure retains earlier successful imports. Runtime decode failures are now item diagnostics, not renderer-loss exceptions/restarts: unsupported decoding is explicit, preparation timeout is pending, and failure before importing is not-attempted. The agent decoder uses an 8-second deadline within the existing 10-second runtime envelope; human enrichment retains its 15-second default. No sleeps or test retries were added.
5. **Page/ownership/recipe metadata.** Inspection adds pageKind/displayName, ownerPageKind/inherited and derived recipe slots (owned text IDs, native names and withheld-safe previews). Recipe notes guidance names the actual slide.update operation. Apply receipts include authoredPages with kind and resourceChanges with owning page/resource/users. Existing relative source fields and native ownership remain intact.
6. **Styles and resources.** Style-name collisions return the conflicting native ID/name and remediation while remaining atomic. Capture removes its old definition only if orphaned; explicit effect.resource.prune removes other unused page definitions through native effects operations. Instance IDs and animated parameter bindings are retained. Tests verify source-only resource receipts, no-op prune, and preserved Motion.
7. **Blocking defect found by evaluation.** Offscreen loadeddata could precede a drawable video frame, generating a black poster with no missing-media warning. Media preparation/poster capture now waits for seek completion; production static preview prepares video posters before mounting/capture. The original black frame, independently extracted video frame and corrected captures remain in artifacts. Native red-video fixture checks poster pixels and cold-package pixels.

One EditorSession/DocumentAuthority, native operation assembly, durable recovery and storage remain authoritative. Exact identity/revision checks, leases, atomic edits, replay and actor-scoped history remain. No raw document writes, alternate renderer, arbitrary execution tool, historical adapter or reduced-motion cap was added.

## Justified deviations and native boundaries

**Template friendly-name editing was not added to the file format.** Native metadata only supports unique A/B/C ordinal labels (`src/core/document.ts`, `templates.ts`, `templateCommands.ts`, `documentOperations.ts`). It has no friendly-name or rename service; adding one is a deliberate current-format versioning task under AGENTS.md. Current display names combine native label and authored ID, with explicit page kinds. The existing v1 model was preserved.

**No new color-role/theme store.** Native Text Styles own complete typography including color. The evaluation used seven authored roles/variants. Collision diagnostics improved; semantic color roles need a separate native format decision. No silent text shrinking or altered authored line breaks were used.

**No global effect-resource link or persisted recipe schema.** Resources stay page-owned. Cross-slide live reuse comes from shared template elements. Recipe discovery derives from ordinary owned text elements and their existing names; duplication uses native idMap and notes semantics.

**No live smoothness claim.** Sampled native production frames prove visual/timing correctness. They do not measure audience frame pacing, video playback smoothness or a performance improvement.

## Actionable remaining work

### P2 — native template names, if the product wants editable friendly names

Reproduce: author template ID `signal-paper`, inspect deck/templates; native label remains B. Slide inspection now identifies `pageKind:template` and display `Template B (signal-paper)`, eliminating the ownership ambiguity, but no persisted friendly name exists.

Locations: `src/core/document.ts` templateMeta schema/validation, `src/core/templates.ts` ordinal generation, `templateCommands.ts`, `documentOperations.ts`, native template UI and `agentProjection.ts`.

Acceptance: choose a native naming contract deliberately; if persisted schema changes, version document/SME/SMP formats and update writers/readers/fixtures plus the immediately supported migration together. Preserve ordinal/default-template constraints and one store. MCP must use the same native rename operation and return the accepted name after cold reopen.

### P2 — richer, bounded recipe discovery

Reproduce: slide inspection returns owned slot IDs/names/previews, but frames and resolved typography need a subsequent elements inspection. Very large slides repeat discovery payload for every text slot; there is no layout catalog/pagination.

Locations: `src/core/agentProjection.ts` recipe projection, `agentRead.ts` inspection schema, `agentOperationContracts.ts` discovery.

Acceptance: a bounded derived query (or optional bounded slot details) exposes page size, slot bounds/style references and explicit note policy without a parallel recipe format. Hidden content remains withheld. Missing/non-text replacement remains atomic; native idMap semantics remain unchanged. Do not add a global persisted recipe store merely to label slots.

### P2 — media cancellation and unsupported-codec breadth

Current native regression covers PNG, SVG, oriented JPEG, valid WebM, corrupt PNG, missing path, item receipts, poster pixels, typed package and fresh-library video pixels. The evaluation used WebM and original SVG/PNG; MP4 and every codec/orientation variation were not exhaustively exercised.

Locations: `src/components/mediaEnrichment.ts`, `SlidePreviewPage.tsx` prepareAgentMedia, `electron/main.ts` workspace import loop, `agentWorkspace.ts` admission.

Reproduction to add: cancel/revoke between the first completed import and a second delayed metadata decoder; separately simulate renderer loss while decoding. Current implementation rechecks admission and retains completed item receipts, but these specific mid-loop paths need deterministic fault injection rather than sleeps.

Acceptance: exactly identify all imported IDs and remaining not-attempted indexes; no document revision/history changes; no subsequent item begins after admission ends; supported-but-unavailable preparation reports pending, deterministic decode rejection reports unsupported without restarting the runtime. Do not call library side effects atomic. Use focused deterministic/native tests and retain valid video/poster checks.

### P2 — audit transport rediscovery for non-idempotent lifecycle/delivery calls

Code-review concern, NOT reproduced by the finished deck: `mcp/showmeClient.ts` cached/discovered read recovery can resend a request after transport failure. apply has mutationId replay protection; workspace create and package do not. A lost response after successful create/export could therefore repeat native work. The earlier incomplete package plumbing exposed DELIVERY_BUSY while a dialog was still active, but it does not establish a completed-write duplication bug.

Locations: `mcp/showmeClient.ts` read/readDiscovered/rediscovery; native lifecycle/delivery receipts and bridge cancellation.

Reproduction: fault-inject a disconnect only AFTER native create or package write has completed but BEFORE its HTTP receipt reaches the client. Count native operations and allocated destinations.

Acceptance: rediscovery must not silently repeat a completed non-idempotent operation; return an explicit uncertain outcome plus identity/context recovery, or adopt a native request receipt policy through the existing service. Preserve safe context discovery and apply replay. Do not weaken access/cancellation checks or add another document owner.

### P3 — optional shared color roles and fit batching

The current full-color Text Style model correctly requires variants. If color roles are desired, design them natively with full compatibility/versioning review. Existing measure_text supports explicit production fit and caught no overflow in this deck; optional page-batch preflight must not silently shrink text or rewrite line breaks.

## Verification

All native runs were separate from evaluation apps. No assertions were weakened and no test retries/quarantines were added.

```powershell
npm run build

$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/editor/agentWorkspace.test.ts","tests/feature/editor/agentProjection.test.ts","tests/feature/editor/agentDelivery.test.ts","tests/feature/editor/session-failure.test.ts","tests/feature/editor/agentPreview.test.ts","tests/feature/editor/agentBridge.test.ts","tests/feature/editor/agentInspection.test.ts","tests/feature/editor/agentClosing.test.ts","tests/feature/persistence/package-options.test.ts"]'
npx vitest run
Remove-Item Env:SHOWME_TEST_FILES
# 10 files, 113 tests passed.

$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-mcp-friction-isolated-final
Remove-Item Env:SHOWME_TEST_FILES
# 17 passed, 58.6 seconds.

# Final SDK root-field diagnostic delta:
$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts"]'
npx vitest run
Remove-Item Env:SHOWME_TEST_FILES
# 46 passed.

# Final SDK/media recovery delta, including corrupt-image classification:
$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --grep 'native templates shared|raw SDK tools list' --output test-results-mcp-friction-media-recovery-final
Remove-Item Env:SHOWME_TEST_FILES
# 2 passed, 9.3 seconds.

npm run test:stats
npm run test:audit
git -c core.safecrlf=false diff --check
```

Stats: 597 active declarations in 88 groups. ESLint on task-touched source/tests passed; final completion note records whitespace/audit output. The tiny `tests/fixtures/media/prepared-red.webm` is generated constant red VP9 video for a real native pixel contract; no FFmpeg installation is needed to run the test. Previous native failures are retained and explained in the evaluation report.

The 17-declaration sweep preceded only the final canonical root-field diagnostic selection and corrupt-media item-classification refinements; those deltas passed the focused checks above. Supported-media rendering and saved presentation content were unchanged by those final error-path changes. No full/release suite, installer, macOS or repeated benchmark was run. The audience-navigation gate is still required before any later rendering-affecting commit/integration on main; none was authorized here.

Final completion: task-scoped ESLint, final whitespace review (`git -c core.safecrlf=false diff --check`) and final registry audit all passed. Evaluation app instances and the local harness are stopped. All pre-existing changes/artifacts remain uncommitted on the original branch.

## Settings and recovery continuation — 2026-10-18

### Completed

- Settings now offers **Copy for Codex (TOML)**, **Copy for MCP clients (JSON)** and **Copy for VS Code (JSON)**. Each copies a complete server entry and reports its format. All use the existing command/arguments and user-data/instance discovery; explicit instance arguments survive formatting unchanged. No token is copied. Locations: `src/core/mcpConfiguration.ts`, `src/components/McpSettings.tsx`; actual clipboard checks in `tests/extended/agent-mcp.spec.ts`.
- Codex contract verified against the [official documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): `mcp_servers` table, `command`, `args`. Installed Codex parsed generated TOML and round-tripped Windows paths, spaces, quotes, apostrophes, trailing backslashes, control escapes and explicit instance arguments. No shell quoting is added.
- Workspace/delivery transport exceptions now return `OUTCOME_UNKNOWN`, clear the cache and never redispatch that request. Explicit access failures return unchanged without redispatch. Safe reads keep bounded rediscovery; apply keeps mutation-ID replay. Locations: `mcp/showmeClient.ts`, `tests/feature/editor/agentBridge.test.ts`. HTTP fault injection simulates completed native work followed by response destruction for both commands and cached/discovered connections: exactly one dispatch. No duplicate real native create/package write was observed in deck evaluation. This is not durable exactly-once receipt storage.
- Extracted the existing indexed native import loop into `electron/agentMediaImport.ts` so deterministic tests exercise production orchestration. Main supplies the same native storage and isolated preparation services. Admission now also runs immediately after import, before decoding. Remaining unstarted items correctly report `preparation:not-attempted`.
- Deferred deterministic tests cancel/revoke during the second decoder: retain both imported IDs, persist only first metadata, never start the third input, preserve authority projection/revision. Renderer-loss injection retains a pending ID and subsequent preparation recovers that same ID. Native Electron holds the second real decoder, revokes editing and verifies receipts, two decoder calls and unchanged document state. Existing native valid/corrupt media, poster and fresh-package pixel checks pass.
- Repository hygiene: `/.codex/` and `/artifacts/` ignored. No deck, local harness, runtime data or earlier evidence was deleted. Source, maintained docs/tests, registry/stats and the documented tiny red-video fixture belong in the PR. No main integration, publishing or sending.

### Current verification

```powershell
npm run build
# PASS: TypeScript and renderer/Electron/MCP bundles.
$env:SHOWME_TEST_FILES='["tests/feature/editor/agentEditing.test.ts","tests/feature/editor/agentWorkspace.test.ts","tests/feature/editor/agentProjection.test.ts","tests/feature/editor/agentDelivery.test.ts","tests/feature/editor/session-failure.test.ts","tests/feature/editor/agentPreview.test.ts","tests/feature/editor/agentBridge.test.ts","tests/feature/editor/agentInspection.test.ts","tests/feature/editor/agentClosing.test.ts","tests/feature/persistence/package-options.test.ts"]'
npx vitest run
Remove-Item Env:SHOWME_TEST_FILES
# PASS: 10 files, 118 tests.
$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts","tests/extended/agent-preview.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-mcp-settings-recovery
Remove-Item Env:SHOWME_TEST_FILES
# PASS: 17 declarations, 55.1 seconds, before adding the next native declaration.
$env:SHOWME_TEST_FILES='["tests/extended/agent-mcp.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --grep 'native media revocation' --output test-results-mcp-media-admission-corrected
Remove-Item Env:SHOWME_TEST_FILES
# PASS: 1 declaration, 6.0 seconds.
npx eslint src/core/mcpConfiguration.ts src/components/McpSettings.tsx electron/agentMediaImport.ts mcp/showmeClient.ts tests/feature/editor/agentWorkspace.test.ts tests/feature/editor/agentBridge.test.ts tests/extended/agent-mcp.spec.ts
npm run test:stats
npm run test:audit
git -c core.safecrlf=false diff --check
```

Task-wide ESLint also passed on all changed/untracked source/test TS/TSX files.
Stats: **603 declarations in 88 groups**. An isolated local Codex check bundled
the production formatter, wrote a temporary config.toml and ran `codex mcp list
--json` with a subprocess-only temporary configuration home; parsed command and
every argument matched exactly. No user Codex configuration was edited.

Native test setup failure is retained under `test-results-mcp-media-admission`:
the first probe wrapped the thumbnail surface, so the second-decoder signal never
arrived. Corrected the test to select the newly initialized agent runtime, following
existing cold-runtime tests. No timeouts, retries or assertions were weakened.
This was a test-target mistake, not a native import defect.

### Remaining issues and native decisions

1. **P2: repeated native renderer loss during media decode.** Production failure/recovery is covered deterministically; Electron covers real decoding, mid-decoder revocation and cold runtime recreation. Repeated crashes inside the same decoder are not yet fault-injected natively. Locations: `electron/main.ts` runAgentRuntime, `electron/agentMediaImport.ts`, `tests/extended/agent-mcp.spec.ts`. Acceptance: destroy each admitted runtime during decoding using explicit signals; retain IDs with pending preparation; no document/history mutation or duplicate allocation; a later request recovers the same ID. Keep decode rejection distinct from renderer loss; no sleeps, test retries or production fault hooks. Broader MP4/codec coverage remains unmeasured.
2. **P2: optional richer recipe query.** Existing slots plus bounded elements inspection already provide geometry/styles. Deferred a convenience query to keep this continuation focused on copy/recovery. Locations and acceptance remain in the earlier recipe section: optional bounded derived details/pagination, dimensions/style IDs, explicit notes policy and hidden-content withholding; no persisted recipe catalog.
3. **Native names and color roles require product/model decisions.** Keep ordinal template labels plus authored IDs and full-color Text Styles. Friendly names or independent color roles require an intentional native format/UI contract, versioned persisted changes and the immediately supported migration, then the same native operations through MCP. Earlier sections retain exact locations and acceptance criteria. No MCP-only stores or aliases.
4. **Future durable lifecycle receipts.** `OUTCOME_UNKNOWN` stops automatic duplication but cannot prove whether a lost write completed. Context and native library/destination inspection are required before deliberate new work. Any future durable receipt design must use existing native services, exact admission and explicit retention policy.

Final SME and **ShowMe — Editorial signal 2.smp** remain untouched under
`artifacts/showme-editorial-signal/library`. No package was opened in this
continuation; existing cold-open evidence already refreshed complete identity.
No smoothness claim follows from captures. Full/release suites, installers,
macOS, repeated benchmarks and the main integration audience-navigation gate were
not run. No main commit/integration is requested; that gate remains mandatory
before later rendering-affecting main commits/integration.
