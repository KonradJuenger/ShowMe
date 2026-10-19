# ShowMe MCP — next-instance implementation handoff

Continuation completed: read [FRICTION_IMPLEMENTATION_HANDOFF_2026-10-18.md](FRICTION_IMPLEMENTATION_HANDOFF_2026-10-18.md) and [editorial-signal-evaluation-2026-10-18.md](editorial-signal-evaluation-2026-10-18.md) for the newer implementation, final artifacts, verification and remaining issues. The original record below is preserved.

Date: 2026-10-18. Execution profile: local-codex.

## Start here

Work in `D:\local_programming\ShowMe-1`, on the currently checked-out branch `codex/local-mcp-server`. Starting HEAD remains `df31f1a733cdfb3992c15ea6f5b14ff32c9f0069`. This checkout contains the previous revision implementation plus this expansion, all uncommitted. Preserve the entire diff and pre-existing `.codex/`, authoring plan and deck test report. Do not reset, create a branch, commit, push or open a PR unless requested. Read AGENTS.md. No sub-agents were used.

The user requested implementation of six MCP improvements, followed by a new modern presentation to expose friction. The next instance should implement the outstanding issues below, then repeat only the affected evaluation paths. Do not rebuild the existing decks to conceal failures.

## What is implemented

Protocol version 1.7.0, eight tools. The original 1.6 work covers cold runtime initialization/recovery, canonical discovery, replay/current observation, stable timeline editing, sampled production previews, atomic multi-page groups, production font/fit feedback and native delivery.

The six requested additions:

1. **Templates:** create, explicitly target/edit visual content and background, inspect, apply, delete unused non-default templates. `createdTemplateIds` is in the strict MCP output schema. Template pages use existing native projections. Inherited slide content remains protected; edit its owner or explicitly detach. Slide timelines/notes are not template fields.
2. **Named typography:** `text.style.define` directly creates/updates by ID and partial typography; existing apply/override/clear operations remain available. Unique style names follow the native rule.
3. **Shared effect resources:** capture an existing resource under an authored ID, attach independent instances on the same page, update validated source once. Cross-slide sharing uses template elements, because native resource ownership is per page. Opt-in `includeEffectResources` inspection returns native source.
4. **Recipes:** ordinary native slides serve as recipes. `slide.duplicate.textReplacements` substitutes declared source text IDs, retaining styles/templates/motion and returning `idMap`. No second persisted recipe model.
5. **Native workspace:** create/open/close/import-assets through native storage, activation and closing services. Exact current identity/revision and editing opt-in; save before switching/closing. Supplied paths resolve inside the selected root, including symlink resolution; omitted paths use native pickers. Opening an already loaded file reuses its native runtime. Raster imports prepare native dimensions before insertion.
6. **Transparent capacity/CSS:** context advertises standard 8 pages/128 operations/128 affected elements; explicit expanded profile allows 32/256/512. Both retain the native 256-operation transaction, 32 renderer validations and 256KiB transport. Resource source updates count toward validation limits. Scoped nested `@supports` joins `:scope` and `@keyframes`. No reduced-motion cap exists or was introduced.

Persistent edits still use EditorSession → native DocumentOperation[] → DocumentAuthority → durable recovery. No raw document writer, alternate renderer, arbitrary JS bridge or compatibility schema was added. No commits/integration, so the main commit gate was not triggered.

## Saved new presentation

- `artifacts/showme-modern-motion/ShowMe — In its element.sme`
- Eight editable slides about ShowMe, original Aurora/Paper theme: oversized Segoe UI, midnight blue/violet/mint light fields alternating with pale contour backgrounds.
- Two authored native templates, each shared by four slides; the mandatory default template is retained unused. Ten authored named styles (five light/dark counterparts), plus native defaults.
- One shared template background source was revised once across its dependent slides. A native recipe generated slide 5 from slide 3; its four text slots changed while inherited references and motion stayed intact.
- Slide 2 contains a real screenshot captured from the actual editor, imported through MCP and inserted as managed media. It is labeled as an actual editor screenshot.
- Native Presence entrances/stagger/click reveal, numeric scale Motion, two GLSL treatments, scoped CSS using native time, isolated text-JS cycling the effect vocabulary. No external images, invented product metrics or fake UI.
- All eight slides visually inspected at 1440×810. All 36 resolved text appearances measured after corrections with zero overflow. Font family loadability succeeded on this Windows machine; exact fallback face is not asserted.
- Sample captures cover reveal states, shader/CSS/text time, and forward/backward/jump transitions. Native audience controls were exercised; presentation ended, editor remained on the cover with empty selection and clean saved state. No frame-rate/smoothness measurement.
- Native save and a cold reopen succeeded during authoring. Final reopen evidence and exact verification outcomes are recorded in the evaluation report.
- Package export was attempted and returned `cancelled:true,written:false` at native option dialogs. Later native Save As successfully created `artifacts/showme-modern-portable/ShowMe — In its element.smp` through the host-authorized native destination policy. It cold-opened in a fresh library with the embedded screenshot and no missing-media warnings. The SME also remains available; it depends on its managed assets under the evaluation root.

Evidence directory: `artifacts/showme-modern-motion`. Read `tool-calls.jsonl`, `metrics.json`, `discovery.json`, `effect-guides.json`, `text-fit-final.json`, `navigation.json`, transition JSON/PNGs and slide PNGs as needed. Logs contain actual semantic requests and structured responses, without image base64 or bridge credentials. Runtime user-data is private infrastructure; do not publish/copy its MCP descriptors or tokens. The authoring harness lived in the Node REPL; semantic requests are reproducible from the log, not a second document model.

## Observed friction and prioritized next work

### P1 — concise validation errors at the SDK boundary

Reproduction: send `deck.transition_defaults.set` with `kind`, `durationMs`, `easing` at the operation root rather than inside required `value`. The canonical guide correctly exposes `value`, so this initial error was caller misuse. However, SDK JSON Schema admission returned a roughly **22,100-byte** string listing failures from every union variant, no structured `INVALID_REQUEST`, before the bridge's bounded validation could run. A single wrong field should identify the matching operation, path and expected field shape.

Likely entry: `mcp/server.ts`, `schema(agentApplyRequestSchema)` / SDK tool input validation. Keep one canonical schema/admission path; do not maintain hand-written duplicate operation validators. Add a real SDK regression for a malformed known operation and unknown operation. Preserve full valid schemas in raw tools/list and bounded errors to the caller. Check the SDK's supported validation hook rather than guessing a replacement.

### P1 — workspace creation readiness and useful receipts

Reproduction: call workspace create, then context immediately. Create succeeds with a native summary, but the first context can report loading with `editor:null`. The initial evaluation harness assumed an editor page and threw; a later context correctly became ready. This is a caller assumption plus discoverable workflow friction, not data loss.

Improve the receipt with accepted document identity, epoch/revision and initial page IDs obtained from the native runtime, and explicit readiness/poll guidance. Consider an existing native editor acknowledgement if needed; avoid fixed sleeps or making authority edits depend on renderer navigation. Native create/open must preserve dirty/draft work. Review the boundary for renderer-local human drafts and active leases before allowing a switch; accepted-revision checks alone do not establish that every UI interaction is idle.

### P1 — explicit package options for unattended export

`showme.deliver action:package` chooses its native destination, then still asks native media-lock and speaker-note questions. The direct package action returned cancellation. Native Save As later produced a portable SMP through the host-authorized destination policy, and its embedded screenshot was verified in a fresh library. The direct package action still needs typed options for these choices and route them through the existing native package service, destination policy and authority admission lock. Preserve interactive defaults for human UI callers. Do not implement a new zip writer or use internal IPC from the authoring client. Test speaker-note policy, asset inclusion, cancellation/access changes and cold reopen of the actual exported package.

### P1 — complete managed-media preparation and partial import receipts

**Fixed during this run:** import-assets initially returned a valid PNG ID with no width/height, then semantic insertion rejected `INVALID_MEDIA: The managed asset is missing prepared dimensions.` Native importer now reads raster dimensions through Electron nativeImage and updates the existing asset catalog. Native regression covers import → insert → production preview. The same screenshot was re-imported and inserted successfully after restart; hashing retained its asset ID.

**Remaining:** nativeImage does not establish preparation for every SVG, video or raster format. Reuse the production media preparation path for these and report explicit prepared/pending/unsupported state per asset. Native import loops can have library side effects before a later cancellation/failure; provide per-item success/failure receipts so the caller can recover without guessing. Do not claim these library imports are atomic document transactions. Test orientation, SVG intrinsic dimensions, video posters/metadata and package portability at their lowest sensible tiers.

### P2 — template naming and ownership detail

Templates currently expose native labels A/B/C; authored IDs carry names such as theme-aurora. Provide native friendly label/name editing if the native model supports it, or deliberately extend its current contract with tests. Inspecting a template through slide inspection currently produces `index:-1` and self-owned elements with `source:slide`; clearer page-kind/owner metadata would remove ambiguity. Receipts use `updatedSlideIds`/`authoredSlideIds` for existing template targets; consider explicit authored page kinds. Do not introduce a parallel template store.

### P2 — style variants, collision detail and fit ergonomics

Trying to define a fresh style named Heading collided with the starter's native Heading style: `INVALID_REQUEST: Text Style name already exists.` The entire style batch correctly remained unaccepted. Renaming authored styles to Aurora Heading etc. worked. A dependent construction was mistakenly attempted before checking that setup had failed and received `UNKNOWN_TEXT_STYLE`; this cascade is a harness error, not a separate atomicity defect.

Return the conflicting style ID/name and useful remediation. Named styles currently have a full color, so light/dark slide variants used ten styles rather than five shared type scales plus color roles. Investigate native theme/color roles deliberately, keeping one format model. Optional preflight fit over a page batch could save calls. Do not silently shrink typography or change authored line breaks. This deck needed two number boxes enlarged from 140 to 185 and one two-line display box enlarged/repositioned after measured height exceeded its frame; the existing fit tool correctly caught all three.

### P2 — recipe and resource ergonomics

Recipes currently address source text IDs. They do not expose semantic slot names or a bounded layout catalog, and duplication preserves source notes unless explicitly rewritten. A separate native recipe browser/slot query could simplify discovery without another persisted document schema. Keep missing/non-text substitutions atomic and preserve native idMap semantics.

Resource capture names an existing page definition and keeps the previous unreferenced resource entry. Repeated captures can consume the native 100-resource page budget; add native-safe pruning without breaking animated parameter bindings. Source-only updates report changed revision but element `changedIds` may be empty; resource IDs/users in receipts would improve follow-up editing. Cross-slide resource reuse currently means shared template elements; independently placed instances across different slides do not have a global live resource link. Any broader resource library needs an explicit native architecture decision, not hidden source duplication advertised as sharing.

### P2 — CSS time versus keyframe progress

An initial soft luminance CSS used infinite keyframes with Stop None. The authoring contract correctly says CSS animations are paused and sampled by finite progress; an infinite browser animation is not evidence of continuous playback. The authored resource was revised to use `sin(var(--t))` under scoped @supports, updating its two instances once. Improve concise examples distinguishing native time expressions and finite keyframes. No reduced-motion restriction should be added. @media is still unsupported by the scoped CSS compiler; @supports is now supported.

### Verification caveat — isolated native UI runs

A combined native run passed 16 declarations and failed the Settings revocation declaration: a deliberately blocked preview returned success before opt-out rather than the expected unavailable result. The evaluation app/native package dialogs were active concurrently. A prior isolated run passed. The focused isolated rerun passed, and the final isolated combined sweep passed all 17 declarations. The failure was not reproduced with the evaluation app closed; its cause remains unconfirmed. Do not add retries, weaken the assertion or quarantine it. If it recurs in an isolated run, investigate the preview latch, independent runtime initialization, native Settings timing and access admission using the retained trace. Concurrent native UI interference is a hypothesis until verified.

## Code map

- Semantic schema/assembly: `src/core/agentMutation.ts`; staging/leases/commit: `electron/agentEditing.ts`.
- Canonical discovery: `src/core/agentOperationContracts.ts`, `src/core/agentAuthoring.ts`; scoped server adapter: `electron/agentAuthoring.ts`.
- Inspection: `src/core/agentProjection.ts`, `electron/agentInspection.ts`.
- New workspace schema/service: `src/core/agentWorkspace.ts`, `electron/agentWorkspace.ts`; native composition: `electron/main.ts`.
- MCP tool output/input schemas: `mcp/server.ts`; transport/request routing: `src/core/agentRead.ts`, `electron/agentBridge.ts`, `mcp/showmeClient.ts`.
- CSS scoped compilation: `src/components/effectRuntime.ts`; authoring prompt: `src/core/effectAuthoring.ts`.
- Native template, style, effect and persistence commands remain the underlying implementation.

## Verification discipline

Run focused unit/native regressions appropriate to each change. Register new test files and update reasons/review dates, stats and audit. Avoid the full/release suite unless the actual scope warrants it. Do not claim a static capture proves smoothness. Before any rendering-affecting commit/integration on main, satisfy both audience-navigation declarations exactly as AGENTS.md requires. No such commit is authorized by the current task.

## Final verified state

138 MCP callTool requests logged; six error responses, including two correct DOCUMENT_NOT_ACTIVE responses caused by the harness retaining the SME document ID after opening the independent SMP. Always refresh the complete document identity after native open, not only epoch/revision. This is normal native package identity behavior.

Final checks: 102 focused unit tests across nine files; 17 isolated native Electron declarations; build/typecheck; ESLint across changed/new source/tests; stats/audit (591 active declarations, 88 groups); diff whitespace review. All passed. Full/release/macOS and repeated benchmarks were not run. Both native artifacts were verified and all evaluation instances are closed. No Git commit/branch/push/PR was created. See the modern evaluation report for exact commands and earlier failures.
